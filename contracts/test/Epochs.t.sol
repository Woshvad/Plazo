// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";

import {OriginationFixture} from "./helpers/OriginationFixture.sol";
import {ConfigurablePlan} from "./invariant/stubs/ConfigurablePlan.sol";

import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {TranchedCreditPool} from "../src/TranchedCreditPool.sol";
import {ICreditPool} from "../src/interfaces/ICreditPool.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";

/// @title EpochsTest
/// @notice The two-phase crank, the provision round trip, and the charge-off.
///
/// @dev POOL-04, POOL-07, POOL-14, CURE-04 and COLL-04. The provision round trip gets
///      the most attention because it is where the harvestable NAV oscillation lives: a
///      release that returns anything other than exactly what the delinquency took is a
///      free option for whoever deposits at the trough, and junior pays for it.
contract EpochsTest is OriginationFixture {
    function setUp() public {
        _deployStack();
        _prepareOrigination();
    }

    // ─── POOL-04: the crank ──────────────────────────────────────────────────

    /// @notice The mark phase is incremental and idempotent.
    /// @dev A crank that had to walk the whole book in one transaction would revert as
    ///      the book grew, and a book that cannot close its epoch cannot price a
    ///      deposit. Bounded batches with a cursor mean the cost of closing scales with
    ///      the operator's patience rather than with the book.
    /// @dev Three stub plans rather than three originations, because Tier 0 allows one
    ///      active plan per person and what is under test here is the crank, not the
    ///      limit. The pool reads a stub exactly as it reads a real plan.
    function test_theMarkPhaseIsIncrementalAndIdempotent() public {
        creditPool.setOriginator(address(this));
        _frontStub("a", 500e6);
        _frontStub("b", 500e6);
        _frontStub("c", 500e6);

        vm.warp(creditPool.epochEndsAt() + 1);
        creditPool.markEpoch(16);
        creditPool.closeEpoch();
        vm.warp(creditPool.epochEndsAt() + 1);

        uint256 epochBefore = creditPool.currentEpoch();
        assertFalse(creditPool.markComplete(), "the phase claimed to be done before it ran");
        creditPool.markEpoch(1);
        assertFalse(creditPool.markComplete(), "one plan finished a three-plan book");
        creditPool.markEpoch(1);
        creditPool.markEpoch(1);
        assertTrue(creditPool.markComplete(), "the phase never completed");

        // Running it again changes nothing.
        creditPool.markEpoch(16);
        assertTrue(creditPool.markComplete());
        creditPool.closeEpoch();
        assertEq(creditPool.currentEpoch(), epochBefore + 1, "the epoch did not advance");
    }

    /// @notice An epoch cannot close before its time.
    function test_anEpochCannotCloseEarly() public {
        vm.expectRevert(
            abi.encodeWithSelector(TranchedCreditPool.EpochNotOver.selector, creditPool.epochEndsAt())
        );
        creditPool.closeEpoch();
    }

    /// @notice An epoch cannot close with the mark phase unfinished.
    /// @dev A plan fronted inside the current epoch counts as already walked — it was
    ///      booked a moment ago and nothing has happened to it since. It is the *next*
    ///      epoch that has to walk it, which is what this asserts.
    function test_anEpochCannotCloseWithTheBookUnwalked() public {
        _checkoutDefault();

        vm.warp(creditPool.epochEndsAt() + 1);
        creditPool.markEpoch(16);
        creditPool.closeEpoch();

        vm.warp(creditPool.epochEndsAt() + 1);
        vm.expectRevert(abi.encodeWithSelector(TranchedCreditPool.MarkPhaseIncomplete.selector, 0, 1));
        creditPool.closeEpoch();
    }

    // ─── COLL-04: the unmarked delinquency blocks the close ──────────────────

    /// @notice A plan past grace with no mark stops the book from closing.
    ///
    /// @dev What makes the bountied mark unavoidable rather than merely available.
    ///      Nobody profits from cranking a collection that cannot succeed, so the
    ///      negative signal has to be paid for — and the payment only reliably happens
    ///      if the book cannot publish a NAV without it. Otherwise an operator could
    ///      settle an epoch on a book whose losses have not been recognised and report a
    ///      number that is simply wrong.
    function test_anUnmarkedDelinquencyBlocksTheClose() public {
        InstallmentPlan p = _checkoutDefault();

        // Close one epoch first. A plan fronted inside the current epoch counts as
        // already walked, so the crank would skip it and never look at its installments.
        vm.warp(creditPool.epochEndsAt() + 1);
        creditPool.markEpoch(16);
        creditPool.closeEpoch();
        uint256 epochBefore = creditPool.currentEpoch();

        // The grace window closes well after the epoch does, so this one warp carries
        // past both. Warping back to `epochEndsAt` afterwards would move the clock
        // backwards and quietly un-do the delinquency the test is about.
        vm.warp(p.graceEndsAt(0) + 1);
        creditPool.markEpoch(16);

        assertFalse(creditPool.allDelinquenciesMarked(), "the pool did not see the delinquency");
        vm.expectRevert(abi.encodeWithSelector(TranchedCreditPool.UnmarkedDelinquencyOutstanding.selector, 1));
        creditPool.closeEpoch();

        vm.prank(keeper);
        p.markMissed(0);
        creditPool.recognise(planId);

        creditPool.closeEpoch();
        assertEq(creditPool.currentEpoch(), epochBefore + 1, "the mark did not unblock the close");
    }

    // ─── POOL-07: provisioning ───────────────────────────────────────────────

    /// @notice A delinquent plan marks NAV down by half its carrying value.
    function test_aDelinquentPlanProvisionsHalfItsCarrying() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        uint256 assetsBefore = creditPool.totalAssets();
        _driveToDelinquency(p);
        creditPool.recognise(id);

        uint256 carrying = creditPool.bookOf(id).carrying;
        uint256 expected =
            (carrying * parameters.get(ParameterKeys.DELINQUENT_PROVISION_BPS)) / PlanParams.BPS;

        assertEq(creditPool.provisionOf(id).amount, expected, "the provision was not half the carrying");
        assertEq(assetsBefore - creditPool.totalAssets(), expected, "the provision did not reach NAV");
        assertEq(
            creditPool.provisionedAt(creditPool.currentEpoch()),
            expected,
            "the provision landed in no epoch bucket"
        );
    }

    /// @notice A cure releases exactly what the delinquency took.
    ///
    /// @dev D11's whole argument, as a round trip. A flat provision released at whatever
    ///      the current rate happens to be is a harvestable oscillation: deposit at the
    ///      trough, redeem after the cure wave, funded by whoever redeemed at the
    ///      trough. Junior wears it, because junior is the leveraged claim on the
    ///      residual. Exactness is the fix, and the fix has to be in the accounting.
    function test_aCureReleasesExactlyWhatTheDelinquencyTook() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        uint256 assetsBefore = creditPool.totalAssets();
        uint256 reserveBefore = creditPool.reserveBalance();
        uint256 juniorBefore = creditPool.trancheAssets(ICreditPool.Tranche.Junior);
        uint256 seniorBefore = creditPool.trancheAssets(ICreditPool.Tranche.Senior);

        _driveToDelinquency(p);
        creditPool.recognise(id);
        assertGt(creditPool.totalProvisioned(), 0, "nothing was provisioned");

        // Cure by paying the whole plan off, then crank.
        _payOff(p);
        creditPool.recognise(id);

        assertEq(creditPool.totalProvisioned(), 0, "the provision was not released");
        assertEq(creditPool.provisionedAt(1), 0, "the epoch bucket was not emptied");
        assertGe(creditPool.totalAssets(), assetsBefore, "the round trip lost the book money");

        // The waterfall came back in the order it went down.
        assertGe(creditPool.reserveBalance(), reserveBefore - 1, "the reserve was not rebuilt");
        assertGe(
            creditPool.trancheAssets(ICreditPool.Tranche.Junior), juniorBefore - 1, "junior was not restored"
        );
        assertGe(
            creditPool.trancheAssets(ICreditPool.Tranche.Senior), seniorBefore - 1, "senior was not restored"
        );
    }

    /// @notice Provisioning twice does not provision twice.
    /// @dev Idempotence matters because `recognise` is permissionless and anybody can
    ///      run it in a loop. A crank that compounded would let a griefer mark a healthy
    ///      book to zero for the price of gas.
    function test_provisioningIsIdempotent() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        _driveToDelinquency(p);
        creditPool.recognise(id);
        uint256 once = creditPool.totalProvisioned();

        creditPool.recognise(id);
        creditPool.recognise(id);
        assertEq(creditPool.totalProvisioned(), once, "a repeated crank compounded the provision");
    }

    // ─── CURE-04: charge-off ─────────────────────────────────────────────────

    /// @notice A charge-off releases the provision and takes the loss once.
    ///
    /// @dev DEC-25. A provision is an estimate and reversible; a charge-off is neither.
    ///      Doing both would charge the same money twice, and doing neither would let a
    ///      defaulted book keep quoting par.
    function test_aChargeOffReleasesTheProvisionAndTakesTheLossOnce() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        _driveToDelinquency(p);
        creditPool.recognise(id);

        uint256 provisioned = creditPool.totalProvisioned();
        assertGt(provisioned, 0, "nothing was provisioned before charge-off");

        uint256 assetsBeforeChargeOff = creditPool.totalAssets();
        uint256 carrying = creditPool.bookOf(id).carrying;
        uint256 unearned = creditPool.bookOf(id).deferredIncome;

        vm.warp(p.dueDate(0) + PlanParams.CHARGE_OFF_AFTER + 1);
        vm.prank(keeper);
        p.chargeOff();

        // The loss is read off the waterfall's own event rather than inferred from the
        // net asset movement. The same crank also books the unspent mark escrow coming
        // back and the last of the fee earning, and netting three things together would
        // make the assertion pass for the wrong reason.
        vm.recordLogs();
        creditPool.recognise(id);
        uint256 struck = _lossAbsorbed(vm.getRecordedLogs());

        assertEq(creditPool.totalProvisioned(), 0, "the provision survived the charge-off");
        assertEq(uint8(p.state()), uint8(IInstallmentPlan.PlanState.Defaulted), "the plan did not charge off");

        // Net movement is the real loss: the provision came back and the write-off went
        // out, and the write-off is the carrying value less the fee that was never
        // earned but also never left the building.
        assertEq(struck, carrying - unearned, "the book charged the loss twice, or not at all");
        assertLt(
            assetsBeforeChargeOff - creditPool.totalAssets(),
            carrying,
            "the book wrote off more than it had paid out"
        );
        assertFalse(creditPool.bookOf(id).open, "the book stayed open on a charged-off plan");
    }

    // ─── POOL-14: fraud is not a credit loss ─────────────────────────────────

    /// @notice A fraud loss hits the reserve, not the credit waterfall.
    ///
    /// @dev A senior tranche sold on subordination should not be struck because a
    ///      merchant committed fraud — that is what the reserve is for, and the two
    ///      losses have opposite meanings for anyone reading the book's performance.
    function test_aFraudLossRoutesToTheReserve() public {
        creditPool.setOriginator(address(this));

        uint256 amount = 1000e6;
        ConfigurablePlan stub = new ConfigurablePlan();
        stub.initHealthy(4, amount, vm.getBlockTimestamp() + 365 days, 14 days);

        bytes32 id = keccak256("fraud");
        creditPool.front(
            id, address(stub), merchant, checkout.corridorOf(address(usdc)), amount, 0, 0, address(this)
        );

        uint256 reserveBefore = creditPool.reserveBalance();
        uint256 juniorBefore = creditPool.trancheAssets(ICreditPool.Tranche.Junior);

        stub.setState(IInstallmentPlan.PlanState.FraudReversed);
        creditPool.recognise(id);

        assertEq(reserveBefore - creditPool.reserveBalance(), amount, "the reserve did not absorb the fraud");
        assertEq(
            creditPool.trancheAssets(ICreditPool.Tranche.Junior),
            juniorBefore,
            "a fraud loss reached the credit waterfall"
        );
    }

    // ─── The income waterfall ────────────────────────────────────────────────

    /// @notice Senior's target accrues and is paid before junior's residual.
    ///
    /// @dev The mirror of the loss waterfall, and what makes junior a tranche rather
    ///      than a worse version of the same claim: paid last and struck first, against
    ///      a senior claim paid first and struck last. Splitting income pro rata — which
    ///      is what the flat Phase 3 book did — gave junior a leveraged exposure to
    ///      losses and an unleveraged one to gains.
    function test_seniorIsPaidItsTargetBeforeJuniorTakesTheResidual() public {
        uint256 baseline = creditPool.seniorAccrued();

        vm.warp(creditPool.epochEndsAt() + 1);
        creditPool.markEpoch(16);
        creditPool.closeEpoch();

        uint256 accrued = creditPool.seniorAccrued();
        assertGt(accrued, baseline, "senior's target did not accrue over an epoch");

        uint256 seniorBefore = creditPool.trancheAssets(ICreditPool.Tranche.Senior);
        uint256 juniorBefore = creditPool.trancheAssets(ICreditPool.Tranche.Junior);

        // Income arrives: a plan repays and its fee earns.
        InstallmentPlan p = _checkoutDefault();
        _payOff(p);
        creditPool.recognise(planId);

        assertGt(
            creditPool.trancheAssets(ICreditPool.Tranche.Senior),
            seniorBefore,
            "senior's accrued claim was not paid out of income"
        );
        assertGe(creditPool.trancheAssets(ICreditPool.Tranche.Junior), juniorBefore);
        assertLt(creditPool.seniorAccrued(), accrued, "the accrued claim was not drawn down");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev The total a `LossAbsorbed` event says the waterfall took, across all three
    ///      layers. Zero if the crank took no loss at all, which is itself a failure the
    ///      assertion will catch.
    function _lossAbsorbed(Vm.Log[] memory logs) private pure returns (uint256 total) {
        bytes32 topic = keccak256("LossAbsorbed(bytes32,uint256,uint256,uint256)");
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != topic) continue;
            (uint256 fromReserve, uint256 fromJunior, uint256 fromSenior) =
                abi.decode(logs[i].data, (uint256, uint256, uint256));
            total += fromReserve + fromJunior + fromSenior;
        }
    }

    /// @dev A stub plan fronted straight against the book, for tests about the crank
    ///      rather than about origination.
    function _frontStub(bytes32 tag, uint256 amount) private returns (bytes32 id) {
        ConfigurablePlan stub = new ConfigurablePlan();
        stub.initHealthy(4, amount, vm.getBlockTimestamp() + 365 days, 14 days);
        id = keccak256(abi.encode("stub", tag));
        creditPool.front(
            id, address(stub), merchant, checkout.corridorOf(address(usdc)), amount, 0, 0, address(this)
        );
    }

    /// @dev Miss the first installment and let the grace window close, which is the
    ///      only way a plan reaches `Delinquent`.
    function _driveToDelinquency(InstallmentPlan p) private {
        vm.warp(p.graceEndsAt(0) + 1);
        vm.prank(keeper);
        p.markMissed(0);
    }
}
