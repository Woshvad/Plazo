/**
 * Indexing handlers for the settlement plane — where a merchant's money went.
 *
 * ## Reorgs are somebody else's problem
 *
 * Arc has deterministic single-slot finality under Malachite BFT and zero reorgs, so
 * there is no rollback path in this file to get wrong. Every write below is a
 * once-and-final fact; nothing here has to be undoable, and nothing tries to be.
 *
 * ## Why the payout adapter's events cannot write a payout row on their own
 *
 * `PayoutRouter` deliberately knows nothing about plans (DEC-36). Its four events carry
 * a token, a recipient, a domain and an amount, and that is the whole vocabulary: a
 * payout contract that also had to be told the `planId` and the `mdr` would be a
 * contract that could misreport them, and `dispatch()` is permissionless precisely so
 * that nobody has to trust it. One `dispatch()` also drains a `(token, recipient,
 * domain)` queue that may hold several plans' settlements at once, so there is no
 * one-to-one mapping to hand back even in principle.
 *
 * So the plane is indexed at two levels and stitched afterwards:
 *
 * - `payoutDispatch` is the **route** ledger, one append-only row per adapter event,
 *   keyed by the log that produced it and carrying the transaction hash. This is what
 *   the attestation poller reads, and the transaction hash is the join to Circle's
 *   ledger because a CCTP v2 burn emits a zero nonce and the real `eventNonce` only
 *   comes back from Iris at attestation (DEC-31, finding 28).
 * - `payout` is the **plan** ledger, one row per settlement, whose money columns are
 *   written by `CheckoutRouter.OriginationCompleted` — the one contract that computed
 *   them — and whose status is moved by the events that carry a `planId`.
 *
 * ## The ordering that makes the stitch work
 *
 * `CheckoutRouter._settleMerchant` runs *before* `emit OriginationCompleted`
 * (`CheckoutRouter.sol:226` then `:229`), so within an origination transaction the
 * adapter's and the escrow's logs always arrive at a lower log index than the
 * origination's. Ponder replays a transaction's logs in index order, which means the
 * origination handler can look back at what settlement did and never has to look
 * forward. Reversing those two lines in the contract would silently break this file,
 * which is why the dependency is written down here rather than assumed.
 *
 * The look-back matches on **amount and log index**, not on "the last row with this
 * transaction hash". A batch that originated two plans in one transaction would put
 * two adapter logs under one hash, and taking the last would give the second plan's
 * route to the first. Matching `amount === payable` below the origination's own log
 * index is exact for the batch of one that ships today and stays exact if that changes.
 *
 * ## No borrower, anywhere
 *
 * None of these events carries one, and none could. `carrierRef` is a `bytes32`
 * commitment: a tracking number is a delivery address by proxy, and a queryable column
 * holding one is a borrower's home address for anyone who can ask a carrier.
 */
import {ponder} from "ponder:registry";
import type {Context} from "ponder:registry";
import {eq} from "ponder";
import {payout, payoutDispatch, settlementEscrow} from "ponder:schema";

import {
  ARC_DOMAIN,
  cohortOf,
  dispatchRow,
  netOf,
  planIdsClosedOutBy,
  settlementLogFor,
  statusFromDispatch,
  ZERO_ADDRESS,
  type DispatchKind,
} from "./settlement.js";

/**
 * Re-exported so a reader chasing a merchant's money finds the whole plane through one
 * module, even though the semantics live next door where a test can reach them.
 */
export * from "./settlement.js";

// ─── The route ledger ─────────────────────────────────────────────────────────

ponder.on("PayoutRouter:PaidOut", async ({event, context}) => {
  await context.db.insert(payoutDispatch).values(dispatchRow("paid", event)).onConflictDoNothing();
});

ponder.on("PayoutRouter:PayoutQueued", async ({event, context}) => {
  await context.db.insert(payoutDispatch).values(dispatchRow("queued", event)).onConflictDoNothing();
});

/**
 * The burn went out, and every plan waiting on that route is now waiting on Circle.
 *
 * `dispatchTxHash` is written and `txHash` is left alone. The origination transaction
 * is the merchant's key back to their own order; the burn transaction is Circle's key
 * to the attestation. A settlement that went through the queue has both, and a row that
 * kept only the newer one would have lost the sale.
 */
ponder.on("PayoutRouter:PayoutDispatched", async ({event, context}) => {
  await context.db
    .insert(payoutDispatch)
    .values(dispatchRow("dispatched", event))
    .onConflictDoNothing();

  const open = await context.db.sql.select().from(payout).where(eq(payout.status, "queued"));

  for (const planId of planIdsClosedOutBy(open, event.args)) {
    await context.db
      .update(payout, {planId: planId as `0x${string}`})
      .set({status: "dispatched", dispatchTxHash: event.transaction.hash});
  }
});

// ─── The plan ledger ──────────────────────────────────────────────────────────

/**
 * The money columns, written once, by the contract that computed them.
 *
 * Called from `origination.ts`'s `OriginationCompleted` handler rather than registered
 * here, because Ponder permits exactly one handler per event and the origination plane
 * already owns that one. Keeping the settlement half in this file is the point: a
 * reader looking for what happened to a merchant's money finds all of it here.
 *
 * The status is written **only** when this handler learned the route itself. A held
 * settlement has already had `SettlementHeld` say `escrowed` at a lower log index in
 * this same transaction, and clobbering that would report money the merchant cannot
 * touch as money they have been paid.
 */
export async function recordSettlement(
  db: Context["db"],
  args: {
    planId: `0x${string}`;
    merchant: `0x${string}`;
    principal: bigint;
    mdr: bigint;
    withheld: bigint;
    txHash: `0x${string}`;
    logIndex: number;
    blockNumber: bigint;
    timestamp: number;
  },
): Promise<void> {
  const net = netOf(args.principal, args.mdr, args.withheld);
  const held = await db.find(settlementEscrow, {planId: args.planId});

  const logs = held
    ? []
    : await db.sql.select().from(payoutDispatch).where(eq(payoutDispatch.txHash, args.txHash));

  const log = settlementLogFor(logs, {logIndex: args.logIndex, payable: net});
  const route = log
    ? {
        token: log.token,
        recipient: log.recipient,
        domain: log.domain,
        status: statusFromDispatch(log.kind as DispatchKind),
      }
    : undefined;

  await db
    .insert(payout)
    .values({
      planId: args.planId,
      merchant: args.merchant,
      token: route?.token ?? ZERO_ADDRESS,
      recipient: route?.recipient ?? null,
      domain: route?.domain ?? null,
      gross: args.principal,
      mdr: args.mdr,
      withheld: args.withheld,
      net,
      status: route?.status ?? (held ? "escrowed" : "settled"),
      txHash: args.txHash,
      blockNumber: args.blockNumber,
      timestamp: args.timestamp,
      cohort: cohortOf(args.timestamp),
    })
    .onConflictDoUpdate((row) => ({
      merchant: args.merchant,
      gross: args.principal,
      mdr: args.mdr,
      withheld: args.withheld,
      net,
      txHash: args.txHash,
      status: route?.status ?? row.status,
      ...(route ? {token: route.token, recipient: route.recipient, domain: route.domain} : {}),
    }));
}

// ─── The settlement escrow ────────────────────────────────────────────────────

/**
 * A settlement held against shipment (MERCH-04).
 *
 * Fires *before* `OriginationCompleted` in the origination transaction, so this handler
 * creates the `payout` row with zeroed money and the origination handler fills it in.
 * The row exists early on purpose: a held settlement that appeared in the ledger only
 * after the origination log would be invisible for the width of one transaction, and a
 * merchant reading mid-block would see a plan with no settlement at all.
 */
ponder.on("SettlementEscrow:SettlementHeld", async ({event, context}) => {
  const timestamp = Number(event.block.timestamp);

  await context.db
    .insert(settlementEscrow)
    .values({
      planId: event.args.planId,
      merchant: event.args.merchant,
      amount: event.args.amount,
      heldAt: timestamp,
      state: "held",
    })
    .onConflictDoNothing();

  await context.db
    .insert(payout)
    .values({
      planId: event.args.planId,
      merchant: event.args.merchant,
      token: ZERO_ADDRESS,
      status: "escrowed",
      txHash: event.transaction.hash,
      blockNumber: event.block.number,
      timestamp,
      cohort: cohortOf(timestamp),
    })
    .onConflictDoUpdate(() => ({status: "escrowed"}));
});

/**
 * The merchant's shipment claim.
 *
 * `carrierRef` is stored exactly as emitted and never resolved. It is a commitment, and
 * an indexer that dereferenced it would be putting a delivery address in a queryable
 * column — the one thing the whole storage split exists to prevent.
 */
ponder.on("SettlementEscrow:ShipmentAttested", async ({event, context}) => {
  await context.db.update(settlementEscrow, {planId: event.args.planId}).set({
    attestedAt: Number(event.block.timestamp),
    carrierRef: event.args.carrierRef,
    state: "attested",
  });
});

/**
 * The hold ended and the money went to the merchant's route.
 *
 * The status the release lands in is the same question the adapter answers at
 * origination, so it is answered the same way: settlement to Arc's own domain never
 * left the chain and is final, and settlement to anywhere else is queued until somebody
 * cranks `dispatch()`.
 */
ponder.on("SettlementEscrow:EscrowReleased", async ({event, context}) => {
  const timestamp = Number(event.block.timestamp);

  await context.db
    .update(settlementEscrow, {planId: event.args.planId})
    .set({releasedAt: timestamp, state: "released"});

  await context.db.update(payout, {planId: event.args.planId}).set({
    recipient: event.args.recipient,
    domain: event.args.domain,
    status: event.args.domain === ARC_DOMAIN ? "settled" : "queued",
  });
});

/**
 * The hold ended and the money went back to the pool.
 *
 * Emitted on every return whatever the cause, so this handler says nothing about why.
 * The one objective ground is `SettlementReturnedForNonAttestation`, indexed separately
 * below.
 */
ponder.on("SettlementEscrow:EscrowReturned", async ({event, context}) => {
  const timestamp = Number(event.block.timestamp);

  await context.db
    .update(settlementEscrow, {planId: event.args.planId})
    .set({returnedAt: timestamp, state: "returned"});

  await context.db.update(payout, {planId: event.args.planId}).set({status: "returned"});
});

/**
 * The one objective, operator-free ground for a dispute.
 *
 * Kept as its own column rather than inferred from `returnedAt`, because a return that
 * a merchant can be slashed over and one they cannot must not look alike in a table an
 * adjudication reads.
 */
ponder.on("SettlementEscrow:SettlementReturnedForNonAttestation", async ({event, context}) => {
  await context.db.update(settlementEscrow, {planId: event.args.planId}).set({nonAttested: true});
});

/**
 * `PayoutRouter:DomainDenied` is registered in the config and deliberately not handled
 * here.
 *
 * The route ledger's `kind` vocabulary is `paid | queued | dispatched` — three things
 * that moved money. A denial moved none, and giving it a row would make every
 * `sum(amount)` over the table need a predicate to stay correct. It is a governance
 * fact about a domain rather than a settlement fact about a merchant, and it belongs
 * with the pause plane if it is ever needed. Left unindexed on purpose, not forgotten.
 */
