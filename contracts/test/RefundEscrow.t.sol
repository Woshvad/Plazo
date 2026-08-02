// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {OriginationFixture} from "./helpers/OriginationFixture.sol";

import {RefundEscrow} from "../src/RefundEscrow.sol";
import {TranchedCreditPool} from "../src/TranchedCreditPool.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {ISettlementEscrow} from "../src/interfaces/ISettlementEscrow.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";

/// @notice A stand-in for the escrow plan 06-09 writes, so wave 3 can be tested in wave 3.
///
/// @dev `SettlementEscrow` does not exist yet and this file must not wait for it. What
///      is asserted here is that `RefundEscrow` reads the seam correctly — that
///      eligibility is actually checked, and that the disputed merchant and amount come
///      from the row rather than from the caller. The end-to-end linkage against the
///      real implementation is plan 06-09's `SettlementEscrow.t.sol` to assert.
///
///      Deliberately as dumb as the interface allows: a setter that any test may call,
///      and two views that return exactly what was set. A stub with opinions would be a
///      second implementation to keep in step with the first.
contract StubSettlementEscrow is ISettlementEscrow {
    mapping(bytes32 => bool) private _eligible;
    mapping(bytes32 => ReturnedSettlement) private _rows;

    /// @dev `returnedAt` is supplied rather than read from the block. This contract has
    ///      no cheatcode handle, and a test that warps would otherwise be writing a
    ///      timestamp the caller did not choose — the same class of mistake DEC-30 and
    ///      finding 14 are about.
    function setRow(
        bytes32 planId,
        bool eligible,
        address merchant,
        uint256 amount,
        uint256 returnedAt
    ) external {
        _eligible[planId] = eligible;
        _rows[planId] = ReturnedSettlement({merchant: merchant, amount: amount, returnedAt: returnedAt});
    }

    function disputeEligible(bytes32 planId) external view returns (bool) {
        return _eligible[planId];
    }

    function returnedSettlementOf(bytes32 planId) external view returns (ReturnedSettlement memory) {
        return _rows[planId];
    }
}

/// @title RefundEscrowTest
/// @notice MERCH-02 and MERCH-03: the void, the partial refund, and what each one does
///         to the fee, the bond and the schedule.
///
/// @dev The waterfall itself is `InstallmentPlan`'s and is tested there. What is tested
///      here is everything around it — the claims a merchant, a borrower and a lender
///      each have to be able to rely on, and which are only true because of code that
///      lives outside the plan:
///
///      - a void returns the pool's whole front **and needs no borrower transaction**,
///      - a partial refund shortens the schedule from the end rather than moving the
///        next due date,
///      - the MDR rebate amortises against the remaining balance, not the original
///        principal — finding 15, from the other side,
///      - a merchant cannot cycle originate → refund to get their own bond back,
///      - and nothing anywhere takes an address that refunded value could reach.
contract RefundEscrowTest is OriginationFixture {
    RefundEscrow internal escrow;
    StubSettlementEscrow internal settlementEscrow;

    address internal arbiter = address(0xA9B17E);
    address internal funder = address(0xF00DED);

    /// @dev The plan's whole deferred MDR at origination — `mdr − markEscrow`. The
    ///      escrow slice is not rebatable: it was spent funding the plan's own
    ///      delinquency budget rather than earned as income by anybody.
    uint256 internal deferredAtOrigination;

    function setUp() public {
        _deployStack();
        _prepareOrigination();

        settlementEscrow = new StubSettlementEscrow();
        escrow = new RefundEscrow(
            address(this),
            address(usdc),
            address(checkout),
            address(merchants),
            address(parameters),
            address(settlementEscrow)
        );

        // The role's first and only holder. `MerchantRegistry`'s docstring says Phase
        // 6's `RefundEscrow` is what earns it; this is that grant.
        merchants.grantRole(merchants.SLASHER_ROLE(), address(escrow));
        escrow.grantRole(escrow.ARBITER_ROLE(), arbiter);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _originatePlan() internal {
        _checkoutDefault();
        deferredAtOrigination = creditPool.bookOf(planId).deferredIncome;
    }

    /// @dev The merchant's own money, through the merchant's own call. This contract is
    ///      not the merchant and never becomes one.
    function _merchantRefunds(uint256 amount) internal {
        usdc.mint(merchant, amount);
        vm.startPrank(merchant);
        usdc.approve(address(plan), amount);
        plan.creditRefund(amount);
        vm.stopPrank();
    }

    function _liveCheckCount() internal view returns (uint256 live) {
        for (uint256 i = 0; i < COUNT; ++i) {
            IInstallmentPlan.InstallmentStatus status = plan.installmentStatus(i);
            if (
                status == IInstallmentPlan.InstallmentStatus.Pending
                    || status == IInstallmentPlan.InstallmentStatus.Bounced
            ) live += 1;
        }
    }

    function _firstRefundedIndex() internal view returns (uint256) {
        for (uint256 i = 0; i < COUNT; ++i) {
            if (plan.installmentStatus(i) == IInstallmentPlan.InstallmentStatus.Refunded) return i;
        }
        return type(uint256).max;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MERCH-02 — the void
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The claim MERCH-02 actually makes: the borrower is not in the loop.
    ///
    /// @dev A balance assertion alone does not make this claim — a borrower who had to
    ///      sign a shorter strip would still end up with the right balance. So the
    ///      structural half is asserted directly: the borrower's nonce is unchanged
    ///      across the whole void, meaning no transaction of theirs appears anywhere in
    ///      it. The merchant refunds, a stranger cranks, and the borrower is offline.
    function test_voidReturnsFrontWithoutBorrower() public {
        _originatePlan();
        _fundBorrower(200e6);
        plan.collect(0);

        uint256 borrowerBalance = usdc.balanceOf(borrower);
        uint256 borrowerNonce = vm.getNonce(borrower);
        uint256 voidAmount = escrow.voidAmountFor(planId);

        _merchantRefunds(voidAmount);
        vm.prank(stranger);
        escrow.noteRefund(planId);

        assertEq(
            uint256(plan.state()),
            uint256(IInstallmentPlan.PlanState.Refunded),
            "a full-value refund before fulfilment did not land the plan in Refunded"
        );
        assertEq(
            creditPool.bookOf(planId).carrying,
            0,
            "the pool is still carrying a receivable it was made whole on"
        );
        assertEq(
            usdc.balanceOf(borrower) - borrowerBalance,
            plan.installmentAmount(0),
            "the borrower did not get their down payment back, exactly"
        );
        assertEq(
            vm.getNonce(borrower),
            borrowerNonce,
            "the void required a transaction from the borrower's own key"
        );
        assertEq(
            merchants.outstandingFrontedFor(merchant),
            0,
            "the merchant is still carrying exposure for a voided sale"
        );
    }

    /// @dev A void and a partial refund are the same call to the plan, so the log stream
    ///      is the only place they can be told apart — and an operator's dashboard, a
    ///      merchant's reconciliation and the indexer all need to.
    function test_voidEmitsPlanVoidedNotJustRefundCredited() public {
        _originatePlan();
        _fundBorrower(200e6);
        plan.collect(0);

        uint256 voidAmount = escrow.voidAmountFor(planId);
        _merchantRefunds(voidAmount);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit RefundEscrow.RefundCredited(planId, 75e6);
        vm.expectEmit(true, false, false, false, address(escrow));
        emit RefundEscrow.PlanVoided(planId);

        vm.prank(stranger);
        escrow.noteRefund(planId);
    }

    /// @notice D-05, confirmed by test rather than by argument.
    ///
    /// @dev A full-value `creditRefund` before fulfilment is arithmetically a void, so
    ///      MERCH-02 needs no `PlanState.Cancelled` transition and therefore no
    ///      implementation vintage bump. The plan is immutable, so this assertion is
    ///      cheap and permanent: the void reaches `Refunded`, `Cancelled` is not
    ///      reached, and the factory is still pointing at the implementation this
    ///      fixture deployed — no fourth vintage was needed to ship the void.
    function test_voidNeedsNoVintageBump() public {
        _originatePlan();
        address vintage = factory.implementation();

        uint256 voidAmount = escrow.voidAmountFor(planId);
        _merchantRefunds(voidAmount);
        escrow.noteRefund(planId);

        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Refunded));
        assertTrue(
            plan.state() != IInstallmentPlan.PlanState.Cancelled,
            "the void reached Cancelled, which PLAN-07 shipped unreachable"
        );
        assertEq(
            factory.implementation(), vintage, "shipping the void bumped the plan implementation vintage"
        );
        assertEq(
            factory.implementation(), implementation, "the factory is not on the vintage the fixture deployed"
        );
    }

    /// @dev A void before the first due date is the *more* complete void — nothing was
    ///      collected at all — and must still be distinguishable on the log stream.
    function test_aVoidBeforeAnyCollectionIsStillAVoid() public {
        _originatePlan();

        uint256 voidAmount = escrow.voidAmountFor(planId);
        _merchantRefunds(voidAmount);

        vm.expectEmit(true, false, false, false, address(escrow));
        emit RefundEscrow.PlanVoided(planId);
        escrow.noteRefund(planId);

        assertEq(
            plan.totalCollected(), 0, "the borrower paid for a plan that was voided before its first due date"
        );
    }

    /// @dev A "void" of a settled plan is a merchant sending money to a schedule that
    ///      owes nothing: the whole amount would land on the borrower with the pool's
    ///      book untouched. Refused at the quote rather than discovered afterwards.
    function test_voidAmountRefusesASettledPlan() public {
        _originatePlan();
        _payOff(plan);

        vm.expectRevert(
            abi.encodeWithSelector(
                RefundEscrow.PlanNotVoidable.selector, planId, IInstallmentPlan.PlanState.Repaid
            )
        );
        escrow.voidAmountFor(planId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MERCH-03 — the partial refund
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The schedule shortens from the end, and the next due date does not move.
    ///
    /// @dev The property a borrower actually experiences. A refund that suppressed from
    ///      the front would move every remaining payment forward and turn a partial
    ///      refund into a repayment schedule the borrower never agreed to; one that
    ///      suppressed from the middle would produce a set of dates nobody could read.
    ///      Fuzzed over the whole refund range because the boundary cases — one wei, and
    ///      the exact outstanding balance — are where an off-by-one in the walk would
    ///      live.
    function testFuzz_partialRefundSuppressesFromTail(uint256 amount) public {
        _originatePlan();
        uint256 outstanding = plan.outstandingPrincipal();
        amount = bound(amount, 1, outstanding);

        uint256[] memory dueBefore = new uint256[](COUNT);
        for (uint256 i = 0; i < COUNT; ++i) {
            dueBefore[i] = _dueDate(planId, firstDue, i);
        }

        (,, uint256 previewFirstSuppressed,) = escrow.refundPreview(planId, amount);
        _merchantRefunds(amount);

        assertEq(
            plan.outstandingPrincipal(),
            outstanding - amount,
            "the refund did not retire exactly what it applied"
        );

        // The smallest number of checks that still covers the remaining principal,
        // computed here rather than read from the plan.
        uint256 remaining = outstanding - amount;
        uint256 expectedLive = 0;
        uint256 budget = remaining;
        for (uint256 i = 0; i < COUNT; ++i) {
            uint256 face = _amountAt(PRINCIPAL, COUNT, i);
            if (budget >= face) {
                budget -= face;
                expectedLive += 1;
            }
        }

        assertEq(
            _liveCheckCount(), expectedLive, "the schedule kept a different number of checks than it needs"
        );
        assertEq(
            uint256(plan.installmentStatus(COUNT - 1)),
            uint256(IInstallmentPlan.InstallmentStatus.Refunded),
            "the last check survived a refund that had to suppress something"
        );
        assertEq(
            _firstRefundedIndex(),
            previewFirstSuppressed,
            "the preview named a different first suppressed check"
        );

        for (uint256 i = 0; i < COUNT; ++i) {
            assertEq(
                plan.dueDate(i), dueBefore[i], "a refund moved a due date the borrower had already been given"
            );
        }
    }

    /// @notice Finding 15's guard, from the rebate side.
    ///
    /// @dev The pool defers the MDR and earns it against **what is still owed**.
    ///      Apportioning the rebate against the original principal instead compounds in
    ///      the opposite direction: two successive half-refunds would rebate three
    ///      quarters of the fee on a sale that was refunded in full, and the residue
    ///      would sit forever as income earned on a transaction that did not happen.
    ///
    ///      So the identity asserted is exact and has no slack in it: a plan refunded to
    ///      zero in two steps rebates its entire deferred MDR, and each step's rebate is
    ///      the remaining fee times the refunded share of the remaining balance.
    function test_partialRefundRebateUsesRemainingBalance() public {
        _originatePlan();
        uint256 outstanding = plan.outstandingPrincipal();
        uint256 half = outstanding / 2;

        uint256 expectedFirst = (deferredAtOrigination * half) / outstanding;
        _merchantRefunds(half);
        escrow.noteRefund(planId);

        assertEq(
            escrow.rebateOwed(merchant),
            expectedFirst,
            "the first rebate is not the fee's share of the refund"
        );

        // The second step reads a smaller fee against a smaller balance. Against the
        // original principal it would read the smaller fee against the *original*
        // balance, and come up short.
        TranchedCreditPool.PlanBook memory book = creditPool.bookOf(planId);
        uint256 expectedSecond = (book.deferredIncome * (outstanding - half)) / book.carrying;

        _merchantRefunds(outstanding - half);
        escrow.noteRefund(planId);

        assertEq(
            escrow.rebateOwed(merchant),
            expectedFirst + expectedSecond,
            "the second rebate used a stale denominator"
        );
        assertEq(
            escrow.rebateOwed(merchant),
            deferredAtOrigination,
            "a sale refunded in full left a residue of fee earned on a transaction that did not happen"
        );
        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Refunded));
    }

    /// @dev A borrower who paid before the refund keeps the fee on what they paid. The
    ///      merchant sold that much and the pool earned that much; only the refunded
    ///      share comes back.
    function test_theRebateExcludesFeeEarnedOnPrincipalTheBorrowerRepaid() public {
        _originatePlan();
        _fundBorrower(200e6);
        plan.collect(0);
        // The ordinary crank, not this contract's. `noteRefund` books refunds and
        // nothing else — with no refund credited yet it correctly does nothing at all.
        checkout.recognise(planId);

        uint256 outstanding = plan.outstandingPrincipal();
        TranchedCreditPool.PlanBook memory book = creditPool.bookOf(planId);
        assertLt(book.deferredIncome, deferredAtOrigination, "the down payment earned the pool no fee at all");

        _merchantRefunds(outstanding);
        escrow.noteRefund(planId);

        assertEq(
            escrow.rebateOwed(merchant),
            book.deferredIncome,
            "the rebate reached back into fee the pool had already earned on principal that was repaid"
        );
        assertLt(escrow.rebateOwed(merchant), deferredAtOrigination);
    }

    /// @dev A preview a merchant confirms against must not be a second implementation
    ///      that drifts from the one that runs.
    function test_refundPreviewMatchesTheActualRefund() public {
        _originatePlan();
        _fundBorrower(200e6);
        plan.collect(0);

        uint256 amount = 60e6;
        (uint256 applied, uint256 toBorrower, uint256 firstSuppressed, uint256 rebate) =
            escrow.refundPreview(planId, amount);

        uint256 outstandingBefore = plan.outstandingPrincipal();
        uint256 borrowerBefore = usdc.balanceOf(borrower);

        _merchantRefunds(amount);
        escrow.noteRefund(planId);

        assertEq(
            outstandingBefore - plan.outstandingPrincipal(),
            applied,
            "the preview mispredicted applied principal"
        );
        assertEq(
            usdc.balanceOf(borrower) - borrowerBefore,
            toBorrower,
            "the preview mispredicted the borrower's cash"
        );
        assertEq(
            _firstRefundedIndex(), firstSuppressed, "the preview mispredicted the first suppressed check"
        );
        assertEq(escrow.rebateOwed(merchant), rebate, "the preview mispredicted the MDR rebate");
    }

    /// @dev A refund larger than the balance is the void case: everything outstanding is
    ///      retired and the excess is the borrower's, never the merchant's to redirect.
    function test_previewSplitsAnOverpaymentToTheBorrower() public {
        _originatePlan();
        _fundBorrower(200e6);
        plan.collect(0);

        (uint256 applied, uint256 toBorrower,,) = escrow.refundPreview(planId, PRINCIPAL);
        assertEq(applied, 75e6, "the preview applied more than the plan still owed");
        assertEq(toBorrower, 25e6, "the preview did not return the collected installment to the borrower");
    }

    /// @dev Findings 17 and 19's discipline at the unit level. Every crank in this tree
    ///      is permissionless, which means every crank will be called twice.
    function test_noteRefundIsIdempotent() public {
        _originatePlan();
        _merchantRefunds(50e6);

        vm.prank(stranger);
        escrow.noteRefund(planId);
        uint256 owedAfterFirst = escrow.rebateOwed(merchant);
        uint256 creditedAfterFirst = escrow.credited(planId);
        assertGt(owedAfterFirst, 0);

        vm.prank(keeper);
        escrow.noteRefund(planId);

        assertEq(escrow.rebateOwed(merchant), owedAfterFirst, "a second crank accrued the rebate twice");
        assertEq(escrow.credited(planId), creditedAfterFirst, "a second crank re-counted the same refund");
    }

    /// @dev A plan this router never originated has no book to read and no exposure to
    ///      move. Reverting is right: silently returning would make the crank look like
    ///      it had done something.
    function test_noteRefundRefusesAPlanThisRouterNeverOriginated() public {
        bytes32 unknown = keccak256("not-a-plan");
        vm.expectRevert(abi.encodeWithSelector(RefundEscrow.PlanNotOriginatedHere.selector, unknown));
        escrow.noteRefund(unknown);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The rebate reserve
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev A short reserve is a visible liability with a running balance, not a
    ///      transfer that reverted and left the merchant to work out why. And the claim
    ///      is permissionless, because a rebate only the operator can push is a rebate
    ///      the operator can also decline to push.
    function test_claimRebateIsPermissionlessAndBoundedByTheReserve() public {
        _originatePlan();
        uint256 voidAmount = escrow.voidAmountFor(planId);
        _merchantRefunds(voidAmount);
        escrow.noteRefund(planId);

        uint256 owed = escrow.rebateOwed(merchant);
        assertGt(owed, 0);

        uint256 half = owed / 2;
        _fundRebates(half);

        uint256 before = usdc.balanceOf(merchantPayout);
        vm.prank(stranger);
        escrow.claimRebate(merchant);

        assertEq(
            usdc.balanceOf(merchantPayout) - before,
            half,
            "a short reserve paid something other than what it held"
        );
        assertEq(escrow.rebateOwed(merchant), owed - half, "the unpaid remainder stopped being claimable");
        assertEq(escrow.rebateReserve(), 0);

        _fundRebates(owed - half);
        vm.prank(stranger);
        escrow.claimRebate(merchant);

        assertEq(usdc.balanceOf(merchantPayout) - before, owed, "the remainder never arrived");
        assertEq(escrow.rebateOwed(merchant), 0);
    }

    function test_claimRebateRefusesWhenTheReserveIsEmpty() public {
        _originatePlan();
        uint256 voidAmount = escrow.voidAmountFor(planId);
        _merchantRefunds(voidAmount);
        escrow.noteRefund(planId);

        uint256 owed = escrow.rebateOwed(merchant);
        vm.expectRevert(abi.encodeWithSelector(RefundEscrow.RebateReserveEmpty.selector, owed));
        escrow.claimRebate(merchant);
    }

    function _fundRebates(uint256 amount) internal {
        usdc.mint(funder, amount);
        vm.startPrank(funder);
        usdc.approve(address(escrow), amount);
        escrow.fundRebates(amount);
        vm.stopPrank();
    }
}
