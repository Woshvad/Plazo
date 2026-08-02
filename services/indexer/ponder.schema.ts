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
  /**
   * `MerchantRegistry.SettlementCategory` ordinal — 0 instant, 1 escrowed.
   *
   * The current value only. A plan's settlement route was decided by the category as
   * it read *at origination* and stamped onto the escrow row (D-06), so this column
   * says what the next plan will do and never what a past one did.
   */
  settlementCategory: t.integer().notNull().default(0),
  /** Bond taken by an adjudicated refund dispute and paid to the pool's reserve. */
  slashedToReserve: t.bigint().notNull().default(0n),
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

// ─────────────────────────────────────────────────────────────────────────────
// The merchant plane (Phase 6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One settlement, and where it got to.
 *
 * MERCH-08's row. `origination` already holds what a plan cost; this holds what
 * happened to the money afterwards — the route it took, the domain it went to, and
 * whether it has arrived. The two are kept apart for the same reason `origination` was
 * kept out of `plan`: an origination is immutable and a settlement is not, and folding
 * a moving value into a frozen row makes the frozen row look uncertain.
 *
 * **The money columns are written from `CheckoutRouter.OriginationCompleted`, not from
 * the payout adapter.** `PayoutRouter` deliberately knows nothing about plans (DEC-36):
 * its events carry a token, a recipient, a domain and an amount, and nothing else. A
 * payout contract that also had to be told the `planId` and the `mdr` would be one that
 * could misreport them. So the plan-level figures come from the contract that computed
 * them, and `txHash` is what stitches the two together for an origination-time payout.
 *
 * `recipient` and `domain` are nullable because they are not always known when the row
 * is created: an escrowed settlement announces its route only when the hold releases.
 *
 * No borrower column, as everywhere. `planId` is the only join key into the operator
 * schema, and a merchant's own order id lives on that side of the line (OPS-08, D-17).
 */
export const payout = onchainTable(
  "payout",
  (t) => ({
    planId: t.hex().primaryKey(),
    merchant: t.hex().notNull(),
    token: t.hex().notNull(),
    /** The merchant's registered payout route, once it is known. */
    recipient: t.hex(),
    /** CCTP domain. 26 is Arc — settlement that never left. */
    domain: t.integer(),
    /** What the borrower is financing. 6-decimal USDC, bigint, never a float. */
    gross: t.bigint().notNull().default(0n),
    mdr: t.bigint().notNull().default(0n),
    /** Diverted into the merchant's own bond while they are new (DEC-09). */
    withheld: t.bigint().notNull().default(0n),
    /** `gross - mdr - withheld`. The figure that actually moved. */
    net: t.bigint().notNull().default(0n),
    /** `settled` | `queued` | `dispatched` | `escrowed` | `returned`. */
    status: t.text().notNull(),
    /**
     * The origination transaction.
     *
     * The join to the route-level ledger, and the join to Circle's: a CCTP v2 burn
     * emits a zero nonce and the real `eventNonce` is assigned by Iris at attestation,
     * so there is no on-chain identifier to key on (DEC-31, finding 28).
     */
    txHash: t.hex(),
    /**
     * The transaction that burned, when the settlement went through the queue.
     *
     * A **second** column rather than an overwrite of `txHash`, because a queued
     * settlement has two transactions and a reconciliation needs both: the origination
     * is what the merchant's own order matches on, and the burn is what Circle's
     * ledger matches on. Folding them into one column would answer the second question
     * by destroying the answer to the first, and the row would look correct while
     * having lost the only key back to the sale.
     *
     * Null for an instant settlement, where the two are the same transaction and
     * `txHash` already holds it.
     */
    dispatchTxHash: t.hex(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
    cohort: t.text().notNull(),
  }),
  (table) => ({
    merchantIdx: index().on(table.merchant),
    statusIdx: index().on(table.status),
    domainIdx: index().on(table.domain),
    txIdx: index().on(table.txHash),
  }),
);

/**
 * Every movement the payout adapter made, at the route level.
 *
 * **This is the table the attestation poller reads**, and it is deliberately keyed by
 * nothing but the log that produced it. A `nonce` column would be permanently null —
 * a CCTP v2 burn's emitted nonce is all zeros and the real one comes back from Iris —
 * and a `planId` column would be permanently null too, because `dispatch()` drains a
 * `(token, recipient, domain)` queue that may hold several plans' settlements at once
 * (DEC-36). Neither is here. The join is the transaction hash, off-chain by
 * construction, and that is finding 28 stated as a schema decision.
 *
 * Append-only: a dispatch is a fact about a moment, and a route's history is the
 * question the poller and the merchant both ask.
 */
export const payoutDispatch = onchainTable(
  "payout_dispatch",
  (t) => ({
    id: t.text().primaryKey(),
    /** `paid` on Arc, `queued` awaiting a crank, `dispatched` once the burn is out. */
    kind: t.text().notNull(),
    token: t.hex().notNull(),
    recipient: t.hex().notNull(),
    domain: t.integer().notNull(),
    amount: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    txIdx: index().on(table.txHash),
    routeIdx: index().on(table.recipient, table.domain),
    kindIdx: index().on(table.kind),
  }),
);

/**
 * A settlement held against shipment, and the timers around it.
 *
 * MERCH-04. The row is self-describing after `hold` stamps it, because the merchant's
 * category was read once at origination and may have moved since (D-06) — reading the
 * registry to interpret this row would answer a question about today with a fact about
 * then.
 *
 * `carrierRef` is a `bytes32` commitment and stays one. A tracking number is a delivery
 * address by proxy; in a queryable column it is a borrower's home address for anyone
 * who can ask a carrier, which is precisely the exposure the whole storage split exists
 * to prevent.
 */
export const settlementEscrow = onchainTable(
  "settlement_escrow",
  (t) => ({
    planId: t.hex().primaryKey(),
    merchant: t.hex().notNull(),
    amount: t.bigint().notNull(),
    heldAt: t.integer().notNull(),
    attestedAt: t.integer(),
    carrierRef: t.hex(),
    releasedAt: t.integer(),
    returnedAt: t.integer(),
    /** `held` | `attested` | `released` | `returned`. */
    state: t.text().notNull(),
    /**
     * Returned for **non-attestation** specifically, which is the single objective,
     * operator-free ground for a dispute. Kept apart from `returnedAt` because a
     * return that is a dispute ground and one that is not must not look alike.
     */
    nonAttested: t.boolean().notNull().default(false),
  }),
  (table) => ({
    merchantIdx: index().on(table.merchant),
    stateIdx: index().on(table.state),
  }),
);

/**
 * Every refund and every void, in the order they happened.
 *
 * Append-only rather than a running total on `payout`, because a merchant reconciling
 * a return needs the individual credit that matches their own refund record, and a
 * netted figure cannot be matched against anything.
 *
 * `merchant` is denormalised from `origination` at write time. The refund events carry
 * only a `planId` — D-04 keeps `RefundEscrow` calling the plan rather than reimplementing
 * it, and the plan does not know the merchant's address is what a dashboard filters by.
 */
export const refund = onchainTable(
  "refund",
  (t) => ({
    id: t.text().primaryKey(),
    planId: t.hex().notNull(),
    merchant: t.hex().notNull(),
    amount: t.bigint().notNull().default(0n),
    /** `refund` | `void`. */
    kind: t.text().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    planIdx: index().on(table.planId),
    merchantIdx: index().on(table.merchant),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// The capital plane (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every epoch the book has closed, with the price it struck.
 *
 * The NAV series a lender's chart is drawn from, and the only honest source for it:
 * a share price sampled between closes is an interpolation, because the price does
 * not exist until the epoch strikes it.
 */
export const epoch = onchainTable(
  "epoch",
  (t) => ({
    number: t.bigint().primaryKey(),
    seniorNav: t.bigint().notNull(),
    juniorNav: t.bigint().notNull(),
    /** POOL-09. Zero in an ordinary epoch; the same for everybody when it is not. */
    liquidityFeeBps: t.bigint().notNull(),
    closedAt: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
  }),
  (table) => ({
    closedIdx: index().on(table.closedAt),
  }),
);

/**
 * The provision outstanding against each plan, bucketed by the epoch that raised it.
 *
 * POOL-07's bucketing is what lets a cure release exactly what the delinquency took,
 * and this is where an LP can check that it did. `raised` and `released` are kept
 * separately rather than netted, because the round trip is the property — a net of
 * zero could mean nothing happened or could mean a provision was released against a
 * different bucket than the one that took it.
 */
export const provision = onchainTable(
  "provision",
  (t) => ({
    planId: t.hex().primaryKey(),
    epoch: t.bigint().notNull(),
    raised: t.bigint().notNull().default(0n),
    released: t.bigint().notNull().default(0n),
    outstanding: t.bigint().notNull().default(0n),
    updatedAt: t.integer().notNull(),
  }),
  (table) => ({
    epochIdx: index().on(table.epoch),
  }),
);

/**
 * A lender's position in one tranche.
 *
 * `holder` is a first-class key here, unlike anywhere in the plan or Passport tables.
 * A tranche share is a transfer-restricted ERC-20 whose holder set is already public
 * in every `Transfer`, and the lender needs to see their own position — so hiding it
 * would cost a feature and protect nothing.
 */
export const lenderPosition = onchainTable(
  "lender_position",
  (t) => ({
    id: t.text().primaryKey(),
    tranche: t.integer().notNull(),
    holder: t.hex().notNull(),
    depositedAssets: t.bigint().notNull().default(0n),
    claimedShares: t.bigint().notNull().default(0n),
    redeemedShares: t.bigint().notNull().default(0n),
    redeemedAssets: t.bigint().notNull().default(0n),
    updatedAt: t.integer().notNull(),
  }),
  (table) => ({
    holderIdx: index().on(table.holder),
  }),
);

/**
 * Every redemption ticket, and how far the fill line has reached it.
 *
 * APP-04's queue position with an ETA. The ETA is the app's arithmetic over recent
 * fill rates; `position` and the epoch's fills are the inputs it needs.
 */
export const redemptionTicket = onchainTable(
  "redemption_ticket",
  (t) => ({
    id: t.text().primaryKey(),
    tranche: t.integer().notNull(),
    holder: t.hex().notNull(),
    index: t.bigint().notNull(),
    shares: t.bigint().notNull(),
    /** Cumulative queue position of the last share in this ticket. */
    position: t.bigint().notNull(),
    claimedAssets: t.bigint().notNull().default(0n),
    requestedAt: t.integer().notNull(),
  }),
  (table) => ({
    holderIdx: index().on(table.holder),
    trancheIdx: index().on(table.tranche),
  }),
);

/** Each epoch's fill of each tranche's queue. */
export const queueFill = onchainTable(
  "queue_fill",
  (t) => ({
    id: t.text().primaryKey(),
    tranche: t.integer().notNull(),
    epoch: t.bigint().notNull(),
    shares: t.bigint().notNull(),
    assets: t.bigint().notNull(),
    feeBps: t.bigint().notNull(),
    filledAt: t.integer().notNull(),
  }),
  (table) => ({
    epochIdx: index().on(table.epoch),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Passport (Phase 4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A borrower's credit standing, keyed by their salted subject.
 *
 * **There is no wallet column, and there cannot be one.** The subject is
 * `keccak256(prefix ‖ salt ‖ borrower)`; the operator holds the salt in its own
 * private schema and joins there, behind the consent gate, where a correction or a
 * deletion can actually be honoured. Putting the wallet in the indexed chain schema
 * would rebuild exactly the enumerable credit file the salt exists to prevent — and
 * it would do it in the one table an analyst is most likely to export.
 */
export const passportRecord = onchainTable(
  "passport_record",
  (t) => ({
    subject: t.hex().primaryKey(),
    completions: t.integer().notNull().default(0),
    negativesEver: t.integer().notNull().default(0),
    commitment: t.hex(),
    schemaId: t.hex(),
    version: t.bigint().notNull().default(0n),
    updatedAt: t.integer().notNull(),
  }),
  (table) => ({
    updatedIdx: index().on(table.updatedAt),
  }),
);

/** Every negative mark, so ageing can be recomputed rather than trusted. */
export const passportMark = onchainTable(
  "passport_mark",
  (t) => ({
    id: t.text().primaryKey(),
    subject: t.hex().notNull(),
    markedAt: t.integer().notNull(),
  }),
  (table) => ({
    subjectIdx: index().on(table.subject),
  }),
);

/** Consent grants and revocations, in the order they happened. */
export const consentEvent = onchainTable(
  "consent_event",
  (t) => ({
    id: t.text().primaryKey(),
    subject: t.hex().notNull(),
    reader: t.hex().notNull(),
    schemaId: t.hex().notNull(),
    granted: t.boolean().notNull(),
    validUntil: t.bigint().notNull().default(0n),
    at: t.integer().notNull(),
  }),
  (table) => ({
    readerIdx: index().on(table.reader),
    subjectIdx: index().on(table.subject),
  }),
);

/**
 * Collections the operator's gate made.
 *
 * COLL-10's denominator comes from `collectionAttempt`; this is the numerator's
 * complement. Kept separate so the share of third-party cranks is a join rather than
 * a claim.
 */
export const relayedCollection = onchainTable(
  "relayed_collection",
  (t) => ({
    id: t.text().primaryKey(),
    plan: t.hex().notNull(),
    index: t.bigint().notNull(),
    cleared: t.boolean().notNull(),
    reason: t.integer().notNull(),
    at: t.integer().notNull(),
  }),
  (table) => ({
    planIdx: index().on(table.plan),
  }),
);
