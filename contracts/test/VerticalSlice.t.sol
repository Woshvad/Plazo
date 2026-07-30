// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {PlanFixture} from "./helpers/PlanFixture.sol";
import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {PlanId} from "../src/libraries/PlanId.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";

/// @title VerticalSliceTest
/// @notice The phase gate, in ten steps.
///
/// @dev This is the test the rest of the project is downstream of. It is written as
///      one continuous sequence rather than as ten independent cases on purpose:
///      what is being asserted is that a plan survives a *history* — a clean pull, a
///      third-party crank, a drained borrower, a cure, a delinquency, a payoff and a
///      cancellation — not that each transition works from a freshly staged state.
///      Bugs in a credit state machine live in the paths between states, and a suite
///      of isolated cases never walks one.
///
///      The same ten steps run against live Arc testnet USDC in
///      `script/VerticalSlice.s.sol`. Two runs, because the mock proves the logic
///      and only the network proves the token.
contract VerticalSliceTest is PlanFixture {
    function setUp() public {
        _deployStack();
        vm.warp(1_800_000_000);
    }

    function test_verticalSlice() public {
        // ── 1. Derivation agrees with deployment ────────────────────────────
        //
        // The TypeScript half of this assertion lives in `packages/plan-core` and is
        // checked against a 128-row corpus in CI. Here the claim is narrower and
        // load-bearing: the address the borrower's authorizations name as payee is
        // the address the factory actually deploys to.
        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        bytes32 id = PlanId.derive(terms);
        address predicted = factory.predictAddress(id);

        // ── 2 & 3. Borrower signs; factory deploys and verifies ─────────────
        _originate(terms);
        assertEq(address(plan), predicted, "clone did not land on the signed payee address");
        assertEq(plan.planId(), id, "plan disagrees with its own id");
        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Pending));
        assertEq(plan.outstandingPrincipal(), PRINCIPAL);

        _fundBorrower(200e6);
        uint256 borrowerStart = usdc.balanceOf(borrower);

        // ── 4. The down payment clears at checkout ──────────────────────────
        vm.expectEmit(true, true, false, true, address(plan));
        emit IInstallmentPlan.CheckCleared(id, 0, 25e6, address(this));
        plan.collect(0);

        assertEq(plan.outstandingPrincipal(), 75e6, "25% of principal did not retire");
        assertEq(usdc.balanceOf(borrower), borrowerStart - 25e6, "borrower was not debited exactly one check");
        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Active));

        // ── 5. A third-party keeper collects and is paid ────────────────────
        //
        // The keeper here is an address with no relationship to the protocol: not
        // the operator, not the merchant, not the borrower, holding no role and
        // named nowhere in the plan. If this step needed anything but the chain,
        // "permissionless collection" would be a slogan.
        vm.warp(_dueDate(id, firstDue, 1));
        uint256 quoted = plan.bountyFor(1);
        assertGt(quoted, 0, "a keeper is being asked to work for nothing");

        vm.prank(keeper);
        plan.collect(1);

        assertEq(usdc.balanceOf(keeper), quoted, "the keeper was not paid what they were quoted");
        assertEq(plan.outstandingPrincipal(), 50e6);

        // ── 6. A drained borrower bounces without reverting ─────────────────
        //
        // The whole delinquency apparatus hangs off this not reverting. A revert
        // emits nothing, changes nothing and pays nobody — the pool would have no
        // input to provision against and the kill switch no cohort to read.
        usdc.burnAll(borrower);
        vm.warp(_dueDate(id, firstDue, 2));

        vm.expectEmit(true, true, false, true, address(plan));
        emit IInstallmentPlan.CheckBounced(id, 2, IInstallmentPlan.BounceReason.InsufficientFunds);

        vm.prank(keeper);
        (bool cleared, IInstallmentPlan.BounceReason reason) = plan.collect(2);

        assertFalse(cleared, "a pull against an empty wallet reported success");
        assertEq(uint256(reason), uint256(IInstallmentPlan.BounceReason.InsufficientFunds));
        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Grace));
        assertEq(
            uint256(plan.installmentStatus(2)),
            uint256(IInstallmentPlan.InstallmentStatus.Bounced),
            "the bounce was not recorded against the installment"
        );

        // ── 7. Funds arrive; the same check clears and the plan cures ───────
        _fundBorrower(200e6);

        vm.expectEmit(true, true, false, false, address(plan));
        emit IInstallmentPlan.PlanCured(id, 2);

        vm.prank(keeper);
        plan.collect(2);

        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Active), "the cure did not stick");
        assertEq(plan.outstandingPrincipal(), 25e6);

        // ── 8. Grace expires on the last check; a random address marks it ───
        //
        // Nobody profits from cranking a collection that cannot succeed, which is
        // why this is bountied out of the plan's own escrow rather than left to
        // civic virtue. `stranger` has never touched this plan.
        usdc.burnAll(borrower);
        uint256 lastDue = _dueDate(id, firstDue, 3);
        vm.warp(lastDue + PlanParams.GRACE_WINDOW + 1);

        vm.prank(stranger);
        plan.collect(3);

        vm.expectEmit(true, false, false, false, address(plan));
        emit IInstallmentPlan.PlanDelinquent(id, plan.lateFee());

        vm.prank(stranger);
        plan.markMissed(3);

        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Delinquent));
        assertTrue(plan.isMarked(3), "the delinquency signal was never written");
        assertEq(usdc.balanceOf(stranger), PlanParams.MARK_BOUNTY, "the marker was not paid");
        assertGt(plan.feesOutstanding(), 0, "delinquency accrued no late fee");

        // ── 9. The borrower pays off through the push rail ──────────────────
        _fundBorrower(200e6);
        uint256 payoff = plan.payoffAmount();
        assertEq(payoff, 25e6 + plan.lateFee(), "payoff is not outstanding principal plus the fee");

        vm.startPrank(borrower);
        usdc.approve(address(plan), payoff);
        plan.repay(payoff);
        vm.stopPrank();

        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Repaid));
        assertEq(plan.outstandingPrincipal(), 0);
        assertEq(plan.feesOutstanding(), 0, "a repaid plan still carries fees");

        // ── 10. The unused authorization is cancellable, with no penalty ────
        //
        // Installment 3's nonce was never consumed — the plan was settled by push.
        // A borrower tidying up after payoff is not defaulting on anything, and
        // recording a mark here would put a negative on a Passport for the act of
        // closing a plan cleanly.
        bytes32 unusedNonce = PlanId.checkNonce(id, 3);
        assertFalse(usdc.authorizationState(borrower, unusedNonce), "the nonce was already spent");

        vm.prank(borrower);
        usdc.cancelAuthorization(borrower, unusedNonce, _signCancellation(3));

        assertTrue(usdc.authorizationState(borrower, unusedNonce), "cancellation did not burn the nonce");
        assertEq(
            uint256(plan.state()),
            uint256(IInstallmentPlan.PlanState.Repaid),
            "cancelling after payoff moved the plan"
        );

        // And the plan refuses to record a penalty for it.
        vm.expectRevert();
        plan.noteCancellation(3);
    }

    /// @notice The operator holds no role anywhere in the slice above.
    ///
    /// @dev GOV-08 in miniature, and the reason it is asserted here rather than in
    ///      Phase 6: if the plan primitive needed privileged help, no amount of
    ///      later work could remove the dependency. Every step was sent by
    ///      `address(this)`, a keeper EOA, a stranger or the borrower. None of them
    ///      is an operator, and the plan has no owner, no admin and no pauser to be
    ///      one.
    function test_planHasNoPrivilegedRole() public {
        _originateDefault();

        // The only address the plan treats specially is the merchant, and only for
        // crediting a refund — which moves money *into* the plan.
        assertEq(plan.factory(), address(factory));

        (bool ok,) = address(plan).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "the plan exposes an owner");
        (ok,) = address(plan).call(abi.encodeWithSignature("pause()"));
        assertFalse(ok, "the plan exposes a pause");
        (ok,) = address(plan).call(abi.encodeWithSignature("upgradeTo(address)"));
        assertFalse(ok, "the plan exposes an upgrade path");
    }
}
