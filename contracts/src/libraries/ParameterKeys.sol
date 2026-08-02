// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title ParameterKeys
/// @notice Every `ParameterRegistry` row, named once.
///
/// @dev Keys rather than struct fields because Phases 5, 7 and 8 add parameters,
///      and a typed struct would make every addition a storage-layout migration on
///      a contract the whole origination plane reads. A key is `keccak256` of a
///      dotted name, so the same string names the row in Solidity, in TypeScript,
///      in the indexer and in an operator's console.
///
///      Names are stable. Renaming one is a migration, not a refactor: the old key
///      keeps its value and the new key is undefined, and `ParameterRegistry.get`
///      reverts on an undefined key rather than returning zero — which is the
///      difference between a failed origination and a silently free one.
library ParameterKeys {
    // ─── Ticket ──────────────────────────────────────────────────────────────

    bytes32 internal constant MIN_TICKET = keccak256("plazo.origination.minTicket");
    bytes32 internal constant MAX_TICKET = keccak256("plazo.origination.maxTicket");
    bytes32 internal constant MDR_BPS = keccak256("plazo.origination.mdrBps");

    // ─── Tier 0 ──────────────────────────────────────────────────────────────

    bytes32 internal constant TIER0_INITIAL_LIMIT = keccak256("plazo.tier0.initialLimit");
    bytes32 internal constant TIER0_GROWTH_BPS = keccak256("plazo.tier0.growthBps");
    bytes32 internal constant TIER0_PSEUDONYMOUS_CAP = keccak256("plazo.tier0.pseudonymousCap");
    bytes32 internal constant TIER0_IDENTIFIED_CAP = keccak256("plazo.tier0.identifiedCap");
    bytes32 internal constant TIER0_BOOK_SHARE_BPS = keccak256("plazo.tier0.bookShareBps");
    bytes32 internal constant CONTRACT_SIGNER_CAP_BPS = keccak256("plazo.tier0.contractSignerCapBps");
    bytes32 internal constant LIMIT_HARD_CEILING = keccak256("plazo.underwriting.limitHardCeiling");
    bytes32 internal constant ATTESTATION_MAX_TTL = keccak256("plazo.underwriting.attestationMaxTtl");

    // ─── First-payment-default kill switch ───────────────────────────────────

    bytes32 internal constant FPD_MIN_COHORT = keccak256("plazo.fpd.minCohort");
    bytes32 internal constant FPD_TRIGGER_BPS = keccak256("plazo.fpd.triggerBps");
    bytes32 internal constant FPD_FULL_STOP_BPS = keccak256("plazo.fpd.fullStopBps");
    bytes32 internal constant FPD_NEW_WALLET_WEIGHT_BPS = keccak256("plazo.fpd.newWalletWeightBps");
    bytes32 internal constant FPD_THROTTLE_FLOOR_BPS = keccak256("plazo.fpd.throttleFloorBps");
    bytes32 internal constant FPD_SEASONING_PLANS = keccak256("plazo.fpd.seasoningPlans");
    bytes32 internal constant FPD_OBSERVATION_WINDOW = keccak256("plazo.fpd.observationWindow");

    // ─── Pool ────────────────────────────────────────────────────────────────

    bytes32 internal constant MIN_SUBORDINATION_BPS = keccak256("plazo.pool.minSubordinationBps");
    bytes32 internal constant MIN_RESERVE_BPS = keccak256("plazo.pool.minReserveBps");
    bytes32 internal constant RESERVE_TARGET_BPS = keccak256("plazo.pool.reserveTargetBps");

    // ─── Epoch accounting (Phase 5) ──────────────────────────────────────────

    bytes32 internal constant EPOCH_LENGTH = keccak256("plazo.pool.epochLength");
    bytes32 internal constant DELINQUENT_PROVISION_BPS = keccak256("plazo.pool.delinquentProvisionBps");
    bytes32 internal constant BUFFER_FLOOR_BPS = keccak256("plazo.pool.bufferFloorBps");
    bytes32 internal constant LIQUIDITY_FEE_THRESHOLD_BPS = keccak256("plazo.pool.liquidityFeeThresholdBps");
    bytes32 internal constant LIQUIDITY_FEE_BPS = keccak256("plazo.pool.liquidityFeeBps");
    bytes32 internal constant JUNIOR_LOCK_PERIOD = keccak256("plazo.pool.juniorLockPeriod");
    bytes32 internal constant SENIOR_TARGET_APY_BPS = keccak256("plazo.pool.seniorTargetApyBps");

    // ─── Passport and servicing (Phase 4) ────────────────────────────────────

    bytes32 internal constant PASSPORT_NEGATIVE_MARK_TTL = keccak256("plazo.passport.negativeMarkTtl");
    bytes32 internal constant PASSPORT_CONSENT_MAX_TTL = keccak256("plazo.passport.consentMaxTtl");
    bytes32 internal constant RELAYER_DELAY_FLOOR = keccak256("plazo.relayer.delayFloor");

    // ─── Merchant ────────────────────────────────────────────────────────────

    bytes32 internal constant MERCHANT_BOND_BPS = keccak256("plazo.merchant.bondBps");
    bytes32 internal constant MERCHANT_BOND_FLOOR = keccak256("plazo.merchant.bondFloor");
    bytes32 internal constant MERCHANT_VESTING_WINDOW = keccak256("plazo.merchant.vestingWindow");
    bytes32 internal constant MERCHANT_VESTING_BPS = keccak256("plazo.merchant.vestingBps");
    bytes32 internal constant MERCHANT_VELOCITY_WINDOW = keccak256("plazo.merchant.velocityWindow");
    bytes32 internal constant MERCHANT_VELOCITY_CAP = keccak256("plazo.merchant.velocityCap");

    // ─── Concentration (UW-09) ───────────────────────────────────────────────

    bytes32 internal constant MERCHANT_CONCENTRATION_BPS = keccak256("plazo.concentration.merchantBps");
    bytes32 internal constant CORRIDOR_CONCENTRATION_BPS = keccak256("plazo.concentration.corridorBps");

    // ─── Settlement escrow (Phase 6) ─────────────────────────────────────────
    //
    // D-08. All three land before either escrow is written, so that `RefundEscrow`
    // and `SettlementEscrow` read rows that already exist rather than taking a
    // constructor immutable and quietly leaving GOV-01. Neither of those contracts
    // may add a key of its own here, and neither may compile any of these three in.

    bytes32 internal constant ESCROW_ATTESTATION_DEADLINE = keccak256("plazo.escrow.attestationDeadline");
    bytes32 internal constant ESCROW_RELEASE_TIMER = keccak256("plazo.escrow.releaseTimer");
    bytes32 internal constant ESCROW_DISPUTE_TIMELOCK = keccak256("plazo.escrow.disputeTimelock");

    // ─── FX corridor (Phase 7) ───────────────────────────────────────────────
    //
    // E-01, E-05. These fifteen rows and the nine below them exist on **neither
    // deployed registry**. `ParameterRegistry._define` is private and
    // constructor-only, and nine contracts hold the registry `immutable` with no
    // setter anywhere in the tree, so a row added here cannot be added to
    // `parameterRegistry` (0x753e08a6…) or `escrowParameterRegistry` (0xe74d5ac7…)
    // and no attempt is made to. Plan 07-12 deploys a **third** instance,
    // `fxParameterRegistry`, and only Phase 7 contracts read it. The precedent is
    // `escrowParameterRegistry` itself, which is a second instance for exactly this
    // reason.
    //
    // The last three are read by an off-chain corridor-health poll, not by a
    // contract. They are rows anyway: a breaker whose trigger is undefined is a
    // breaker that never trips, and an outsider auditing the trigger has to be able
    // to read it, exactly as `RELAYER_DELAY_FLOOR` put the relayer's delay floor
    // somewhere it could be audited (DEC-18). No price ever crosses onto the chain.

    bytes32 internal constant FX_CORRIDOR_HAIRCUT_BPS = keccak256("plazo.fx.corridorHaircutBps");
    bytes32 internal constant FX_MAX_DEVIATION_BPS = keccak256("plazo.fx.maxDeviationBps");
    bytes32 internal constant FX_MID_MAX_TTL = keccak256("plazo.fx.midMaxTtl");
    bytes32 internal constant FX_QUOTE_MAX_AGE = keccak256("plazo.fx.quoteMaxAge");
    bytes32 internal constant FX_ROUNDTRIP_MAX_BPS = keccak256("plazo.fx.roundtripMaxBps");
    bytes32 internal constant FX_PAR_BAND_BPS = keccak256("plazo.fx.parBandBps");

    // ─── Tiered underwriting (Phase 7) ───────────────────────────────────────
    //
    // UW-04…UW-07. The `INFLOW_*` trio is named `plazo.tier1.inflow*` because the
    // inflow stream is Tier 1's evidence and nothing else reads it.

    bytes32 internal constant TIER1_INCOME_MULTIPLE_BPS = keccak256("plazo.tier1.incomeMultipleBps");
    bytes32 internal constant TIER1_PSEUDONYMOUS_CAP = keccak256("plazo.tier1.pseudonymousCap");
    bytes32 internal constant TIER1_PAYROLL_BONUS_BPS = keccak256("plazo.tier1.payrollBonusBps");
    bytes32 internal constant INFLOW_LOOKBACK = keccak256("plazo.tier1.inflowLookback");
    bytes32 internal constant INFLOW_MIN_MONTHS = keccak256("plazo.tier1.inflowMinMonths");
    bytes32 internal constant INFLOW_MIN_COUNTERPARTIES = keccak256("plazo.tier1.inflowMinCounterparties");

    bytes32 internal constant TIER2_PLEDGE_HAIRCUT_BPS = keccak256("plazo.tier2.pledgeHaircutBps");

    bytes32 internal constant TIER3_PARTNER_CAP = keccak256("plazo.tier3.partnerCap");
    bytes32 internal constant TIER3_PARTNER_MAX_TTL = keccak256("plazo.tier3.partnerMaxTtl");
}
