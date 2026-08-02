// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {OriginationFixture} from "./helpers/OriginationFixture.sol";

import {RefundEscrow} from "../src/RefundEscrow.sol";
import {TranchedCreditPool} from "../src/TranchedCreditPool.sol";
import {ICreditPool} from "../src/interfaces/ICreditPool.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {ISettlementEscrow} from "../src/interfaces/ISettlementEscrow.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
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

    /// @dev Every dollar the fixture handed the merchant so they could fund a refund.
    ///      Tracked because the bond-cycling test's whole assertion is an accounting
    ///      identity over the merchant's total position, and a mint is not income.
    uint256 internal mintedToMerchant;

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
        mintedToMerchant += amount;
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

    // ─────────────────────────────────────────────────────────────────────────
    // D-02 — the refund is not a bond-withdrawal channel
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Everything the merchant could walk away with, in one number. The bond counts
    ///      because withdrawing it is worth-neutral, and the payout address counts
    ///      because that is where settlement lands.
    function _merchantWorth() internal view returns (uint256) {
        return usdc.balanceOf(merchant) + usdc.balanceOf(merchantPayout) + merchants.bondOf(merchant);
    }

    /// @notice The attack `MerchantRegistry` was written against, run three times.
    ///
    /// @dev The cycle is: originate, take the settlement, refund in full, crank, and try
    ///      to pull the bond back out. It has to be unprofitable, and the reason it is
    ///      unprofitable is D-02 — **no path releases withholding**. The bond falls only
    ///      because `recognise()` brought exposure down, which is the same thing that
    ///      happens when a borrower simply pays, and the withheld dollars stay withheld
    ///      until the requirement they secure is gone.
    ///
    ///      The assertion is an accounting identity rather than an inequality, because
    ///      an inequality would pass for a contract that leaked slowly. Each cycle costs
    ///      the merchant **exactly the MDR** and nothing else: they receive
    ///      `principal − mdr` and they pay `principal` back. The withholding moving into
    ///      the bond nets to zero — it is their own settlement money, held rather than
    ///      given, which is the whole of DEC-09.
    function test_refundCyclingCannotExtractBond() public {
        uint256 floor_ = parameters.get(ParameterKeys.MERCHANT_BOND_FLOOR);
        uint256 posted = merchants.bondOf(merchant);
        vm.prank(merchant);
        merchants.withdrawBond(posted - floor_);
        assertEq(merchants.bondOf(merchant), floor_, "the merchant did not start at their bond floor");

        uint256 mdr = checkout.mdrFor(PRINCIPAL);
        uint256 start = _merchantWorth();

        for (uint256 cycle = 1; cycle <= 3; ++cycle) {
            _checkout(_terms(PRINCIPAL, COUNT, cycle), keccak256(abi.encode("cycle", cycle)), 200e6);
            uint256 withheldAfterOrigination = merchants.merchantOf(merchant).withheld;

            _merchantRefunds(PRINCIPAL);
            escrow.noteRefund(planId);

            assertEq(
                merchants.merchantOf(merchant).withheld,
                withheldAfterOrigination,
                "the refund released the merchant's withholding, which is the extraction D-02 forbids"
            );
            assertEq(
                merchants.outstandingFrontedFor(merchant),
                0,
                "exposure did not fall when the refund landed, so the bond requirement never would"
            );

            tier0.notePlanOutcome(planId);
        }

        // The bond is larger than it started, and every extra dollar of it is settlement
        // the merchant never received. Withdrawing it changes nothing.
        uint256 required = merchants.requiredBond(merchant);
        uint256 held = merchants.bondOf(merchant);
        assertGt(held, required, "there is nothing withdrawable, so the next assertion would be vacuous");

        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(MerchantRegistry.BondBelowRequirement.selector, 0, required));
        merchants.withdrawBond(held);

        vm.prank(merchant);
        merchants.withdrawBond(held - required);

        assertEq(
            _merchantWorth(),
            start + mintedToMerchant - 3 * mdr,
            "three originate-refund cycles moved the merchant's position by something other than three MDRs"
        );
        assertEq(
            merchants.bondOf(merchant), required, "the merchant was left holding more bond than they owe"
        );
    }

    /// @notice Nothing in this ABI is a destination for refunded value.
    ///
    /// @dev `RefundEscrow` has exactly two address-typed parameters across its whole
    ///      external surface — `claimRebate(address merchant)` and
    ///      `openDispute(bytes32,address,uint256,bytes32)`. Neither is a payee: the
    ///      first names *whose* rebate and pays the route recorded in
    ///      `MerchantRegistry`, and the second names whose bond is at risk. Both are
    ///      exercised below with a stranger's address to show what they do and do not
    ///      reach. Every other entry point takes only a `bytes32` or a `uint256`.
    ///
    ///      The positive half matters more: refunded value lands on the plan's immutable
    ///      `borrower` even when the merchant's registered payout route points somewhere
    ///      else entirely, because `creditRefund` has no other destination to offer.
    function test_merchantCannotNameARefundRecipient() public {
        uint32 domain = payout.ARC_DOMAIN();
        vm.prank(merchant);
        merchants.setPayoutRoute(stranger, domain);

        _originatePlan();
        _fundBorrower(200e6);
        plan.collect(0);

        uint256 borrowerBefore = usdc.balanceOf(borrower);
        uint256 strangerBefore = usdc.balanceOf(stranger);

        uint256 voidAmount = escrow.voidAmountFor(planId);
        _merchantRefunds(voidAmount);
        escrow.noteRefund(planId);

        assertEq(
            usdc.balanceOf(borrower) - borrowerBefore,
            25e6,
            "refunded value did not land on the plan's immutable borrower"
        );
        assertEq(
            usdc.balanceOf(stranger),
            strangerBefore,
            "refunded value reached the merchant's chosen payout route"
        );

        // The first address parameter: it names whose rebate, not where it goes.
        vm.expectRevert(abi.encodeWithSelector(RefundEscrow.NothingOwed.selector, stranger));
        escrow.claimRebate(stranger);

        // The second: it names whose bond is at risk, and nothing else. Naming an
        // address with no bond does not make them a payee — it reverts, because the
        // only meaning the parameter has is "whose stake", and a stranger has none.
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(RefundEscrow.DisputeExceedsBond.selector, planId, 1, 0));
        escrow.openDispute(planId, stranger, 1, keccak256("evidence"));
        assertEq(
            usdc.balanceOf(stranger), strangerBefore, "opening a dispute moved value to the named address"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // D-03 — the dispute timelock
    // ─────────────────────────────────────────────────────────────────────────

    function _openArbiterDispute(uint256 amount) internal {
        vm.prank(arbiter);
        escrow.openDispute(planId, merchant, amount, keccak256("evidence-commitment"));
    }

    function test_slashRequiresAnOpenDispute() public {
        _originatePlan();
        vm.expectRevert(abi.encodeWithSelector(RefundEscrow.NoDisputeOpen.selector, planId));
        escrow.executeSlash(planId);
    }

    /// @notice The whole of D-03: an opened dispute, an elapsed registry timelock, and
    ///         then anyone at all.
    ///
    /// @dev A `SLASHER_ROLE` on a human key is a key that can drain any merchant's bond.
    ///      This contract is the key, and the window is what makes it one the merchant
    ///      can see coming. Execution is then permissionless on purpose — a slash only
    ///      the arbiter can complete is a slash the arbiter can hold over a merchant
    ///      indefinitely.
    function test_slashRequiresTheTimelockToElapse() public {
        _originatePlan();
        _openArbiterDispute(100e6);

        uint256 executableAt = escrow.disputeExecutableAt(planId);
        assertEq(
            executableAt - vm.getBlockTimestamp(),
            parameters.get(ParameterKeys.ESCROW_DISPUTE_TIMELOCK),
            "the window is not the one the registry row says it is"
        );

        vm.warp(executableAt - 1);
        vm.expectRevert(
            abi.encodeWithSelector(RefundEscrow.DisputeStillTimelocked.selector, planId, executableAt)
        );
        escrow.executeSlash(planId);

        vm.warp(executableAt + 1);
        address nobody = address(0xC0FFEE01);
        assertFalse(escrow.hasRole(escrow.ARBITER_ROLE(), nobody));
        assertFalse(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), nobody));

        vm.prank(nobody);
        escrow.executeSlash(planId);

        assertEq(escrow.disputeOf(planId).openedAt, 0, "the dispute row survived its own execution");
    }

    /// @dev Governance moving the row moves the window. That is the point of reading it
    ///      at call time rather than compiling it in — and it is why the compiled band
    ///      in `ParameterRegistry` is the security property rather than the default.
    function test_theTimelockIsReadFromTheRegistryAtCallTime() public {
        _originatePlan();
        _openArbiterDispute(100e6);

        uint256 openedAt = escrow.disputeOf(planId).openedAt;
        assertEq(escrow.disputeExecutableAt(planId), openedAt + 72 hours);

        parameters.set(ParameterKeys.ESCROW_DISPUTE_TIMELOCK, 10 days);
        assertEq(
            escrow.disputeExecutableAt(planId),
            openedAt + 10 days,
            "a dispute already open kept a window the registry no longer says"
        );

        vm.warp(openedAt + 72 hours + 1);
        vm.expectRevert(
            abi.encodeWithSelector(RefundEscrow.DisputeStillTimelocked.selector, planId, openedAt + 10 days)
        );
        escrow.executeSlash(planId);
    }

    /// @dev The arbiter is the check on a dispute opened in error, and the registry's
    ///      24-hour floor is the window they have to use it. Asserted from both entry
    ///      points, because a dispute row is a dispute row whoever opened it.
    function test_cancelledDisputeCannotBeSlashed() public {
        _originatePlan();
        _openArbiterDispute(100e6);

        uint256 executableAt = escrow.disputeExecutableAt(planId);
        vm.prank(arbiter);
        escrow.cancelDispute(planId);

        vm.warp(executableAt + 1);
        vm.expectRevert(abi.encodeWithSelector(RefundEscrow.NoDisputeOpen.selector, planId));
        escrow.executeSlash(planId);

        // And the same for one nobody with a role opened at all.
        settlementEscrow.setRow(planId, true, merchant, 60e6, vm.getBlockTimestamp());
        vm.prank(stranger);
        escrow.openNonAttestationDispute(planId);

        uint256 secondExecutableAt = escrow.disputeExecutableAt(planId);
        vm.prank(arbiter);
        escrow.cancelDispute(planId);

        vm.warp(secondExecutableAt + 1);
        vm.expectRevert(abi.encodeWithSelector(RefundEscrow.NoDisputeOpen.selector, planId));
        escrow.executeSlash(planId);
    }

    /// @dev A cancellation racing an execution that is already legitimate would make the
    ///      timelock advisory.
    function test_aDisputeCannotBeCancelledOnceItsWindowHasPassed() public {
        _originatePlan();
        _openArbiterDispute(100e6);

        uint256 executableAt = escrow.disputeExecutableAt(planId);
        vm.warp(executableAt);

        vm.prank(arbiter);
        vm.expectRevert(
            abi.encodeWithSelector(RefundEscrow.TimelockAlreadyElapsed.selector, planId, executableAt)
        );
        escrow.cancelDispute(planId);
    }

    /// @dev The role is read into a local first. `vm.expectRevert` does not consume a
    ///      prank, but an external call among its *arguments* does — so building the
    ///      expectation inline would prank `ARBITER_ROLE()` and send the call that
    ///      matters from the test contract. The fixture's `_onboardMerchant` carries the
    ///      same warning for the same reason.
    function test_openDisputeNeedsTheArbiterRole() public {
        _originatePlan();
        bytes32 role = escrow.ARBITER_ROLE();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        escrow.openDispute(planId, merchant, 100e6, keccak256("evidence"));
    }

    /// @dev Refused rather than silently reduced. A dispute recorded for more than can
    ///      ever be taken is a number the merchant, the arbiter and the indexer would
    ///      each read differently.
    function test_arbiterCannotSlashMoreThanTheBond() public {
        _originatePlan();
        uint256 bond = merchants.bondOf(merchant);

        vm.prank(arbiter);
        vm.expectRevert(
            abi.encodeWithSelector(RefundEscrow.DisputeExceedsBond.selector, planId, bond + 1, bond)
        );
        escrow.openDispute(planId, merchant, bond + 1, keccak256("evidence"));
    }

    /// @notice POOL-14, asserted rather than assumed.
    ///
    /// @dev A slashed bond is a fraud recovery, not a credit recovery. Routing it down
    ///      the waterfall would pay junior a residual out of somebody's fraud, which is
    ///      not the risk junior was sold. It goes to the reserve, which is what the
    ///      reserve is for.
    function test_slashProceedsReachTheReserveNotJunior() public {
        _originatePlan();
        uint256 amount = 100e6;
        _openArbiterDispute(amount);

        uint256 reserveBefore = creditPool.reserveBalance();
        uint256 juniorBefore = creditPool.trancheAssets(ICreditPool.Tranche.Junior);
        uint256 seniorBefore = creditPool.trancheAssets(ICreditPool.Tranche.Senior);
        uint256 bondBefore = merchants.bondOf(merchant);

        vm.warp(escrow.disputeExecutableAt(planId));
        vm.prank(stranger);
        escrow.executeSlash(planId);

        assertEq(
            creditPool.reserveBalance() - reserveBefore,
            amount,
            "the slashed bond did not land in the reserve, or did not land whole"
        );
        assertEq(
            creditPool.trancheAssets(ICreditPool.Tranche.Junior),
            juniorBefore,
            "a fraud recovery paid junior a residual it was never sold"
        );
        assertEq(creditPool.trancheAssets(ICreditPool.Tranche.Senior), seniorBefore);
        assertEq(
            merchants.bondOf(merchant), bondBefore - amount, "the bond fell by something other than the slash"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // W-3 — the borrower's route out of an order that never shipped
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A dispute anyone can open, including the borrower, with no role anywhere.
    ///
    /// @dev `SettlementEscrow.refundToPool` makes the pool whole and deliberately leaves
    ///      the plan's receivable alone (D-04). Correct — and it is exactly why a
    ///      borrower can be left paying for goods that never shipped. Without this entry
    ///      point their only route is somebody with a role remembering to act, which is
    ///      an operator dependency on the borrower's side of the book.
    ///
    ///      So the assertion is not merely that the call succeeds: it is that the caller
    ///      holds no role at the moment it does.
    function test_nonAttestationDisputeNeedsNoOperator() public {
        _originatePlan();
        settlementEscrow.setRow(planId, true, merchant, 60e6, vm.getBlockTimestamp());

        address nobody = address(0xB0BB1E);
        assertFalse(escrow.hasRole(escrow.ARBITER_ROLE(), nobody), "the caller held the arbiter role");
        assertFalse(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), nobody), "the caller held admin");

        vm.prank(nobody);
        escrow.openNonAttestationDispute(planId);

        RefundEscrow.Dispute memory d = escrow.disputeOf(planId);
        assertEq(d.merchant, merchant, "the dispute was not opened against the merchant who failed to attest");
        assertEq(d.amount, 60e6, "the dispute was not opened for what went back to the pool");
        assertEq(d.evidenceRef, planId, "the evidence reference is not the plan the chain already records");
        assertGt(d.openedAt, 0);
    }

    /// @dev Eligibility is the only key, so it has to actually be turned. A path that
    ///      needs no role and checks no fact is a path that manufactures slashes.
    function test_nonAttestationDisputeRefusedWhenNotEligible() public {
        _originatePlan();
        settlementEscrow.setRow(planId, false, merchant, 60e6, vm.getBlockTimestamp());

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RefundEscrow.NotDisputeEligible.selector, planId));
        escrow.openNonAttestationDispute(planId);
    }

    /// @dev The anti-forgery argument is a signature, not a check: neither the merchant
    ///      nor the amount is a parameter, so a stranger has nothing to substitute. Both
    ///      rows below record the escrow's answer, and the two answers differ — which is
    ///      the only way to show the value came from the escrow rather than from a
    ///      constant.
    function test_nonAttestationDisputeCannotBeForged() public {
        _originatePlan();

        address merchantTwo = address(0xACCED2);
        _onboardMerchant(merchantTwo, 300e6);

        settlementEscrow.setRow(planId, true, merchant, 60e6, vm.getBlockTimestamp());
        vm.prank(stranger);
        escrow.openNonAttestationDispute(planId);

        ISettlementEscrow.ReturnedSettlement memory row = settlementEscrow.returnedSettlementOf(planId);
        RefundEscrow.Dispute memory first = escrow.disputeOf(planId);
        assertEq(first.merchant, row.merchant, "the recorded merchant is not the escrow's");
        assertEq(first.amount, row.amount, "the recorded amount is not the escrow's");

        bytes32 other = keccak256("a second returned settlement");
        settlementEscrow.setRow(other, true, merchantTwo, 30e6, vm.getBlockTimestamp());
        vm.prank(keeper);
        escrow.openNonAttestationDispute(other);

        RefundEscrow.Dispute memory second = escrow.disputeOf(other);
        assertEq(second.merchant, merchantTwo, "a caller's preference outranked the escrow's row");
        assertEq(second.amount, 30e6, "the amount tracked something other than the escrow's row");
    }

    /// @dev Opening a dispute without an arbiter must not also mean slashing without a
    ///      delay. Both entry points write the same row and `executeSlash` reads one
    ///      timelock.
    function test_nonAttestationSlashStillWaitsForTheTimelock() public {
        _originatePlan();
        settlementEscrow.setRow(planId, true, merchant, 60e6, vm.getBlockTimestamp());

        vm.prank(stranger);
        escrow.openNonAttestationDispute(planId);

        uint256 executableAt = escrow.disputeExecutableAt(planId);
        vm.warp(executableAt - 1);
        vm.expectRevert(
            abi.encodeWithSelector(RefundEscrow.DisputeStillTimelocked.selector, planId, executableAt)
        );
        escrow.executeSlash(planId);

        uint256 reserveBefore = creditPool.reserveBalance();
        vm.warp(executableAt + 1);
        vm.prank(keeper);
        escrow.executeSlash(planId);

        assertEq(creditPool.reserveBalance() - reserveBefore, 60e6, "the recovery did not reach the reserve");
    }

    /// @dev A merchant whose bond has fallen below what they took should still be
    ///      disputable for what is left. Reverting here would let a thin bond close the
    ///      borrower's only door, which is the opposite of what the arbiter path wants.
    function test_aNonAttestationDisputeSaturatesAtTheBondRatherThanReverting() public {
        _originatePlan();
        uint256 bond = merchants.bondOf(merchant);
        settlementEscrow.setRow(planId, true, merchant, bond + 1e6, vm.getBlockTimestamp());

        vm.prank(stranger);
        escrow.openNonAttestationDispute(planId);

        assertEq(escrow.disputeOf(planId).amount, bond, "the dispute recorded more than could ever be taken");
    }

    function test_aSecondDisputeCannotOverwriteAnOpenOne() public {
        _originatePlan();
        _openArbiterDispute(100e6);
        uint256 openedAt = escrow.disputeOf(planId).openedAt;

        settlementEscrow.setRow(planId, true, merchant, 400e6, vm.getBlockTimestamp());
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(RefundEscrow.DisputeAlreadyOpen.selector, planId, openedAt));
        escrow.openNonAttestationDispute(planId);
    }
}
