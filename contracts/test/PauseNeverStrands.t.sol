// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {OriginationFixture} from "./helpers/OriginationFixture.sol";

import {CheckoutRouter} from "../src/CheckoutRouter.sol";
import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {OriginationPause} from "../src/OriginationPause.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {PlanId} from "../src/libraries/PlanId.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";

/// @notice GOV-03 — a pause that cannot reach a borrower.
///
/// @dev The requirement is "per-corridor and global pause switches exist and never
///      strand borrower funds", and the second half is the one worth proving rather
///      than asserting. This file pauses everything the protocol has a switch for and
///      then drives a live plan through the whole of its remaining life: collect,
///      bounce, mark, cure, pay off, and settle with the underwriter.
///
///      **A collections system that can stop accepting money is a collections system
///      that can manufacture a default.** The borrower who tried to pay and could not
///      is delinquent through no act of their own, and the loss is real — it lands on
///      their credit record, their late fee and, in this protocol, on the pool. Every
///      incumbent's emergency lever has this property. This one does not, and the
///      reason is structural rather than procedural: `InstallmentPlan` has no owner,
///      no pauser and no upgrade path, so there is no message the pause plane could
///      send it even if someone wanted to.
contract PauseNeverStrandsTest is OriginationFixture {
    function setUp() public {
        _deployStack();
        _prepareOrigination();
    }

    /// @notice Everything paused; the plan runs to payoff regardless.
    function test_aFullyPausedProtocolCannotStrandALivePlan() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        // Every switch the protocol has.
        pauses.pause();
        pauses.pauseCorridor(checkout.corridorOf(address(usdc)));
        assertFalse(pauses.isOpen(checkout.corridorOf(address(usdc))), "the pause did not take");

        // 1. A keeper still collects.
        _fundBorrower(p.installmentAmount(0));
        vm.warp(p.dueDate(0) + 1);
        vm.prank(keeper);
        (bool cleared,) = p.collect(0);
        assertTrue(cleared, "a paused protocol blocked a collection");

        // 2. A drained borrower still bounces rather than reverting.
        vm.warp(p.dueDate(1) + 1);
        vm.prank(keeper);
        (bool second, IInstallmentPlan.BounceReason reason) = p.collect(1);
        assertFalse(second, "the second pull should have failed on funds");
        assertEq(
            uint8(reason),
            uint8(IInstallmentPlan.BounceReason.InsufficientFunds),
            "a paused protocol changed why a pull failed"
        );

        // 3. The delinquency signal still gets written, and still gets paid for.
        vm.warp(p.graceEndsAt(1) + 1);
        uint256 markerBefore = usdc.balanceOf(stranger);
        vm.prank(stranger);
        p.markMissed(1);
        assertEq(
            usdc.balanceOf(stranger) - markerBefore,
            PlanParams.MARK_BOUNTY,
            "a paused protocol stopped paying for the delinquency signal"
        );
        assertEq(
            uint8(p.state()), uint8(IInstallmentPlan.PlanState.Delinquent), "the plan is not delinquent"
        );

        // 4. The borrower still cures and pays off.
        _payOff(p);
        assertEq(uint8(p.state()), uint8(IInstallmentPlan.PlanState.Repaid), "a paused protocol blocked payoff");

        // 5. The book still recognises it and the borrower's slot still reopens.
        creditPool.recognise(id);
        tier0.notePlanOutcome(id);
        assertEq(tier0.personOf(_personId()).activePlans, 0, "a paused protocol held the borrower's slot");
    }

    /// @notice What the pause does stop is new credit.
    function test_aGlobalPauseStopsOrigination() public {
        pauses.pause();

        CheckoutRouter.OriginationInput memory input =
            _originationInput(_terms(PRINCIPAL, COUNT, 1), keccak256("s"), 5_000e6);

        vm.expectRevert(OriginationPause.OriginationPaused.selector);
        checkout.originate(input);
    }

    /// @notice A corridor can be closed without closing the protocol.
    ///
    /// @dev Two distinct errors, on purpose. A merchant told "originations are paused"
    ///      when only one corridor is down escalates the wrong thing, and an operator
    ///      reading the support ticket needs to know which switch someone threw.
    function test_aCorridorPauseIsScopedToThatCorridor() public {
        bytes32 corridor = checkout.corridorOf(address(usdc));
        pauses.pauseCorridor(corridor);

        CheckoutRouter.OriginationInput memory input =
            _originationInput(_terms(PRINCIPAL, COUNT, 1), keccak256("s"), 5_000e6);

        vm.expectRevert(
            abi.encodeWithSelector(OriginationPause.CorridorOriginationPaused.selector, corridor)
        );
        checkout.originate(input);

        assertFalse(pauses.globallyPaused(), "a corridor pause escalated to a global one");
        assertTrue(pauses.isOpen(keccak256("some other corridor")), "an unrelated corridor closed");
    }

    /// @notice Pausing is fast; unpausing is deliberate.
    ///
    /// @dev An incident-response key that can also declare the incident over is a key
    ///      that will be used to declare the incident over.
    function test_thePauserCannotUnpause() public {
        address pauser = address(0xA1E27);
        pauses.grantRole(pauses.PAUSER_ROLE(), pauser);

        vm.prank(pauser);
        pauses.pause();
        assertTrue(pauses.globallyPaused());

        vm.prank(pauser);
        vm.expectRevert();
        pauses.unpause();

        pauses.unpause();
        assertFalse(pauses.globallyPaused(), "the admin could not restart the protocol");
    }

    /// @notice Origination resumes exactly where it left off.
    function test_originationResumesAfterAnUnpause() public {
        pauses.pause();
        pauses.unpause();

        _checkoutDefault();
        assertEq(uint8(plan.state()), uint8(IInstallmentPlan.PlanState.Pending), "the plan did not originate");
    }
}
