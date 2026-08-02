// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {OriginationFixture} from "./helpers/OriginationFixture.sol";

import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {PayoutRouter} from "../src/PayoutRouter.sol";
import {RefundEscrow} from "../src/RefundEscrow.sol";
import {SettlementEscrow} from "../src/SettlementEscrow.sol";
import {TranchedCreditPool} from "../src/TranchedCreditPool.sol";
import {ICreditPool} from "../src/interfaces/ICreditPool.sol";
import {ISettlementEscrow} from "../src/interfaces/ISettlementEscrow.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
import {PlanId} from "../src/libraries/PlanId.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";
import {MockTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";

/// @title SettlementEscrowTest
/// @notice MERCH-04 — physical goods settle into escrow, digital settles instantly, and
///         nobody is needed at either exit.
///
/// @dev Four claims are under test here and they are not the same claim.
///
///      The first is that the category actually routes. `test_categoryRoutesSettlement`
///      runs two originations against two merchants in one transaction each and asserts
///      where the money landed — which is MERCH-04's headline and CHKT-04's continued
///      truth in a single test, because D-09 says escrowed settlement is a carve-out
///      from CHKT-04 rather than a regression of it.
///
///      The second is that neither exit needs anybody. An escrow only an operator can
///      release is an operator role on the settlement path and fails GOV-08; an escrow
///      only an operator can return lets a merchant who vanishes strand the pool's
///      capital indefinitely. Both are called here from addresses that hold no role,
///      and the tests assert the *absence of the role* rather than merely the success
///      of the call.
///
///      The third is the borrower's route. `SettlementEscrow.refundToPool` deliberately
///      leaves the plan's receivable alone (D-04 — the pool learns from the plan and
///      nothing may open a second write path for the same money), which is correct and
///      is also the reason a borrower can be left paying for goods that never shipped.
///      `test_nonAttestedReturnMakesThePlanDisputeEligible` runs that whole chain
///      against the **real** `RefundEscrow` rather than plan 06-08's stub, and the
///      address that opens the dispute holds neither `ARBITER_ROLE` nor
///      `DEFAULT_ADMIN_ROLE` at the moment of the call.
///
///      The fourth is that the flag stayed a flag. `test_disputeEligibilityWritesNoPoolBook`
///      asserts the plan's outstanding principal and the pool's carrying value are
///      byte-for-byte unchanged across `refundToPool`, so the only thing that moved is
///      cash through `fundReserve`.
///
///      Every warp reads the clock through `vm.getBlockTimestamp()`. `via_ir` hoists a
///      bare `block.timestamp` past `vm.warp`, and a release timer is exactly the kind
///      of code that would then warp forty times to the same instant and pass anyway
///      (DEC-30, finding 14, Pitfall 11). Balance assertions run against `MockArcUsdc`,
///      because Arc USDC's token movement is a native precompile Foundry cannot execute.
contract SettlementEscrowTest is OriginationFixture {
    RefundEscrow internal refunds;

    /// @dev The fixture's default merchant is unseasoned, and an unseasoned merchant is
    ///      `Escrowed` with no opt-out available. That is the physical-goods case
    ///      without anybody having to configure it, which is the point of D-06's
    ///      default.
    address internal digitalMerchant = address(0xD1617A1);
    address internal digitalPayout = address(0xDDDDDD);

    address internal arbiter = address(0xA9B17E);

    /// @dev Two callers with no roles anywhere, used at the two exits. Distinct so the
    ///      permissionlessness test cannot pass by one address happening to be special.
    address internal passerby = address(0x9A55E4);
    address internal otherPasserby = address(0x9A55E5);

    /// @notice Base Sepolia. The destination the live 06-01 burn actually went to.
    uint32 internal constant BASE_DOMAIN = 6;
    bytes32 internal constant REMOTE_MESSENGER =
        bytes32(uint256(uint160(0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA)));

    /// @dev A commitment to an off-chain carrier record under a published schema. Never
    ///      a tracking number: a tracking number resolves, for anybody who asks the
    ///      carrier, to where a named borrower lives (D-07).
    bytes32 internal constant CARRIER_REF = keccak256("carrier-record-commitment");

    function setUp() public {
        _deployStack();
        _prepareOrigination();

        refunds = new RefundEscrow(
            address(this),
            address(usdc),
            address(checkout),
            address(merchants),
            address(parameters),
            address(settlementEscrow)
        );
        merchants.grantRole(merchants.SLASHER_ROLE(), address(refunds));
        refunds.grantRole(refunds.ARBITER_ROLE(), arbiter);

        // A second merchant with their own payout route, so "where the money went" is a
        // question with two distinguishable answers.
        _onboardMerchant(digitalMerchant, 500e6);
        uint32 arc = payout.ARC_DOMAIN();
        vm.prank(digitalMerchant);
        merchants.setPayoutRoute(digitalPayout, arc);
        _screenClear(digitalMerchant);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The fixture's default terms with the merchant swapped. `_request` derives the
    ///      acceptance, the strip and the plan id from the terms it is handed, so
    ///      changing one field here changes all three consistently.
    function _termsFor(address who, uint256 nonce) internal view returns (PlanId.PlanTerms memory t) {
        t = _terms(PRINCIPAL, COUNT, nonce);
        t.merchant = who;
    }

    function _originateFor(address who, uint256 nonce) internal returns (bytes32) {
        _checkout(_termsFor(who, nonce), keccak256(abi.encode("session", who, nonce)), 5000e6);
        return planId;
    }

    /// @dev Move every party past the vesting window and re-screen them. Compliance
    ///      screens go stale after seven days, so a test that warps ninety and does not
    ///      re-screen fails on `ScreenStale` rather than on the thing it is about.
    function _seasonEveryone() internal {
        vm.warp(vm.getBlockTimestamp() + parameters.get(ParameterKeys.MERCHANT_VESTING_WINDOW) + 1);
        _screenClear(borrower);
        _screenClear(merchant);
        _screenClear(digitalMerchant);
    }

    /// @dev Tier 0 allows one active plan per person, so a test needing a second
    ///      origination has to close the first. Worth knowing on its own: the escrow row
    ///      is completely untouched by the plan reaching `Repaid`. The two clocks are
    ///      independent by design — a borrower can finish paying for goods the merchant
    ///      has still not attested shipping, which is precisely the asymmetry MERCH-04
    ///      exists to price.
    function _closeBorrowersSlot() internal {
        _payOff(plan);
        tier0.notePlanOutcome(planId);
    }

    function _attest(bytes32 id, address who) internal {
        vm.prank(who);
        settlementEscrow.attestShipment(id, CARRIER_REF);
    }

    function _warpPastReleaseTimer() internal {
        vm.warp(vm.getBlockTimestamp() + parameters.get(ParameterKeys.ESCROW_RELEASE_TIMER) + 1);
    }

    function _warpPastAttestationDeadline() internal {
        vm.warp(vm.getBlockTimestamp() + parameters.get(ParameterKeys.ESCROW_ATTESTATION_DEADLINE) + 1);
    }

    /// @dev Asserts that `who` holds nothing that could explain a successful call. The
    ///      claim being made about the two exits is not "this call works" — it is "this
    ///      call needs nobody", and only the second one is GOV-08.
    function _assertHoldsNoRole(address who) internal view {
        assertFalse(
            merchants.hasRole(merchants.DEFAULT_ADMIN_ROLE(), who), "the caller was a merchant-registry admin"
        );
        assertFalse(merchants.hasRole(merchants.KYB_ROLE(), who), "the caller held KYB_ROLE");
        assertFalse(
            merchants.hasRole(merchants.BOOKKEEPER_ROLE(), who), "the caller held the bookkeeper role"
        );
        assertFalse(refunds.hasRole(refunds.ARBITER_ROLE(), who), "the caller held ARBITER_ROLE");
        assertFalse(
            refunds.hasRole(refunds.DEFAULT_ADMIN_ROLE(), who), "the caller was a refund-escrow admin"
        );
        assertFalse(
            checkout.hasRole(checkout.DEFAULT_ADMIN_ROLE(), who), "the caller was a checkout-router admin"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Routing (MERCH-04, CHKT-04, D-09)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The category decides where settlement goes, in the origination call.
    ///
    /// @dev MERCH-04's headline and CHKT-04's continued truth in one test. The physical
    ///      merchant's net is held by a contract; the digital merchant's is in their
    ///      payout route before the transaction ends. Escrowed settlement is a carve-out
    ///      from CHKT-04, not a regression of it (D-09), and the only way to say that
    ///      credibly is to assert both halves at once.
    function test_categoryRoutesSettlement() public {
        _seasonEveryone();

        // Reaching `Instant` needs both halves of D-06 — a seasoned merchant *and* a
        // governance opt-out. `merchant` gets neither and stays escrowed.
        merchants.setCategory(digitalMerchant, MerchantRegistry.SettlementCategory.Instant);

        uint256 net = PRINCIPAL - checkout.mdrFor(PRINCIPAL);
        assertEq(merchants.vestingBpsFor(merchant), 0, "a withholding would muddy the balance assertions");

        bytes32 escrowed = _originateFor(merchant, 1);

        assertEq(
            usdc.balanceOf(address(settlementEscrow)),
            net,
            "a physical merchant's settlement did not reach the escrow"
        );
        assertEq(usdc.balanceOf(merchantPayout), 0, "a physical merchant was paid before shipping anything");

        SettlementEscrow.Escrow memory row = settlementEscrow.escrowOf(escrowed);
        assertEq(uint8(row.state), uint8(SettlementEscrow.EscrowState.Held), "the escrow row is not Held");
        assertEq(row.amount, net, "the row records an amount other than what was held");
        assertEq(row.merchant, merchant, "the row names the wrong merchant");
        assertEq(row.recipient, merchantPayout, "the row did not capture the payout route");

        _closeBorrowersSlot();
        bytes32 instant = _originateFor(digitalMerchant, 2);

        assertEq(
            usdc.balanceOf(digitalPayout),
            net,
            "a digital merchant was not credited in the origination transaction, which is CHKT-04"
        );
        assertEq(
            usdc.balanceOf(address(settlementEscrow)),
            net,
            "the digital origination put something into the escrow"
        );
        assertEq(
            uint8(settlementEscrow.escrowOf(instant).state),
            uint8(SettlementEscrow.EscrowState.None),
            "an instant plan has an escrow row"
        );
    }

    /// @notice A later registry change cannot reach a plan that has already settled.
    ///
    /// @dev D-06's mutability objection, closed by test rather than by argument. The
    ///      category is a mutable field driving an irreversible routing choice, and the
    ///      thing that makes that safe is that the read happens once, at origination.
    function test_categoryIsReadOnceAtOrigination() public {
        bytes32 id = _originateFor(merchant, 1);
        SettlementEscrow.Escrow memory before = settlementEscrow.escrowOf(id);
        assertEq(uint8(before.state), uint8(SettlementEscrow.EscrowState.Held), "the plan did not escrow");

        // Season the merchant and opt them out. Everything future settles instantly.
        _seasonEveryone();
        merchants.setCategory(merchant, MerchantRegistry.SettlementCategory.Instant);
        assertEq(
            uint8(merchants.categoryOf(merchant)),
            uint8(MerchantRegistry.SettlementCategory.Instant),
            "the opt-out did not take"
        );

        SettlementEscrow.Escrow memory settled = settlementEscrow.escrowOf(id);
        assertEq(
            uint8(settled.state), uint8(before.state), "the registry change moved a settled plan's state"
        );
        assertEq(settled.amount, before.amount, "the registry change moved a settled plan's amount");
        assertEq(
            uint8(settled.category),
            uint8(MerchantRegistry.SettlementCategory.Escrowed),
            "the row's stamped category followed the registry instead of recording origination"
        );

        // And the escrow path still runs to completion for that plan.
        _attest(id, merchant);
        _warpPastReleaseTimer();
        vm.prank(passerby);
        settlementEscrow.release(id);

        assertEq(
            usdc.balanceOf(merchantPayout),
            before.amount,
            "the already-escrowed plan did not release through the escrow"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Permissionlessness (D-07, GOV-08)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Both exits are open to anybody. Validation row 3b.
    ///
    /// @dev An escrow only an operator can release is an operator role on the settlement
    ///      path, and an escrow only an operator can return lets a vanished merchant
    ///      strand the pool's capital. Both callers here hold nothing, and the test says
    ///      so structurally rather than trusting that the fixture never granted them
    ///      anything.
    function test_escrowIsPermissionless() public {
        bytes32 released = _originateFor(merchant, 1);
        _closeBorrowersSlot();
        bytes32 returned = _originateFor(merchant, 2);

        uint256 heldEach = settlementEscrow.escrowOf(released).amount;
        _attest(released, merchant);

        // One warp past the longer of the two timers. The release timer runs from the
        // attestation a moment ago; the attestation deadline runs from the hold.
        _warpPastAttestationDeadline();

        _assertHoldsNoRole(passerby);
        vm.prank(passerby);
        settlementEscrow.release(released);

        _assertHoldsNoRole(otherPasserby);
        vm.prank(otherPasserby);
        settlementEscrow.refundToPool(returned);

        assertEq(
            usdc.balanceOf(merchantPayout), heldEach, "a stranger could not release an attested settlement"
        );
        assertEq(
            uint8(settlementEscrow.escrowOf(returned).state),
            uint8(SettlementEscrow.EscrowState.Returned),
            "a stranger could not return an unattested settlement"
        );
    }

    /// @notice The release timer binds to the second, and the error names the moment.
    function test_releaseBeforeTheTimerReverts() public {
        bytes32 id = _originateFor(merchant, 1);
        _attest(id, merchant);

        uint256 readyAt = settlementEscrow.releasableAt(id);
        assertEq(
            readyAt,
            settlementEscrow.escrowOf(id).attestedAt + parameters.get(ParameterKeys.ESCROW_RELEASE_TIMER),
            "the view and the row disagree about when release becomes possible"
        );

        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(SettlementEscrow.TimerNotElapsed.selector, id, readyAt));
        vm.prank(passerby);
        settlementEscrow.release(id);

        vm.warp(readyAt);
        vm.prank(passerby);
        settlementEscrow.release(id);
        assertEq(
            uint8(settlementEscrow.escrowOf(id).state),
            uint8(SettlementEscrow.EscrowState.Released),
            "the release did not land one second after the timer"
        );
    }

    /// @notice No attestation, no release — however long anybody waits.
    /// @dev The release timer runs from the attestation, so a plan that was never
    ///      attested has no clock to run out. A merchant who ships nothing is never paid
    ///      by the passage of time, which is the whole of MERCH-04.
    function test_releaseWithoutAttestationReverts() public {
        bytes32 id = _originateFor(merchant, 1);

        vm.warp(vm.getBlockTimestamp() + 365 days);
        vm.expectRevert(abi.encodeWithSelector(SettlementEscrow.NotAttested.selector, id));
        vm.prank(passerby);
        settlementEscrow.release(id);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The return path (D-04, T-06-09-02)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice An unattested settlement goes back to the pool's first-loss reserve.
    ///
    /// @dev The reserve and `bookedCash` both move by exactly the held amount, and
    ///      neither tranche moves at all. Routing this down the waterfall instead would
    ///      distribute a merchant's failure to ship as though it were investment income.
    function test_refundToPoolAfterDeadlineReachesTheReserve() public {
        bytes32 id = _originateFor(merchant, 1);
        uint256 held = settlementEscrow.escrowOf(id).amount;

        uint256 reserveBefore = creditPool.reserveBalance();
        uint256 cashBefore = creditPool.bookedCash();
        uint256 juniorBefore = creditPool.trancheAssets(ICreditPool.Tranche.Junior);
        uint256 seniorBefore = creditPool.trancheAssets(ICreditPool.Tranche.Senior);

        _warpPastAttestationDeadline();
        vm.prank(passerby);
        settlementEscrow.refundToPool(id);

        assertEq(
            creditPool.reserveBalance() - reserveBefore, held, "the reserve did not receive the whole hold"
        );
        assertEq(
            creditPool.bookedCash() - cashBefore, held, "the cash entry does not match the reserve entry"
        );
        assertEq(
            creditPool.trancheAssets(ICreditPool.Tranche.Junior),
            juniorBefore,
            "junior's assets moved, so a merchant's non-shipment was distributed as income"
        );
        assertEq(
            creditPool.trancheAssets(ICreditPool.Tranche.Senior),
            seniorBefore,
            "senior's assets moved on a return that is not a credit event"
        );
        assertEq(usdc.balanceOf(address(settlementEscrow)), 0, "the escrow kept part of the settlement");
    }

    /// @notice Before the deadline the money stays where it is.
    function test_refundToPoolBeforeTheDeadlineReverts() public {
        bytes32 id = _originateFor(merchant, 1);

        uint256 readyAt = settlementEscrow.returnableAt(id);
        assertEq(
            readyAt,
            settlementEscrow.escrowOf(id).heldAt + parameters.get(ParameterKeys.ESCROW_ATTESTATION_DEADLINE),
            "the view and the row disagree about the attestation deadline"
        );

        vm.warp(readyAt - 1);
        vm.expectRevert(abi.encodeWithSelector(SettlementEscrow.TimerNotElapsed.selector, id, readyAt));
        vm.prank(passerby);
        settlementEscrow.refundToPool(id);
    }

    /// @notice A merchant who attested cannot have their settlement clawed by a timer.
    /// @dev The two exits are mutually exclusive, and this is the half that protects an
    ///      honest merchant: shipping the goods and then waiting out a deadline nobody
    ///      told them about would be the protocol taking payment for delivered goods.
    function test_refundToPoolAfterAttestationReverts() public {
        bytes32 id = _originateFor(merchant, 1);
        _attest(id, merchant);

        _warpPastAttestationDeadline();
        vm.expectRevert(abi.encodeWithSelector(SettlementEscrow.AlreadyAttested.selector, id));
        vm.prank(passerby);
        settlementEscrow.refundToPool(id);

        // And the other exit is still open, which is what makes this an exclusion rather
        // than a lock-up.
        settlementEscrow.release(id);
        assertEq(
            uint8(settlementEscrow.escrowOf(id).state),
            uint8(SettlementEscrow.EscrowState.Released),
            "the attested settlement could not be released after the deadline passed"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The borrower's route (W-3, T-06-09-11)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Nothing shipped, so the plan is disputable by anybody.
    ///
    /// @dev The whole linkage, end to end, against both real contracts rather than plan
    ///      06-08's stub. `refundToPool` makes the pool whole and leaves the borrower's
    ///      receivable live — correct under D-04, and the exact circumstance in which a
    ///      borrower is left paying for goods that never existed. Without the flag their
    ///      only remedy is an operator noticing. With it, a passer-by can open the
    ///      dispute, and this test asserts that the passer-by holds nothing at the moment
    ///      they do.
    function test_nonAttestedReturnMakesThePlanDisputeEligible() public {
        bytes32 id = _originateFor(merchant, 1);
        uint256 held = settlementEscrow.escrowOf(id).amount;

        _warpPastAttestationDeadline();

        vm.expectEmit(true, true, false, true, address(settlementEscrow));
        emit ISettlementEscrow.SettlementReturnedForNonAttestation(id, merchant, held);
        vm.prank(passerby);
        settlementEscrow.refundToPool(id);

        assertTrue(settlementEscrow.disputeEligible(id), "a non-attested return left no dispute ground");

        ISettlementEscrow.ReturnedSettlement memory row = settlementEscrow.returnedSettlementOf(id);
        assertEq(row.merchant, merchant, "the returned row names the wrong merchant");
        assertEq(row.amount, held, "the returned row reports the wrong amount");
        assertEq(row.returnedAt, vm.getBlockTimestamp(), "the returned row did not stamp the return");

        // The borrower's route: a second stranger, no roles, no operator, no ticket.
        _assertHoldsNoRole(otherPasserby);
        vm.prank(otherPasserby);
        refunds.openNonAttestationDispute(id);

        RefundEscrow.Dispute memory dispute = refunds.disputeOf(id);
        assertEq(dispute.merchant, merchant, "the dispute was opened against the wrong merchant");
        assertGt(dispute.openedAt, 0, "no dispute was opened");
        assertEq(dispute.amount, held, "the dispute amount was not read from the escrow row");
    }

    /// @notice The negative control. The flag means the thing it says.
    /// @dev A merchant who attested and was released is not disputable on this ground.
    ///      Widening eligibility past "provably failed to attest before an on-chain
    ///      deadline" would hand a permissionless slash to circumstances nobody
    ///      adjudicated.
    function test_attestedPlanIsNotDisputeEligible() public {
        bytes32 id = _originateFor(merchant, 1);
        _attest(id, merchant);
        _warpPastReleaseTimer();
        settlementEscrow.release(id);

        assertFalse(settlementEscrow.disputeEligible(id), "a released plan reported a dispute ground");

        ISettlementEscrow.ReturnedSettlement memory row = settlementEscrow.returnedSettlementOf(id);
        assertEq(row.merchant, address(0), "a released plan reported a returned merchant");
        assertEq(row.amount, 0, "a released plan reported a returned amount");
        assertEq(row.returnedAt, 0, "a released plan reported a return time");

        vm.expectRevert(abi.encodeWithSelector(RefundEscrow.NotDisputeEligible.selector, id));
        vm.prank(otherPasserby);
        refunds.openNonAttestationDispute(id);
    }

    /// @notice The flag is a flag. D-04, asserted rather than assumed.
    ///
    /// @dev The one mistake a later reader is most likely to make is to "complete"
    ///      `refundToPool` by also crediting the plan, which rebuilds the second ledger
    ///      DEC-21 exists to prevent. Around the call, the plan's outstanding principal
    ///      and the pool's carrying value for it are byte-for-byte unchanged; the only
    ///      thing that moved is cash, and it moved through `fundReserve` alone.
    function test_disputeEligibilityWritesNoPoolBook() public {
        bytes32 id = _originateFor(merchant, 1);

        TranchedCreditPool.PlanBook memory bookBefore = creditPool.bookOf(id);
        uint256 outstandingBefore = plan.outstandingPrincipal();
        uint256 receivablesBefore = creditPool.grossReceivables();
        uint256 exposureBefore = merchants.outstandingFrontedFor(merchant);

        _warpPastAttestationDeadline();
        vm.prank(passerby);
        settlementEscrow.refundToPool(id);

        TranchedCreditPool.PlanBook memory bookAfter = creditPool.bookOf(id);
        assertEq(
            bookAfter.carrying, bookBefore.carrying, "the pool's carrying value moved, which is a ledger"
        );
        assertEq(bookAfter.principal, bookBefore.principal, "the plan's booked principal moved");
        assertEq(
            bookAfter.deferredIncome,
            bookBefore.deferredIncome,
            "the deferred MDR moved on a settlement return"
        );
        assertEq(plan.outstandingPrincipal(), outstandingBefore, "the borrower's obligation moved");
        assertEq(creditPool.grossReceivables(), receivablesBefore, "gross receivables moved");
        assertEq(
            merchants.outstandingFrontedFor(merchant),
            exposureBefore,
            "merchant exposure moved, so the flag became a second write path"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Who may do what
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Only the merchant attests. There is no oracle behind it and no proxy.
    function test_attestShipmentIsMerchantOnly() public {
        bytes32 id = _originateFor(merchant, 1);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SettlementEscrow.OnlyMerchant.selector, stranger, merchant));
        settlementEscrow.attestShipment(id, CARRIER_REF);

        // Not even the deployer, who holds every admin role in this fixture.
        vm.expectRevert(
            abi.encodeWithSelector(SettlementEscrow.OnlyMerchant.selector, address(this), merchant)
        );
        settlementEscrow.attestShipment(id, CARRIER_REF);
    }

    /// @notice Only the router writes a row.
    ///
    /// @dev The row is the evidence a non-attestation dispute is opened against, so an
    ///      arbitrary caller who could manufacture one could wait out the deadline and
    ///      hand themselves a permissionless slash against a merchant who never sold
    ///      anything.
    function test_holdIsRouterOnly() public {
        usdc.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usdc.approve(address(settlementEscrow), 100e6);
        vm.expectRevert(abi.encodeWithSelector(SettlementEscrow.OnlyRouter.selector, stranger));
        settlementEscrow.hold(keccak256("forged"), merchant, address(usdc), 26, merchantPayout, 100e6);
        vm.stopPrank();

        assertFalse(settlementEscrow.disputeEligible(keccak256("forged")), "a forged row became disputable");
    }

    /// @notice The router cannot be renamed once it is set.
    /// @dev A rotatable router on a contract that holds merchant money is an admin key
    ///      that can redirect where a settlement is pulled from.
    function test_theRouterIsNamedOnce() public {
        assertEq(settlementEscrow.router(), address(checkout), "the fixture did not complete the handshake");

        vm.expectRevert(abi.encodeWithSelector(SettlementEscrow.RouterAlreadySet.selector, address(checkout)));
        settlementEscrow.setRouter(stranger);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SettlementEscrow.OnlyAdmin.selector, stranger));
        settlementEscrow.setRouter(stranger);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Composition with the cross-chain path (XCH-02)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A physical merchant on a remote domain queues, and a stranger dispatches.
    ///
    /// @dev Escrow and cross-chain compose rather than special-casing each other:
    ///      `release` pays through the same `ICrossChainPayout` seam an instant
    ///      settlement uses, so a non-Arc destination lands in `PayoutRouter.queued` and
    ///      is bridged afterwards by anybody, exactly as D-10's settle-then-dispatch
    ///      intends.
    ///
    ///      The escrow under test is a second deployment wired to a `PayoutRouter`, with
    ///      the test contract standing in as the router. The `OriginationFixture` still
    ///      runs `ArcLocalPayout` — swapping the fixture's payout implementation is plan
    ///      06-13's rewire and not this plan's to make — so `hold` is driven directly
    ///      here rather than through an origination. Nothing else about the path
    ///      differs: it is the same `release`, the same seam, and the same
    ///      `depositForBurn` shape plan 06-05 asserted.
    function test_escrowedRemoteDomainStillQueuesAndDispatches() public {
        MockTokenMessengerV2 messenger = new MockTokenMessengerV2(address(0x7A45));
        messenger.setRemoteTokenMessenger(BASE_DOMAIN, REMOTE_MESSENGER);
        PayoutRouter remotePayout = new PayoutRouter(address(this), address(messenger));

        SettlementEscrow remoteEscrow = new SettlementEscrow(
            address(this), address(merchants), address(remotePayout), address(parameters)
        );
        remoteEscrow.setRouter(address(this));

        bytes32 id = keccak256("remote-plan");
        uint256 amount = 96e6;
        usdc.mint(address(this), amount);
        usdc.approve(address(remoteEscrow), amount);
        remoteEscrow.hold(id, merchant, address(usdc), BASE_DOMAIN, merchantPayout, amount);

        _attest2(remoteEscrow, id, merchant);
        _warpPastReleaseTimer();

        vm.prank(passerby);
        remoteEscrow.release(id);

        assertEq(
            remotePayout.queued(address(usdc), merchantPayout, BASE_DOMAIN),
            amount,
            "a released escrow on a remote domain did not queue"
        );
        assertEq(usdc.balanceOf(merchantPayout), 0, "a remote-domain release paid on Arc instead");

        vm.prank(otherPasserby);
        remotePayout.dispatch(address(usdc), merchantPayout, BASE_DOMAIN);

        assertEq(messenger.burnCount(), 1, "a stranger could not dispatch the queued settlement");
        assertEq(messenger.lastAmount(), amount, "the burn was for the wrong amount");
        assertEq(messenger.lastDestinationDomain(), BASE_DOMAIN, "the burn named the wrong domain");
        assertEq(
            messenger.lastMintRecipient(),
            bytes32(uint256(uint160(merchantPayout))),
            "the mint recipient was not left-padded, so the mint is unrecoverable"
        );
        assertEq(
            remotePayout.queued(address(usdc), merchantPayout, BASE_DOMAIN), 0, "the queue was not drained"
        );
    }

    function _attest2(SettlementEscrow escrow_, bytes32 id, address who) internal {
        vm.prank(who);
        escrow_.attestShipment(id, CARRIER_REF);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The timers are rows (D-08, GOV-01)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The timers are read at call time, so an open row's clock follows the row.
    ///
    /// @dev **This is the semantics, stated explicitly because a timer nobody wrote down
    ///      is a timer that will be changed by accident.** `release` reads
    ///      `ESCROW_RELEASE_TIMER` from the registry at the moment it is called, not at
    ///      the moment of attestation — so moving the parameter inside its compiled band
    ///      moves the readiness of escrows that are *already open*, in both directions.
    ///
    ///      That is the correct choice here rather than a stamped-at-hold-time timer,
    ///      because the alternative is a deployment carrying as many timer regimes as it
    ///      has ever had parameter values, and a governance action that could not shorten
    ///      a hold it had reason to shorten. The compiled band (1 hour to 14 days) is
    ///      what stops the same read being used to release everything at once — the band
    ///      is a `require` in `ParameterRegistry`, and widening it needs a redeployment
    ///      rather than a vote.
    function test_timersComeFromTheRegistryNotAConstant() public {
        bytes32 id = _originateFor(merchant, 1);
        _attest(id, merchant);

        uint256 attestedAt = settlementEscrow.escrowOf(id).attestedAt;
        uint256 original = parameters.get(ParameterKeys.ESCROW_RELEASE_TIMER);
        assertEq(
            settlementEscrow.releasableAt(id), attestedAt + original, "the timer was not the row's value"
        );

        // Inside the band, and shorter. An open row follows it.
        uint256 shortened = 6 hours;
        assertLt(shortened, original, "the probe did not actually shorten the timer");
        parameters.set(ParameterKeys.ESCROW_RELEASE_TIMER, shortened);

        assertEq(
            settlementEscrow.releasableAt(id),
            attestedAt + shortened,
            "an already-open escrow kept the timer it was created under, so the read is stamped not live"
        );

        vm.warp(attestedAt + shortened);
        vm.prank(passerby);
        settlementEscrow.release(id);
        assertEq(
            uint8(settlementEscrow.escrowOf(id).state),
            uint8(SettlementEscrow.EscrowState.Released),
            "the shortened timer did not make an open escrow releasable"
        );

        // And a new row takes the new value too, which is the uninteresting half.
        _closeBorrowersSlot();
        bytes32 second = _originateFor(merchant, 2);
        _attest(second, merchant);
        assertEq(
            settlementEscrow.releasableAt(second),
            settlementEscrow.escrowOf(second).attestedAt + shortened,
            "a fresh escrow did not read the current row"
        );
    }

    /// @notice A row cannot be written twice over the top of itself.
    function test_aPlanCannotBeHeldTwice() public {
        bytes32 id = keccak256("double-hold");
        SettlementEscrow local =
            new SettlementEscrow(address(this), address(merchants), address(payout), address(parameters));
        local.setRouter(address(this));

        // The domain is read into a local first. `vm.expectRevert` attaches to the next
        // external call, and an argument that is itself an external call consumes it —
        // the same trap `OriginationFixture._onboardMerchant` documents for `vm.prank`.
        uint32 arc = payout.ARC_DOMAIN();

        usdc.mint(address(this), 200e6);
        usdc.approve(address(local), 200e6);
        local.hold(id, merchant, address(usdc), arc, merchantPayout, 100e6);

        vm.expectRevert(abi.encodeWithSelector(SettlementEscrow.AlreadyHeld.selector, id));
        local.hold(id, merchant, address(usdc), arc, merchantPayout, 100e6);
    }

    /// @notice The carrier reference is a commitment, and it is what the merchant said.
    /// @dev A `bytes32`, so there is no cleartext field on this contract that could
    ///      carry a tracking number — which is a delivery address by proxy for any
    ///      borrower whose plan it belongs to (D-07).
    function test_theCarrierReferenceIsACommitmentOnTheRow() public {
        bytes32 id = _originateFor(merchant, 1);

        vm.expectEmit(true, false, false, true, address(settlementEscrow));
        emit SettlementEscrow.ShipmentAttested(id, CARRIER_REF);
        _attest(id, merchant);

        SettlementEscrow.Escrow memory row = settlementEscrow.escrowOf(id);
        assertEq(row.carrierRef, CARRIER_REF, "the commitment did not reach the row");
        assertEq(row.attestedAt, vm.getBlockTimestamp(), "the attestation did not start the release timer");
        assertEq(
            uint8(row.state), uint8(SettlementEscrow.EscrowState.Attested), "the row did not move to Attested"
        );

        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(SettlementEscrow.AlreadyAttested.selector, id));
        settlementEscrow.attestShipment(id, keccak256("a second story"));
    }
}
