/**
 * The credit ladder, indexed — and the six events it deliberately does not index.
 *
 * Phase 7's underwriting contracts emit fifteen events. Nine are in `@plazo/events` v5 and
 * six are not, and the omission is the design rather than a gap in it. The rule the schema
 * draws, and this file obeys: **an event that joins a wallet to a `planId` is a credit
 * file the moment it is materialised into a queryable table.**
 *
 * - `PledgeVault.PledgeBound`, `.PledgeUnbound`, `.PledgeSeized` each pair an indexed
 *   `planId` with an indexed wallet — and on the only production path that emits them,
 *   `TieredUnderwriter.bindPlan` passes the same address it computed the offer for
 *   straight through as the pledger. `PledgeSeized` is a default record keyed by wallet.
 * - `PayrollSweeper.SweepOptedIn`, `.SweepOptedOut`, `.Swept` do the same, and the two
 *   consent events move no money at all, so a table of them would be a wallet-keyed
 *   register of who is on salary deduction that exists nowhere else.
 *
 * None of the six is in the schema, so none can be subscribed to, so none has a handler
 * here. What is left keys on a wallet with no plan (`pledgePosition`, `pledgeEvent`) or on
 * a plan with no wallet (`tierOrigination`, `sweepEvent`), and never both.
 *
 * ## Two consequences worth stating rather than leaving to be discovered
 *
 * **The sweep stream is derived from `CheckCleared`.** A sweep settles its installment
 * through `InstallmentPlan.repay`, so the plan emits `CheckCleared(planId, index, amount,
 * keeper)` with the sweeper's contract address in `keeper`. `recordSweep` is called from
 * the existing `CheckCleared` handler in `index.ts` — one handler per event is Ponder's
 * rule and also the right shape, since this is one fact seen through one lens rather than
 * two events. The only field lost against `Swept` is `residue`, which is the payer's own
 * change coming back to them in a `Transfer` in the same transaction.
 *
 * **`pledgePosition` has no locked column.** The lock is `lockedOf(pledger)`, a public
 * getter and the live truth. Accumulating a copy here would need `PledgeBound` and
 * `PledgeUnbound` — excluded — and would produce a second number that can drift from the
 * first. Every column below is either an event's own value or a sum of values from one
 * event type, and every write is idempotent on a writer-chosen id (DEC-58), so a replay
 * is a no-op rather than a double count.
 */
import {ponder} from "ponder:registry";

import {pledgeEvent, pledgePosition, sweepEvent, tierOrigination} from "ponder:schema";

import {PAYROLL_SWEEPER} from "../ponder.config.js";
import {isPayrollSweep, logId, type PledgeKind} from "./corridor.js";

// ─────────────────────────────────────────────────────────────────────────────
// The pledge vault (UW-06) — a wallet, never a plan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One pledge log row.
 *
 * `kind` is constrained by `PledgeKind` in TypeScript rather than by a database-level
 * enum (DEC-57): such a type has to be altered before a value can be added, and that
 * alter is the statement that breaks a cross-service push.
 */
const recordPledgeEvent = async (
  db: {insert: (table: typeof pledgeEvent) => {values: (v: Record<string, unknown>) => {onConflictDoNothing: () => Promise<unknown>}}},
  row: {
    kind: PledgeKind;
    account: `0x${string}`;
    amount: bigint;
    shares: bigint;
    txHash: `0x${string}`;
    logIndex: number;
    blockNumber: bigint;
    timestamp: number;
  },
): Promise<void> => {
  await db
    .insert(pledgeEvent)
    .values({
      id: logId(row.txHash, row.logIndex),
      kind: row.kind,
      account: row.account,
      amount: row.amount,
      shares: row.shares,
      blockNumber: row.blockNumber,
      txHash: row.txHash,
      timestamp: row.timestamp,
    })
    .onConflictDoNothing();
};

ponder.on("PledgeVault:Pledged", async ({event, context}) => {
  const timestamp = Number(event.block.timestamp);

  await recordPledgeEvent(context.db as never, {
    kind: "pledged",
    account: event.args.pledger,
    amount: event.args.amount,
    shares: event.args.shares,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    blockNumber: event.block.number,
    timestamp,
  });

  await context.db
    .insert(pledgePosition)
    .values({
      id: event.args.pledger.toLowerCase() as `0x${string}`,
      totalPledged: event.args.amount,
      sharesHeld: event.args.shares,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate((row) => ({
      totalPledged: row.totalPledged + event.args.amount,
      sharesHeld: row.sharesHeld + event.args.shares,
      updatedAt: timestamp,
    }));
});

ponder.on("PledgeVault:Released", async ({event, context}) => {
  const timestamp = Number(event.block.timestamp);

  await recordPledgeEvent(context.db as never, {
    kind: "released",
    account: event.args.pledger,
    amount: event.args.amount,
    shares: event.args.shares,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    blockNumber: event.block.number,
    timestamp,
  });

  await context.db
    .insert(pledgePosition)
    .values({
      id: event.args.pledger.toLowerCase() as `0x${string}`,
      totalReleased: event.args.amount,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate((row) => ({
      totalReleased: row.totalReleased + event.args.amount,
      // Clamped: a release of shares the row never saw would otherwise go negative and
      // read as a debt. It cannot happen from a complete stream; it can happen from a
      // range that began after the pledge.
      sharesHeld: row.sharesHeld > event.args.shares ? row.sharesHeld - event.args.shares : 0n,
      updatedAt: timestamp,
    }));
});

/**
 * DEC-95. The accrual that makes "the pledge keeps earning while it is locked" observable.
 *
 * `from` is the funder, not a pledger, and it is stored on the log row rather than on a
 * position: yield paid into the vault raises every holder's claim pro rata, so attributing
 * it to one address would be wrong in exactly the way the vault is designed not to be.
 * `shares` carries `totalAssets` after the payment — the number that, held against the
 * locked total, is the yield a pledger may withdraw without weakening their collateral.
 */
ponder.on("PledgeVault:YieldPaid", async ({event, context}) => {
  await recordPledgeEvent(context.db as never, {
    kind: "yieldPaid",
    account: event.args.from,
    amount: event.args.amount,
    shares: event.args.totalAssets,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The tier composite (UW-07) — a plan, never a wallet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The whole event, and the whole table.
 *
 * `planId`, tier and principal are all `TieredOrigination` carries: no person id, no
 * wallet, and none of the inputs the tier was computed from. That is UW-07's boundary, and
 * it makes the tier mix of the book measurable without making its counterparties
 * enumerable.
 */
ponder.on("TieredUnderwriter:TieredOrigination", async ({event, context}) => {
  await context.db
    .insert(tierOrigination)
    .values({
      id: event.args.planId,
      tier: event.args.tier,
      principal: event.args.principal,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
      timestamp: Number(event.block.timestamp),
    })
    .onConflictDoNothing();
});

// ─────────────────────────────────────────────────────────────────────────────
// The sweep stream — derived, because the sweeper's own events are not indexable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a collection that a payroll sweeper cranked.
 *
 * Called from the `CheckCleared` handler in `index.ts` rather than registered as a second
 * handler: Ponder allows one handler per event name, and a sweep is one fact seen through
 * the plan's own lens rather than a second event. A collection by any other keeper is not
 * a sweep and writes nothing.
 *
 * The id is the log's coordinates, so a replay overwrites rather than doubles.
 */
export const recordSweep = async (
  db: {
    insert: (table: typeof sweepEvent) => {
      values: (v: Record<string, unknown>) => {onConflictDoNothing: () => Promise<unknown>};
    };
  },
  collection: {
    planId: `0x${string}`;
    index: number;
    value: bigint;
    keeper: `0x${string}`;
    txHash: `0x${string}`;
    logIndex: number;
    blockNumber: bigint;
    timestamp: number;
  },
): Promise<boolean> => {
  if (!isPayrollSweep(collection.keeper, PAYROLL_SWEEPER)) return false;

  await db
    .insert(sweepEvent)
    .values({
      id: logId(collection.txHash, collection.logIndex),
      planId: collection.planId,
      index: collection.index,
      value: collection.value,
      sweeper: collection.keeper,
      blockNumber: collection.blockNumber,
      txHash: collection.txHash,
      timestamp: collection.timestamp,
    })
    .onConflictDoNothing();

  return true;
};
