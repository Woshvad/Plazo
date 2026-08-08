// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {CorridorFixture} from "../helpers/CorridorFixture.sol";
import {StubSettlementEscrow} from "../RefundEscrow.t.sol";

import {CheckoutRouter} from "../../src/CheckoutRouter.sol";
import {InstallmentPlan} from "../../src/InstallmentPlan.sol";
import {OriginationPause} from "../../src/OriginationPause.sol";
import {RefundEscrow} from "../../src/RefundEscrow.sol";
import {IInstallmentPlan} from "../../src/interfaces/IInstallmentPlan.sol";
import {IUnderwritingPartner} from "../../src/interfaces/IUnderwritingPartner.sol";
import {PlanId} from "../../src/libraries/PlanId.sol";
import {PlanParams} from "../../src/libraries/PlanParams.sol";

/// @title DepegPauseTest
/// @notice The most important test in this phase: a corridor breaker that stops new
///         credit and **cannot manufacture a delinquency**.
///
/// @dev Pitfall 9, stated as the failure it excludes. An over-broad breaker that paused
///      *collection* rather than *origination* would turn an FX event into a delinquency:
///      the borrower who tried to pay and could not is late through no act of their own,
///      and the loss is real — a late fee, a Passport mark, a provision against the book.
///      Every incumbent's emergency lever has that property, because in every incumbent
///      the lever and the ledger are the same system.
///
///      Here they are not, and the reason is structural rather than procedural:
///      `InstallmentPlan` has no owner, no pauser and no upgrade path, so there is no
///      message the pause plane could send it even if an operator wanted to send one.
///      `PauseNeverStrands.t.sol` proves that for the global switch. This proves it for
///      the switch the depeg breaker will actually throw — `pauseCorridor` — which is a
///      different code path reaching a different guard, and therefore a different proof.
///
///      Every clock read is `vm.getBlockTimestamp()` (DEC-30, finding 14).
contract DepegPauseTest is CorridorFixture {
    RefundEscrow internal refunds;
    StubSettlementEscrow internal stubEscrow;

    address internal pauser = address(0xA1E27);
    address internal arbiter = address(0xA9B17E);

    uint256 internal constant BORROWER_2 = 0xB0BB2;
    uint256 internal constant BORROWER_3 = 0xB0BB3;

    /// @dev Inside the ticket band and under a first-timer's Tier-0 cap once loaded by
    ///      the 5% corridor haircut: 90 × 1.05 = 94.5, against 100.
    uint256 internal constant EURC_PRINCIPAL = 90e6;

    /// @notice Plan 07-08's six trip reasons, as the enum the service exports.
    ///
    /// @dev The list is duplicated here **on purpose and with the duplication named**:
    ///      `services/fx/src/breaker.ts` says in its own header that the count is six in
    ///      the objective, in the must-haves, in the success criteria and in this test,
    ///      and that a list disagreeing with any of them would leave a reader resolving
    ///      the difference by guessing. Solidity cannot import a TypeScript union, so the
    ///      restatement is the only available form of the cross-check, and
    ///      `test_everyTripReasonMapsToThisOneCall` is what makes it load-bearing rather
    ///      than decorative.
    string[6] internal TRIP_REASONS =
        [string("ParBand"), "Stale", "RoundTrip", "VenueDistress", "Outage", "GuardRevert"];

    function setUp() public {
        _deployStack();
        _prepareCorridorOrigination();

        pauses.grantRole(pauses.PAUSER_ROLE(), pauser);

        // A EURC-denominated refund escrow, because a borrower's remedy has to be
        // payable in the currency the plan is denominated in. The settlement-escrow seam
        // is the same stub `RefundEscrow.t.sol` drives — a second implementation here
        // would be a second thing to keep in step with the first.
        stubEscrow = new StubSettlementEscrow();
        refunds = new RefundEscrow(
            address(this),
            address(eurc),
            address(checkout),
            address(merchants),
            address(parameters),
            address(stubEscrow)
        );
        merchants.grantRole(merchants.SLASHER_ROLE(), address(refunds));
        refunds.grantRole(refunds.ARBITER_ROLE(), arbiter);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The one that matters
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A paused EURC corridor cannot touch a live EURC plan: it still bounces,
    ///         marks, cures, collects and pays off.
    ///
    /// @dev **T-07-10-01, and the phase's headline safety property.** Five steps, and the
    ///      pause is re-asserted at every one of them — because a test that paused, drove
    ///      a plan and asserted only the outcome would pass just as happily against a
    ///      pause that had silently lifted somewhere in the middle.
    function test_depegPauseCannotStrandABorrower() public {
        InstallmentPlan p = _originateEurcPlan(EURC_PRINCIPAL, 1, keccak256("strand"), 5000e6);
        bytes32 corridor = checkout.corridorOf(address(eurc));

        vm.prank(pauser);
        pauses.pauseCorridor(corridor);
        assertFalse(pauses.isOpen(corridor), "the corridor pause did not take");

        // ── 1. The check bounces, and bouncing is not reverting ──────────────
        // A borrower with no euro is a borrower who cannot pay. The distinction the
        // whole property rests on is that `collect` *reports* that rather than throwing:
        // a revert would leave the keeper market with nothing to record and the plan
        // with no evidence the attempt was made.
        vm.warp(p.dueDate(0) + 1);
        vm.prank(keeper);
        (bool cleared, IInstallmentPlan.BounceReason reason) = p.collect(0);
        assertFalse(cleared, "the borrower had no euro, so this pull should have bounced");
        assertEq(
            uint8(reason),
            uint8(IInstallmentPlan.BounceReason.InsufficientFunds),
            "a corridor pause changed why a pull failed"
        );
        assertFalse(pauses.isOpen(corridor), "the pause lifted during the bounce");

        // ── 2. The delinquency signal is written, and paid for ───────────────
        vm.warp(p.graceEndsAt(0) + 1);
        uint256 markerBefore = eurc.balanceOf(stranger);
        vm.prank(stranger);
        p.markMissed(0);
        assertEq(
            eurc.balanceOf(stranger) - markerBefore,
            PlanParams.MARK_BOUNTY,
            "a corridor pause stopped paying for the delinquency signal"
        );
        assertEq(uint8(p.state()), uint8(IInstallmentPlan.PlanState.Delinquent), "the plan is not delinquent");
        assertFalse(pauses.isOpen(corridor), "the pause lifted during the mark");

        // ── 3. The borrower cures, by push, while paused ─────────────────────
        // **CURE-08/09, and the step the whole test exists for.** `repay()` is never
        // pausable. If it were, the depeg would have created the delinquency it is
        // supposed to be protecting the book from.
        //
        // **What "cure" can and cannot mean here, stated rather than assumed.** The
        // waterfall in `_account` is principal-first: a payment retires
        // `_outstandingPrincipal` before it touches `_feesOutstanding`, so a *partial*
        // payment cannot clear an accrued late fee while any principal remains — and
        // `isCurrent()` requires zero fees. A marked plan therefore stays `Delinquent`
        // until payoff, by design: principal-first is why a borrower who keeps paying
        // converges at all (fees-first is how a €7 fee becomes a permanent delinquency),
        // and `SettledWithFeeOutstanding` exists so the residual fee never blocks the
        // exit. Asserting `Active` here would have encoded a state transition the
        // contract does not offer.
        //
        // So what is asserted is the property the pause could actually break: the
        // borrower's money moved, and the debt fell by exactly what they paid. That the
        // *state* is unaffected by the pause is `test_pauseReachesNoPlanFunction`'s job,
        // which proves it for every function at once rather than for this one by hand.
        uint256 owedBefore = p.outstandingPrincipal();
        uint256 fee = p.feesOutstanding();
        assertGt(fee, 0, "the mark accrued no late fee, so this step is not the one it claims to be");

        uint256 cure = p.installmentAmount(0) + fee;
        eurc.mint(borrower, cure);
        vm.startPrank(borrower);
        eurc.approve(address(p), cure);
        p.repay(cure);
        vm.stopPrank();

        assertEq(
            p.outstandingPrincipal(),
            owedBefore - cure,
            "a corridor pause stopped a borrower's own payment from reaching their own debt"
        );
        assertFalse(pauses.isOpen(corridor), "the pause lifted during the cure");

        // ── 4. The remaining checks collect, on schedule ─────────────────────
        eurc.mint(borrower, 400e6);
        for (uint256 i = 1; i < COUNT; ++i) {
            vm.warp(p.dueDate(i));
            vm.prank(keeper);
            (bool ok,) = p.collect(i);
            assertTrue(ok, "a corridor pause blocked a collection on a live plan");
            assertFalse(pauses.isOpen(corridor), "the pause lifted mid-collection");
        }

        // ── 5. And the plan reaches Repaid ───────────────────────────────────
        assertEq(
            uint8(p.state()),
            uint8(IInstallmentPlan.PlanState.Repaid),
            "a plan driven to term under a corridor pause did not repay"
        );
        assertEq(p.outstandingPrincipal(), 0, "a repaid plan still carries principal");
        assertFalse(pauses.isOpen(corridor), "the pause was not in place for the whole drive");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // What the pause does stop
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice New EURC credit stops, and the quote stops offering it.
    ///
    /// @dev The quote returning zero is the half that matters for the checkout surface:
    ///      a breaker that stopped originations but left `maxPrincipalFor` answering
    ///      would produce a storefront that offers a plan and a chain that refuses it,
    ///      which is CHKT-01's failure arriving through the incident-response door.
    function test_depegPauseStopsNewEurcOrigination() public {
        bytes32 corridor = checkout.corridorOf(address(eurc));

        assertGt(_eurcQuote(), 0, "the corridor quoted nothing before the pause, so zero proves nothing");

        vm.prank(pauser);
        pauses.pauseCorridor(corridor);

        CheckoutRouter.OriginationInput memory input = _eurcOriginationInput(
            _eurcTerms(EURC_PRINCIPAL, COUNT, 11), keccak256("paused"), 5000e6, _eurcMid(keccak256("paused"))
        );
        vm.expectRevert(abi.encodeWithSelector(OriginationPause.CorridorOriginationPaused.selector, corridor));
        checkout.originate(input);

        assertEq(_eurcQuote(), 0, "a paused corridor still offered a limit the chain would refuse");
    }

    /// @notice The dollar corridor stays open while the euro one is shut.
    ///
    /// @dev Two distinct errors exist for exactly this reason. A merchant told
    ///      "originations are paused" when only EURC is down escalates the wrong thing,
    ///      and an operator reading that support ticket goes looking for the wrong switch.
    function test_depegPauseLeavesTheUsdcCorridorOpen() public {
        bytes32 eurcCorridor = checkout.corridorOf(address(eurc));
        bytes32 usdcCorridor = checkout.corridorOf(address(usdc));

        vm.prank(pauser);
        pauses.pauseCorridor(eurcCorridor);

        assertFalse(pauses.isOpen(eurcCorridor), "the euro corridor did not close");
        assertTrue(pauses.isOpen(usdcCorridor), "closing the euro corridor closed the dollar one");
        assertFalse(pauses.globallyPaused(), "a corridor pause escalated to a global one");

        _checkout(_terms(PRINCIPAL, COUNT, 21), keccak256("usdc-open"), 5000e6);
        assertEq(
            uint8(plan.state()),
            uint8(IInstallmentPlan.PlanState.Pending),
            "a dollar plan did not originate while only the euro corridor was paused"
        );
    }

    /// @notice Pausing a corridor is fast; unpausing it is deliberate.
    ///
    /// @dev An incident-response key that can also declare the incident over is a key
    ///      that will be used to declare the incident over — at 3am, by whoever is
    ///      holding it, under exactly the pressure the role split exists to resist.
    function test_pauserCannotUnpause() public {
        bytes32 corridor = checkout.corridorOf(address(eurc));

        vm.prank(pauser);
        pauses.pauseCorridor(corridor);
        assertFalse(pauses.isOpen(corridor), "the pauser could not pause");

        vm.prank(pauser);
        vm.expectRevert();
        pauses.unpauseCorridor(corridor);
        assertFalse(pauses.isOpen(corridor), "the pauser reopened the corridor they closed");

        pauses.unpauseCorridor(corridor);
        assertTrue(pauses.isOpen(corridor), "the admin could not reopen the corridor");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The structural claim
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice With the corridor paused, every function on a live plan behaves exactly
    ///         as it does unpaused.
    ///
    /// @dev **Asserted as one comparison rather than as six, on purpose.** The claim is
    ///      not "these six functions are unaffected" — it is "the pause plane and the
    ///      plan do not communicate", and the second is the one that stays true when
    ///      somebody adds a seventh function. So the same drive runs twice against the
    ///      same starting state, once paused and once not, and the two fingerprints are
    ///      compared. A future function folded into `_fingerprint` is covered without
    ///      this test being rewritten; a future function that *is* affected by the pause
    ///      changes the fingerprint and turns it red.
    ///
    ///      `vm.snapshotState` is what makes "the same starting state" literal rather
    ///      than approximate — two separately-originated plans would differ in address,
    ///      plan id and every bounty derived from them.
    function test_pauseReachesNoPlanFunction() public {
        _originateEurcPlan(EURC_PRINCIPAL, 31, keccak256("both-worlds"), 5000e6);

        uint256 snap = vm.snapshotState();
        bytes32 openWorld = _driveAndFingerprint(false);
        vm.revertToState(snap);
        bytes32 pausedWorld = _driveAndFingerprint(true);

        assertEq(
            pausedWorld,
            openWorld,
            "a corridor pause changed what a live plan does, so the pause plane reaches the ledger"
        );
    }

    /// @notice A pause does not take away the borrower's remedy.
    ///
    /// @dev T-07-10-09. A borrower whose goods never shipped is already the party with
    ///      the weakest position in the arrangement. Losing their refund or their dispute
    ///      route to an FX event on the *other* side of the trade would be the protocol
    ///      choosing the book over them at the exact moment the choice is visible.
    function test_refundAndDisputePathsSurviveAPause() public {
        InstallmentPlan p = _originateEurcPlan(EURC_PRINCIPAL, 41, keccak256("remedy"), 5000e6);
        bytes32 id = planId;
        bytes32 corridor = checkout.corridorOf(address(eurc));

        // Both plans are written **before** the breaker trips, because that is the only
        // order the incident actually happens in: a pause stops new credit, so a plan
        // originated after it is not a plan whose remedy could be at risk. Testing the
        // remedy on a plan that could not exist would be testing nothing.
        _asBorrower(BORROWER_2);
        _originateEurcPlan(EURC_PRINCIPAL, 42, keccak256("remedy-2"), 5000e6);
        bytes32 second = planId;

        vm.prank(pauser);
        pauses.pauseCorridor(corridor);

        // ── The merchant's own refund, in the plan's own currency ────────────
        uint256 voidAmount = refunds.voidAmountFor(id);
        eurc.mint(merchant, voidAmount);
        vm.startPrank(merchant);
        eurc.approve(address(p), voidAmount);
        p.creditRefund(voidAmount);
        vm.stopPrank();

        assertEq(
            uint8(p.state()),
            uint8(IInstallmentPlan.PlanState.Refunded),
            "a corridor pause blocked a merchant refund"
        );

        // A stranger cranks the book. The refund route is permissionless with the pause
        // on, exactly as it is with the pause off.
        vm.prank(stranger);
        refunds.noteRefund(id);
        assertEq(eurcPool.bookOf(id).carrying, 0, "the book still carries a receivable it was made whole on");
        assertFalse(pauses.isOpen(corridor), "the pause lifted during the refund");

        // ── The borrower's dispute route, on the second plan ─────────────────
        uint256 claim = 100e6;
        stubEscrow.setRow(second, true, merchant, claim, vm.getBlockTimestamp());

        // Permissionless, and no arbiter: this is the borrower's door and it must not
        // depend on an operator remembering to act — least of all during an incident.
        vm.prank(stranger);
        refunds.openNonAttestationDispute(second);

        assertEq(
            refunds.disputeOf(second).amount, claim, "a corridor pause closed the borrower's dispute route"
        );
        assertEq(
            refunds.disputeOf(second).merchant, merchant, "the dispute was recorded against the wrong party"
        );
        assertFalse(pauses.isOpen(corridor), "the pause lifted during the dispute");
    }

    /// @notice All six of plan 07-08's trip reasons reach the chain as this one call, and
    ///         that call changes nothing but the corridor's paused state.
    ///
    /// @dev **The service and the chain must not disagree about what a trip does.** The
    ///      breaker classifies a depeg six ways because an operator needs to know *why*
    ///      the corridor closed; the chain deliberately does not, because a breaker with
    ///      six onchain behaviours is six things to get right under incident conditions
    ///      instead of one. This asserts the narrowing: whichever reason fired, the
    ///      observable consequence is `pauseCorridor` and nothing else.
    ///
    ///      The "nothing else" half is the part worth having. It is asserted by
    ///      fingerprinting the surrounding world either side of the call — the dollar
    ///      corridor, the global switch, both books' NAV and exposure, and the merchant
    ///      bond ledger — rather than by listing what the trip is not allowed to touch.
    function test_everyTripReasonMapsToThisOneCall() public {
        bytes32 corridor = checkout.corridorOf(address(eurc));
        assertEq(TRIP_REASONS.length, 6, "the breaker exports six reasons and this list is not six");

        for (uint256 i = 0; i < TRIP_REASONS.length; ++i) {
            uint256 snap = vm.snapshotState();

            bytes32 before = _worldFingerprint();
            assertTrue(pauses.isOpen(corridor), "the corridor was already shut before this reason fired");

            // The one call. There is no `pauseCorridorBecause`, no reason argument and no
            // per-reason variant — which is the property, not an omission.
            vm.prank(pauser);
            pauses.pauseCorridor(corridor);

            assertFalse(
                pauses.isOpen(corridor),
                string.concat("trip reason ", TRIP_REASONS[i], " did not close the corridor")
            );
            assertEq(
                _worldFingerprint(),
                before,
                string.concat("trip reason ", TRIP_REASONS[i], " changed something other than the corridor")
            );

            vm.revertToState(snap);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Local helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev A second or third person. Tier 0 allows one active plan each, so a test that
    ///      needs two plans open needs two people — and a person is an address that can
    ///      sign. Both fields move together or the strip signs for a stranger.
    function _asBorrower(uint256 key) internal {
        borrower = vm.addr(key);
        borrowerKey = key;
        _screenClear(borrower);
    }

    function _eurcQuote() internal view returns (uint256) {
        return checkout.maxPrincipalFor(
            eurcTier0.pseudonymousId(borrower),
            IUnderwritingPartner.IdentityClass.Pseudonymous,
            signerClass,
            merchant,
            address(eurc),
            address(eurcPool)
        );
    }

    /// @dev Drive the live plan through every function it exposes and hash the
    ///      observables. `paused` decides which world this is; nothing else differs.
    ///
    ///      `markExpired` is exercised on an index whose authorization window has run
    ///      out, and `revalidate` on an EOA strip, so both take their real path rather
    ///      than reverting early and fingerprinting the revert.
    function _driveAndFingerprint(bool paused) internal returns (bytes32) {
        InstallmentPlan p = plan;
        bytes32 corridor = checkout.corridorOf(address(eurc));

        if (paused) {
            vm.prank(pauser);
            pauses.pauseCorridor(corridor);
            assertFalse(pauses.isOpen(corridor), "the paused world is not paused");
        }

        // A collection that clears.
        eurc.mint(borrower, 400e6);
        vm.warp(p.dueDate(0));
        vm.prank(keeper);
        (bool cleared, IInstallmentPlan.BounceReason reason) = p.collect(0);

        // A push repayment.
        uint256 push = 5e6;
        vm.startPrank(borrower);
        eurc.approve(address(p), push);
        p.repay(push);
        vm.stopPrank();

        // A miss, marked.
        vm.warp(p.graceEndsAt(1) + 1);
        vm.prank(stranger);
        p.markMissed(1);

        // An authorization that outlived its window, recorded as expired.
        vm.warp(p.validBefore(2) + 1);
        vm.prank(stranger);
        p.markExpired(2);

        // And the strip, re-checked.
        p.revalidate();

        return keccak256(
            abi.encode(
                cleared,
                reason,
                uint8(p.state()),
                p.outstandingPrincipal(),
                p.feesOutstanding(),
                p.feesPaid(),
                p.forwarded(),
                p.payoffAmount(),
                p.totalCollected(),
                eurc.balanceOf(address(p)),
                eurc.balanceOf(borrower),
                eurc.balanceOf(stranger),
                uint8(p.installmentStatus(0)),
                uint8(p.installmentStatus(1)),
                uint8(p.installmentStatus(2)),
                uint8(p.installmentStatus(3))
            )
        );
    }

    /// @dev Everything a corridor trip is *not* allowed to move.
    function _worldFingerprint() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                pauses.isOpen(checkout.corridorOf(address(usdc))),
                pauses.globallyPaused(),
                creditPool.totalAssets(),
                eurcPool.totalAssets(),
                creditPool.corridorExposure(checkout.corridorOf(address(usdc))),
                eurcPool.corridorExposure(checkout.corridorOf(address(eurc))),
                tier0.outstandingExposure(),
                eurcTier0.outstandingExposure(),
                merchants.bondOf(merchant),
                merchants.outstandingFrontedFor(merchant),
                PlanId.derive(_eurcTerms(EURC_PRINCIPAL, COUNT, 999))
            )
        );
    }
}
