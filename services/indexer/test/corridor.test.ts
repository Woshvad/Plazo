/**
 * Two books, and the streams the corridor adds.
 *
 * The load-bearing half is the first describe block, and it runs against a real Postgres
 * rather than against a key-building function. Phase 7 deploys a second
 * `TranchedCreditPool` for the EURC corridor, and the failure that change invites is not a
 * crash — it is the EURC book's epoch 1 landing on the USDC book's epoch 1 through an
 * upsert written to be idempotent, overwriting a NAV with no error anywhere. A test over
 * the id function alone would pass against a schema whose primary key had not moved, so
 * the assertion is on the rows: two pools, one epoch number, one block, **two rows**.
 *
 * The second half asserts the pure decisions behind the new streams — which collection was
 * a payroll sweep, how a pause edge becomes an interval, how close a fill came to its
 * floor. Those live in `pools.ts` and `corridor.ts` precisely so they can be cornered
 * here; `capital.ts`, `fx.ts` and `underwriting.ts` import `ponder:registry` and cannot be
 * loaded outside the Ponder runtime.
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {eq, sql} from "drizzle-orm";

import {epoch, lenderPosition, queueFill, redemptionTicket} from "../ponder.schema.js";
import {nonUniformFills, poolPositionId, poolTicketId} from "../src/pools.js";
import {
  corridorPauseWindows,
  fxHeadroom,
  isPayrollSweep,
  logId,
  PLEDGE_KINDS,
} from "../src/corridor.js";
import {openTestDatabase, type TestDatabase} from "./db.fixture.js";

/** The USDC book. */
const USDC_POOL = `0x${"d0".repeat(20)}` as const;
/** The EURC book (07-09). Same ABI, same epoch numbering, different balance sheet. */
const EURC_POOL = `0x${"e0".repeat(20)}` as const;
const HOLDER = `0x${"a1".repeat(20)}` as const;
const SWEEPER = `0x${"5e".repeat(20)}` as const;
const KEEPER = `0x${"be".repeat(20)}` as const;
const ZERO = `0x${"00".repeat(20)}` as const;
const CORRIDOR_A = `0x${"aa".repeat(32)}` as const;
const CORRIDOR_B = `0x${"bb".repeat(32)}` as const;
const TX = `0x${"11".repeat(32)}` as const;

describe("two books never collapse onto one row", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await openTestDatabase([epoch, lenderPosition, redemptionTicket, queueFill]);
  });

  afterAll(async () => {
    await database?.close();
  });

  /**
   * The plan's named criterion, and the reason the primary key moved.
   *
   * Both books close epoch 1. Under the v4 schema `number` was the whole key, so the
   * second insert was the same row as the first — and `onConflictDoNothing` meant the
   * EURC NAV was silently discarded while the surface reported the USDC figure under both
   * books' names.
   */
  it("writes two epoch rows when two pools close the same epoch in one block", async () => {
    await database.db.insert(epoch).values([
      {
        pool: USDC_POOL,
        number: 1n,
        seniorNav: 1_000_000_000n,
        juniorNav: 250_000_000n,
        liquidityFeeBps: 0n,
        closedAt: 1_700_000_000,
        blockNumber: 54_000_000n,
      },
      {
        pool: EURC_POOL,
        number: 1n,
        seniorNav: 400_000_000n,
        juniorNav: 100_000_000n,
        liquidityFeeBps: 0n,
        closedAt: 1_700_000_000,
        blockNumber: 54_000_000n,
      },
    ]);

    const rows = await database.db.select().from(epoch);
    expect(rows).toHaveLength(2);

    const usdc = rows.find((r) => r.pool === USDC_POOL);
    const eurc = rows.find((r) => r.pool === EURC_POOL);
    expect(usdc?.seniorNav).toBe(1_000_000_000n);
    expect(eurc?.seniorNav).toBe(400_000_000n);
    // Neither book's NAV was overwritten by the other's, which is the whole property.
    expect(usdc?.seniorNav).not.toBe(eurc?.seniorNav);
  });

  /**
   * An allocator holding senior in both books is two positions.
   *
   * Under `tranche-holder` their EURC deposit accumulated onto their USDC row, producing
   * one position worth the sum of two balance sheets and denominated in neither.
   */
  it("keeps one holder's position in each book apart", async () => {
    await database.db.insert(lenderPosition).values([
      {
        id: poolPositionId(USDC_POOL, 0, HOLDER),
        pool: USDC_POOL,
        tranche: 0,
        holder: HOLDER,
        depositedAssets: 500_000_000n,
        updatedAt: 1_700_000_000,
      },
      {
        id: poolPositionId(EURC_POOL, 0, HOLDER),
        pool: EURC_POOL,
        tranche: 0,
        holder: HOLDER,
        depositedAssets: 120_000_000n,
        updatedAt: 1_700_000_000,
      },
    ]);

    const rows = await database.db
      .select()
      .from(lenderPosition)
      .where(eq(lenderPosition.holder, HOLDER));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.depositedAssets).sort()).toEqual([120_000_000n, 500_000_000n]);
  });

  /**
   * Ticket `index` is a per-tranche counter inside one pool and restarts at zero for each
   * book, so two lenders in two books are handed ticket 0 on the same day.
   */
  it("keeps two books' ticket zero apart", async () => {
    await database.db.insert(redemptionTicket).values([
      {
        id: poolTicketId(USDC_POOL, 0, HOLDER, 0n),
        pool: USDC_POOL,
        tranche: 0,
        holder: HOLDER,
        index: 0n,
        shares: 10n,
        position: 10n,
        requestedAt: 1_700_000_000,
      },
      {
        id: poolTicketId(EURC_POOL, 0, HOLDER, 0n),
        pool: EURC_POOL,
        tranche: 0,
        holder: HOLDER,
        index: 0n,
        shares: 40n,
        position: 40n,
        requestedAt: 1_700_000_000,
      },
    ]);

    const rows = await database.db.select().from(redemptionTicket);
    expect(rows).toHaveLength(2);
  });

  /**
   * `pool` is `not null`, asserted against Postgres rather than against TypeScript.
   *
   * `tsc` already refuses an insert that omits it, which is the better guard for code in
   * this repository — but it says nothing about the table. A DDL that made the column
   * nullable would still typecheck through a cast, an untyped query or a future
   * migration, and the row would land unattributed. So this goes around the type system
   * on purpose and asks the database.
   */
  it("refuses an epoch row that does not say which book struck it", async () => {
    // Drizzle wraps the driver error, so "it threw" is asserted through the cause rather
    // than the message: `23502` is Postgres' `not_null_violation` and `column` names the
    // one that was missing. Asserting only that something threw would pass on a syntax
    // error, which is a test that agrees with itself.
    let caught: {code?: string; column?: string} | undefined;
    try {
      await database.db.execute(
        sql`insert into epoch (number, senior_nav, junior_nav, liquidity_fee_bps, closed_at, block_number)
            values (99, 1, 1, 0, 1700000001, 54000001)`,
      );
    } catch (error) {
      caught = ((error as {cause?: unknown}).cause ?? error) as {code?: string; column?: string};
    }

    expect(caught, "the insert was accepted — `pool` is nullable").toBeDefined();
    expect(caught?.code).toBe("23502");
    expect(caught?.column).toBe("pool");
  });
});

/**
 * POOL-09's uniformity is now a per-book property.
 *
 * Two correct rates in two pools' epoch 4 are two correct epochs. A check that ignored
 * the pool would read them as one book charging two redeemers differently — the exact
 * violation the liquidity fee replaced, reported where it did not happen.
 */
describe("queue-fill uniformity is checked inside a book", () => {
  it("does not flag two books charging different rates in the same epoch", () => {
    expect(
      nonUniformFills([
        {pool: USDC_POOL, tranche: 0, epoch: 4n, feeBps: 0n},
        {pool: EURC_POOL, tranche: 0, epoch: 4n, feeBps: 25n},
      ]),
    ).toEqual([]);
  });

  it("still flags one book charging two rates in one epoch", () => {
    const offenders = nonUniformFills([
      {pool: USDC_POOL, tranche: 0, epoch: 4n, feeBps: 0n},
      {pool: USDC_POOL, tranche: 0, epoch: 4n, feeBps: 25n},
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("-0-4");
  });

  it("treats the same book's two tranches as two groups", () => {
    expect(
      nonUniformFills([
        {pool: USDC_POOL, tranche: 0, epoch: 4n, feeBps: 0n},
        {pool: USDC_POOL, tranche: 1, epoch: 4n, feeBps: 25n},
      ]),
    ).toEqual([]);
  });
});

/**
 * The sweep stream, which exists because the sweeper's own events do not.
 *
 * All three `PayrollSweeper` events carry the plan's counterparty as an indexed address
 * beside a `planId`, so `@plazo/events` v5 declines to list them and nothing can subscribe
 * to them. A sweep still settles through `InstallmentPlan.repay`, so `CheckCleared`
 * carries the sweeper's contract address in `keeper` and this comparison is the stream.
 */
describe("a payroll sweep is a keeper comparison, not an event", () => {
  it("recognises the configured sweeper", () => {
    expect(isPayrollSweep(SWEEPER, SWEEPER)).toBe(true);
  });

  it("ignores case, because a provider's casing is not a fact", () => {
    expect(isPayrollSweep(SWEEPER.toUpperCase() as `0x${string}`, SWEEPER)).toBe(true);
  });

  it("does not call an ordinary keeper a sweep", () => {
    expect(isPayrollSweep(KEEPER, SWEEPER)).toBe(false);
  });

  /**
   * The failure that matters. An unconfigured sweeper is the zero address; without the
   * explicit guard a `keeper` that were somehow zero would match it, and the stream would
   * claim a collection nobody swept.
   */
  it("claims nothing when no sweeper is configured", () => {
    expect(isPayrollSweep(KEEPER, ZERO)).toBe(false);
    expect(isPayrollSweep(ZERO, ZERO)).toBe(false);
  });
});

describe("the deviation guard's headroom", () => {
  it("is the distance above the floor", () => {
    expect(fxHeadroom(1_050_000n, 1_000_000n)).toBe(50_000n);
  });

  it("is zero at the floor rather than negative", () => {
    expect(fxHeadroom(1_000_000n, 1_000_000n)).toBe(0n);
    // A fill below the floor reverts and never emits; a stored negative would sort to
    // the top of "closest to the floor" and read as the guard having failed.
    expect(fxHeadroom(999_999n, 1_000_000n)).toBe(0n);
  });
});

/**
 * FX-04's breaker, joined to plan 07-08's trip reasons.
 *
 * A reason carries a timestamp, not an edge, so it can only be matched against an
 * interval. Both properties below are ones an edge list gets wrong.
 */
describe("corridor pauses become intervals", () => {
  it("pairs a trip with its release", () => {
    expect(
      corridorPauseWindows([
        {corridor: CORRIDOR_A, paused: true, timestamp: 100},
        {corridor: CORRIDOR_A, paused: false, timestamp: 400},
      ]),
    ).toEqual([{corridor: CORRIDOR_A, from: 100, to: 400}]);
  });

  it("treats two trips of one breaker as one outage", () => {
    const windows = corridorPauseWindows([
      {corridor: CORRIDOR_A, paused: true, timestamp: 100},
      {corridor: CORRIDOR_A, paused: true, timestamp: 200},
      {corridor: CORRIDOR_A, paused: false, timestamp: 400},
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({corridor: CORRIDOR_A, from: 100, to: 400});
  });

  /** The case an operator most needs to see must not be the one that disappears. */
  it("reports a corridor that is still shut", () => {
    expect(
      corridorPauseWindows([{corridor: CORRIDOR_A, paused: true, timestamp: 100}]),
    ).toEqual([{corridor: CORRIDOR_A, from: 100, to: null}]);
  });

  it("keeps two corridors' outages apart", () => {
    const windows = corridorPauseWindows([
      {corridor: CORRIDOR_A, paused: true, timestamp: 100},
      {corridor: CORRIDOR_B, paused: true, timestamp: 150},
      {corridor: CORRIDOR_A, paused: false, timestamp: 200},
    ]);
    expect(windows).toEqual([
      {corridor: CORRIDOR_A, from: 100, to: 200},
      {corridor: CORRIDOR_B, from: 150, to: null},
    ]);
  });

  it("opens no window for a release that closes nothing", () => {
    expect(corridorPauseWindows([{corridor: CORRIDOR_A, paused: false, timestamp: 100}])).toEqual(
      [],
    );
  });
});

describe("writer-chosen ids and TypeScript-side enums", () => {
  it("keys a log row by its own coordinates, so a replay is a no-op", () => {
    expect(logId(TX, 3)).toBe(`${TX}:3`);
    expect(logId(TX, 3)).toBe(logId(TX, 3));
    expect(logId(TX, 3)).not.toBe(logId(TX, 4));
  });

  /** DEC-57: the constraint lives in TypeScript, never in a `pgEnum`. */
  it("names the three pledge kinds", () => {
    expect([...PLEDGE_KINDS]).toEqual(["pledged", "released", "yieldPaid"]);
  });
});
