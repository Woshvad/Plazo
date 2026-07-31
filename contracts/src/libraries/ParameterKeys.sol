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
}
