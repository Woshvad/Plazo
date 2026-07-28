/**
 * Indexer tables — the `chain` half of the storage split.
 *
 * Everything here is reproducible from the chain alone. No column identifies a
 * borrower, because no event does: the plan-to-borrower mapping lives in the
 * `operator` schema, behind the consent gate, where a correction or a deletion can
 * actually be honoured. `planId` is the only join key between the two, and it is
 * exactly what a deletion request severs.
 *
 * `@plazo/events` `checkSchemaSeparation` runs over these definitions in CI.
 */
import {index, onchainTable, primaryKey} from "ponder";

export const plan = onchainTable(
  "plan",
  (t) => ({
    planId: t.hex().primaryKey(),
    address: t.hex().notNull(),
    implementation: t.hex().notNull(),
    /** `IInstallmentPlan.PlanState` ordinal. */
    state: t.integer().notNull().default(0),
    installmentCount: t.integer().notNull().default(0),
    /** 6-decimal USDC. Stored as bigint; never a float. */
    principal: t.bigint().notNull().default(0n),
    outstandingPrincipal: t.bigint().notNull().default(0n),
    totalCollected: t.bigint().notNull().default(0n),
    feesOutstanding: t.bigint().notNull().default(0n),
    refundCredit: t.bigint().notNull().default(0n),
    lateFee: t.bigint().notNull().default(0n),
    originatedAtBlock: t.bigint().notNull(),
    originatedAt: t.integer().notNull(),
    /** Origination cohort as `YYYY-MM`, for loss calibration. */
    cohort: t.text().notNull(),
    chargedOff: t.boolean().notNull().default(false),
    repaidAt: t.integer(),
  }),
  (table) => ({
    stateIdx: index().on(table.state),
    cohortIdx: index().on(table.cohort),
  }),
);

export const installment = onchainTable(
  "installment",
  (t) => ({
    planId: t.hex().notNull(),
    index: t.integer().notNull(),
    /** `IInstallmentPlan.InstallmentStatus` ordinal. */
    status: t.integer().notNull().default(0),
    amount: t.bigint().notNull().default(0n),
    dueDate: t.integer().notNull().default(0),
    graceEndsAt: t.integer().notNull().default(0),
    clearedAt: t.integer(),
    /** Who cranked it. The keeper-market share is measured from this column. */
    keeper: t.hex(),
    /** `IInstallmentPlan.BounceReason` ordinal, when the last attempt bounced. */
    bounceReason: t.integer().notNull().default(0),
    bounceCount: t.integer().notNull().default(0),
    markedBy: t.hex(),
    markedAt: t.integer(),
  }),
  (table) => ({
    pk: primaryKey({columns: [table.planId, table.index]}),
    dueIdx: index().on(table.dueDate),
    statusIdx: index().on(table.status),
  }),
);

/**
 * Every collection attempt, successful or not.
 *
 * Kept as an append-only log rather than folded into `installment`, because the
 * measurable claim — what share of collections were cranked by someone other than
 * the operator — needs the attempts, not the outcomes.
 */
export const collectionAttempt = onchainTable(
  "collection_attempt",
  (t) => ({
    id: t.text().primaryKey(),
    planId: t.hex().notNull(),
    installmentIndex: t.integer().notNull(),
    keeper: t.hex().notNull(),
    succeeded: t.boolean().notNull(),
    bounceReason: t.integer().notNull().default(0),
    amount: t.bigint().notNull().default(0n),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    keeperIdx: index().on(table.keeper),
    planIdx: index().on(table.planId),
  }),
);

export const planStateTransition = onchainTable(
  "plan_state_transition",
  (t) => ({
    id: t.text().primaryKey(),
    planId: t.hex().notNull(),
    fromState: t.integer().notNull(),
    toState: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    planIdx: index().on(table.planId),
  }),
);

/**
 * Rolling keeper-market health.
 *
 * "The operator is redundant" is a claim, and this table is what makes it a
 * measurement. If `operatorCollections / totalCollections` does not fall, the
 * permissionless path is documented rather than exercised.
 */
export const keeperStats = onchainTable("keeper_stats", (t) => ({
  keeper: t.hex().primaryKey(),
  collections: t.integer().notNull().default(0),
  marks: t.integer().notNull().default(0),
  bountyEarned: t.bigint().notNull().default(0n),
  firstSeenAt: t.integer().notNull(),
  lastSeenAt: t.integer().notNull(),
  isOperator: t.boolean().notNull().default(false),
}));
