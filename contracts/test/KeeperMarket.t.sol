// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {PlanFixture} from "./helpers/PlanFixture.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";

/// @title KeeperMarketTest
/// @notice The claim that the operator is not required, tested rather than asserted.
///
/// @dev "Permissionless collection" is the load-bearing claim in the whole design,
///      and it is the easiest one to ship as a slogan. A protocol whose collections
///      technically may be cranked by anyone but where nobody ever does has an
///      operator dependency it has not admitted to. So what is tested here is not
///      only that a stranger *can* crank, but that cranking pays enough to be worth
///      doing, that the price rises until someone takes it, and that batching does
///      not quietly make single cranks unprofitable.
contract KeeperMarketTest is PlanFixture {
    function setUp() public {
        _deployStack();
        vm.warp(1_800_000_000);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COLL-01 — anyone, and they are paid
    // ─────────────────────────────────────────────────────────────────────────

    function test_anyAddressCanCollectAndIsPaid() public {
        _originateDefault();
        _fundBorrower(200e6);
        vm.warp(_dueDate(planId, firstDue, 1));

        uint256 quoted = plan.bountyFor(1);
        vm.prank(stranger);
        plan.collect(1);

        assertEq(usdc.balanceOf(stranger), quoted, "the crank paid something other than the quote");
        assertGt(quoted, 0);
    }

    /// @dev COLL-10. The keeper is in the event, unindexed. Indexing it would make a
    ///      keeper's whole book publicly correlatable for no gain; carrying it at all
    ///      is what lets the indexer report the share of collections cranked by
    ///      non-operator addresses, which is the measurable version of the claim.
    function test_theCollectingAddressIsRecorded() public {
        _originateDefault();
        _fundBorrower(200e6);
        vm.warp(_dueDate(planId, firstDue, 1));

        vm.expectEmit(true, true, false, true, address(plan));
        emit IInstallmentPlan.CheckCleared(planId, 1, 25e6, keeper);

        vm.prank(keeper);
        plan.collect(1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COLL-06 — the Dutch ramp
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The marginal collection is the one a keeper is deciding not to bother
    ///      with, and it is exactly the one that has been sitting uncollected. A flat
    ///      fee either overpays every prompt crank or underpays every late one; the
    ///      ramp pays the least that clears the market.
    function test_theBountyRisesAcrossTheGraceWindow() public {
        _originateDefault();
        _fundBorrower(200e6);

        uint256 due = _dueDate(planId, firstDue, 1);
        uint256 previous;
        for (uint256 step = 0; step <= 6; ++step) {
            vm.warp(due + (PlanParams.GRACE_WINDOW * step) / 6);
            uint256 bounty = plan.bountyFor(1);
            assertGe(bounty, previous, "the ramp went backwards");
            previous = bounty;
        }

        // 25 bp of a $25 installment is 6.25 cents — above the 5-cent floor, so the
        // proportional figure is what a keeper is quoted on a plan this size.
        vm.warp(due);
        assertEq(plan.bountyFor(1), (25e6 * PlanParams.BOUNTY_START_BPS) / PlanParams.BPS);
        assertGt(plan.bountyFor(1), PlanParams.BOUNTY_FLOOR);

        vm.warp(due + PlanParams.GRACE_WINDOW);
        assertEq(plan.bountyFor(1), (25e6 * PlanParams.BOUNTY_END_BPS) / PlanParams.BPS);
    }

    /// @dev A $25 installment at 25 bp is 6.25 cents; the floor is 5 cents, so the
    ///      proportional figure binds. The floor exists for the ticket sizes below
    ///      that, where a keeper would otherwise be working for the difference
    ///      between two rounding errors.
    function test_theFloorAndCapBothBind() public {
        // Floor: a $75 minimum ticket over twelve installments is $6.25 a check, and
        // 25 bp of that is under two cents — well below what a keeper will run for.
        uint256 small = PlanParams.collectBounty(6_250_000, 0, PlanParams.GRACE_WINDOW);
        assertEq(small, PlanParams.BOUNTY_FLOOR);

        // Cap: 250 bp of a $5,000 B2B leg would be $125 for the same 140k gas.
        uint256 large = PlanParams.collectBounty(5000e6, PlanParams.GRACE_WINDOW, PlanParams.GRACE_WINDOW);
        assertEq(large, PlanParams.BOUNTY_CAP);
    }

    /// @dev The bounty is paid out of the pull, so it can never exceed what arrived.
    ///      A collection that netted negative to the book would make the pool pay a
    ///      keeper for the privilege of shrinking.
    function testFuzz_theBountyNeverExceedsTheInstallment(uint128 amount, uint32 elapsed) public pure {
        uint256 bounty = PlanParams.collectBounty(amount, elapsed, PlanParams.GRACE_WINDOW);
        assertLe(bounty, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COLL-05 — batching is a convenience, not a requirement
    // ─────────────────────────────────────────────────────────────────────────

    function test_aBatchCostsExactlyWhatTheSameCranksWouldCostSingly() public {
        _originateDefault();
        _fundBorrower(400e6);

        vm.warp(_dueDate(planId, firstDue, 2));
        uint256 expected = plan.bountyFor(0) + plan.bountyFor(1) + plan.bountyFor(2);

        uint256[] memory indices = new uint256[](3);
        indices[0] = 0;
        indices[1] = 1;
        indices[2] = 2;

        vm.prank(keeper);
        plan.collectBatch(indices);

        assertEq(usdc.balanceOf(keeper), expected, "a batch was discounted against single cranks");
        assertEq(plan.outstandingPrincipal(), 25e6);
    }

    /// @dev A wave contains plans that will not clear. If one bounce reverted the
    ///      batch, a keeper would have to simulate every index first or lose the
    ///      whole transaction to a single drained borrower — and the rational
    ///      response is to stop batching, which is the behaviour COLL-05 exists to
    ///      avoid.
    function test_aBounceInsideABatchDoesNotLoseTheRestOfTheWave() public {
        _originateDefault();
        _fundBorrower(30e6);
        vm.warp(_dueDate(planId, firstDue, 2));

        uint256[] memory indices = new uint256[](3);
        indices[0] = 0;
        indices[1] = 1;
        indices[2] = 2;

        vm.prank(keeper);
        (bool[] memory cleared, IInstallmentPlan.BounceReason[] memory reasons) = plan.collectBatch(indices);

        assertTrue(cleared[0], "the first collectible check did not clear");
        assertFalse(cleared[1]);
        assertEq(uint256(reasons[1]), uint256(IInstallmentPlan.BounceReason.InsufficientFunds));
        assertEq(plan.outstandingPrincipal(), 75e6);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COLL-09 — a borrower who cures their own plan keeps the servicing fee
    // ─────────────────────────────────────────────────────────────────────────

    function test_aBorrowerCrankingTheirOwnPlanEarnsTheBounty() public {
        _originateDefault();
        _fundBorrower(200e6);
        vm.warp(_dueDate(planId, firstDue, 1));

        uint256 before = usdc.balanceOf(borrower);
        uint256 bounty = plan.bountyFor(1);

        vm.prank(borrower);
        plan.collect(1);

        // Debited the installment, credited the bounty. Curing yourself costs less
        // than waiting for someone else to do it, which is the incentive that should
        // exist.
        assertEq(usdc.balanceOf(borrower), before - 25e6 + bounty);
    }

    function test_curingByPushCostsNoBountyAtAll() public {
        _originateDefault();
        _fundBorrower(200e6);

        uint256 before = usdc.balanceOf(borrower);
        vm.startPrank(borrower);
        usdc.approve(address(plan), 25e6);
        plan.repay(25e6);
        vm.stopPrank();

        assertEq(usdc.balanceOf(borrower), before - 25e6, "the push rail charged a servicing fee");
        assertEq(usdc.balanceOf(pool), 25e6, "the pool did not receive the whole installment");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COLL-03 — the mark bounty, and where it comes from
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev D2 said the mark bounty comes from the ops budget. An operator-funded
    ///      budget contradicts GOV-08, which requires the loop to run with every
    ///      operator role at the zero address — so the budget is prefunded per plan
    ///      at origination and lives in the plan's own escrow. A delinquency signal
    ///      that depends on the delinquent borrower paying for it is not a signal.
    function test_theMarkBountyIsPrefundedAndBounded() public {
        _originateDefault();
        assertEq(plan.markEscrow(), PlanParams.markEscrowFor(COUNT));

        // Four marks is the whole schedule. The escrow is sized for exactly that and
        // cannot be drained past it.
        for (uint256 i = 0; i < COUNT; ++i) {
            vm.warp(_dueDate(planId, firstDue, i) + PlanParams.GRACE_WINDOW + 1);
            vm.prank(stranger);
            plan.markMissed(i);
        }

        // Four marks at $0.10. The escrow held twice that, and the second half —
        // the observation budget — was never touched by a mark.
        assertEq(usdc.balanceOf(stranger), COUNT * PlanParams.MARK_BOUNTY);
        assertEq(plan.markEscrow(), PlanParams.markEscrowFor(COUNT) - COUNT * PlanParams.MARK_BOUNTY);
    }

    /// @dev The failure mode the split escrow exists to prevent. A plan whose signer
    ///      keeps changing can be revalidated every window for the ninety days its
    ///      strip stays live — enough calls to empty a single-budget escrow, and the
    ///      delinquency signal would then fail on exactly the plans most likely to
    ///      need it.
    function test_revalidationCannotStarveTheMarkBudget() public {
        _originateDefault();

        for (uint256 i = 0; i < 40; ++i) {
            vm.warp(block.timestamp + PlanParams.REVALIDATION_WINDOW);
            vm.prank(stranger);
            plan.revalidate();
        }

        assertTrue(plan.markBudgetIsFunded(), "observation drained the delinquency signal's budget");
        assertGe(plan.markEscrow(), COUNT * PlanParams.MARK_BOUNTY);
    }

    function test_unspentEscrowGoesBackToTheBookOnPayoff() public {
        _originateDefault();
        _fundBorrower(200e6);

        vm.startPrank(borrower);
        usdc.approve(address(plan), PRINCIPAL);
        plan.repay(PRINCIPAL);
        vm.stopPrank();

        assertEq(plan.markEscrow(), 0);
        assertEq(
            usdc.balanceOf(pool),
            PRINCIPAL + PlanParams.markEscrowFor(COUNT),
            "the unspent escrow was stranded in the plan"
        );
        assertEq(usdc.balanceOf(address(plan)), 0);
    }

    /// @dev A plan cannot be marked before its grace window closes, however many
    ///      times a keeper tries. Otherwise the mark bounty is a faucet.
    function test_markingEarlyIsRefused() public {
        _originateDefault();
        vm.warp(_dueDate(planId, firstDue, 1) + 1);

        vm.expectRevert();
        plan.markMissed(1);
        assertEq(plan.markEscrow(), PlanParams.markEscrowFor(COUNT));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // D10 — the measured figures the parameters were derived from
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Phase 1 measured a pull on live Arc at 140,885 gas — $0.00296. This
    ///      records what the same pull costs against the full plan, so the ops budget
    ///      is recomputed from a number rather than re-inherited from Appendix A's
    ///      assumed $0.013. The assertion is loose on purpose: it is a regression
    ///      guard on the order of magnitude, not a gas-golf target. The bounty
    ///      dominates gas by roughly ten to one, so the ramp is where the ticket
    ///      floor actually comes from.
    function test_collectionGasStaysInTheModelledBand() public {
        _originateDefault();
        _fundBorrower(200e6);
        vm.warp(_dueDate(planId, firstDue, 1));

        uint256 before = gasleft();
        vm.prank(keeper);
        plan.collect(1);
        uint256 used = before - gasleft();

        assertLt(used, 400_000, "a collection costs more than the ops budget was modelled on");
        emit log_named_uint("collect() gas", used);
    }
}
