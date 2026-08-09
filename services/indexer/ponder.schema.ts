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
    /**
     * `planId` alone, for the same reason `provision` keeps it: a plan settles to the
     * book named in its own signed terms and to no other, forever. `pool` is beside the
     * key so "what is this book carrying" is a filter — nullable because the row is
     * created by whichever crank fires first and `Fronted` is not guaranteed to be it.
     */
    planId: t.hex().primaryKey(),
    pool: t.hex(),
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
    /**
     * Which book's gate. Two books have two subordination floors and close
     * independently; a reading without the pool cannot say which one shut.
     */
    pool: t.hex().notNull(),
    open: t.boolean().notNull(),
    subordinationBps: t.bigint().notNull(),
    reserveBps: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    timeIdx: index().on(table.timestamp),
    poolIdx: index().on(table.pool),
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
 *
 * ## `pool` is half the key, and it was not before
 *
 * Phase 7 deploys a second `TranchedCreditPool` for the EURC corridor, and both books
 * number their epochs from one. A `number`-only primary key made the USDC book's epoch 1
 * and the EURC book's epoch 1 the same row, so whichever closed second would silently
 * overwrite the other's NAV — and the surface would show one book's price under both
 * books' names with nothing anywhere reporting an error.
 *
 * This is the schema-v5 non-additivity made concrete: no event changed, the emitting
 * address simply stopped being a constant. Every table below that a pool writes carries
 * `pool` for the same reason, and the three whose natural key would otherwise collide —
 * this one, `lenderPosition` and `redemptionTicket` — carry it *in* the key rather than
 * beside it.
 */
export const epoch = onchainTable(
  "epoch",
  (t) => ({
    /** The `TranchedCreditPool` that struck it. Neither book is "the" book. */
    pool: t.hex().notNull(),
    number: t.bigint().notNull(),
    seniorNav: t.bigint().notNull(),
    juniorNav: t.bigint().notNull(),
    /** POOL-09. Zero in an ordinary epoch; the same for everybody when it is not. */
    liquidityFeeBps: t.bigint().notNull(),
    closedAt: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({columns: [table.pool, table.number]}),
    closedIdx: index().on(table.closedAt),
    poolIdx: index().on(table.pool),
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
    /**
     * Still keyed by `planId` alone, and that is a claim rather than an omission: a
     * `planId` belongs to exactly one book forever (POOL-01, and `CheckoutRouter.poolOf`
     * is written once at origination), so two books cannot provision the same plan and
     * the key cannot collide. `pool` is carried beside it so a per-book provision total
     * is a filter rather than a join.
     */
    planId: t.hex().primaryKey(),
    pool: t.hex(),
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
 *
 * **`id` is `pool-tranche-holder`, not `tranche-holder`.** An allocator holding senior in
 * both books is two positions; without the pool in the key their EURC deposit would
 * accumulate onto their USDC row and the surface would report one position worth the sum
 * of two books' assets, denominated in neither.
 */
export const lenderPosition = onchainTable(
  "lender_position",
  (t) => ({
    id: t.text().primaryKey(),
    pool: t.hex().notNull(),
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
    poolIdx: index().on(table.pool),
  }),
);

/**
 * Every redemption ticket, and how far the fill line has reached it.
 *
 * APP-04's queue position with an ETA. The ETA is the app's arithmetic over recent
 * fill rates; `position` and the epoch's fills are the inputs it needs.
 *
 * Keyed `pool-tranche-holder-index`. `index` is a per-tranche counter inside one pool,
 * so two books hand out ticket 0 to two different lenders on the same day.
 */
export const redemptionTicket = onchainTable(
  "redemption_ticket",
  (t) => ({
    id: t.text().primaryKey(),
    pool: t.hex().notNull(),
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
    poolIdx: index().on(table.pool),
  }),
);

/**
 * Each epoch's fill of each tranche's queue.
 *
 * `id` is the log's coordinates and was never at risk of collision, but `pool` is still
 * required rather than optional: POOL-09's uniformity — one fill per tranche per epoch at
 * one rate — is checked from this table, and with two books in it the check has to be run
 * per book. Two correct rates in two pools' epoch 4 would otherwise read as one book
 * charging two redeemers differently, which is the exact violation the fee replaced.
 */
export const queueFill = onchainTable(
  "queue_fill",
  (t) => ({
    id: t.text().primaryKey(),
    pool: t.hex().notNull(),
    tranche: t.integer().notNull(),
    epoch: t.bigint().notNull(),
    shares: t.bigint().notNull(),
    assets: t.bigint().notNull(),
    feeBps: t.bigint().notNull(),
    filledAt: t.integer().notNull(),
  }),
  (table) => ({
    epochIdx: index().on(table.epoch),
    poolIdx: index().on(table.pool),
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

// ─────────────────────────────────────────────────────────────────────────────
// The inflow stream (Phase 7) — UW-04's evidence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One inbound native movement, at **both** scales, narrowed exactly once.
 *
 * ## Why both columns exist
 *
 * Arc emits an ERC-20 `Transfer` from a system emitter for every native movement, and
 * that log's `value` is **18 decimals**. The USDC contract's own `Transfer` for the
 * same movement is **6**. Only the system stream is written here (E-08, and see
 * `src/inflow.ts` for the rule and the gate that enforces it), so this table is a
 * faithful copy of an 18-decimal stream that the credit system counts in 6.
 *
 * `valueMinor` is `toMinor6(valueNative)`, computed **once, at write time**, by the
 * one narrowing function `@plazo/plan-core` exposes for this purpose. Storing only the
 * narrowed figure would leave a consumer unable to audit the narrowing; storing only
 * the raw figure would make every consumer narrow it again, and a 10^12 error made in
 * three places is a 10^12 error found in none. One narrowing, both figures, and the
 * arithmetic is checkable from the row.
 *
 * ## Why `recipient` is a wallet here and a salted subject next door
 *
 * Every other identity-adjacent table in this schema keys on a salted subject, because
 * the events behind them carry one. This one carries a wallet because the *log* does,
 * and a log on a public chain is already public — hiding it here would protect nothing
 * and cost the ability to reconcile a row against the chain it came from. What is not
 * here is the join from a wallet to a person: that lives in `operator.inflow_summary`
 * and `operator.inflow_counterparty`, both keyed on a salted subject, behind the
 * consent gate where a deletion can actually be honoured (OPS-08).
 *
 * The table is also not an enumerable income file over all of Arc, because the handler
 * writes only for wallets the operator was explicitly told to track. See `src/inflow.ts`.
 *
 * The primary key is writer-chosen — `${txHash}:${logIndex}` — for DEC-58's reason: a
 * server-assigned value is not known until after the insert, so an idempotent handler
 * cannot use one. There is no sequence-backed column, no identity column and no
 * database-level enum anywhere in this schema (DEC-57).
 */
export const inflow = onchainTable(
  "inflow",
  (t) => ({
    /** `${txHash}:${logIndex}`. Writer-chosen, so a replay is a no-op. */
    id: t.text().primaryKey(),
    /** The `to` field of the system emitter's log. Tracked wallets only. */
    recipient: t.hex().notNull(),
    /** The `from` field. Who paid — the diversity and round-trip exclusions read this. */
    counterparty: t.hex().notNull(),
    /** The log's own `value`, at the 18 decimals the system emitter writes. */
    valueNative: t.bigint().notNull(),
    /** `toMinor6(valueNative)`. Narrowed once, here, and never again downstream. */
    valueMinor: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTimestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    recipientIdx: index().on(table.recipient),
    counterpartyIdx: index().on(table.counterparty),
    timeIdx: index().on(table.blockTimestamp),
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

// ─────────────────────────────────────────────────────────────────────────────
// The corridor and the credit ladder (Phase 7)
//
// Every id below is writer-chosen (DEC-58). There is no sequence-backed column, no
// identity column, no database-level enum and no view here, as nowhere else in this
// file (DEC-57) — a sequence emits a `DROP SEQUENCE` on the next cross-service push,
// and an id the writer does not know until after the insert cannot make a handler
// idempotent. The gate for this is a substring grep over the whole file, so the
// prohibited constructs are described rather than named; the paragraph above `inflow`
// sets the same precedent.
//
// **No table here joins a wallet to a `planId`.** That is the same line schema v5 draws:
// `PledgeBound`, `PledgeUnbound`, `PledgeSeized`, `SweepOptedIn`, `SweepOptedOut` and
// `Swept` all exist on chain and none is in `@plazo/events`, so none can be subscribed
// to and none has a table. The pledge tables key on a wallet with no plan; the tier and
// sweep tables key on a plan with no wallet.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every fill that cleared the FX deviation guard, with the floor it had to clear.
 *
 * FX-04's observable. `floor` is stored rather than recomputed because it was derived
 * from a signed mid the guard consumed at the same moment — the session id is spent and
 * cannot be quoted twice, so an observer checking the band afterwards has no way to
 * rebuild the threshold. A guard whose threshold is unauditable is one nobody can hold
 * to account, which is the whole reason the contract emits it.
 */
export const fxFill = onchainTable(
  "fx_fill",
  (t) => ({
    /** `${txHash}:${logIndex}`. Writer-chosen, so a replay overwrites rather than doubles. */
    id: t.text().primaryKey(),
    /** `keccak256(fromToken, toToken)` — a token pair, never a party. */
    corridor: t.hex().notNull(),
    venue: t.hex().notNull(),
    amountIn: t.bigint().notNull(),
    amountOut: t.bigint().notNull(),
    floor: t.bigint().notNull(),
    /** `amountOut - floor`. Stored so "how close did that come" is a sort, not a scan. */
    headroom: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    corridorIdx: index().on(table.corridor),
    venueIdx: index().on(table.venue),
    timeIdx: index().on(table.timestamp),
  }),
);

/**
 * A capital provider's position in the pledge vault.
 *
 * Keyed on the wallet and carrying **no plan**, which is the whole of the privacy
 * decision made in `@plazo/events` v5: an address that deposited collateral is a fact
 * `pledgedValueOf(address)` already discloses to anyone who types the address, so a table
 * of it costs nothing and lets a pledger see their own position. An address joined to a
 * `planId` would be a credit file, and the three events that would supply one are not in
 * the schema and therefore cannot reach here.
 *
 * **There is no `totalLocked` column, and its absence is deliberate.** The lock is
 * `lockedOf(pledger)`, a public getter on the vault and the live truth. Accumulating a
 * copy of it here from `PledgeBound`/`PledgeUnbound` would need those two events —
 * excluded — and would produce a second number that can drift from the first. Nothing
 * here is derived by accumulation that the chain answers directly.
 */
export const pledgePosition = onchainTable(
  "pledge_position",
  (t) => ({
    /** The pledger's address, lowercased. */
    id: t.hex().primaryKey(),
    totalPledged: t.bigint().notNull().default(0n),
    totalReleased: t.bigint().notNull().default(0n),
    sharesHeld: t.bigint().notNull().default(0n),
    updatedAt: t.integer().notNull(),
  }),
  (table) => ({
    updatedIdx: index().on(table.updatedAt),
  }),
);

/**
 * The pledge vault's log, one row per event.
 *
 * `kind` is a `text` column and not a database-level enum (DEC-57): such a type has to be
 * altered before a value can be added, and the alter is the statement that breaks a
 * cross-service push. The permitted values are `pledged`, `released` and `yieldPaid`,
 * enforced in TypeScript by `PledgeKind` where a bad value is a compile error rather than
 * a migration.
 */
export const pledgeEvent = onchainTable(
  "pledge_event",
  (t) => ({
    id: t.text().primaryKey(),
    kind: t.text().notNull(),
    /** The pledger, or the yield funder. Never joined to a plan — see the header. */
    account: t.hex().notNull(),
    amount: t.bigint().notNull(),
    /** Shares moved, or the vault's `totalAssets` after a yield payment. */
    shares: t.bigint().notNull().default(0n),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    accountIdx: index().on(table.account),
    kindIdx: index().on(table.kind),
  }),
);

/**
 * An installment settled by payroll deduction.
 *
 * **Derived from `InstallmentPlan.CheckCleared`, not from `PayrollSweeper.Swept`**, and
 * that is the substance rather than a shortcut. All three sweeper events carry the plan's
 * counterparty as an indexed address beside a `planId`, so schema v5 declines to list
 * them and the indexer cannot subscribe to them. It does not need to: a sweep settles the
 * installment through `repay`, so the plan emits `CheckCleared(planId, index, amount,
 * keeper)` with the sweeper's own contract address in `keeper`. "This was payroll" is a
 * comparison against one configured address.
 *
 * What is lost is `residue` — the payer's change coming back to them, which is a
 * `Transfer` in the same transaction and not a fact the credit book needs.
 */
export const sweepEvent = onchainTable(
  "sweep_event",
  (t) => ({
    id: t.text().primaryKey(),
    planId: t.hex().notNull(),
    index: t.integer().notNull(),
    value: t.bigint().notNull(),
    /** The `PayrollSweeper` that cranked it. A contract, never a wallet. */
    sweeper: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    planIdx: index().on(table.planId),
    timeIdx: index().on(table.timestamp),
  }),
);

/**
 * The tier a plan originated at, and nothing else about who took it.
 *
 * UW-07's boundary, indexed. `planId`, tier and principal are the whole event, so this
 * table is the whole event — no person id, no wallet, and none of the inputs the tier was
 * computed from. It is what makes the tier mix of the book measurable without making the
 * book's counterparties enumerable.
 */
export const tierOrigination = onchainTable(
  "tier_origination",
  (t) => ({
    id: t.hex().primaryKey(),
    tier: t.integer().notNull(),
    principal: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    timestamp: t.integer().notNull(),
  }),
  (table) => ({
    tierIdx: index().on(table.tier),
    timeIdx: index().on(table.timestamp),
  }),
);

/**
 * The currency a merchant elected to be settled in.
 *
 * The election, and deliberately not the effect. DEC-112 has `payoutCurrencyOf` re-read
 * the allowlist on every call, so a merchant whose elected currency has had its allowance
 * withdrawn is paid in dollars while this row still says what they asked for. Joining
 * against `currencyAllowance` is how a surface tells a merchant *why* their settlements
 * changed without their having done anything — which is the question DEC-112 creates and
 * a single current-value column could not answer.
 */
export const merchantCurrency = onchainTable(
  "merchant_currency",
  (t) => ({
    /** The merchant's address, lowercased. */
    id: t.hex().primaryKey(),
    /** What they elected. Zero means the plan's own currency. */
    currency: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    updatedAt: t.integer().notNull(),
  }),
  (table) => ({
    currencyIdx: index().on(table.currency),
  }),
);

/**
 * Whether a currency is allowed, and when that last changed.
 *
 * `DomainDenied` in the currency plane. A current-value getter can say a currency is not
 * allowed; it cannot say when it stopped being allowed or who did it, and those are the
 * two facts a merchant whose settlements silently reverted to dollars actually needs.
 */
export const currencyAllowance = onchainTable(
  "currency_allowance",
  (t) => ({
    /** The currency's address, lowercased. */
    id: t.hex().primaryKey(),
    allowed: t.boolean().notNull(),
    by: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    updatedAt: t.integer().notNull(),
  }),
  (table) => ({
    allowedIdx: index().on(table.allowed),
  }),
);

/**
 * One corridor's wiring: the token, and the three contracts that price it.
 *
 * Listed where `SettlementEscrow.RouterSet` is not because it is neither one-way nor
 * once-per-deployment. There is one of these per corridor and the deployment record holds
 * a single router key rather than a per-token map, so from the second corridor onwards the
 * artefact does not already carry the answer — and an origination priced under a corridor
 * that has since been re-pointed can only be explained from a log.
 */
export const corridorWiring = onchainTable(
  "corridor_wiring",
  (t) => ({
    /** The corridor's settlement token, lowercased. */
    id: t.hex().primaryKey(),
    fxRouter: t.hex().notNull(),
    parameters: t.hex().notNull(),
    underwriter: t.hex().notNull(),
    setBy: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    updatedAt: t.integer().notNull(),
  }),
  (table) => ({
    routerIdx: index().on(table.fxRouter),
  }),
);
