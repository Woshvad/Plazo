// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {PlanInvariants, IPlanFlowView} from "./PlanInvariants.sol";
import {PoolInvariants} from "./PoolInvariants.sol";
import {ConfigurablePlan} from "./stubs/ConfigurablePlan.sol";
import {ConfigurablePool} from "./stubs/ConfigurablePool.sol";
import {IInstallmentPlan} from "../../src/interfaces/IInstallmentPlan.sol";
import {ICreditPool} from "../../src/interfaces/ICreditPool.sol";

/// @title The invariant suite bites
///
/// @notice Proves every property in `PlanInvariants` and `PoolInvariants` actually
///         fails when it is violated.
///
/// @dev The phase criterion is that the invariant suite was written *before* the
///      contracts it constrains. The obvious way to evidence that — point it at
///      nothing and watch it fail — evidences almost nothing: a suite that fails
///      because the target is missing would fail identically if every assertion in
///      it were `assertTrue(true)`.
///
///      So each property is driven into failure deliberately, one at a time, from a
///      baseline that satisfies all of them. A property that cannot be made to fail
///      is not a property, and this file would catch that.
///
///      Phase 2 and Phase 5 rebind the same abstract suites to the real
///      `InstallmentPlan` and `CreditPool` and run them under the invariant fuzzer.
///      Nothing here changes at that point.
contract PlanInvariantsBiteTest is PlanInvariants {
    ConfigurablePlan internal sut;

    uint256 internal constant PRINCIPAL = 100_000_000; // 100 USDC
    uint256 internal constant COUNT = 4;

    function setUp() public {
        vm.warp(1_800_000_000);
        sut = new ConfigurablePlan();
        // Schedule starts a year out, so nothing is overdue in the baseline.
        sut.initHealthy(COUNT, PRINCIPAL, vm.getBlockTimestamp() + 365 days, 14 days);
        subject = IInstallmentPlan(address(sut));
        flows = IPlanFlowView(address(sut));
    }

    function test_baselineSatisfiesEveryInvariant() public view {
        check_valueIsConserved();
        check_outstandingNeverExceedsPrincipal();
        check_payoffCoversOutstanding();
        check_noInstallmentClearsTwice();
        check_everyOverdueInstallmentIsAccountedFor();
        check_scheduleIsMonotone();
        check_graceFollowsDueDate();
        check_terminalStatesAreClean();
        check_settledWithFeeOutstandingIsCoherent();
        check_refundOnlyToBorrower();
        check_escrowNeverStrandsSettlement();
    }

    /// @dev Collections that do not retire principal or pay a fee. The plan is
    ///      holding float it cannot account for.
    function test_catchesValueLeak() public {
        sut.setAccounting(PRINCIPAL, 25_000_000, 0, 0, 0);
        vm.expectRevert();
        this.check_valueIsConserved();
    }

    function test_catchesOutstandingAbovePrincipal() public {
        sut.setAccounting(PRINCIPAL + 1, 0, 0, 0, 0);
        vm.expectRevert();
        this.check_outstandingNeverExceedsPrincipal();
    }

    /// @dev Payoff understating the debt. A borrower who paid it in full would
    ///      still be delinquent — they did everything asked and the plan disagrees.
    function test_catchesUnderstatedPayoff() public {
        sut.setAccounting(PRINCIPAL, 0, 0, 5_000_000, 0);
        sut.setPayoffOverride(PRINCIPAL); // silently drops the outstanding fee

        vm.expectRevert();
        this.check_payoffCoversOutstanding();
    }

    /// @dev Payoff overstating the debt. The protocol would be collecting money it
    ///      cannot account for, which the conservation invariant would then catch
    ///      one step later.
    function test_catchesOverstatedPayoff() public {
        sut.setAccounting(PRINCIPAL, 0, 0, 0, 0);
        sut.setPayoffOverride(PRINCIPAL + 1);

        vm.expectRevert();
        this.check_payoffCoversOutstanding();
    }

    /// @dev More installments marked cleared than value ever arrived.
    function test_catchesDoubleClear() public {
        sut.setStatus(0, IInstallmentPlan.InstallmentStatus.Cleared);
        sut.setStatus(1, IInstallmentPlan.InstallmentStatus.Cleared);
        sut.setAccounting(PRINCIPAL - 25_000_000, 25_000_000, 0, 0, 0);

        vm.expectRevert();
        this.check_noInstallmentClearsTwice();
    }

    /// @dev The one that matters most: an installment sits past grace with no
    ///      recorded outcome. This is the delinquency signal that, left to the
    ///      token, nobody creates.
    function test_catchesUnrecordedDelinquency() public {
        vm.warp(subject.graceEndsAt(0) + 1);
        // Status is still Pending — the pull reverted, so nothing was emitted.
        vm.expectRevert();
        this.check_everyOverdueInstallmentIsAccountedFor();
    }

    /// @dev A bounce that was recorded but never marked is equally unaccounted.
    ///      `Bounced` is transient; resting there past grace is the exact condition
    ///      that must block epoch settlement.
    function test_catchesBouncedButUnmarked() public {
        sut.setStatus(0, IInstallmentPlan.InstallmentStatus.Bounced);
        vm.warp(subject.graceEndsAt(0) + 1);

        vm.expectRevert();
        this.check_everyOverdueInstallmentIsAccountedFor();
    }

    /// @dev A marked delinquency is accounted for, even though nothing was collected.
    function test_markedDelinquencySatisfiesTheGuarantee() public {
        sut.setStatus(0, IInstallmentPlan.InstallmentStatus.Missed);
        vm.warp(subject.graceEndsAt(0) + 1);
        check_everyOverdueInstallmentIsAccountedFor();
    }

    function test_catchesNonMonotoneSchedule() public {
        sut.setDueDate(2, subject.dueDate(1) - 1);
        vm.expectRevert();
        this.check_scheduleIsMonotone();
    }

    function test_catchesGraceBeforeDueDate() public {
        sut.setGraceEndsAt(1, subject.dueDate(1) - 1);
        vm.expectRevert();
        this.check_graceFollowsDueDate();
    }

    /// @dev A plan reporting `Repaid` while still carrying debt. There is no path
    ///      from `Repaid` back to `Grace`, so this state would be permanent.
    function test_catchesDirtyRepaid() public {
        sut.setState(IInstallmentPlan.PlanState.Repaid);
        sut.setAccounting(1_000_000, 0, 0, 0, 0);

        vm.expectRevert();
        this.check_terminalStatesAreClean();
    }

    /// @dev A refunded plan leaving principal the pool still believes it holds.
    function test_catchesRefundedWithOutstandingPrincipal() public {
        sut.setState(IInstallmentPlan.PlanState.Refunded);
        sut.setAccounting(40_000_000, 0, 0, 0, 0);

        vm.expectRevert();
        this.check_terminalStatesAreClean();
    }

    function test_catchesIncoherentSettledWithFeeOutstanding() public {
        sut.setState(IInstallmentPlan.PlanState.SettledWithFeeOutstanding);
        sut.setAccounting(0, 0, 0, 0, 0); // no fee outstanding — so why this state

        vm.expectRevert();
        this.check_settledWithFeeOutstandingIsCoherent();
    }

    /// @dev A refund whose residue went somewhere the borrower never named. The
    ///      on-chain redirection attack is impossible in today's `creditRefund`, and
    ///      this is what would notice the day a recipient parameter gets added for
    ///      somebody's convenience.
    function test_catchesRefundToAThirdParty() public {
        sut.setRefundFlow(100_000_000, 60_000_000, 15_000_000, 25_000_000);

        vm.expectRevert();
        this.check_refundOnlyToBorrower();
    }

    /// @dev The same flow with nothing diverted, but not exhaustive: 40 arrived and
    ///      nowhere accounts for it. Without this row the property would pass on any
    ///      leak that simply failed to name its destination.
    function test_catchesRefundResidue() public {
        sut.setRefundFlow(100_000_000, 60_000_000, 0, 0);

        vm.expectRevert();
        this.check_refundOnlyToBorrower();
    }

    /// @dev A settlement in none of its three states — the fourth outcome MERCH-04's
    ///      state machine is not allowed to have.
    function test_catchesStrandedSettlement() public {
        sut.setSettlement(407_000_000, 0, 0, 0, false);

        vm.expectRevert();
        this.check_escrowNeverStrandsSettlement();
    }

    /// @dev Accounted for, and still stranded: held in full with neither exit
    ///      reachable. This is the clause that makes the property about D-07's
    ///      permissionless exits rather than only about arithmetic.
    function test_catchesHeldSettlementWithNoExit() public {
        sut.setSettlement(407_000_000, 407_000_000, 0, 0, false);

        vm.expectRevert();
        this.check_escrowNeverStrandsSettlement();
    }
}

contract PoolInvariantsBiteTest is PoolInvariants {
    ConfigurablePool internal sut;

    uint256 internal constant ASSETS = 1_000_000_000_000; // 1,000,000 USDC

    function setUp() public {
        sut = new ConfigurablePool();
        sut.initHealthy(ASSETS);
        pool = ICreditPool(address(sut));
    }

    function test_baselineSatisfiesEveryInvariant() public view {
        check_assetsEqualClaims();
        check_sharesImplyAssets();
        check_provisionBucketsSumToTotal();
        check_provisionNeverExceedsAssets();
        check_reserveAbsorbsBeforeJunior();
        check_subordinationIsDerived();
        check_originationClosedBelowFloors();
        check_epochBlocksOnUnmarkedDelinquency();
    }

    /// @dev The most important failure in the book: assets and claims disagree, so
    ///      someone's shares are backed by nothing.
    function test_catchesInsolventBalanceSheet() public {
        sut.setBalanceSheet(ASSETS, 0, ASSETS / 2, ASSETS / 2 + 1);
        vm.expectRevert();
        this.check_assetsEqualClaims();
    }

    /// @dev Shares outstanding against zero assets — the next depositor funds the
    ///      previous one. Half of the first-depositor inflation attack.
    function test_catchesSharesWithoutAssets() public {
        sut.setBalanceSheet(ASSETS, ASSETS, 0, 0);
        sut.setShares(ICreditPool.Tranche.Junior, 1000);

        vm.expectRevert();
        this.check_sharesImplyAssets();
    }

    /// @dev Un-bucketed provisioning. The buckets and the total disagree, which is
    ///      exactly the state in which a cure cannot release what the delinquency
    ///      took — the harvestable NAV oscillation.
    function test_catchesUnbucketedProvision() public {
        sut.setEpoch(3);
        sut.setProvision(1, 10_000_000);
        sut.setProvision(2, 5_000_000);
        sut.setTotalProvisioned(50_000_000);

        vm.expectRevert();
        this.check_provisionBucketsSumToTotal();
    }

    function test_catchesProvisionExceedingAssets() public {
        sut.setTotalProvisioned(ASSETS + 1);
        vm.expectRevert();
        this.check_provisionNeverExceedsAssets();
    }

    /// @dev Junior impaired below its floor while the reserve still holds assets.
    ///      Senior was sold a subordination it does not have.
    function test_catchesOutOfOrderLossWaterfall() public {
        uint256 reserve = ASSETS / 20; // 5% still sitting there
        uint256 junior = ASSETS / 100; // 1%, well under the 10% floor
        sut.setBalanceSheet(ASSETS, reserve, junior, ASSETS - reserve - junior);

        vm.expectRevert();
        this.check_reserveAbsorbsBeforeJunior();
    }

    /// @dev Origination open below the subordination floor.
    function test_catchesOriginationBelowSubordinationFloor() public {
        uint256 junior = ASSETS / 100;
        sut.setBalanceSheet(ASSETS, 0, junior, ASSETS - junior);
        sut.setOriginationOpen(true);

        vm.expectRevert();
        this.check_originationClosedBelowFloors();
    }

    /// @dev Origination open with the first-loss reserve drained.
    function test_catchesOriginationBelowReserveFloor() public {
        uint256 junior = (ASSETS * 1500) / 10_000;
        sut.setBalanceSheet(ASSETS, 0, junior, ASSETS - junior);
        sut.setOriginationOpen(true);

        vm.expectRevert();
        this.check_originationClosedBelowFloors();
    }

    /// @dev The book keeps originating with delinquencies nobody has recorded, so
    ///      its reported NAV is against losses that have not been recognised.
    function test_catchesOriginatingWithUnmarkedDelinquencies() public {
        sut.setAllDelinquenciesMarked(false);
        sut.setOriginationOpen(true);

        vm.expectRevert();
        this.check_epochBlocksOnUnmarkedDelinquency();
    }
}
