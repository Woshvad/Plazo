// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {FirstPaymentDefaultSwitch} from "../src/FirstPaymentDefaultSwitch.sol";
import {ParameterRegistry} from "../src/ParameterRegistry.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";
import {ConfigurablePlan} from "./invariant/stubs/ConfigurablePlan.sol";

/// @notice The cohort kill switch — UW-03.
///
/// @dev Driven against `ConfigurablePlan` rather than real originations, because the
///      switch needs cohorts of fifty and above to say anything at all, and fifty
///      real originations would make this a gas benchmark rather than a test of the
///      mechanism. What is being tested is the arithmetic that decides whether the
///      book keeps lending, and that arithmetic reads one thing off a plan: the
///      status of installment zero.
///
///      The three properties, each answering a specific way a naive switch fails:
///      graduated rather than binary, silent below a minimum cohort, and weighted so
///      that manufacturing wallets is not a cheap way to close someone else's book.
contract KillSwitchTest is Test {
    ParameterRegistry internal parameters;
    FirstPaymentDefaultSwitch internal switchboard;

    uint256 internal nextPlan;

    function setUp() public {
        parameters = new ParameterRegistry(address(this));
        switchboard = new FirstPaymentDefaultSwitch(address(this), address(parameters));
        switchboard.grantRole(switchboard.REGISTRAR_ROLE(), address(this));
        vm.warp(365 days);
    }

    // ─── Cohort size ─────────────────────────────────────────────────────────

    /// @notice Below the minimum cohort the switch cannot fire at all.
    ///
    /// @dev Three defaults out of five plans is noise. A switch that fires on noise
    ///      is a switch an attacker trips for the price of five plans, and every
    ///      merchant on the network pays for it.
    function test_theSwitchIsSilentBelowTheMinimumCohort() public {
        _observe(10, 10, true); // every single one defaulted

        assertEq(switchboard.cohortSize(), 10, "cohort not recorded");
        assertEq(switchboard.fpdBps(), PlanParams.BPS, "a 100% default rate did not read as 100%");
        assertEq(
            switchboard.throttleBps(),
            PlanParams.BPS,
            "the switch fired on a cohort of ten"
        );
    }

    /// @notice Above the minimum, the same rate closes the book.
    function test_theSameRateFiresOnceTheCohortIsLargeEnough() public {
        uint256 minCohort = parameters.get(ParameterKeys.FPD_MIN_COHORT);
        _observe(minCohort, minCohort, true);

        assertEq(switchboard.throttleBps(), 0, "a 100% seasoned default rate left the book open");
    }

    // ─── Graduated, not binary ───────────────────────────────────────────────

    /// @notice The output is a throttle, not a boolean.
    ///
    /// @dev A book that stops originating entirely while its liabilities keep running
    ///      is a book in runoff. A switch whose only settings are "fine" and "closed"
    ///      gets set to "fine" by whoever has to explain the runoff, which is how a
    ///      kill switch ends up disabled in production.
    function test_theThrottleIsGraduatedBetweenTheTriggerAndTheFullStop() public {
        // 100 seasoned plans, 10 defaults: a 10% weighted rate. The trigger is 5% and
        // the full stop is 20%, so this lands a third of the way along the ramp.
        _observe(100, 10, true);

        assertEq(switchboard.fpdBps(), 1_000, "the weighted rate is not 10%");

        uint256 throttle = switchboard.throttleBps();
        assertGt(throttle, 0, "a mid-range default rate closed the book entirely");
        assertLt(throttle, PlanParams.BPS, "a mid-range default rate did not throttle at all");

        // A third of the way from 5% to 20% removes a third of the limit.
        assertApproxEqAbs(throttle, PlanParams.BPS - 3_333, 2, "the ramp is not linear");
        assertEq(switchboard.throttle(1_000e6), (1_000e6 * throttle) / PlanParams.BPS);
    }

    function test_aRateBelowTheTriggerChangesNothing() public {
        // 100 plans, 4 defaults: 4%, under the 5% trigger.
        _observe(100, 4, true);
        assertEq(switchboard.throttleBps(), PlanParams.BPS, "the switch fired below its trigger");
    }

    // ─── Weighting (the grief resistance) ────────────────────────────────────

    /// @notice New-wallet defaults move the switch less than seasoned ones.
    ///
    /// @dev The attack this exists for: mint a hundred wallets, take a hundred
    ///      minimum tickets, default on every first payment, and halt the book for
    ///      everyone. Weighting those observations at a quarter means buying the
    ///      throttle down requires *seasoned* wallets, and a seasoned wallet costs
    ///      real completed plans to produce. The attack does not become impossible;
    ///      it becomes more expensive than the damage it does, which is the only
    ///      durable form of impossible.
    function test_aNewWalletDefaultCountsAQuarterOfASeasonedOne() public {
        _observe(100, 20, false); // 20 new-wallet defaults out of 100
        uint256 newWalletRate = switchboard.fpdBps();

        setUp();
        _observe(100, 5, true); // 5 seasoned defaults out of 100
        uint256 seasonedRate = switchboard.fpdBps();

        assertEq(
            newWalletRate,
            seasonedRate,
            "twenty percent of new wallets did not read the same as five percent of seasoned ones"
        );
        assertEq(newWalletRate, 500, "the weighted rate is not 5%");
    }

    /// @notice Seasoning is fixed at origination, not read at observation.
    /// @dev Seasoning at the time of the decision is what was priced. A borrower who
    ///      becomes seasoned between origination and their first missed payment did
    ///      not make that decision better.
    function test_seasoningIsFrozenAtOrigination() public {
        bytes32 id = _register(false);
        _resolve(id, IInstallmentPlan.InstallmentStatus.Missed);

        assertFalse(switchboard.registrationOf(id).seasoned, "seasoning was not recorded");
        // One new-wallet default weighted at a quarter.
        assertEq(switchboard.fpdBps(), 2_500, "the new-wallet weight was not applied");
    }

    // ─── Reading the plan ────────────────────────────────────────────────────

    /// @notice The outcome is read off the plan, never accepted from the caller.
    ///
    /// @dev `observe` is permissionless and takes no verdict. GOV-08 requires the
    ///      whole loop to run with every operator role at the zero address, and a
    ///      kill switch fed by an operator is a kill switch that stops working the
    ///      moment an operator has a reason to want it to.
    function test_anybodyCanObserveAndNobodyCanLie() public {
        bytes32 id = _register(true);
        ConfigurablePlan p = ConfigurablePlan(switchboard.registrationOf(id).plan);
        p.setStatus(0, IInstallmentPlan.InstallmentStatus.Cleared);

        vm.prank(address(0xD00D));
        switchboard.observe(id);

        assertFalse(switchboard.registrationOf(id).defaulted, "a cleared first payment read as a default");
        assertEq(switchboard.fpdBps(), 0, "a cleared cohort produced a default rate");
    }

    /// @notice A plan whose first installment is still live cannot be observed.
    function test_anUnresolvedFirstInstallmentIsNotYetObservable() public {
        bytes32 id = _register(true);
        ConfigurablePlan p = ConfigurablePlan(switchboard.registrationOf(id).plan);

        assertFalse(switchboard.isObservable(id), "an unresolved installment reported observable");
        vm.expectRevert(
            abi.encodeWithSelector(
                FirstPaymentDefaultSwitch.NotYetObservable.selector, id, p.graceEndsAt(0)
            )
        );
        switchboard.observe(id);
    }

    /// @notice Grace expiring makes an unmarked bounce readable.
    ///
    /// @dev Without this the switch waits forever on exactly the cohort it needs to
    ///      see: a plan that bounced and was never marked would sit unobservable, and
    ///      the plans nobody bothered to crank are disproportionately the bad ones.
    function test_graceExpiringMakesAnUnmarkedBounceReadable() public {
        bytes32 id = _register(true);
        ConfigurablePlan p = ConfigurablePlan(switchboard.registrationOf(id).plan);
        p.setStatus(0, IInstallmentPlan.InstallmentStatus.Bounced);

        vm.warp(p.graceEndsAt(0) + 1);
        assertTrue(switchboard.isObservable(id), "an expired grace did not make the bounce readable");

        switchboard.observe(id);
        assertTrue(switchboard.registrationOf(id).defaulted, "the bounce did not count as a default");
    }

    /// @notice A refunded first installment is not a credit observation.
    /// @dev A merchant reversing a sale says nothing about the borrower, and counting
    ///      it as a default would let any merchant throttle the whole book by
    ///      refunding their own orders.
    function test_aRefundedFirstInstallmentIsNotADefault() public {
        bytes32 id = _register(true);
        ConfigurablePlan p = ConfigurablePlan(switchboard.registrationOf(id).plan);
        p.setStatus(0, IInstallmentPlan.InstallmentStatus.Refunded);

        vm.warp(p.graceEndsAt(0) + 1);
        switchboard.observe(id);

        assertFalse(switchboard.registrationOf(id).defaulted, "a refund counted as a default");
    }

    function test_aPlanIsObservedOnlyOnce() public {
        bytes32 id = _register(true);
        _resolve(id, IInstallmentPlan.InstallmentStatus.Missed);

        vm.expectRevert(abi.encodeWithSelector(FirstPaymentDefaultSwitch.AlreadyObserved.selector, id));
        switchboard.observe(id);
    }

    // ─── Decay ───────────────────────────────────────────────────────────────

    /// @notice Observations age out of the window.
    ///
    /// @dev A rate computed over all history stops responding exactly when it
    ///      matters: a book that ran badly in month one would carry that throttle
    ///      into month twelve, and a book that ran well for a year would absorb a
    ///      fresh wave of fraud without noticing.
    function test_observationsDecayOutOfTheWindow() public {
        uint256 minCohort = parameters.get(ParameterKeys.FPD_MIN_COHORT);
        _observe(minCohort, minCohort, true);
        assertEq(switchboard.throttleBps(), 0, "the book stayed open on a total default cohort");

        vm.warp(block.timestamp + parameters.get(ParameterKeys.FPD_OBSERVATION_WINDOW));

        assertEq(switchboard.cohortSize(), 0, "the cohort did not decay");
        assertEq(switchboard.throttleBps(), PlanParams.BPS, "the throttle did not lift with the cohort");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _register(bool seasoned) private returns (bytes32 id) {
        ConfigurablePlan p = new ConfigurablePlan();
        p.initHealthy(4, 100e6, block.timestamp + 1 days, 14 days);

        id = keccak256(abi.encode("plan", nextPlan++));
        switchboard.noteOrigination(id, address(p), seasoned);
    }

    function _resolve(bytes32 id, IInstallmentPlan.InstallmentStatus status) private {
        ConfigurablePlan(switchboard.registrationOf(id).plan).setStatus(0, status);
        switchboard.observe(id);
    }

    /// @dev `total` plans, of which `defaults` missed their first payment.
    function _observe(uint256 total, uint256 defaults, bool seasoned) private {
        for (uint256 i = 0; i < total; ++i) {
            bytes32 id = _register(seasoned);
            _resolve(
                id,
                i < defaults
                    ? IInstallmentPlan.InstallmentStatus.Missed
                    : IInstallmentPlan.InstallmentStatus.Cleared
            );
        }
    }
}
