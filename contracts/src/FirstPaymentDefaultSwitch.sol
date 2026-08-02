// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IInstallmentPlan} from "./interfaces/IInstallmentPlan.sol";
import {ParameterRegistry} from "./ParameterRegistry.sol";
import {ParameterKeys} from "./libraries/ParameterKeys.sol";
import {PlanParams} from "./libraries/PlanParams.sol";

/// @title FirstPaymentDefaultSwitch
/// @notice The cohort kill switch, graduated and grief-resistant.
///
/// @dev UW-03, and it is load-bearing rather than decorative: DEC-02 put Tier 0 on
///      pool capital from day one against a research recommendation for a shadow
///      book. That risk was accepted knowingly, which means this switch and the
///      book-share cap are the two things standing between an unproven scorecard and
///      the senior tranche.
///
///      First-payment default is the right signal because it is the one that cannot
///      be explained by anything except bad underwriting or fraud. A borrower who
///      misses their third installment had a life event. A borrower who never makes
///      the first one never intended to.
///
///      Three properties, each answering a specific way a naive switch fails:
///
///      **Graduated, not binary.** The output is a throttle in basis points applied
///      to every limit, not a boolean. A book that stops originating entirely while
///      its liabilities keep running is a book in runoff, and a switch whose only
///      settings are "fine" and "closed" will be set to "fine" by whoever has to
///      explain the runoff.
///
///      **Conditional on cohort size.** Below `FPD_MIN_COHORT` the switch cannot fire
///      at all. Three defaults out of five plans is noise, and a switch that fires on
///      noise is a switch an attacker trips for the price of five plans.
///
///      **New-wallet defaults weighted down.** A fresh wallet is the cheap thing to
///      manufacture: an attacker mints a hundred of them, takes a hundred minimum
///      tickets, defaults on every first payment, and halts the book for everyone.
///      Weighting those observations at a fraction means buying the throttle down
///      requires *seasoned* wallets, and a seasoned wallet costs real completed plans
///      to produce. The attack does not become impossible; it becomes more expensive
///      than the damage it does, which is the only durable form of "impossible".
///
///      **Observations decay.** A rate computed over all history stops responding
///      exactly when it matters. The window is a leaky bucket rather than a ring of
///      day-buckets: same behaviour, constant gas, and no boundary an attacker can
///      time an origination burst against.
contract FirstPaymentDefaultSwitch is AccessControl {
    /// @notice May register originations for later observation.
    /// @dev Held by `CheckoutRouter`. Registration has to be gated because it decides
    ///      the denominator, and an open denominator is a switch anyone can dilute by
    ///      registering plans that will never default.
    bytes32 public constant REGISTRAR_ROLE = keccak256("PLAZO.FPD_REGISTRAR");

    /// @dev Observations are held in 1e18-per-plan fixed point so the decay has
    ///      resolution. A plain integer count would round every decay step to zero
    ///      below a few dozen observations, which is precisely the cohort size where
    ///      the switch is being asked to be careful.
    uint256 private constant ONE = 1e18;

    struct Cohort {
        /// @notice Observations recorded, decayed. 1e18 per plan.
        uint256 observations;
        /// @notice Weighted defaults, decayed. 1e18 per seasoned default.
        uint256 weightedDefaults;
        uint64 decayedAt;
    }

    struct Registration {
        address plan;
        bool seasoned;
        bool registered;
        bool observed;
        bool defaulted;
    }

    ParameterRegistry public immutable parameters;

    Cohort private _cohort;
    mapping(bytes32 planId => Registration) private _registrations;

    event OriginationRegistered(bytes32 indexed planId, address indexed plan, bool seasoned);
    event FirstPaymentObserved(
        bytes32 indexed planId, bool defaulted, bool seasoned, address indexed observer
    );
    event ThrottleChanged(uint256 throttleBps, uint256 fpdBps, uint256 cohortSize);

    error AlreadyRegistered(bytes32 planId);
    error NotRegistered(bytes32 planId);
    error AlreadyObserved(bytes32 planId);
    error NotYetObservable(bytes32 planId, uint256 observableAt);

    constructor(address admin, address parameters_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        parameters = ParameterRegistry(parameters_);
        _cohort.decayedAt = uint64(block.timestamp);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Recording
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Register a plan whose first payment will be observed.
    /// @param seasoned Whether the borrower had completed plans at origination.
    /// @dev Seasoning is fixed at origination rather than read at observation,
    ///      because seasoning at the time of the decision is what was priced. A
    ///      borrower who becomes seasoned between origination and their first missed
    ///      payment did not make that decision better.
    function noteOrigination(bytes32 planId, address plan, bool seasoned) external onlyRole(REGISTRAR_ROLE) {
        Registration storage r = _registrations[planId];
        if (r.registered) revert AlreadyRegistered(planId);

        r.plan = plan;
        r.seasoned = seasoned;
        r.registered = true;

        emit OriginationRegistered(planId, plan, seasoned);
    }

    /// @notice Record how a plan's first installment went.
    ///
    /// @dev Permissionless, and it reads the plan directly rather than accepting an
    ///      operator's report. GOV-08 requires the whole loop to run with every
    ///      operator role at the zero address; a kill switch fed by an operator is a
    ///      kill switch that stops working the moment an operator has a reason to
    ///      want it to.
    ///
    ///      Observable once installment 0 has reached a terminal status, or once its
    ///      grace window has passed. The grace fallback matters: an installment that
    ///      bounced and was never marked would otherwise keep the switch waiting
    ///      forever on exactly the cohort it needs to see.
    function observe(bytes32 planId) external {
        Registration storage r = _registrations[planId];
        if (!r.registered) revert NotRegistered(planId);
        if (r.observed) revert AlreadyObserved(planId);

        IInstallmentPlan plan = IInstallmentPlan(r.plan);
        IInstallmentPlan.InstallmentStatus status = plan.installmentStatus(0);

        bool defaulted;
        if (status == IInstallmentPlan.InstallmentStatus.Cleared) {
            defaulted = false;
        } else if (
            status == IInstallmentPlan.InstallmentStatus.Missed
                || status == IInstallmentPlan.InstallmentStatus.Expired
        ) {
            defaulted = true;
        } else {
            // Pending, Bounced or Refunded. Only the passage of grace makes any of
            // them readable, and a refunded first installment is not a credit
            // observation at all — it is a merchant reversing a sale.
            uint256 observableAt = plan.graceEndsAt(0);
            if (block.timestamp <= observableAt) revert NotYetObservable(planId, observableAt);
            defaulted = status != IInstallmentPlan.InstallmentStatus.Refunded;
        }

        r.observed = true;
        r.defaulted = defaulted;

        _decay();
        _cohort.observations += ONE;
        if (defaulted) {
            _cohort.weightedDefaults += r.seasoned
                ? ONE
                : (ONE * parameters.get(ParameterKeys.FPD_NEW_WALLET_WEIGHT_BPS)) / PlanParams.BPS;
        }

        emit FirstPaymentObserved(planId, defaulted, r.seasoned, msg.sender);
        emit ThrottleChanged(throttleBps(), fpdBps(), cohortSize());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reading
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The weighted first-payment-default rate, in basis points.
    /// @dev Weighting the numerator only is deliberate. Weighting both would cancel
    ///      for a homogeneous cohort and the mechanism would do nothing. As it
    ///      stands, at a 25% weight, twenty percent of new wallets defaulting reads
    ///      the same as five percent of seasoned ones — which is the trade the
    ///      protocol means to make.
    function fpdBps() public view returns (uint256) {
        (uint256 observations, uint256 weighted) = _decayed();
        if (observations == 0) return 0;
        return (weighted * PlanParams.BPS) / observations;
    }

    /// @notice Observations currently in the window, in whole plans.
    function cohortSize() public view returns (uint256) {
        (uint256 observations,) = _decayed();
        return observations / ONE;
    }

    /// @notice The multiplier applied to every Tier-0 limit, in basis points.
    ///
    /// @dev 10,000 is fully open. The floor is a parameter rather than zero so a
    ///      future recalibration can decide that the book never fully stops — and so
    ///      that "fully stops" is a decision someone made rather than a default
    ///      nobody examined.
    function throttleBps() public view returns (uint256) {
        (uint256 observations, uint256 weighted) = _decayed();

        uint256 minCohort = parameters.get(ParameterKeys.FPD_MIN_COHORT);
        if (observations < minCohort * ONE) return PlanParams.BPS;

        uint256 rate = (weighted * PlanParams.BPS) / observations;
        uint256 trigger = parameters.get(ParameterKeys.FPD_TRIGGER_BPS);
        if (rate <= trigger) return PlanParams.BPS;

        uint256 fullStop = parameters.get(ParameterKeys.FPD_FULL_STOP_BPS);
        uint256 floorBps = parameters.get(ParameterKeys.FPD_THROTTLE_FLOOR_BPS);
        if (rate >= fullStop || fullStop <= trigger) return floorBps;

        // Linear between the trigger and the full stop. Nothing subtler is warranted:
        // the shape of this curve is a recalibration question that measured cohort
        // data has not yet been collected to answer, and a plausible-looking convex
        // curve would be a guess wearing a lab coat.
        uint256 travelled = ((rate - trigger) * PlanParams.BPS) / (fullStop - trigger);
        uint256 span = PlanParams.BPS - floorBps;
        return PlanParams.BPS - (span * travelled) / PlanParams.BPS;
    }

    /// @notice Apply the throttle to a limit.
    function throttle(uint256 limit) external view returns (uint256) {
        return (limit * throttleBps()) / PlanParams.BPS;
    }

    function registrationOf(bytes32 planId) external view returns (Registration memory) {
        return _registrations[planId];
    }

    /// @notice Whether `planId` can be observed right now.
    /// @dev A view so a keeper can decide whether the crank is worth sending without
    ///      paying for a revert. There is no bounty on `observe` — it is cheap, and
    ///      anyone whose capital is in the book has reason to run it — but a keeper
    ///      running it as a courtesy should still be able to skip the ones that
    ///      would fail.
    function isObservable(bytes32 planId) external view returns (bool) {
        Registration storage r = _registrations[planId];
        if (!r.registered || r.observed) return false;

        IInstallmentPlan plan = IInstallmentPlan(r.plan);
        IInstallmentPlan.InstallmentStatus status = plan.installmentStatus(0);
        if (
            status == IInstallmentPlan.InstallmentStatus.Cleared
                || status == IInstallmentPlan.InstallmentStatus.Missed
                || status == IInstallmentPlan.InstallmentStatus.Expired
        ) {
            return true;
        }
        return block.timestamp > plan.graceEndsAt(0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Decay
    // ─────────────────────────────────────────────────────────────────────────

    function _decayed() private view returns (uint256 observations, uint256 weighted) {
        uint256 window = parameters.get(ParameterKeys.FPD_OBSERVATION_WINDOW);
        uint256 elapsed = block.timestamp - _cohort.decayedAt;
        if (elapsed >= window) return (0, 0);

        observations = _cohort.observations - (_cohort.observations * elapsed) / window;
        weighted = _cohort.weightedDefaults - (_cohort.weightedDefaults * elapsed) / window;
    }

    function _decay() private {
        (uint256 observations, uint256 weighted) = _decayed();
        _cohort.observations = observations;
        _cohort.weightedDefaults = weighted;
        _cohort.decayedAt = uint64(block.timestamp);
    }
}
