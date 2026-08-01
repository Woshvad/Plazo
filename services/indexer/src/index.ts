/**
 * Indexing handlers over the frozen event schema.
 *
 * Two things are worth stating up front, because they explain most of the shape.
 *
 * **No handler writes a borrower address.** None of them could — no plan event
 * carries one. The plan-to-borrower mapping lives in the operator schema behind the
 * consent gate, and `planId` is the only join key between the two. That is what makes
 * a deletion request something the operator can actually honour rather than something
 * they have to explain they cannot.
 *
 * **Every collection attempt is recorded, successful or not.** The claim this project
 * has to be able to defend is that collections do not depend on the operator, and the
 * measurable version of it is the share of cranks sent by addresses that are not
 * ours. That needs attempts, not outcomes: a keeper who tries and bounces is still a
 * keeper, and a book where only the operator ever tries is a book with an operator
 * dependency it has not admitted to.
 */
import {ponder} from "ponder:registry";
import {collectionAttempt, installment, keeperStats, plan, planStateTransition} from "ponder:schema";

/** Addresses the operator controls, so the keeper-market share means something. */
const OPERATOR_ADDRESSES = new Set(
  (process.env["PLAZO_OPERATOR_ADDRESSES"] ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),
);

const isOperator = (address: string): boolean => OPERATOR_ADDRESSES.has(address.toLowerCase());

const cohortOf = (timestamp: number): string => {
  const date = new Date(timestamp * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

const PLAN_VIEW_ABI = [
  {type: "function", name: "principal", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
  {
    type: "function",
    name: "installmentCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {type: "function", name: "lateFee", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
  {
    type: "function",
    name: "installmentAmount",
    stateMutability: "view",
    inputs: [{type: "uint256"}],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "dueDate",
    stateMutability: "view",
    inputs: [{type: "uint256"}],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "graceEndsAt",
    stateMutability: "view",
    inputs: [{type: "uint256"}],
    outputs: [{type: "uint256"}],
  },
] as const;

/**
 * A plan's schedule is read once, at origination, and never again.
 *
 * The schedule cannot change: `firstDueDate`, `interval` and `installmentCount` are
 * all inside the `planId` preimage, and the jitter derives from `planId` itself. So
 * one read per plan is complete rather than merely cheap — re-reading would produce
 * the same answer and cost the RPC another round trip on an endpoint that sheds a
 * quarter of what it is asked.
 */
ponder.on("PlanFactory:PlanDeployed", async ({event, context}) => {
  const address = event.args.plan;
  const timestamp = Number(event.block.timestamp);

  const [principal, count, lateFee] = await Promise.all([
    context.client.readContract({address, abi: PLAN_VIEW_ABI, functionName: "principal"}),
    context.client.readContract({address, abi: PLAN_VIEW_ABI, functionName: "installmentCount"}),
    context.client.readContract({address, abi: PLAN_VIEW_ABI, functionName: "lateFee"}),
  ]);

  await context.db.insert(plan).values({
    planId: event.args.planId,
    address,
    implementation: event.args.implementation,
    state: 0,
    installmentCount: Number(count),
    principal,
    outstandingPrincipal: principal,
    lateFee,
    originatedAtBlock: event.block.number,
    originatedAt: timestamp,
    cohort: cohortOf(timestamp),
  });

  for (let index = 0; index < Number(count); index++) {
    const [amount, dueDate, graceEndsAt] = await Promise.all([
      context.client.readContract({
        address,
        abi: PLAN_VIEW_ABI,
        functionName: "installmentAmount",
        args: [BigInt(index)],
      }),
      context.client.readContract({
        address,
        abi: PLAN_VIEW_ABI,
        functionName: "dueDate",
        args: [BigInt(index)],
      }),
      context.client.readContract({
        address,
        abi: PLAN_VIEW_ABI,
        functionName: "graceEndsAt",
        args: [BigInt(index)],
      }),
    ]);

    await context.db.insert(installment).values({
      planId: event.args.planId,
      index,
      status: 0,
      amount,
      dueDate: Number(dueDate),
      graceEndsAt: Number(graceEndsAt),
      bounceReason: 0,
      bounceCount: 0,
    });
  }
});

/**
 * A keeper's first row, and how to fold a later one into it.
 *
 * Split into two plain values rather than a helper function because the handler's
 * `db` is a generated type: threading it through a signature costs more in type
 * gymnastics than the duplication saves, and the duplication is four call sites of
 * two lines.
 */
function keeperRow(address: `0x${string}`, timestamp: number, delta: KeeperDelta) {
  return {
    keeper: address,
    collections: delta.collections ?? 0,
    marks: delta.marks ?? 0,
    bountyEarned: delta.bounty ?? 0n,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    isOperator: isOperator(address),
  };
}

interface KeeperDelta {
  collections?: number;
  marks?: number;
  bounty?: bigint;
}

function keeperMerge(timestamp: number, delta: KeeperDelta) {
  return (row: {collections: number; marks: number; bountyEarned: bigint}) => ({
    collections: row.collections + (delta.collections ?? 0),
    marks: row.marks + (delta.marks ?? 0),
    bountyEarned: row.bountyEarned + (delta.bounty ?? 0n),
    lastSeenAt: timestamp,
  });
}

ponder.on("InstallmentPlan:CheckCleared", async ({event, context}) => {
  const timestamp = Number(event.block.timestamp);
  const keeper = event.args.keeper;

  await context.db
    .update(installment, {planId: event.args.planId, index: Number(event.args.index)})
    .set({status: 1, clearedAt: timestamp, keeper, bounceReason: 0});

  await context.db.insert(collectionAttempt).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    planId: event.args.planId,
    installmentIndex: Number(event.args.index),
    keeper,
    succeeded: true,
    bounceReason: 0,
    amount: event.args.amount,
    blockNumber: event.block.number,
    timestamp,
  });

  await context.db
    .update(plan, {planId: event.args.planId})
    .set((row) => ({totalCollected: row.totalCollected + event.args.amount}));

  await context.db
    .insert(keeperStats)
    .values(keeperRow(keeper, timestamp, {collections: 1}))
    .onConflictDoUpdate(keeperMerge(timestamp, {collections: 1}));
});

/**
 * A bounce carries no keeper — the frozen schema gives it `planId`, `index` and a
 * typed reason, and nothing else. The sender comes from the transaction instead,
 * which is the more honest figure anyway: it records who paid to try.
 */
ponder.on("InstallmentPlan:CheckBounced", async ({event, context}) => {
  const timestamp = Number(event.block.timestamp);
  const sender = event.transaction.from;

  await context.db
    .update(installment, {planId: event.args.planId, index: Number(event.args.index)})
    .set((row) => ({
      status: 2,
      bounceReason: event.args.reason,
      bounceCount: row.bounceCount + 1,
    }));

  await context.db.insert(collectionAttempt).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    planId: event.args.planId,
    installmentIndex: Number(event.args.index),
    keeper: sender,
    succeeded: false,
    bounceReason: event.args.reason,
    amount: 0n,
    blockNumber: event.block.number,
    timestamp,
  });

  await context.db
    .insert(keeperStats)
    .values(keeperRow(sender, timestamp, {}))
    .onConflictDoUpdate(keeperMerge(timestamp, {}));
});

ponder.on("InstallmentPlan:CheckMissed", async ({event, context}) => {
  const timestamp = Number(event.block.timestamp);
  await context.db
    .update(installment, {planId: event.args.planId, index: Number(event.args.index)})
    .set({status: 3, markedBy: event.args.marker, markedAt: timestamp});
  await context.db
    .insert(keeperStats)
    .values(keeperRow(event.args.marker, timestamp, {marks: 1}))
    .onConflictDoUpdate(keeperMerge(timestamp, {marks: 1}));
});

ponder.on("InstallmentPlan:CheckExpired", async ({event, context}) => {
  const timestamp = Number(event.block.timestamp);
  await context.db
    .update(installment, {planId: event.args.planId, index: Number(event.args.index)})
    .set({status: 4, markedBy: event.args.marker, markedAt: timestamp});
  await context.db
    .insert(keeperStats)
    .values(keeperRow(event.args.marker, timestamp, {marks: 1}))
    .onConflictDoUpdate(keeperMerge(timestamp, {marks: 1}));
});

ponder.on("InstallmentPlan:PlanStateChanged", async ({event, context}) => {
  await context.db.insert(planStateTransition).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    planId: event.args.planId,
    fromState: event.args.from,
    toState: event.args.to,
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
  });

  await context.db.update(plan, {planId: event.args.planId}).set({state: event.args.to});
});

ponder.on("InstallmentPlan:PlanDelinquent", async ({event, context}) => {
  await context.db
    .update(plan, {planId: event.args.planId})
    .set({feesOutstanding: event.args.lateFee});
});

ponder.on("InstallmentPlan:PlanCured", async ({event, context}) => {
  await context.db.update(plan, {planId: event.args.planId}).set({feesOutstanding: 0n});
});

ponder.on("InstallmentPlan:PlanRepaid", async ({event, context}) => {
  await context.db.update(plan, {planId: event.args.planId}).set({
    outstandingPrincipal: 0n,
    feesOutstanding: 0n,
    repaidAt: Number(event.block.timestamp),
  });
});

ponder.on("InstallmentPlan:PlanChargedOff", async ({event, context}) => {
  await context.db.update(plan, {planId: event.args.planId}).set({chargedOff: true});
});

ponder.on("InstallmentPlan:RefundCredited", async ({event, context}) => {
  await context.db.update(plan, {planId: event.args.planId}).set((row) => ({
    refundCredit: row.refundCredit + event.args.amount,
    outstandingPrincipal:
      row.outstandingPrincipal > event.args.amount
        ? row.outstandingPrincipal - event.args.amount
        : 0n,
  }));
});

/**
 * The origination plane's handlers.
 *
 * Imported for side effects — `ponder.on` registers on call — and kept in a separate
 * module because the two planes answer different questions. This file is "what
 * happened to a plan"; `origination.ts` is "what the book did about it".
 */
import "./origination.js";
import "./capital.js";
