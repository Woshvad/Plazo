/**
 * MERCH-08's observable, asserted against real rows in both schemas.
 *
 * The question the endpoint has to answer is not "what did this plan settle for" — the
 * chain answers that — but "which of *my* orders is this". So the assertion that matters
 * is the one on `externalId`: a settlement row carrying a merchant's own order id,
 * joined across the storage split on `planId` and on nothing else.
 *
 * Both halves are real here. The chain-derived tables come from `ponder.schema.ts`; the
 * operator-private table comes from the committed migration in
 * `services/origination/drizzle`, applied verbatim into the same throwaway schema. That
 * makes this the first thing in the repository to observe that either DDL applies.
 *
 * The second assertion that matters is that every money field crosses as a **string**
 * and `BigInt()` of it equals the seeded value exactly. At 6-decimal USDC the
 * safe-integer boundary is about $9bn; a float would return a neighbouring value, and
 * the failure would read as an off-by-one rather than as a lost dollar.
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {sql} from "drizzle-orm";

import {origination, payout, payoutDispatch, refund, settlementEscrow} from "../ponder.schema.js";
import {pendingDispatches, settlementsFor, type QueryRunner} from "../src/reconciliation.js";
import {openTestDatabase, type TestDatabase} from "./db.fixture.js";

const MERCHANT = "0x00000000000000000000000000000000000acced" as const;
const OTHER_MERCHANT = "0x00000000000000000000000000000000000face2" as const;
const RECIPIENT = "0x000000000000000000000000000000000000dec1" as const;
const TOKEN = "0x3600000000000000000000000000000000000000" as const;

const PLAN_INSTANT = `0x${"a1".repeat(32)}` as const;
const PLAN_ESCROWED = `0x${"b2".repeat(32)}` as const;
const PLAN_OTHERS = `0x${"c3".repeat(32)}` as const;

const ORIGINATION_TX = `0x${"11".repeat(32)}` as const;
const BURN_TX = `0x${"22".repeat(32)}` as const;

/** The merchant's own order id. The whole reason this endpoint exists. */
const EXTERNAL_ID = "A-10432";
const MERCHANT_UUID = "8f2b1c34-5d6e-4f70-8a91-b2c3d4e5f607";

/** Deliberately past `Number.MAX_SAFE_INTEGER`. See the file header. */
const HUGE_GROSS = 9_007_199_254_740_993n;
const HUGE_MDR = 360_287_970_189_639n;

describe("a merchant reconciles settlements against their own ledger", () => {
  let fixture: TestDatabase;
  let db: QueryRunner;

  beforeAll(async () => {
    fixture = await openTestDatabase(
      [payout, payoutDispatch, settlementEscrow, refund, origination],
      {withOperatorSchema: true},
    );
    db = fixture.db as unknown as QueryRunner;

    await fixture.db.insert(origination).values({
      planId: PLAN_INSTANT,
      merchant: MERCHANT,
      principal: HUGE_GROSS,
      mdr: HUGE_MDR,
      withheld: 0n,
      blockNumber: 54_714_200n,
      timestamp: 1_800_000_000,
      cohort: "2027-01",
    });

    await fixture.db.insert(payout).values([
      {
        planId: PLAN_INSTANT,
        merchant: MERCHANT,
        token: TOKEN,
        recipient: RECIPIENT,
        domain: 3,
        gross: HUGE_GROSS,
        mdr: HUGE_MDR,
        withheld: 0n,
        net: HUGE_GROSS - HUGE_MDR,
        status: "dispatched",
        txHash: ORIGINATION_TX,
        dispatchTxHash: BURN_TX,
        blockNumber: 54_714_200n,
        timestamp: 1_800_000_000,
        cohort: "2027-01",
      },
      {
        planId: PLAN_ESCROWED,
        merchant: MERCHANT,
        token: TOKEN,
        gross: 100_000_000n,
        mdr: 4_000_000n,
        withheld: 9_600_000n,
        net: 86_400_000n,
        status: "escrowed",
        txHash: ORIGINATION_TX,
        blockNumber: 54_714_100n,
        timestamp: 1_799_990_000,
        cohort: "2027-01",
      },
      {
        planId: PLAN_OTHERS,
        merchant: OTHER_MERCHANT,
        token: TOKEN,
        gross: 1_000_000n,
        mdr: 0n,
        withheld: 0n,
        net: 1_000_000n,
        status: "settled",
        txHash: ORIGINATION_TX,
        blockNumber: 54_714_300n,
        timestamp: 1_800_001_000,
        cohort: "2027-01",
      },
    ]);

    await fixture.db.insert(settlementEscrow).values({
      planId: PLAN_ESCROWED,
      merchant: MERCHANT,
      amount: 86_400_000n,
      heldAt: 1_799_990_000,
      state: "held",
    });

    // Two credits against one plan, because a merchant matches individual returns and a
    // netted figure cannot be matched against anything.
    await fixture.db.insert(refund).values([
      {
        id: "54714210-1",
        planId: PLAN_INSTANT,
        merchant: MERCHANT,
        amount: 2_000_000n,
        kind: "refund",
        blockNumber: 54_714_210n,
        timestamp: 1_800_000_500,
      },
      {
        id: "54714211-1",
        planId: PLAN_INSTANT,
        merchant: MERCHANT,
        amount: 3_000_000n,
        kind: "refund",
        blockNumber: 54_714_211n,
        timestamp: 1_800_000_600,
      },
    ]);

    await fixture.db.insert(payoutDispatch).values([
      {
        id: "54714200-9",
        kind: "dispatched",
        token: TOKEN,
        recipient: RECIPIENT,
        domain: 3,
        amount: HUGE_GROSS - HUGE_MDR,
        txHash: BURN_TX,
        blockNumber: 54_714_200n,
        logIndex: 9,
        timestamp: 1_800_000_000,
      },
      {
        id: "54714100-2",
        kind: "queued",
        token: TOKEN,
        recipient: RECIPIENT,
        domain: 3,
        amount: 86_400_000n,
        txHash: ORIGINATION_TX,
        blockNumber: 54_714_100n,
        logIndex: 2,
        timestamp: 1_799_990_000,
      },
    ]);

    // The operator-private half: the merchant's own order id, keyed by plan and nothing
    // else. Raw SQL because the table belongs to another service's schema — importing
    // its Drizzle definition would be this package reaching across the split for a
    // convenience, which is the direction the split exists to prevent.
    await fixture.db.execute(
      sql.raw(
        `insert into "${fixture.schema}"."merchant_external_ref" (plan_id, merchant_id, external_id) ` +
          `values ('${PLAN_INSTANT}', '${MERCHANT_UUID}', '${EXTERNAL_ID}')`,
      ),
    );
  }, 30_000);

  afterAll(async () => {
    await fixture?.close();
  });

  const query = () => ({merchant: MERCHANT, operatorSchema: fixture.schema});

  it("returns one row per settlement, and only this merchant's", async () => {
    const rows = await settlementsFor(db, query());
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.planId)).not.toContain(PLAN_OTHERS);
  });

  /**
   * The assertion MERCH-08 is actually about.
   *
   * A settlement row a merchant cannot match to their own order is a row they have to
   * reconcile by hand, which is the problem the requirement names.
   */
  it("carries the merchant's own order id", async () => {
    const rows = await settlementsFor(db, query());
    const instant = rows.find((r) => r.planId === PLAN_INSTANT);
    expect(instant?.externalId).toBe(EXTERNAL_ID);
    expect(instant?.externalId).not.toBeNull();
  });

  /**
   * `planId` is the only join key across the split, and it is exactly what a deletion
   * request severs. Sever it and the settlement is still here — it simply no longer
   * knows whose order it was. That is the design working, not failing.
   */
  it("still returns the settlement when no order id has been filed", async () => {
    const rows = await settlementsFor(db, query());
    const escrowed = rows.find((r) => r.planId === PLAN_ESCROWED);
    expect(escrowed).toBeDefined();
    expect(escrowed?.externalId).toBeNull();
  });

  it("puts every money figure across as a string that round-trips exactly", async () => {
    const rows = await settlementsFor(db, query());
    const instant = rows.find((r) => r.planId === PLAN_INSTANT)!;

    for (const field of ["gross", "mdr", "withheld", "net", "refundedAmount"] as const) {
      expect(typeof instant[field]).toBe("string");
    }

    expect(BigInt(instant.gross)).toBe(HUGE_GROSS);
    expect(BigInt(instant.mdr)).toBe(HUGE_MDR);
    expect(BigInt(instant.net)).toBe(HUGE_GROSS - HUGE_MDR);
  });

  it("sums the individual refunds against a plan", async () => {
    const rows = await settlementsFor(db, query());
    const instant = rows.find((r) => r.planId === PLAN_INSTANT);
    expect(BigInt(instant?.refundedAmount ?? "0")).toBe(5_000_000n);
  });

  it("reports zero refunded rather than null when nothing came back", async () => {
    const rows = await settlementsFor(db, query());
    const escrowed = rows.find((r) => r.planId === PLAN_ESCROWED);
    expect(escrowed?.refundedAmount).toBe("0");
  });

  it("carries the payout domain, the payout status and the escrow state", async () => {
    const rows = await settlementsFor(db, query());
    const instant = rows.find((r) => r.planId === PLAN_INSTANT);
    const escrowed = rows.find((r) => r.planId === PLAN_ESCROWED);

    expect(instant?.payoutDomain).toBe(3);
    expect(instant?.payoutStatus).toBe("dispatched");
    expect(instant?.escrowState).toBeNull();

    expect(escrowed?.payoutStatus).toBe("escrowed");
    expect(escrowed?.escrowState).toBe("held");
  });

  /**
   * Both transactions, because a queued settlement has two and reconciliation needs
   * each: the origination is the merchant's key back to their own order, the burn is
   * Circle's key to the attestation.
   */
  it("carries the origination transaction and the burn separately", async () => {
    const rows = await settlementsFor(db, query());
    const instant = rows.find((r) => r.planId === PLAN_INSTANT);
    expect(instant?.txHash).toBe(ORIGINATION_TX);
    expect(instant?.dispatchTxHash).toBe(BURN_TX);
  });

  it("exposes no borrower, because no column could hold one", async () => {
    const rows = await settlementsFor(db, query());
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("borrower");
      expect(JSON.stringify(row).toLowerCase()).not.toContain("borrower");
    }
  });

  it("filters on the block range, inclusive at both ends", async () => {
    const inRange = await settlementsFor(db, {...query(), from: 54_714_150n, to: 54_714_250n});
    expect(inRange.map((r) => r.planId)).toEqual([PLAN_INSTANT]);

    const atBoundary = await settlementsFor(db, {...query(), from: 54_714_100n, to: 54_714_100n});
    expect(atBoundary.map((r) => r.planId)).toEqual([PLAN_ESCROWED]);
  });

  it("filters on the payout status", async () => {
    const escrowed = await settlementsFor(db, {...query(), status: "escrowed"});
    expect(escrowed.map((r) => r.planId)).toEqual([PLAN_ESCROWED]);

    const settled = await settlementsFor(db, {...query(), status: "settled"});
    expect(settled).toHaveLength(0);
  });

  it("matches a merchant address without regard to case", async () => {
    const rows = await settlementsFor(db, {...query(), merchant: MERCHANT.toUpperCase()});
    expect(rows).toHaveLength(2);
  });

  it("returns the newest settlement first", async () => {
    const rows = await settlementsFor(db, query());
    expect(rows.map((r) => r.planId)).toEqual([PLAN_INSTANT, PLAN_ESCROWED]);
  });

  it("refuses a schema name that is not an identifier", async () => {
    await expect(
      settlementsFor(db, {...query(), operatorSchema: 'operator"; drop table payout; --'}),
    ).rejects.toThrow(/unsafe schema identifier/);
  });
});

/**
 * The provider that replaces plan 06-06's stub.
 *
 * C10 in practice: the settlement loop is driven by the indexer's own table, and the
 * only vendor on the path is the one being asked a question, never the one deciding when
 * to ask it.
 */
describe("the dispatches the attestation poller is told about", () => {
  let fixture: TestDatabase;
  let db: QueryRunner;

  beforeAll(async () => {
    fixture = await openTestDatabase([payoutDispatch]);
    db = fixture.db as unknown as QueryRunner;

    await fixture.db.insert(payoutDispatch).values([
      {
        id: "100-1",
        kind: "dispatched",
        token: TOKEN,
        recipient: RECIPIENT,
        domain: 3,
        amount: 10n,
        txHash: BURN_TX,
        blockNumber: 100n,
        logIndex: 1,
        timestamp: 1_800_000_000,
      },
      {
        id: "200-1",
        kind: "dispatched",
        token: TOKEN,
        recipient: RECIPIENT,
        domain: 3,
        amount: 20n,
        txHash: ORIGINATION_TX,
        blockNumber: 200n,
        logIndex: 1,
        timestamp: 1_800_000_100,
      },
      // Never burned — it is still sitting in the queue waiting for a crank.
      {
        id: "150-1",
        kind: "queued",
        token: TOKEN,
        recipient: RECIPIENT,
        domain: 3,
        amount: 30n,
        txHash: ORIGINATION_TX,
        blockNumber: 150n,
        logIndex: 1,
        timestamp: 1_800_000_050,
      },
      // Settled on Arc. It never left the chain, so there is nothing to attest.
      {
        id: "160-1",
        kind: "paid",
        token: TOKEN,
        recipient: RECIPIENT,
        domain: 26,
        amount: 40n,
        txHash: ORIGINATION_TX,
        blockNumber: 160n,
        logIndex: 1,
        timestamp: 1_800_000_060,
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("offers only burns, never a queued or an Arc-local settlement", async () => {
    const pending = await pendingDispatches(db);
    expect(pending.map((d) => d.id)).toEqual(["100-1", "200-1"]);
  });

  it("orders by block, because Iris attests in the order the burns landed", async () => {
    const pending = await pendingDispatches(db);
    expect(pending.map((d) => Number(d.blockNumber))).toEqual([100, 200]);
  });

  /**
   * The cursor is how the poller skips what it has already completed. The alternative —
   * an `attested` column on `payoutDispatch` — would put a vendor's answer in a
   * chain-derived table and the table would stop being reproducible from the chain.
   */
  it("advances past what the poller has already handled", async () => {
    const pending = await pendingDispatches(db, {after: 100n});
    expect(pending.map((d) => d.id)).toEqual(["200-1"]);
  });

  it("carries the transaction hash, which is the only join to Circle", async () => {
    const [first] = await pendingDispatches(db);
    expect(first?.txHash).toBe(BURN_TX);
    expect(first).not.toHaveProperty("nonce");
  });

  it("puts the amount across as a string", async () => {
    const [first] = await pendingDispatches(db);
    expect(typeof first?.amount).toBe("string");
    expect(BigInt(first!.amount)).toBe(10n);
  });
});
