/**
 * Indexing handlers for what came back, and what it cost the merchant.
 *
 * Split from `payout.ts` by question rather than by contract. That file is "where did
 * the money go"; this one is "what came back and what standing it left the merchant
 * with". `RefundEscrow` events appear in both halves of that sentence, which is why the
 * split is by question — a reader chasing a refund does not care which contract emitted
 * it, and a reader chasing a merchant's standing does not care either.
 *
 * As everywhere in this schema, no handler writes a borrower address, and none could:
 * a refund names a `planId`, a void names a `planId`, and a slash names a merchant.
 * None of the three names a person, and `planId` is the only join key into the operator
 * schema — which is exactly what a deletion request severs.
 *
 * ## Why `merchant` is denormalised onto a refund row
 *
 * `RefundEscrow` calls the plan rather than reimplementing it (D-04), so its events
 * carry the plan and nothing else. A merchant dashboard filters by merchant. The
 * address is therefore read back from `origination` — the row the checkout router wrote
 * when the plan was created — and copied onto the refund at write time. Reading it at
 * query time instead would make every dashboard page a join against a table whose only
 * purpose here is to answer one immutable question.
 *
 * A refund for a plan this indexer never saw originate keeps the zero address rather
 * than being dropped. Losing the money because the origination is outside the
 * configured block range would be a silent hole in a reconciliation; a row a merchant
 * filter misses is at least still in the total.
 */
import {ponder} from "ponder:registry";
import {merchant, origination, refund} from "ponder:schema";

/** A plan whose origination this indexer never saw. Kept, not dropped. */
const UNKNOWN_MERCHANT = `0x${"00".repeat(20)}` as const;

const eventId = (event: {block: {number: bigint}; log: {logIndex: number}}): string =>
  `${event.block.number}-${event.log.logIndex}`;

/** What reduced the borrower's balance. `void` is the whole plan; `refund` is a part. */
export type RefundKind = "refund" | "void";

// ─── What came back ───────────────────────────────────────────────────────────

/**
 * A refund credited against a live plan.
 *
 * Append-only rather than a running total, because a merchant reconciling a return
 * needs the individual credit that matches their own refund record. A netted figure
 * cannot be matched against anything, and "the totals agree" is not the question a
 * merchant is asking when they open the dashboard about one order.
 *
 * Distinct from `InstallmentPlan:RefundCredited`, which `index.ts` handles and which
 * moves the plan's own outstanding balance. Both fire for one refund and both are
 * wanted: the plan's row is the borrower's remaining debt, this row is the merchant's
 * ledger entry. Same fact, two readers, two questions.
 */
ponder.on("RefundEscrow:RefundCredited", async ({event, context}) => {
  const source = await context.db.find(origination, {planId: event.args.planId});

  await context.db
    .insert(refund)
    .values({
      id: eventId(event),
      planId: event.args.planId,
      merchant: source?.merchant ?? UNKNOWN_MERCHANT,
      amount: event.args.amount,
      kind: "refund" satisfies RefundKind,
      blockNumber: event.block.number,
      timestamp: Number(event.block.timestamp),
    })
    .onConflictDoNothing();
});

/**
 * The whole plan, cancelled.
 *
 * `PlanVoided` carries no amount — the escrow voids by calling the plan, and the plan
 * is the authority on what was outstanding. So the row carries zero and says `void`,
 * and a reconciliation that wants the figure reads the plan's own state rather than
 * trusting a number this handler would have had to invent.
 */
ponder.on("RefundEscrow:PlanVoided", async ({event, context}) => {
  const source = await context.db.find(origination, {planId: event.args.planId});

  await context.db
    .insert(refund)
    .values({
      id: eventId(event),
      planId: event.args.planId,
      merchant: source?.merchant ?? UNKNOWN_MERCHANT,
      amount: 0n,
      kind: "void" satisfies RefundKind,
      blockNumber: event.block.number,
      timestamp: Number(event.block.timestamp),
    })
    .onConflictDoNothing();
});

// ─── What it cost the merchant ────────────────────────────────────────────────

/**
 * An adjudicated dispute took the merchant's bond and paid it to the pool's reserve.
 *
 * An accumulator, because a merchant can be slashed more than once and the question a
 * risk desk asks is the total. The per-dispute detail stays on chain in the
 * `BondSlashedToReserve` log, which is where an adjudication would read it.
 */
ponder.on("RefundEscrow:BondSlashedToReserve", async ({event, context}) => {
  await context.db
    .insert(merchant)
    .values({
      address: event.args.merchant,
      registeredAt: Number(event.block.timestamp),
      slashedToReserve: event.args.amount,
    })
    .onConflictDoUpdate((row) => ({
      slashedToReserve: row.slashedToReserve + event.args.amount,
    }));
});

/**
 * The merchant's settlement category, as it reads **now**.
 *
 * The current value only, and that is the whole meaning of the column. A plan's
 * settlement route was decided by the category as it read at origination and stamped
 * onto the escrow row (D-06), so this says what the merchant's next plan will do and
 * never what a past one did. Reading it to interpret a settled plan would answer a
 * question about then with a fact about today.
 */
ponder.on("MerchantRegistry:SettlementCategoryChanged", async ({event, context}) => {
  await context.db
    .insert(merchant)
    .values({
      address: event.args.merchant,
      registeredAt: Number(event.block.timestamp),
      settlementCategory: event.args.category,
    })
    .onConflictDoUpdate(() => ({settlementCategory: event.args.category}));
});
