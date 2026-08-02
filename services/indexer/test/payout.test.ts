/**
 * The settlement plane, asserted against real Postgres rows.
 *
 * Two halves, and the split is deliberate.
 *
 * The **predicate** half asserts the functions that decide what a dispatch closes out
 * and which adapter log settled an origination. They are exported from `payout.ts`
 * rather than inlined into the handlers precisely so they can be asserted directly: the
 * queued → dispatched transition is not a primary-key update, because a dispatch names
 * a route and never a plan (DEC-36), so the decision lives in TypeScript where it can
 * be cornered rather than in a SQL string nobody can run without a server.
 *
 * The **row** half runs the same code against a real database. It is the first time
 * anything in this package has touched one. What it catches that `typecheck` cannot: a
 * `numeric(78)` that silently rounds a `bigint`, a column that does not exist, and a
 * status transition that reads correctly and writes nothing.
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {eq} from "drizzle-orm";

import {payout, payoutDispatch, settlementEscrow} from "../ponder.schema.js";
import {
  ARC_DOMAIN,
  dispatchClosesOut,
  netOf,
  planIdsClosedOutBy,
  settlementLogFor,
  statusFromDispatch,
} from "../src/settlement.js";
import {openTestDatabase, type TestDatabase} from "./db.fixture.js";

const PLAN_A = `0x${"a1".repeat(32)}` as const;
const PLAN_B = `0x${"b2".repeat(32)}` as const;
const PLAN_C = `0x${"c3".repeat(32)}` as const;
const MERCHANT = "0x00000000000000000000000000000000000acced" as const;
const TOKEN = "0x3600000000000000000000000000000000000000" as const;
const RECIPIENT = "0x000000000000000000000000000000000000dec1" as const;
const OTHER_RECIPIENT = "0x00000000000000000000000000000000000face2" as const;
const ORIGINATION_TX = `0x${"11".repeat(32)}` as const;
const BURN_TX = `0x${"22".repeat(32)}` as const;

const ARBITRUM_DOMAIN = 3;

/** A route the adapter would name. */
const route = {token: TOKEN, recipient: RECIPIENT, domain: ARBITRUM_DOMAIN};

// ─── The predicates ───────────────────────────────────────────────────────────

describe("what a settlement is worth", () => {
  /**
   * `CheckoutRouter._settleMerchant` hands the adapter `ctx.net - ctx.withholding` and
   * `ctx.net` is `principal - mdr`. No event carries the figure, so if this arithmetic
   * is wrong every reconciliation row is wrong by the withholding and nothing else in
   * the system disagrees with it.
   */
  it("is principal less MDR less the bond withholding", () => {
    expect(netOf(100_000_000n, 4_000_000n, 9_600_000n)).toBe(86_400_000n);
  });

  it("stays exact past the safe-integer boundary", () => {
    expect(netOf(9_007_199_254_740_993n, 1n, 1n)).toBe(9_007_199_254_740_991n);
  });
});

describe("the status an origination-time settlement lands in", () => {
  it("is settled when the adapter paid out on Arc", () => {
    expect(statusFromDispatch("paid")).toBe("settled");
  });

  it("is queued when the adapter could only queue", () => {
    expect(statusFromDispatch("queued")).toBe("queued");
  });

  it("is dispatched when the burn already went out", () => {
    expect(statusFromDispatch("dispatched")).toBe("dispatched");
  });
});

describe("which rows one dispatch closes out", () => {
  const queued = {planId: PLAN_A, status: "queued", token: TOKEN, recipient: RECIPIENT, domain: ARBITRUM_DOMAIN};

  it("closes a queued row on exactly that route", () => {
    expect(dispatchClosesOut(queued, route)).toBe(true);
  });

  /**
   * The negative controls that matter, one per component of the key.
   *
   * DEC-36 made the queue three-keyed specifically because `dispatch()` is
   * permissionless and a two-key queue would let a stranger choose which chain a
   * merchant's settlement landed on. An indexer that closed out on two of the three
   * would be reporting that exact confusion as fact.
   */
  it("does not close a row bound for another domain", () => {
    expect(dispatchClosesOut(queued, {...route, domain: 7})).toBe(false);
  });

  it("does not close a row bound for another recipient", () => {
    expect(dispatchClosesOut(queued, {...route, recipient: OTHER_RECIPIENT})).toBe(false);
  });

  it("does not close a row denominated in another token", () => {
    expect(dispatchClosesOut(queued, {...route, token: OTHER_RECIPIENT})).toBe(false);
  });

  it("matches addresses without regard to case", () => {
    expect(dispatchClosesOut({...queued, recipient: RECIPIENT.toUpperCase()}, route)).toBe(true);
  });

  /**
   * A settled row never went through the queue and a returned row is over. Reopening
   * either because a later, unrelated dispatch shared a route would report money as in
   * flight after it has gone home.
   */
  it.each(["settled", "escrowed", "returned", "dispatched"])(
    "leaves a %s row alone even on a matching route",
    (status) => {
      expect(dispatchClosesOut({...queued, status}, route)).toBe(false);
    },
  );

  it("returns every queued plan on the route and only those", () => {
    const rows = [
      queued,
      {...queued, planId: PLAN_B},
      {...queued, planId: PLAN_C, domain: ARC_DOMAIN},
    ];
    expect(planIdsClosedOutBy(rows, route)).toEqual([PLAN_A, PLAN_B]);
  });
});

describe("which adapter log settled an origination", () => {
  const log = (logIndex: number, amount: bigint) => ({logIndex, amount});

  /**
   * `_settleMerchant` runs before `emit OriginationCompleted`, so the adapter's log is
   * always below the origination's. A log at or above it belongs to a later plan.
   */
  it("ignores a log at or above the origination's own index", () => {
    expect(settlementLogFor([log(9, 100n)], {logIndex: 9, payable: 100n})).toBeUndefined();
    expect(settlementLogFor([log(10, 100n)], {logIndex: 9, payable: 100n})).toBeUndefined();
  });

  it("takes the log that moved exactly the payable amount", () => {
    const chosen = settlementLogFor([log(2, 99n), log(3, 100n)], {logIndex: 9, payable: 100n});
    expect(chosen?.logIndex).toBe(3);
  });

  /**
   * The reason the match is on amount and not "the last log under this hash". A batch
   * originating two plans in one transaction puts two adapter logs under one hash, and
   * taking the last would hand the first plan the second plan's route — a merchant's
   * money reported as going to another merchant's address.
   */
  it("gives each plan in a batched transaction its own log", () => {
    const logs = [log(2, 100n), log(5, 250n)];
    expect(settlementLogFor(logs, {logIndex: 3, payable: 100n})?.logIndex).toBe(2);
    expect(settlementLogFor(logs, {logIndex: 6, payable: 250n})?.logIndex).toBe(5);
  });

  it("finds nothing when the settlement went to escrow instead", () => {
    expect(settlementLogFor([], {logIndex: 3, payable: 100n})).toBeUndefined();
  });
});

// ─── The rows ─────────────────────────────────────────────────────────────────

describe("the settlement plane against a real database", () => {
  let fixture: TestDatabase;

  beforeAll(async () => {
    fixture = await openTestDatabase([payout, payoutDispatch, settlementEscrow]);
  }, 30_000);

  afterAll(async () => {
    await fixture?.close();
  });

  const seedQueued = async (planId: `0x${string}`, gross: bigint) => {
    await fixture.db.insert(payout).values({
      planId,
      merchant: MERCHANT,
      token: TOKEN,
      recipient: RECIPIENT,
      domain: ARBITRUM_DOMAIN,
      gross,
      mdr: 4_000_000n,
      withheld: 0n,
      net: netOf(gross, 4_000_000n, 0n),
      status: "queued",
      txHash: ORIGINATION_TX,
      blockNumber: 54_714_200n,
      timestamp: 1_800_000_000,
      cohort: "2027-01",
    });
  };

  it("carries a dispatch's transaction hash, which is the only join to Circle", async () => {
    /**
     * DEC-31, finding 28: a CCTP v2 burn emits a **zero** nonce and the real
     * `eventNonce` only comes back from Iris at attestation. There is no on-chain
     * identifier for this row to key on, so the transaction hash is the join and a
     * `nonce` column would be permanently null. The attestation poller reads this row.
     */
    await fixture.db.insert(payoutDispatch).values({
      id: "54714201-4",
      kind: "dispatched",
      token: TOKEN,
      recipient: RECIPIENT,
      domain: ARBITRUM_DOMAIN,
      amount: 96_000_000n,
      txHash: BURN_TX,
      blockNumber: 54_714_201n,
      logIndex: 4,
      timestamp: 1_800_000_100,
    });

    const [row] = await fixture.db
      .select()
      .from(payoutDispatch)
      .where(eq(payoutDispatch.id, "54714201-4"));

    expect(row?.txHash).toBe(BURN_TX);
    expect(row?.amount).toBe(96_000_000n);
    expect(typeof row?.amount).toBe("bigint");
  });

  /**
   * The transition, run through the code that ships.
   *
   * The SQL below is the handler's SQL and the predicate is the handler's predicate.
   * What a database adds over the predicate test above is that `status = 'queued'`
   * actually selects the rows the handler believes it selects, and that the update
   * lands.
   */
  it("moves every queued row on the route to dispatched, and nothing else", async () => {
    await seedQueued(PLAN_A, 100_000_000n);
    await seedQueued(PLAN_B, 200_000_000n);

    // A settled row on the very same route. It never went through the queue.
    await fixture.db.insert(payout).values({
      planId: PLAN_C,
      merchant: MERCHANT,
      token: TOKEN,
      recipient: RECIPIENT,
      domain: ARBITRUM_DOMAIN,
      gross: 50_000_000n,
      mdr: 0n,
      withheld: 0n,
      net: 50_000_000n,
      status: "settled",
      txHash: ORIGINATION_TX,
      blockNumber: 54_714_199n,
      timestamp: 1_799_999_000,
      cohort: "2027-01",
    });

    const open = await fixture.db.select().from(payout).where(eq(payout.status, "queued"));
    const closed = planIdsClosedOutBy(open, route);
    expect(closed.sort()).toEqual([PLAN_A, PLAN_B].sort());

    for (const planId of closed) {
      await fixture.db
        .update(payout)
        .set({status: "dispatched", dispatchTxHash: BURN_TX})
        .where(eq(payout.planId, planId as `0x${string}`));
    }

    const [a] = await fixture.db.select().from(payout).where(eq(payout.planId, PLAN_A));
    const [c] = await fixture.db.select().from(payout).where(eq(payout.planId, PLAN_C));

    expect(a?.status).toBe("dispatched");
    expect(a?.dispatchTxHash).toBe(BURN_TX);
    expect(c?.status).toBe("settled");
    expect(c?.dispatchTxHash).toBeNull();
  });

  /**
   * The origination transaction survives the dispatch.
   *
   * A queued settlement has two transactions and a reconciliation needs both: the
   * origination is the merchant's key back to their own order, the burn is Circle's key
   * to the attestation. Writing the burn over `txHash` would leave a row that looks
   * correct and has lost the sale — which is exactly what the first draft of this
   * handler did.
   */
  it("keeps the origination transaction after the burn is recorded", async () => {
    const [a] = await fixture.db.select().from(payout).where(eq(payout.planId, PLAN_A));
    expect(a?.txHash).toBe(ORIGINATION_TX);
    expect(a?.txHash).not.toBe(a?.dispatchTxHash);
  });

  /**
   * `t.bigint()` is `numeric(78)` in Postgres. A column that went through a JavaScript
   * float would return a neighbouring value here, and the assertion would read as an
   * off-by-one rather than as a lost dollar.
   */
  it("round-trips money past the safe-integer boundary exactly", async () => {
    const enormous = 9_007_199_254_740_993n;
    const planId = `0x${"d4".repeat(32)}` as const;

    await fixture.db.insert(payout).values({
      planId,
      merchant: MERCHANT,
      token: TOKEN,
      gross: enormous,
      mdr: 1n,
      withheld: 1n,
      net: netOf(enormous, 1n, 1n),
      status: "settled",
      blockNumber: 54_714_202n,
      timestamp: 1_800_000_200,
      cohort: "2027-01",
    });

    const [row] = await fixture.db.select().from(payout).where(eq(payout.planId, planId));
    expect(row?.gross).toBe(enormous);
    expect(row?.net).toBe(enormous - 2n);
  });

  /**
   * An escrowed settlement has no route until the hold releases, which is the whole
   * reason `recipient` and `domain` are nullable. A `notNull` on either would have
   * forced `SettlementHeld` to invent an address.
   */
  it("holds a settlement with no route yet, and no borrower column to put one in", async () => {
    const planId = `0x${"e5".repeat(32)}` as const;

    await fixture.db.insert(settlementEscrow).values({
      planId,
      merchant: MERCHANT,
      amount: 86_400_000n,
      heldAt: 1_800_000_300,
      state: "held",
    });

    await fixture.db.insert(payout).values({
      planId,
      merchant: MERCHANT,
      token: `0x${"00".repeat(20)}`,
      status: "escrowed",
      blockNumber: 54_714_203n,
      timestamp: 1_800_000_300,
      cohort: "2027-01",
    });

    const [row] = await fixture.db.select().from(payout).where(eq(payout.planId, planId));
    expect(row?.recipient).toBeNull();
    expect(row?.domain).toBeNull();
    expect(row?.status).toBe("escrowed");
    expect(Object.keys(row ?? {})).not.toContain("borrower");

    const [held] = await fixture.db
      .select()
      .from(settlementEscrow)
      .where(eq(settlementEscrow.planId, planId));
    expect(held?.nonAttested).toBe(false);
    expect(held?.carrierRef).toBeNull();
  });
});
