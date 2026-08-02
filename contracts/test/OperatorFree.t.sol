// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {console2} from "forge-std/console2.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {OperatorFreeFixture} from "./helpers/OperatorFreeFixture.sol";

import {CheckoutRouter} from "../src/CheckoutRouter.sol";
import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {RefundEscrow} from "../src/RefundEscrow.sol";
import {SettlementEscrow} from "../src/SettlementEscrow.sol";
import {TranchedCreditPool} from "../src/TranchedCreditPool.sol";
import {ICreditPool} from "../src/interfaces/ICreditPool.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {PlanId} from "../src/libraries/PlanId.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";

/// @title OperatorFreeTest
/// @notice GOV-08, the phase gate: with every operator role at the zero address,
///         collection, cure, marking, epoch settlement, redemption requests and refunds
///         all still work.
///
/// @dev **What is and is not being claimed.** Not "the protocol runs with nobody" —
///      that reading is what makes GOV-08 the most mis-scopeable requirement in the
///      phase. The claim is narrower and stronger: *once a plan exists, no operator is
///      needed for anything that happens to it, or to the capital behind it, ever
///      again.* Origination is deliberately outside it, because it needs
///      `CheckoutRouter.UNDERWRITER_ROLE` (CHKT-05) and `MerchantRegistry.KYB_ROLE`
///      (MERCH-01) and both are supposed to be load-bearing.
///
///      **Row 12 is why the other eleven mean anything.** An operator-free test with no
///      negative control proves the roles were never on the critical path in the first
///      place, which is a different and much weaker claim than the one GOV-08 makes.
///      Deleting row 12 makes no other test in the suite fail — that was measured, not
///      assumed — which is precisely the hole it fills. It is the same discipline as
///      `test_erc1271RejectingSignerIsRefused` in finding 1: the positive result is
///      worthless without the control that shows the mechanism was armed.
///
///      **D-25 governs where this runs.** Every renounce below happens in a Foundry
///      fixture. Renouncing `EligibilityRegistry` ownership on the deployment that
///      holds real capital would permanently freeze every tranche holder — finding 16
///      made unfixable — so the live half of GOV-08 runs on a throwaway deployment in
///      plan 06-13, and this file is the proof while that run is the witness.
///
///      Row 8 asserts a **token balance delta on the lender**, not that a ticket
///      existed. Finding 27: a claim assertion that does not check the balance proves
///      a ticket was issued and nothing about whether anyone got paid.
///
///      Every warp reads `vm.getBlockTimestamp()`. Under `via_ir` a bare
///      `block.timestamp` is hoisted past `vm.warp`, and this test warps constantly
///      (DEC-30, finding 14). Balance assertions run against `MockArcUsdc`, because Arc
///      USDC's token movement is a native precompile Foundry cannot execute (finding 3).
contract OperatorFreeTest is OperatorFreeFixture {
    InstallmentPlan internal planA;
    InstallmentPlan internal planB;
    bytes32 internal idA;
    bytes32 internal idB;
    uint256 internal dueA;
    uint256 internal dueB;

    /// @dev A remote-domain settlement queued **before** the roles went, so row 11 asks
    ///      the real question: can money already owed to a merchant still be pushed
    ///      across when there is nobody left to push it?
    uint256 internal constant QUEUED_PAYOUT = 407e6;

    /// @dev Plan B's schedule starts far enough out that nothing on it falls due during
    ///      the loop. It is the void case, and a void needs a plan that never went
    ///      delinquent: a late fee would send `creditRefund` to
    ///      `SettledWithFeeOutstanding` instead of `Refunded`, and `PlanVoided` would
    ///      never fire.
    uint256 internal constant PLAN_B_HORIZON = 200 days;

    /// @dev A third person for the attribution test. Both borrowers above already carry
    ///      an open plan, and Tier 0 allows one each.
    uint256 internal constant THIRD_BORROWER_KEY = 0xB0BB2;

    function setUp() public {
        _deployStack();
        _prepareOrigination();

        planA = _checkout(_terms(PRINCIPAL, COUNT, 1), keccak256("gov08-a"), 200e6);
        idA = planId;
        dueA = firstDue;

        // A second person, because Tier 0 allows one active plan each (UW-01).
        _becomeBorrower(secondBorrower, SECOND_BORROWER_KEY);
        PlanId.PlanTerms memory termsB = _terms(PRINCIPAL, COUNT, 2);
        termsB.firstDueDate = vm.getBlockTimestamp() + PLAN_B_HORIZON;
        planB = _checkout(termsB, keccak256("gov08-b"), 200e6);
        idB = planId;
        dueB = firstDue;

        // Back to the first borrower: rows 1 through 9 are all about plan A, and
        // `_fundBorrower` and the cure in row 3 both act on whoever `borrower` names.
        _becomeBorrower(vm.addr(BORROWER_KEY), BORROWER_KEY);

        // Queued while an operator still existed. Nothing below re-queues it.
        usdc.mint(address(this), QUEUED_PAYOUT);
        usdc.approve(address(payoutRouter), QUEUED_PAYOUT);
        payoutRouter.payout(address(usdc), REMOTE_DOMAIN, merchantPayout, QUEUED_PAYOUT);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The twelve rows
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Each row logs itself. A twelve-row table is a specification, and a
    ///      specification whose rows can go missing without anyone noticing is a
    ///      specification with a hole in it — so `-vv` prints the twelve lines and the
    ///      absence of one is visible rather than inferred from a green tick.
    function test_operatorFreeLoop() public {
        _goOperatorFree();
        assertTrue(operatorFree, "the roles were never actually revoked");

        _row(1, "collect from a stranger");
        _row1_strangerCollects();

        _row(2, "bounce recorded, not reverted");
        _row2_bounceIsRecordedNotReverted();

        _row(3, "borrower cures by push");
        _row3_borrowerCures();

        _row(4, "stranger marks, and is paid");
        _row4_strangerMarks();

        _row(5, "stranger recognises: pool book and merchant exposure both move");
        _row5_strangerRecognises();

        _row(6, "stranger marks and closes an epoch");
        _row6_strangerSettlesAnEpoch();

        _row(7, "lender requests a redemption");
        uint256 ticket = _row7_lenderRequestsRedemption();

        _row(8, "lender is actually paid");
        _row8_lenderIsActuallyPaid(ticket);

        _row(9, "merchant refunds, stranger books it");
        _row9_merchantRefundsAndAStrangerBooksIt();

        _row(10, "the void: pool made whole");
        _row10_theVoid();

        _row(11, "stranger dispatches the queued cross-chain payout");
        _row11_strangerDispatchesTheQueuedPayout();

        _row(12, "NEGATIVE CONTROL: origination reverts");
        _row12_originationReverts();
    }

    function _row(uint256 n, string memory what) private pure {
        console2.log(string.concat("GOV-08 row ", vm.toString(n), ": ", what));
    }

    /// @dev Row 1. The sharpest assertion in the file (DEC-18): `RELAYER_ROLE` is gone,
    ///      so the operator's own collection key can no longer crank, and a stranger
    ///      cranks anyway and is paid for it.
    function _row1_strangerCollects() private {
        _fundBorrower(200e6);
        _warpTo(planA.dueDate(0));

        uint256 quoted = planA.bountyFor(0);
        uint256 borrowerBefore = usdc.balanceOf(borrower);
        uint256 poolBefore = usdc.balanceOf(address(creditPool));
        uint256 amount = planA.installmentAmount(0);

        vm.prank(stranger1);
        planA.collect(0);

        assertEq(
            uint8(planA.installmentStatus(0)),
            uint8(IInstallmentPlan.InstallmentStatus.Cleared),
            "row 1: a stranger's collect did not clear the installment, so collection needs an operator"
        );
        assertEq(
            usdc.balanceOf(borrower), borrowerBefore - amount, "row 1: the borrower's balance did not move"
        );
        assertEq(
            usdc.balanceOf(address(creditPool)),
            poolBefore + amount - quoted,
            "row 1: the collected installment did not reach the book that funded it"
        );
        assertGt(quoted, 0, "row 1: the crank was quoted at nothing, so nobody would ever run it");
        assertEq(usdc.balanceOf(stranger1), quoted, "row 1: the crank paid something other than the quote");

        // The relayer path is the one that *did* need a role, and it is now shut.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, operator, relayer.RELAYER_ROLE()
            )
        );
        relayer.collect(address(planA), 1);
    }

    /// @dev Row 2. The failure is the signal (finding 4). An underfunded pull reverts at
    ///      the token; the plan has to catch it and *record* it, because grace
    ///      transitions, Passport marks, NAV provisioning, the subordination gate and
    ///      the FPD kill switch are all fed by an event that, left to the token, nobody
    ///      creates.
    function _row2_bounceIsRecordedNotReverted() private {
        _warpTo(planA.dueDate(1));
        usdc.burnAll(borrower);

        vm.expectEmit(true, true, false, true, address(planA));
        emit IInstallmentPlan.CheckBounced(idA, 1, IInstallmentPlan.BounceReason.InsufficientFunds);

        vm.prank(stranger1);
        (bool cleared,) = planA.collect(1);

        assertFalse(cleared, "row 2: a pull against a drained borrower reported success");
        assertEq(
            uint8(planA.state()),
            uint8(IInstallmentPlan.PlanState.Grace),
            "row 2: a bounce did not open the grace clock"
        );
    }

    /// @dev Row 3. The cure runs on the borrower's own transaction, through the push
    ///      rail, with nobody's permission.
    ///
    ///      The emitted index is `_firstUnresolved()` after the credit applies, which is
    ///      the bounced installment 1 — asserted exactly rather than loosely, because a
    ///      cure that named the wrong installment would be a Passport record about the
    ///      wrong payment.
    function _row3_borrowerCures() private {
        uint256 owed = planA.installmentAmount(1);
        usdc.mint(borrower, owed);

        // The approval is its own external call and emits its own event, so the
        // expectation is armed *after* it. Arming first would attach `PlanCured` to
        // `approve` and fail against an `Approval` log — the same class of mistake as
        // the prank trap `_onboardMerchant` documents.
        vm.prank(borrower);
        usdc.approve(address(planA), owed);

        vm.expectEmit(true, true, false, false, address(planA));
        emit IInstallmentPlan.PlanCured(idA, 1);

        vm.prank(borrower);
        planA.repay(owed);

        assertEq(
            uint8(planA.state()),
            uint8(IInstallmentPlan.PlanState.Active),
            "row 3: a borrower who paid what they owed is still in grace"
        );
    }

    /// @dev Row 4. The check itself was never cleared — `repay` retires principal, it
    ///      does not resolve the authorization that bounced — so the record still has to
    ///      be made, and a stranger is paid to make it. This is the crank that epoch
    ///      settlement cannot close without (COLL-04), which is what makes the negative
    ///      signal economically forced rather than merely available.
    function _row4_strangerMarks() private {
        _warpTo(planA.graceEndsAt(1) + 1);

        uint256 before = usdc.balanceOf(stranger2);

        vm.expectEmit(true, false, false, false, address(planA));
        emit IInstallmentPlan.PlanDelinquent(idA, 0);

        vm.prank(stranger2);
        planA.markMissed(1);

        assertTrue(planA.isMarked(1), "row 4: an overdue installment could not be recorded by a stranger");
        assertEq(
            uint8(planA.state()),
            uint8(IInstallmentPlan.PlanState.Delinquent),
            "row 4: grace expired without the plan becoming delinquent"
        );
        assertGt(usdc.balanceOf(stranger2), before, "row 4: recording a delinquency paid nothing");
    }

    /// @dev Row 5. Both ledgers move, and they move because a stranger asked. The pool's
    ///      carrying value and the merchant's exposure are separate books that a refund
    ///      or a recovery has to reach together, and `recognise` is the only path that
    ///      moves either (D-04, DEC-21).
    function _row5_strangerRecognises() private {
        uint256 carryingBefore = creditPool.bookOf(idA).carrying;
        uint256 exposureBefore = merchants.outstandingFrontedFor(merchant);
        uint256 retired = planA.principal() - planA.outstandingPrincipal();

        vm.prank(stranger3);
        checkout.recognise(idA);

        assertEq(
            creditPool.bookOf(idA).carrying,
            planA.outstandingPrincipal(),
            "row 5: the pool's carrying value did not follow the plan"
        );
        assertEq(
            carryingBefore - creditPool.bookOf(idA).carrying,
            retired,
            "row 5: the book did not recognise the principal that was actually recovered"
        );
        assertEq(
            exposureBefore - merchants.outstandingFrontedFor(merchant),
            retired,
            "row 5: the merchant's exposure did not fall with the pool's, so the bond is priced off a stale number"
        );
        assertGt(retired, 0, "row 5: nothing had been recovered, so the assertion was vacuous");
    }

    /// @dev Row 6. DEC-27 made both cranks permissionless, and here nobody holds
    ///      anything. The epoch cannot close while a delinquency is unmarked, so the
    ///      strangers have to do the marking too — which is the keeper market keeping
    ///      the book closable with no operator in it.
    function _row6_strangerSettlesAnEpoch() private {
        uint256 epochBefore = creditPool.currentEpoch();

        _markEverythingOverdue(stranger2);
        _closeEpochAsStranger(stranger4);

        assertEq(
            creditPool.currentEpoch(),
            epochBefore + 1,
            "row 6: an epoch could not be settled without an operator, so NAV stops being struck"
        );
        assertTrue(
            creditPool.allDelinquenciesMarked(),
            "row 6: the epoch closed over a delinquency nobody had recorded"
        );
    }

    /// @dev Row 7. The lender queues their own exit. `requestRedeem` moves shares into
    ///      the pool, which is a transfer the eligibility registry has to permit — and
    ///      the registry has had its owner renounced, so this also proves the renounce
    ///      did not freeze an existing holder out of leaving.
    function _row7_lenderRequestsRedemption() private returns (uint256 index) {
        uint256 shares = creditPool.seniorShares().balanceOf(lender) / 2;
        assertGt(shares, 0, "row 7: the lender held nothing to redeem, so the row was vacuous");

        vm.startPrank(lender);
        creditPool.seniorShares().approve(address(creditPool), shares);
        index = creditPool.requestRedeem(ICreditPool.Tranche.Senior, shares);
        vm.stopPrank();

        TranchedCreditPool.RedeemTicket memory ticket =
            creditPool.redeemTicketAt(ICreditPool.Tranche.Senior, lender, index);
        assertEq(
            ticket.hi - ticket.lo, shares, "row 7: the ticket does not cover the shares that were queued"
        );
    }

    /// @dev Row 8. **The money arrived**, not "a ticket was claimable" (finding 27). A
    ///      redemption assertion that stops at the ticket is an assertion about
    ///      bookkeeping; the thing a lender cares about is the balance.
    function _row8_lenderIsActuallyPaid(uint256 index) private {
        _markEverythingOverdue(stranger2);
        _closeEpochAsStranger(stranger4);

        uint256 before = usdc.balanceOf(lender);

        vm.prank(lender);
        uint256 assets = creditPool.claimRedemption(ICreditPool.Tranche.Senior, index, 64);

        assertGt(
            assets, 0, "row 8: the queue filled nothing, so the claim proved only that it reverted quietly"
        );
        assertEq(
            usdc.balanceOf(lender) - before,
            assets,
            "row 8: the lender's balance did not rise by the claimed amount, so the redemption is a ticket and not a payment"
        );
    }

    /// @dev Row 9. MERCH-03. The merchant credits the plan directly and a stranger books
    ///      it into both ledgers. **Principal is retired before borrower cash**: the pool
    ///      fronted the whole amount, so a refund that repaid completed installments
    ///      first would move a loss onto the book by the merchant's unilateral action.
    function _row9_merchantRefundsAndAStrangerBooksIt() private {
        uint256 refund = planA.outstandingPrincipal() / 2;
        assertGt(refund, 0, "row 9: nothing was outstanding, so there was no refund to apply");

        uint256 borrowerBefore = usdc.balanceOf(borrower);
        uint256 creditBefore = planA.refundCredit();
        uint256 outstandingBefore = planA.outstandingPrincipal();

        usdc.mint(merchant, refund);
        vm.startPrank(merchant);
        usdc.approve(address(planA), refund);
        planA.creditRefund(refund);
        vm.stopPrank();

        assertEq(
            planA.refundCredit() - creditBefore,
            refund,
            "row 9: the refund did not land as a plan-level credit"
        );
        assertEq(
            outstandingBefore - planA.outstandingPrincipal(),
            refund,
            "row 9: the refund did not retire principal"
        );
        assertEq(
            usdc.balanceOf(borrower),
            borrowerBefore,
            "row 9: borrower cash was paid ahead of principal, which moves a loss onto the book"
        );

        vm.expectEmit(true, false, false, true, address(refundEscrow));
        emit RefundEscrow.RefundCredited(idA, refund);

        vm.prank(stranger5);
        refundEscrow.noteRefund(idA);

        assertEq(
            creditPool.bookOf(idA).carrying,
            planA.outstandingPrincipal(),
            "row 9: the pool's book did not follow the refund"
        );
    }

    /// @dev Row 10. MERCH-02, and D-05's whole argument: a full-value `creditRefund`
    ///      before fulfilment *is* a void, arithmetically. The pool is made whole, the
    ///      tail is suppressed, and the plan reaches `Refunded` without
    ///      `PlanState.Cancelled` ever being reachable.
    function _row10_theVoid() private {
        uint256 owed = planB.outstandingPrincipal();
        uint256 receivablesBefore = creditPool.grossReceivables();

        usdc.mint(merchant, owed);
        vm.startPrank(merchant);
        usdc.approve(address(planB), owed);
        planB.creditRefund(owed);
        vm.stopPrank();

        assertEq(
            uint8(planB.state()),
            uint8(IInstallmentPlan.PlanState.Refunded),
            "row 10: a full-value refund did not void the plan"
        );

        vm.expectEmit(true, false, false, false, address(refundEscrow));
        emit RefundEscrow.PlanVoided(idB);

        vm.prank(stranger5);
        refundEscrow.noteRefund(idB);

        assertFalse(
            creditPool.bookOf(idB).open, "row 10: the pool still carries an open book against a voided plan"
        );
        assertEq(creditPool.bookOf(idB).carrying, 0, "row 10: a voided plan left carrying value behind");
        assertEq(
            receivablesBefore - creditPool.grossReceivables(),
            owed,
            "row 10: the pool was not made whole for what it fronted"
        );
    }

    /// @dev Row 11. XCH-02. `dispatch` takes no role and no bounty; the merchant is the
    ///      party with the interest and a keeper is the party with the gas, and neither
    ///      should have to ask an operator. The messenger is mocked because the shape of
    ///      the call is what a local test can add — the live burn out of Arc was measured
    ///      for real in plan 06-01 (finding 28).
    function _row11_strangerDispatchesTheQueuedPayout() private {
        assertEq(
            payoutRouter.queued(address(usdc), merchantPayout, REMOTE_DOMAIN),
            QUEUED_PAYOUT,
            "row 11: nothing was queued, so the row would have proven nothing"
        );

        vm.prank(stranger5);
        payoutRouter.dispatch(address(usdc), merchantPayout, REMOTE_DOMAIN);

        assertEq(
            messenger.burnCount(), 1, "row 11: a queued payout could not be pushed across without an operator"
        );
        assertEq(messenger.lastAmount(), QUEUED_PAYOUT, "row 11: the burn was for the wrong amount");
        assertEq(
            messenger.lastDestinationDomain(), REMOTE_DOMAIN, "row 11: the burn went to the wrong domain"
        );
        assertEq(
            messenger.lastMintRecipient(),
            bytes32(uint256(uint160(merchantPayout))),
            "row 11: the recipient was not left-padded, so the mint lands where nobody holds a key"
        );
        assertEq(
            payoutRouter.queued(address(usdc), merchantPayout, REMOTE_DOMAIN),
            0,
            "row 11: the queue was not cleared, so the same settlement could be burned twice"
        );
    }

    /// @dev **Row 12 — the negative control, and it is not optional.**
    ///
    ///      Without it the eleven rows above prove only that the roles were never
    ///      load-bearing. Deleting this row makes no other test in the suite fail, which
    ///      is exactly the reason it has to exist: its absence would be silent.
    ///
    ///      The typed error is `ScreenStale`, not `AttestationSignerUnauthorized`, and
    ///      that is a finding rather than a compromise. `originate` screens before it
    ///      authorizes, `AllowlistCompliance.SCREENER_ROLE` is one of the revoked
    ///      Class-B roles, and `SCREEN_FRESHNESS` is seven days — so the *first* gate
    ///      origination hits under role-zeroing is compliance freshness, and with nobody
    ///      able to re-screen it is a gate that never opens again.
    ///      `test_originationRevertsForEachRevokedRoleSeparately` reaches past it and
    ///      attributes the refusal to `KYB_ROLE` and `UNDERWRITER_ROLE` individually,
    ///      because a single combined control does not say *which* role was doing the
    ///      work.
    function _row12_originationReverts() private {
        // Staged before `expectRevert` is armed. `vm.expectRevert` attaches to the next
        // external call, and `compliance.screenedAt` is an external call — building the
        // input inline would attach the expectation to a view that does not revert.
        CheckoutRouter.OriginationInput memory input =
            _originationInput(_terms(PRINCIPAL, COUNT, 99), keccak256("gov08-after"), 200e6);
        uint256 screenedAt = compliance.screenedAt(borrower);

        assertGt(
            vm.getBlockTimestamp(),
            screenedAt + checkout.SCREEN_FRESHNESS(),
            "row 12: the screen had not yet gone stale, so the expected error is the wrong one"
        );

        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.ScreenStale.selector, borrower, screenedAt));
        checkout.originate(input);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Attribution: which role was actually load-bearing
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Each origination-gating role, revoked on its own, and the typed refusal
    ///         that follows.
    ///
    /// @dev A combined negative control says "origination stopped". It does not say what
    ///      stopped it, and a test that cannot answer that would keep passing if one of
    ///      the two roles quietly stopped mattering.
    ///
    ///      The two cases are genuinely different in kind, and the difference is the
    ///      point. `UNDERWRITER_ROLE` is checked against the *signature* on every
    ///      origination, so revoking it kills the next checkout immediately. `KYB_ROLE`
    ///      is not: a merchant already attested stays attested, and what dies is the
    ///      ability to onboard the *next* one. A test that expected both to behave the
    ///      same way would have to weaken one of them to pass.
    function test_originationRevertsForEachRevokedRoleSeparately() public {
        // ── Only `UNDERWRITER_ROLE` ──────────────────────────────────────────
        uint256 snapshot = vm.snapshotState();

        checkout.revokeRole(checkout.UNDERWRITER_ROLE(), underwriterKey);

        CheckoutRouter.OriginationInput memory input =
            _originationInput(_terms(PRINCIPAL, COUNT, 11), keccak256("gov08-uw"), 200e6);
        vm.expectRevert(
            abi.encodeWithSelector(CheckoutRouter.AttestationSignerUnauthorized.selector, underwriterKey)
        );
        checkout.originate(input);

        vm.revertToState(snapshot);

        // ── Only `KYB_ROLE` ──────────────────────────────────────────────────
        //
        // A third person, because both existing borrowers have an open plan and Tier
        // 0's one-active-plan rule would refuse this origination for a reason that has
        // nothing to do with the role under test.
        _becomeBorrower(vm.addr(THIRD_BORROWER_KEY), THIRD_BORROWER_KEY);

        address newMerchant = makeAddr("gov08-unattested-merchant");
        uint32 domain = payout.ARC_DOMAIN();
        vm.prank(newMerchant);
        merchants.register(merchantPayout, domain);
        _screenClear(newMerchant);

        merchants.revokeRole(merchants.KYB_ROLE(), operator);

        // Nobody can attest them. The role is the whole gate.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, operator, merchants.KYB_ROLE()
            )
        );
        merchants.attestKyb(newMerchant, true);

        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 12);
        terms.merchant = newMerchant;
        CheckoutRouter.OriginationInput memory second =
            _originationInput(terms, keccak256("gov08-kyb"), 200e6);
        vm.expectRevert(
            abi.encodeWithSelector(CheckoutRouter.MerchantIneligible.selector, "merchant not KYB verified")
        );
        checkout.originate(second);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DEC-13, re-asserted under role-zeroing
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The pause plane governs origination and cannot reach a plan that already
    ///         exists — with nobody able to pause, and again with everything paused and
    ///         nobody able to unpause.
    ///
    /// @dev The second half is the one worth having. `OriginationPause.unpause` needs
    ///      `DEFAULT_ADMIN_ROLE`, which `_goOperatorFree` revokes, so a pause struck
    ///      before the zeroing is a pause that lasts forever. If the pause plane could
    ///      reach a live plan, a stuck pause would be a book nobody could ever service
    ///      again — which is the failure mode DEC-13 exists to make impossible.
    function test_pausePlaneCannotReachALivePlan() public {
        pauses.pause();
        assertFalse(pauses.isOpen(checkout.corridorOf(address(usdc))), "the pause did not take");

        _goOperatorFree();

        // Nobody left to lift it, and nobody left to strike another one.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                operator,
                pauses.DEFAULT_ADMIN_ROLE()
            )
        );
        pauses.unpause();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, operator, pauses.PAUSER_ROLE()
            )
        );
        pauses.pause();

        // The loop runs anyway.
        _fundBorrower(200e6);
        _warpTo(planA.dueDate(0));
        vm.prank(stranger1);
        planA.collect(0);
        assertEq(
            uint8(planA.installmentStatus(0)),
            uint8(IInstallmentPlan.InstallmentStatus.Cleared),
            "a permanently paused origination plane stopped a plan that already existed"
        );

        _warpTo(planA.graceEndsAt(1) + 1);
        vm.prank(stranger2);
        planA.markMissed(1);
        assertTrue(planA.isMarked(1), "a paused protocol could not record its own delinquency");

        _markEverythingOverdue(stranger2);
        uint256 epochBefore = creditPool.currentEpoch();
        _closeEpochAsStranger(stranger4);
        assertEq(creditPool.currentEpoch(), epochBefore + 1, "a paused protocol could not settle an epoch");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MERCH-04's two exits, with genuinely nobody there
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Both escrow exits run from strangers after the roles are gone.
    ///
    /// @dev The fixture's merchant is unseasoned, and an unseasoned merchant is
    ///      `Escrowed` with no opt-out available — so both plans above settled into
    ///      `SettlementEscrow` without anybody configuring it. Plan A's merchant attests
    ///      and a stranger releases; plan B's is left unattested and a stranger returns
    ///      it to the pool. An escrow only an operator can release is an operator role on
    ///      the settlement path (D-07), and an escrow only an operator can return lets a
    ///      merchant who vanishes strand the pool's capital.
    function test_settlementEscrowExitsWithoutAnOperator() public {
        SettlementEscrow.Escrow memory a = settlementEscrow.escrowOf(idA);
        SettlementEscrow.Escrow memory b = settlementEscrow.escrowOf(idB);
        assertEq(
            uint8(a.state), uint8(SettlementEscrow.EscrowState.Held), "plan A did not settle into escrow"
        );
        assertEq(
            uint8(b.state), uint8(SettlementEscrow.EscrowState.Held), "plan B did not settle into escrow"
        );

        // Attested while an operator still existed; released after they are gone.
        vm.prank(merchant);
        settlementEscrow.attestShipment(idA, keccak256("carrier-record-commitment"));

        _goOperatorFree();

        uint256 payoutBefore = usdc.balanceOf(merchantPayout);
        _warpTo(settlementEscrow.releasableAt(idA));

        vm.prank(stranger1);
        settlementEscrow.release(idA);

        assertEq(
            uint8(settlementEscrow.escrowOf(idA).state),
            uint8(SettlementEscrow.EscrowState.Released),
            "a held settlement could not be released without an operator"
        );
        assertEq(
            usdc.balanceOf(merchantPayout) - payoutBefore,
            a.amount,
            "the released settlement did not reach the merchant's registered route"
        );

        // The other exit: never attested, past the deadline, returned by somebody else.
        uint256 reserveBefore = creditPool.reserveBalance();
        _warpTo(settlementEscrow.returnableAt(idB));

        vm.prank(stranger5);
        settlementEscrow.refundToPool(idB);

        assertEq(
            uint8(settlementEscrow.escrowOf(idB).state),
            uint8(SettlementEscrow.EscrowState.Returned),
            "an unattested settlement could not be returned without an operator"
        );
        assertEq(
            creditPool.reserveBalance() - reserveBefore,
            b.amount,
            "the returned settlement did not make the pool's reserve whole"
        );
        assertTrue(
            settlementEscrow.disputeEligible(idB),
            "a borrower left paying for goods that never shipped has no remedy, because nothing flagged it"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Mark every live installment on both plans that has run past its grace
    ///      window, from an address holding no role. `closeEpoch` refuses to run while
    ///      any of them is unmarked (COLL-04), so this is not scaffolding — it is the
    ///      keeper market being what keeps the book closable with no operator in it.
    function _markEverythingOverdue(address who) private {
        _markOverdue(planA, who);
        _markOverdue(planB, who);
    }

    function _markOverdue(InstallmentPlan p, address who) private {
        if (_isTerminal(p.state())) return;
        for (uint256 i = 0; i < p.installmentCount(); ++i) {
            IInstallmentPlan.InstallmentStatus status = p.installmentStatus(i);
            bool live = status == IInstallmentPlan.InstallmentStatus.Pending
                || status == IInstallmentPlan.InstallmentStatus.Bounced;
            if (!live) continue;
            if (vm.getBlockTimestamp() <= p.graceEndsAt(i)) continue;

            vm.prank(who);
            p.markMissed(i);
        }
    }

    function _isTerminal(IInstallmentPlan.PlanState state) private pure returns (bool) {
        return state == IInstallmentPlan.PlanState.Repaid || state == IInstallmentPlan.PlanState.Refunded
            || state == IInstallmentPlan.PlanState.Cancelled || state == IInstallmentPlan.PlanState.Defaulted
            || state == IInstallmentPlan.PlanState.FraudReversed;
    }
}
