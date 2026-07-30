// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {PlanFixture} from "./helpers/PlanFixture.sol";
import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {PlanFactory} from "../src/PlanFactory.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {PlanId} from "../src/libraries/PlanId.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";
import {PlanAcceptance} from "../src/libraries/PlanAcceptance.sol";
import {TermsDetail} from "../src/libraries/TermsDetail.sol";
import {JurisdictionRegistry} from "../src/JurisdictionRegistry.sol";

/// @title InstallmentPlanTest
/// @notice The plan primitive's obligations, one at a time.
contract InstallmentPlanTest is PlanFixture {
    function setUp() public {
        _deployStack();
        vm.warp(1_800_000_000);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PLAN-05 — the borrower sees the deal, and the contract checks they did
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The acceptance is not decoration. Four EIP-3009 authorizations render in
    ///      a wallet as four unrelated transfers to a contract that holds no code
    ///      yet; nothing in them says what the total is, when the last payment
    ///      falls, or who the merchant is. If the acceptance were merely displayed
    ///      and not verified, the disclosed deal would be an operator's assertion.
    function test_rejectsAnAcceptanceThatDisagreesWithTheSchedule() public {
        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        PlanFactory.OriginationRequest memory request = _request(terms, _detail());

        // A borrower shown a final payment two weeks earlier than the contract will
        // take it has been shown a different plan.
        request.acceptance.finalDueDate -= 14 days;
        request.acceptanceSignature =
            _signAcceptance(request.acceptance, factory.predictAddress(PlanId.derive(terms)));
        _fundEscrow(COUNT);

        vm.expectRevert();
        factory.originate(request);
    }

    function test_rejectsAnAcceptanceSignedBySomeoneElse() public {
        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        PlanFactory.OriginationRequest memory request = _request(terms, _detail());

        bytes32 digest = PlanAcceptance.digest(
            request.acceptance, block.chainid, factory.predictAddress(PlanId.derive(terms))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xDEAD), digest);
        request.acceptanceSignature = abi.encodePacked(r, s, v);
        _fundEscrow(COUNT);

        vm.expectRevert(InstallmentPlan.AcceptanceInvalid.selector);
        factory.originate(request);
    }

    function test_rejectsAStaleAcceptance() public {
        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        PlanFactory.OriginationRequest memory request = _request(terms, _detail());
        _fundEscrow(COUNT);

        // An offer that never expires is a standing authorization to originate
        // credit at a price that has since moved.
        vm.warp(request.acceptance.validUntil + 1);

        vm.expectRevert(
            abi.encodeWithSelector(InstallmentPlan.AcceptanceExpired.selector, request.acceptance.validUntil)
        );
        factory.originate(request);
    }

    /// @dev The disclosed detail is bound to `planId` through `termsHash`. Swapping
    ///      the settlement recipient — or the FX router, or the jurisdiction — after
    ///      signing produces a hash the terms do not commit to.
    function test_rejectsDetailTheBorrowerDidNotCommitTo() public {
        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        PlanFactory.OriginationRequest memory request = _request(terms, _detail());
        request.detail.settlementRecipient = stranger;
        _fundEscrow(COUNT);

        vm.expectRevert();
        factory.originate(request);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PLAN-06 — the logic cannot change after the borrower signs
    // ─────────────────────────────────────────────────────────────────────────

    function test_cannotBeReinitialized() public {
        _originateDefault();

        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        InstallmentPlan.InitParams memory params = InstallmentPlan.InitParams({
            terms: terms,
            detail: _detail(),
            acceptance: _acceptance(terms, planId),
            acceptanceSignature: hex"",
            strip: new bytes[](COUNT),
            lateFeeCapBps: 2500,
            lateFeeCapAbsolute: 7e6,
            statementCadence: 30 days,
            withdrawalWindow: 14 days
        });

        vm.expectRevert(InstallmentPlan.AlreadyInitialized.selector);
        plan.initialize(params);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PLAN-07 / D3 — the state machine is frozen
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The ordinals are the ABI. `PlanStateChanged` carries `uint8`, an indexer
    ///      has written them to a database and four surfaces read them back; a
    ///      reorder silently relabels every historical row. This is a build failure
    ///      rather than a code review comment on purpose — Phase 9 submits this enum
    ///      to formal verification, and a state added afterwards re-opens the gate.
    function test_stateMachineOrdinalsAreFrozen() public pure {
        assertEq(uint256(IInstallmentPlan.PlanState.Pending), 0);
        assertEq(uint256(IInstallmentPlan.PlanState.Active), 1);
        assertEq(uint256(IInstallmentPlan.PlanState.Grace), 2);
        assertEq(uint256(IInstallmentPlan.PlanState.Delinquent), 3);
        assertEq(uint256(IInstallmentPlan.PlanState.Disputed), 4);
        assertEq(uint256(IInstallmentPlan.PlanState.Hold), 5);
        assertEq(uint256(IInstallmentPlan.PlanState.HALTED), 6);
        assertEq(uint256(IInstallmentPlan.PlanState.Blocked), 7);
        assertEq(uint256(IInstallmentPlan.PlanState.FraudReversed), 8);
        assertEq(uint256(IInstallmentPlan.PlanState.SettledWithFeeOutstanding), 9);
        assertEq(uint256(IInstallmentPlan.PlanState.Repaid), 10);
        assertEq(uint256(IInstallmentPlan.PlanState.Defaulted), 11);
        assertEq(uint256(IInstallmentPlan.PlanState.Cancelled), 12);
        assertEq(uint256(IInstallmentPlan.PlanState.Refunded), 13);

        assertEq(uint256(IInstallmentPlan.BounceReason.None), 0);
        assertEq(uint256(IInstallmentPlan.BounceReason.InsufficientFunds), 1);
        assertEq(uint256(IInstallmentPlan.BounceReason.Blocked), 2);
        assertEq(uint256(IInstallmentPlan.BounceReason.Halted), 3);
        assertEq(uint256(IInstallmentPlan.BounceReason.SignerInvalid), 4);
        assertEq(uint256(IInstallmentPlan.BounceReason.AuthorizationExpired), 5);
        assertEq(uint256(IInstallmentPlan.BounceReason.AuthorizationUsed), 6);

        assertEq(uint256(IInstallmentPlan.InstallmentStatus.Pending), 0);
        assertEq(uint256(IInstallmentPlan.InstallmentStatus.Cleared), 1);
        assertEq(uint256(IInstallmentPlan.InstallmentStatus.Bounced), 2);
        assertEq(uint256(IInstallmentPlan.InstallmentStatus.Missed), 3);
        assertEq(uint256(IInstallmentPlan.InstallmentStatus.Expired), 4);
        assertEq(uint256(IInstallmentPlan.InstallmentStatus.Refunded), 5);
    }

    /// @dev `Repaid` is absorbing. A keeper crank arriving after payoff cannot make
    ///      a settled borrower delinquent.
    function test_repaidIsAbsorbing() public {
        _originateDefault();
        _fundBorrower(200e6);

        vm.startPrank(borrower);
        usdc.approve(address(plan), PRINCIPAL);
        plan.repay(PRINCIPAL);
        vm.stopPrank();

        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Repaid));

        vm.warp(_dueDate(planId, firstDue, 3) + PlanParams.GRACE_WINDOW + 1);
        vm.expectRevert();
        plan.markMissed(3);

        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Repaid));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PLAN-08 — any count, any interval
    // ─────────────────────────────────────────────────────────────────────────

    function test_scheduleIsGenericOverCountAndInterval() public {
        // Pay in 4, fortnightly. The default product.
        _originate(_terms(100e6, 4, 1));
        assertEq(plan.installmentAmount(0), 25e6);
        assertEq(
            int256(plan.dueDate(1)) - int256(plan.dueDate(0)), int256(INTERVAL) + PlanParams.jitter(planId)
        );

        // Pay in 3 — the over-limit fallback the design comp already shows.
        _originate(_terms(90e6, 3, 2));
        assertEq(plan.installmentAmount(0), 30e6);
        assertEq(plan.installmentCount(), 3);

        // Twelve monthly, which is Flex's shape. Nothing in the plan knows the
        // difference; that is the point of installing N-generic schedules now
        // rather than re-opening the audited core in Phase 8.
        PlanId.PlanTerms memory terms = _terms(1200e6, 12, 3);
        terms.interval = 30 days;
        _originate(terms);
        assertEq(plan.installmentCount(), 12);
        assertEq(plan.installmentAmount(11), 100e6);
    }

    /// @dev A principal that does not divide evenly has to put the remainder
    ///      somewhere. It rides on installment 0, which settles at checkout, so
    ///      every installment the borrower has left to pay is the uniform figure the
    ///      merchant page advertised.
    function test_remainderRidesOnTheFirstInstallment() public {
        _originate(_terms(100_000_003, 4, 1));
        assertEq(plan.installmentAmount(0), 25_000_003);
        assertEq(plan.installmentAmount(1), 25_000_000);
        assertEq(plan.installmentAmount(3), 25_000_000);

        uint256 total;
        for (uint256 i = 0; i < 4; ++i) {
            total += plan.installmentAmount(i);
        }
        assertEq(total, 100_000_003, "the schedule does not sum to the principal");
    }

    function test_rejectsATicketBelowTheMinimum() public {
        PlanFactory.OriginationRequest memory request = _request(_terms(50e6, 4, 1), _detail());
        _fundEscrow(4);

        vm.expectRevert(
            abi.encodeWithSelector(InstallmentPlan.TicketBelowMinimum.selector, 50e6, PlanParams.MIN_TICKET)
        );
        factory.originate(request);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PLAN-09 — jitter
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Two plans originated in the same block get different recurring due
    ///      dates. Without this a cohort's checks all fall in one block and every
    ///      keeper's pull is a race it usually loses, which is a keeper market that
    ///      only the fastest bot participates in.
    ///
    ///      Derived from `planId`, not from `PREVRANDAO` — which is always zero on
    ///      Arc — so a borrower can reproduce their own dates without asking anyone.
    function test_jitterSeparatesPlansOriginatedTogether() public {
        InstallmentPlan first = _originate(_terms(PRINCIPAL, COUNT, 1));
        bytes32 firstId = planId;
        InstallmentPlan second = _originate(_terms(PRINCIPAL, COUNT, 2));

        assertEq(first.dueDate(0), second.dueDate(0), "the down payment is not jittered");
        assertTrue(first.dueDate(1) != second.dueDate(1), "recurring due dates collided");

        int256 delta = int256(first.dueDate(1)) - int256(second.dueDate(1));
        if (delta < 0) delta = -delta;
        assertLe(uint256(delta), 2 * PlanParams.JITTER_HALF_WIDTH, "jitter exceeded its window");
        assertEq(PlanParams.jitter(firstId), int256(first.dueDate(1)) - int256(firstDue + INTERVAL));
    }

    function test_scheduleStaysStrictlyIncreasing() public {
        _originateDefault();
        for (uint256 i = 1; i < COUNT; ++i) {
            assertGt(plan.dueDate(i), plan.dueDate(i - 1), "due dates are not strictly increasing");
            assertGe(plan.graceEndsAt(i), plan.dueDate(i), "grace ends before the installment is due");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COLL-02 — every failure mode is typed
    // ─────────────────────────────────────────────────────────────────────────

    function test_bouncesInsufficientFundsWithoutReverting() public {
        _originateDefault();
        vm.warp(_dueDate(planId, firstDue, 1));

        (bool cleared, IInstallmentPlan.BounceReason reason) = plan.collect(1);
        assertFalse(cleared);
        assertEq(uint256(reason), uint256(IInstallmentPlan.BounceReason.InsufficientFunds));
    }

    /// @dev CURE-07. A blocklisted borrower is a compliance event, not a credit
    ///      event, and it carries the opposite Passport and provisioning treatment.
    ///      Collapsing the two would make the loss data unreadable and put a default
    ///      on the record of someone who was never given the chance to pay.
    function test_blocklistIsADistinctStateFromAMissedPayment() public {
        _originateDefault();
        _fundBorrower(200e6);
        usdc.setBlacklisted(borrower, true);
        vm.warp(_dueDate(planId, firstDue, 1));

        (, IInstallmentPlan.BounceReason reason) = plan.collect(1);
        assertEq(uint256(reason), uint256(IInstallmentPlan.BounceReason.Blocked));
        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Blocked));
        assertTrue(
            plan.state() != IInstallmentPlan.PlanState.Grace, "a compliance block became a credit event"
        );
    }

    /// @dev CURE-06. A paused token means nobody could have paid. Running the grace
    ///      clock through it would manufacture delinquencies out of an
    ///      infrastructure outage — and every one of them would provision NAV, mark
    ///      a Passport and feed the kill switch.
    function test_aPausedTokenSuspendsTheClocksRatherThanManufacturingDefaults() public {
        _originateDefault();
        _fundBorrower(200e6);
        plan.collect(0);

        uint256 due = _dueDate(planId, firstDue, 1);
        vm.warp(due);
        usdc.setPaused(true);

        (, IInstallmentPlan.BounceReason reason) = plan.collect(1);
        assertEq(uint256(reason), uint256(IInstallmentPlan.BounceReason.Halted));
        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.HALTED));

        uint256 graceBefore = plan.graceEndsAt(1);

        // Ten days of outage. Under a running clock the plan would be four days past
        // grace and markable by anyone.
        vm.warp(due + 10 days);
        assertEq(plan.graceEndsAt(1), graceBefore + 10 days, "the clock kept running through the halt");
        vm.expectRevert();
        plan.markMissed(1);

        usdc.setPaused(false);
        plan.resume();
        assertEq(plan.haltOffset(), 10 days, "the suspension was not banked");

        // And the borrower still has their full grace window on the other side.
        plan.collect(1);
        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Active));
    }

    /// @dev The residue the invariant campaign found. `collect()` halts the plan
    ///      automatically when it runs into a paused token — but a plan with nothing
    ///      due that week never calls `collect()`, so the outage goes unobserved and
    ///      the grace clock keeps running against a borrower who could not have paid.
    ///
    ///      The token exposes that it *is* paused, never when it started, so a
    ///      suspension can only be banked from the moment someone tells the plan.
    ///      Observing is therefore permissionless and paid out of the same surplus
    ///      that funds revalidation, and recording a default is refused outright
    ///      while the rail is down.
    function test_anUnobservedPauseCanBeHaltedByAnyone() public {
        _originateDefault();
        _fundBorrower(200e6);
        plan.collect(0);

        usdc.setPaused(true);

        // Nobody has cranked. Without the halt the clock would run through the outage.
        vm.expectRevert(InstallmentPlan.TokenPaused.selector);
        plan.markMissed(1);

        vm.prank(stranger);
        plan.halt();

        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.HALTED));

        uint256 graceBefore = plan.graceEndsAt(1);
        vm.warp(block.timestamp + 6 days);
        assertEq(plan.graceEndsAt(1), graceBefore + 6 days, "the halt did not suspend the clock");

        // The bounty for the cycle lands on `resume()`, because paying it during the
        // outage would mean transferring the token that is paused.
        usdc.setPaused(false);
        vm.prank(stranger);
        plan.resume();
        assertEq(usdc.balanceOf(stranger), PlanParams.MARK_BOUNTY, "restarting the clock paid nothing");
    }

    function test_bouncesWhenTheBorrowerCancelledTheAuthorization() public {
        _originateDefault();
        _fundBorrower(200e6);

        vm.prank(borrower);
        usdc.cancelAuthorization(borrower, PlanId.checkNonce(planId, 1), _signCancellation(1));

        vm.warp(_dueDate(planId, firstDue, 1));
        (, IInstallmentPlan.BounceReason reason) = plan.collect(1);
        assertEq(uint256(reason), uint256(IInstallmentPlan.BounceReason.AuthorizationUsed));
    }

    function test_bouncesWhenTheAuthorizationHasExpired() public {
        _originateDefault();
        _fundBorrower(200e6);

        vm.warp(_dueDate(planId, firstDue, 1) + PlanParams.AUTHORIZATION_WINDOW);
        (, IInstallmentPlan.BounceReason reason) = plan.collect(1);
        assertEq(uint256(reason), uint256(IInstallmentPlan.BounceReason.AuthorizationExpired));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CURE — the push rail
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev CURE-02 and CURE-08. After the strip expires no keeper can help the
    ///      borrower: every authorization is dead and the debt is still owed. If the
    ///      push rail could be closed — by a pause, a role, or a state check — the
    ///      protocol would be holding a receivable it had made unpayable.
    function test_repayWorksAfterTheWholeStripHasExpired() public {
        _originateDefault();
        vm.warp(_dueDate(planId, firstDue, 3) + PlanParams.AUTHORIZATION_WINDOW + 1);

        plan.markExpired(0);
        _fundBorrower(200e6);

        uint256 payoff = plan.payoffAmount();
        vm.startPrank(borrower);
        usdc.approve(address(plan), payoff);
        plan.repay(payoff);
        vm.stopPrank();

        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Repaid));
    }

    function test_repayIsOpenToAnyoneAndRefundsAnyOverpayment() public {
        _originateDefault();
        usdc.mint(stranger, 500e6);

        // A parent, an employer, a merchant covering a goodwill gesture. The plan
        // does not care who settles it, only that it is settled.
        vm.startPrank(stranger);
        usdc.approve(address(plan), 500e6);
        plan.repay(500e6);
        vm.stopPrank();

        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Repaid));
        assertEq(usdc.balanceOf(stranger), 400e6, "the overpayment was not returned");
        assertEq(usdc.balanceOf(pool), PRINCIPAL + PlanParams.markEscrowFor(COUNT));
    }

    /// @dev CURE-05. Cancelling while the obligation stands says the remaining
    ///      checks will not be honoured. Cancelling after payoff is housekeeping.
    ///      The difference is the whole requirement.
    function test_cancellingWhileOutstandingIsAnAnticipatoryDefault() public {
        _originateDefault();
        _fundBorrower(200e6);
        plan.collect(0);

        vm.prank(borrower);
        usdc.cancelAuthorization(borrower, PlanId.checkNonce(planId, 2), _signCancellation(2));

        vm.prank(stranger);
        plan.noteCancellation(2);

        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Delinquent));
        assertEq(uint256(plan.installmentStatus(2)), uint256(IInstallmentPlan.InstallmentStatus.Missed));
        assertEq(usdc.balanceOf(stranger), PlanParams.MARK_BOUNTY, "the marker was not paid");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // D9 — refunds
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Principal first, borrower cash second. If a refund repaid completed
    ///      installments first, the pool would still carry a receivable against a
    ///      plan the borrower had no reason to keep paying, and a merchant's
    ///      unilateral action would move a loss onto the book.
    function test_aPartialRefundRetiresPrincipalAndSuppressesTheTail() public {
        _originateDefault();
        _fundBorrower(200e6);
        plan.collect(0);

        usdc.mint(merchant, 50e6);
        vm.startPrank(merchant);
        usdc.approve(address(plan), 50e6);
        plan.creditRefund(50e6);
        vm.stopPrank();

        assertEq(plan.outstandingPrincipal(), 25e6, "the refund did not retire principal");
        assertEq(plan.refundCredit(), 50e6);
        assertEq(
            uint256(plan.installmentStatus(3)),
            uint256(IInstallmentPlan.InstallmentStatus.Refunded),
            "the tail check was not suppressed"
        );

        // And a keeper cannot pull a check the refund already covered.
        vm.warp(_dueDate(planId, firstDue, 3));
        vm.expectRevert();
        plan.collect(3);
    }

    function test_aFullRefundReturnsThePaidInstallmentsToTheBorrower() public {
        _originateDefault();
        _fundBorrower(200e6);
        plan.collect(0);
        uint256 borrowerAfterDownPayment = usdc.balanceOf(borrower);

        usdc.mint(merchant, PRINCIPAL);
        vm.startPrank(merchant);
        usdc.approve(address(plan), PRINCIPAL);
        plan.creditRefund(PRINCIPAL);
        vm.stopPrank();

        assertEq(plan.outstandingPrincipal(), 0);
        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Refunded));
        assertEq(
            usdc.balanceOf(borrower),
            borrowerAfterDownPayment + 25e6,
            "the borrower did not get their paid installment back"
        );
    }

    /// @dev A merchant taking goods back does not undo that a payment was late.
    ///      `SettledWithFeeOutstanding` exists so this does not block payoff — a fee
    ///      waiver is an operator decision, not an accounting rule.
    function test_aRefundDoesNotWaiveAnAlreadyAssessedLateFee() public {
        _originateDefault();
        _fundBorrower(200e6);
        plan.collect(0);

        usdc.burnAll(borrower);
        vm.warp(_dueDate(planId, firstDue, 1) + PlanParams.GRACE_WINDOW + 1);
        plan.markMissed(1);
        assertGt(plan.feesOutstanding(), 0);

        usdc.mint(merchant, PRINCIPAL);
        vm.startPrank(merchant);
        usdc.approve(address(plan), PRINCIPAL);
        plan.creditRefund(PRINCIPAL);
        vm.stopPrank();

        assertEq(plan.outstandingPrincipal(), 0);
        assertGt(plan.feesOutstanding(), 0, "the refund silently waived the fee");
        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.SettledWithFeeOutstanding));
    }

    function test_onlyTheMerchantCanCreditARefund() public {
        _originateDefault();
        usdc.mint(stranger, 50e6);
        vm.startPrank(stranger);
        usdc.approve(address(plan), 50e6);
        vm.expectRevert(abi.encodeWithSelector(InstallmentPlan.OnlyMerchant.selector, stranger));
        plan.creditRefund(50e6);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GOV-04 — the jurisdiction parameter set
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The default set caps the late fee at 25% of an installment. On a $100
    ///      plan that is $6.25 against a $7.00 disclosed fee, so the cap binds — and
    ///      a borrower is charged the lower of what they were shown and what the law
    ///      where they live allows.
    function test_theJurisdictionCapBindsBelowTheDisclosedFee() public {
        _originateDefault();
        assertEq(plan.lateFee(), 6_250_000, "the jurisdiction cap did not bind");
        assertLt(plan.lateFee(), PlanParams.LATE_FEE_FLAT);
    }

    function test_aPlanCannotBeOriginatedUnderAnUnconfiguredJurisdiction() public {
        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        TermsDetail.Detail memory detail = _detail();
        detail.jurisdiction = keccak256("XX.NOWHERE");
        terms.termsHash = TermsDetail.hash(detail);

        PlanFactory.OriginationRequest memory request = _request(terms, detail);
        _fundEscrow(COUNT);

        // Silently applying someone else's rules is how a fee gets assessed under a
        // regime that forbids it.
        vm.expectRevert(
            abi.encodeWithSelector(JurisdictionRegistry.UnknownJurisdiction.selector, detail.jurisdiction)
        );
        factory.originate(request);
    }

    function test_governanceCannotSetAUsuriousLateFeeCap() public {
        JurisdictionRegistry.Params memory params = JurisdictionRegistry.Params({
            lateFeeCapBps: 9000,
            lateFeeCapAbsolute: 7e6,
            aprCapBps: 0,
            statementCadence: 30 days,
            withdrawalWindow: 14 days,
            enabled: true
        });
        vm.expectRevert();
        jurisdictions.set(keccak256("US.CA"), params);
    }

    /// @dev A live plan never re-reads the registry. Governance configures
    ///      origination; it cannot re-price a deal the borrower has already signed.
    function test_movingTheRegistryDoesNotRepriceALivePlan() public {
        _originateDefault();
        uint256 feeAtOrigination = plan.lateFee();

        jurisdictions.set(
            jurisdictions.DEFAULT_JURISDICTION(),
            JurisdictionRegistry.Params({
                lateFeeCapBps: 2500,
                lateFeeCapAbsolute: 25e6,
                aprCapBps: 0,
                statementCadence: 30 days,
                withdrawalWindow: 14 days,
                enabled: true
            })
        );

        assertEq(plan.lateFee(), feeAtOrigination, "governance re-priced a signed plan");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FX-01 / FX-06 — the seam is wired, not merely declared
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The identity router is invoked on every settlement. An interface with no
    ///      call site is a promise; a call site exercised from the first release is
    ///      a seam Phase 7 can supply without re-opening the audited core.
    function test_originationRefusesARouterThatCannotPriceThePlan() public {
        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        TermsDetail.Detail memory detail = _detail();
        // A router that prices something else. Passing an unknown currency through
        // unchanged would produce a plausible number the waterfall cannot tell from
        // a payment.
        detail.fxRouter = address(new IdentityFXRouterFor(address(0xEEEE)));
        terms.termsHash = TermsDetail.hash(detail);

        PlanFactory.OriginationRequest memory request = _request(terms, detail);
        _fundEscrow(COUNT);

        vm.expectRevert(abi.encodeWithSelector(InstallmentPlan.RouterCannotPrice.selector, address(usdc)));
        factory.originate(request);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CURE-09 — funds go back to the borrower or forward, and nowhere else
    // ─────────────────────────────────────────────────────────────────────────

    function test_strayValueCanOnlyBeForwarded() public {
        _originateDefault();
        usdc.mint(address(plan), 5e6);

        uint256 poolBefore = usdc.balanceOf(pool);
        vm.prank(stranger);
        plan.sweep();

        assertEq(usdc.balanceOf(pool), poolBefore + 5e6, "stray value did not go to the disclosed recipient");
        assertEq(usdc.balanceOf(stranger), 0, "the sweeper took a cut");
        assertEq(
            usdc.balanceOf(address(plan)),
            PlanParams.markEscrowFor(COUNT),
            "the sweep ate the plan's mark escrow"
        );
    }
}

/// @notice A router that prices a currency this plan does not use.
contract IdentityFXRouterFor {
    address public immutable accountingToken;

    constructor(address accountingToken_) {
        accountingToken = accountingToken_;
    }

    function normalize(address fromToken, uint256 amount) external view returns (uint256) {
        require(fromToken == accountingToken, "unsupported");
        return amount;
    }

    function isSupported(address fromToken) external view returns (bool) {
        return fromToken == accountingToken;
    }
}
