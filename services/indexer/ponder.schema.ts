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

// ─── The origination plane (Phase 3) ──────────────────────────────────────────

/**
 * What a plan cost and who was paid, at the moment it was created.
 *
 * Separate from `plan` rather than folded into it because these are settlement
 * facts a merchant reconciles against, and they never change: a plan's state moves
 * for years, its origination does not. Keeping them apart means a merchant's
 * statement is a read of immutable rows.
 *
 * No borrower column, for the same reason as everywhere else — the event does not
 * carry one, and `planId` is the only join key into the operator schema.
 */
export const origination = onchainTable(
  "origination",
  (t) => ({
    planId: t.hex().primaryKey(),
    merchant: t.hex().notNull(),
    principal: t.bigint().notNull(),
    mdr: t.bigint().notNull(),
    /** Diverted into the merchant's own bond while they are new. */
    withheld: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
    cohort: t.text().notNull(),
  }),
  (table) => ({
    merchantIdx: index().on(table.merchant),
    cohortIdx: index().on(table.cohort),
  }),
);

/**
 * Every credit decision that reached the chain, as a band.
 *
 * Keyed by session rather than by plan, and deliberately not joined to one. The band
 * exists so an operator can see that a signing key is issuing an anomalous
 * distribution and an allocator can see the book's shape; neither needs to know which
 * borrower got which band, and a table that could answer that would be a table an
 * operator could be compelled to produce.
 *
 * A session with a row here and no matching origination is its own signal: a decision
 * was made and the borrower walked away.
 */
export const attestation = onchainTable(
  "attestation",
  (t) => ({
    sessionId: t.hex().primaryKey(),
    band: t.integer().notNull(),
    attestor: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    attestorIdx: index().on(table.attestor),
    bandIdx: index().on(table.band),
  }),
);

/**
 * Merchant standing, as the chain reports it.
 *
 * `outstandingFronted` and `requiredBond` are the pair that matters: the fraud
 * posture is that a merchant's skin is proportional to what they could currently
 * walk away with, and a dashboard that showed one without the other would be
 * showing half a control.
 */
export const merchant = onchainTable("merchant", (t) => ({
  address: t.hex().primaryKey(),
  kybVerified: t.boolean().notNull().default(false),
  bond: t.bigint().notNull().default(0n),
  /** The part of `bond` that arrived by settlement withholding rather than deposit. */
  withheld: t.bigint().notNull().default(0n),
  outstandingFronted: t.bigint().notNull().default(0n),
  requiredBond: t.bigint().notNull().default(0n),
  registeredAt: t.integer().notNull(),
  originations: t.integer().notNull().default(0),
  principalOriginated: t.bigint().notNull().default(0n),
}));

/**
 * The funding book's own view of one plan.
 *
 * Written by the permissionless recognition crank, so a stale row means nobody has
 * cranked rather than that the pool is wrong. That distinction is worth preserving
 * in the data: `lastRecognisedAt` is how an LP tells "no news" from "no crank".
 */
export const bookEntry = onchainTable(
  "book_entry",
  (t) => ({
    planId: t.hex().primaryKey(),
    merchant: t.hex().notNull(),
    principal: t.bigint().notNull(),
    /** Cash the plan has forwarded and the book has counted. */
    recognisedInflow: t.bigint().notNull().default(0n),
    principalRecovered: t.bigint().notNull().default(0n),
    incomeEarned: t.bigint().notNull().default(0n),
    lossAbsorbed: t.bigint().notNull().default(0n),
    fromReserve: t.bigint().notNull().default(0n),
    fromJunior: t.bigint().notNull().default(0n),
    fromSenior: t.bigint().notNull().default(0n),
    /** Seen past grace with nothing recorded, as of the last crank. */
    unmarked: t.boolean().notNull().default(false),
    lastRecognisedAt: t.integer(),
  }),
  (table) => ({
    merchantIdx: index().on(table.merchant),
    unmarkedIdx: index().on(table.unmarked),
  }),
);

/**
 * The origination gate, every time it moved.
 *
 * POOL-06's constraint made visible to LPs in real time. An append-only log rather
 * than a current-value row, because "when did the book close and for how long" is
 * the question an allocator asks and a single row cannot answer it.
 */
export const gateReading = onchainTable(
  "gate_reading",
  (t) => ({
    id: t.text().primaryKey(),
    open: t.boolean().notNull(),
    subordinationBps: t.bigint().notNull(),
    reserveBps: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    timeIdx: index().on(table.timestamp),
  }),
);

/**
 * Every first-payment observation, and the throttle it produced.
 *
 * The kill switch's whole input, and the cohort recalibration track's whole raw
 * material. `seasoned` is frozen at origination rather than read at observation,
 * which is why it is stored rather than derived.
 */
export const firstPaymentObservation = onchainTable(
  "first_payment_observation",
  (t) => ({
    planId: t.hex().primaryKey(),
    defaulted: t.boolean().notNull(),
    seasoned: t.boolean().notNull(),
    observer: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
    cohort: t.text().notNull(),
  }),
  (table) => ({
    cohortIdx: index().on(table.cohort),
    defaultedIdx: index().on(table.defaulted),
  }),
);

export const throttleReading = onchainTable(
  "throttle_reading",
  (t) => ({
    id: t.text().primaryKey(),
    throttleBps: t.bigint().notNull(),
    fpdBps: t.bigint().notNull(),
    cohortSize: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    timeIdx: index().on(table.timestamp),
  }),
);

/**
 * Every parameter recalibration, with what it was.
 *
 * The bands are hard-coded and can only be narrowed, so this table plus the deployed
 * bytecode is the complete record of what governance was ever able to do. An
 * operator console reads it; so does anyone deciding whether to lend.
 */
export const parameterChange = onchainTable(
  "parameter_change",
  (t) => ({
    id: t.text().primaryKey(),
    key: t.hex().notNull(),
    previous: t.bigint().notNull(),
    value: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    keyIdx: index().on(table.key),
  }),
);

/**
 * The pause plane, every time it moved.
 *
 * Worth an append-only log for the same reason as the gate: an incident is a
 * duration, and a current-value row cannot describe one after it ends.
 */
export const pauseEvent = onchainTable(
  "pause_event",
  (t) => ({
    id: t.text().primaryKey(),
    /** Zero for the global switch. */
    corridor: t.hex().notNull(),
    paused: t.boolean().notNull(),
    by: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    timeIdx: index().on(table.timestamp),
  }),
);
