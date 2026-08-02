// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {OriginationFixture} from "./helpers/OriginationFixture.sol";
import {ConfigurablePlan} from "./invariant/stubs/ConfigurablePlan.sol";

import {TranchedCreditPool} from "../src/TranchedCreditPool.sol";
import {TrancheToken} from "../src/TrancheToken.sol";
import {ParkedYieldVenue} from "../src/ParkedYieldVenue.sol";
import {ICreditPool} from "../src/interfaces/ICreditPool.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";

/// @title RedemptionQueueTest
/// @notice Getting out: the cumulative queue, the uniform fee, and the idle buffer.
///
/// @dev POOL-08, POOL-09 and POOL-13.
///
///      The queue exists so that a book which cannot pay everybody today can still say
///      something true about when it will. The fee exists so that being first in that
///      queue is not worth anything — which is the only thing that stops a run, because
///      the threat of a gate is itself what causes one, and this pool publishes its
///      buffer depth as a live gauge telling a first mover exactly when to move.
contract RedemptionQueueTest is OriginationFixture {
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        _deployStack();
        _prepareOrigination();

        eligibility.setGlobal(alice, true);
        eligibility.setGlobal(bob, true);
    }

    // ─── POOL-08: the cumulative queue ───────────────────────────────────────

    /// @notice Positions are cumulative and the fill line only moves forward.
    function test_queuePositionsAreCumulative() public {
        _giveShares(alice, 10_000e6);
        _giveShares(bob, 10_000e6);

        uint256 aShares = creditPool.seniorShares().balanceOf(alice) / 2;
        uint256 bShares = creditPool.seniorShares().balanceOf(bob) / 2;

        uint256 aIndex = _queue(alice, aShares);
        uint256 bIndex = _queue(bob, bShares);

        TranchedCreditPool.RedeemTicket memory a =
            creditPool.redeemTicketAt(ICreditPool.Tranche.Senior, alice, aIndex);
        TranchedCreditPool.RedeemTicket memory b =
            creditPool.redeemTicketAt(ICreditPool.Tranche.Senior, bob, bIndex);

        assertEq(a.lo, 0, "the first ticket did not start at the head");
        assertEq(a.hi, aShares);
        assertEq(b.lo, a.hi, "the second ticket did not queue behind the first");
        assertEq(b.hi, a.hi + bShares);

        (uint256 queued, uint256 filled) = creditPool.queueDepth(ICreditPool.Tranche.Senior);
        assertEq(queued, b.hi, "the tail did not reach the last ticket");
        assertEq(filled, 0, "the line moved before an epoch closed");
    }

    /// @notice A queue larger than the book fills in order, and the remainder waits.
    ///
    /// @dev The behaviour a synchronous vault cannot express. Alice is ahead of Bob, so
    ///      she is paid first; Bob keeps his position and is paid by natural runoff. The
    ///      alternative — reverting Bob's redemption — tells him nothing about when he
    ///      will be paid, and the other alternative, selling a receivable in a hurry to
    ///      pay him today, is a loss for everyone who stayed.
    function test_aQueueLargerThanTheBookFillsInOrder() public {
        _giveShares(alice, 10_000e6);
        _giveShares(bob, 10_000e6);
        _drainCashTo(500e6);

        uint256 aIndex = _queue(alice, creditPool.seniorShares().balanceOf(alice));
        uint256 bIndex = _queue(bob, creditPool.seniorShares().balanceOf(bob));

        _closeEpoch();

        vm.prank(alice);
        uint256 aPaid = creditPool.claimRedemption(ICreditPool.Tranche.Senior, aIndex, 8);
        vm.prank(bob);
        uint256 bPaid = creditPool.claimRedemption(ICreditPool.Tranche.Senior, bIndex, 8);

        assertGt(aPaid, 0, "the head of the queue was not paid");
        assertEq(bPaid, 0, "the tail was paid out of a book that had nothing left");

        TranchedCreditPool.RedeemTicket memory b =
            creditPool.redeemTicketAt(ICreditPool.Tranche.Senior, bob, bIndex);
        assertLt(b.claimedTo, b.hi, "the unfilled ticket lost its position");
    }

    /// @notice A ticket filled across two epochs claims both, and only once.
    /// @dev The fill log is walked from where the ticket left off, so a claim is
    ///      resumable and never double-counts. A redeemer who waits three epochs pays
    ///      for three steps of gas; the pool pays for none of it at close.
    function test_aTicketFilledAcrossTwoEpochsClaimsBothOnce() public {
        _giveShares(alice, 10_000e6);
        _drainCashTo(300e6);

        uint256 index = _queue(alice, creditPool.seniorShares().balanceOf(alice));

        _closeEpoch();
        vm.prank(alice);
        uint256 first = creditPool.claimRedemption(ICreditPool.Tranche.Senior, index, 8);

        // Runoff: a plan repays and the cash comes back to the book.
        _repayStub();

        _closeEpoch();
        vm.prank(alice);
        uint256 second = creditPool.claimRedemption(ICreditPool.Tranche.Senior, index, 8);

        assertGt(first, 0, "the first epoch paid nothing");
        assertGt(second, 0, "the runoff did not reach the queue");

        vm.prank(alice);
        uint256 third = creditPool.claimRedemption(ICreditPool.Tranche.Senior, index, 8);
        assertEq(third, 0, "a third claim paid for a fill that had already been collected");
        assertEq(usdc.balanceOf(alice), first + second, "the ticket paid more than it filled");
    }

    // ─── POOL-09: the uniform fee ────────────────────────────────────────────

    /// @notice Two redeemers in the same epoch pay the same rate.
    ///
    /// @dev DEC-23, and the reason a fee beats a gate. The fee is struck on the epoch,
    ///      not on a queue position, so being early buys nothing — and what it takes
    ///      stays in the tranche, so the holders who did not redeem are paid by the ones
    ///      who did.
    function test_everyRedeemerInAnEpochPaysTheSameRate() public {
        _giveShares(alice, 20_000e6);
        _giveShares(bob, 20_000e6);

        uint256 aIndex = _queue(alice, creditPool.seniorShares().balanceOf(alice));
        uint256 bIndex = _queue(bob, creditPool.seniorShares().balanceOf(bob));

        uint256 price = creditPool.navPerShare(ICreditPool.Tranche.Senior);
        uint256 aShares = _size(alice, aIndex);
        uint256 bShares = _size(bob, bIndex);

        _closeEpoch();

        vm.prank(alice);
        uint256 aPaid = creditPool.claimRedemption(ICreditPool.Tranche.Senior, aIndex, 8);
        vm.prank(bob);
        uint256 bPaid = creditPool.claimRedemption(ICreditPool.Tranche.Senior, bIndex, 8);

        uint256 aRate = (aPaid * 1e18) / aShares;
        uint256 bRate = (bPaid * 1e18) / bShares;
        assertApproxEqRel(aRate, bRate, 1e12, "two redeemers in one epoch paid different rates");
        assertLt(aRate, price, "the epoch's fee was not charged at all");
    }

    /// @notice The fee stays in the tranche.
    /// @dev It is not revenue. Its whole purpose is that the exit is priced, and the
    ///      price is paid to the holders who are still there.
    function test_theLiquidityFeeStaysWithTheHoldersWhoStayed() public {
        _giveShares(alice, 20_000e6);

        uint256 priceBefore = creditPool.navPerShare(ICreditPool.Tranche.Senior);
        _queue(alice, creditPool.seniorShares().balanceOf(alice));
        _closeEpoch();

        assertGt(
            creditPool.navPerShare(ICreditPool.Tranche.Senior),
            priceBefore,
            "the fee left the tranche instead of paying the holders who stayed"
        );
    }

    // ─── POOL-13: the idle buffer ────────────────────────────────────────────

    /// @notice Only an allowlisted venue can take the buffer.
    function test_theBufferOnlyGoesToAnAllowlistedVenue() public {
        ParkedYieldVenue venue = new ParkedYieldVenue(address(this), address(usdc));
        vm.expectRevert(abi.encodeWithSelector(TranchedCreditPool.VenueNotAllowed.selector, address(venue)));
        creditPool.setVenue(address(venue));
    }

    /// @notice The buffer floor is respected, the position is booked at redeemable
    ///         value, and the yield reaches the tranches.
    function test_theBufferEarnsAndTheYieldReachesTheBook() public {
        ParkedYieldVenue venue = new ParkedYieldVenue(address(this), address(usdc));
        creditPool.setVenueAllowed(address(venue), true);
        creditPool.setVenue(address(venue));

        uint256 room = creditPool.deployableBuffer();
        assertGt(room, 0, "there was nothing idle to deploy");
        assertLt(room, creditPool.bookedCash(), "the buffer floor was not withheld");

        uint256 cashBefore = creditPool.bookedCash();
        uint256 navBefore = creditPool.totalAssets();
        creditPool.deployBuffer(room);

        assertEq(creditPool.deployedAssets(), room, "the venue position was not booked");
        assertEq(creditPool.bookedCash(), cashBefore - room, "cash did not leave the book");
        assertEq(creditPool.totalAssets(), navBefore, "deploying the buffer moved NAV");

        // Yield arrives. The position is worth more than it cost, and the difference is
        // income — it goes down the income waterfall like any other earning.
        usdc.mint(address(this), 1000e6);
        usdc.approve(address(venue), 1000e6);
        uint256 assetsBefore = creditPool.totalAssets();
        venue.payYield(1000e6);

        creditPool.syncVenue();
        assertGt(creditPool.totalAssets(), assetsBefore, "the yield never reached the book");
        assertEq(
            creditPool.deployedAssets(),
            venue.redeemableValue(address(creditPool)),
            "the position is booked at cost rather than at what it would return"
        );
    }

    /// @notice The buffer comes back on demand.
    function test_theBufferCanBeRecalled() public {
        ParkedYieldVenue venue = new ParkedYieldVenue(address(this), address(usdc));
        creditPool.setVenueAllowed(address(venue), true);
        creditPool.setVenue(address(venue));

        uint256 room = creditPool.deployableBuffer();
        creditPool.deployBuffer(room);
        creditPool.recallBuffer(room);

        assertEq(creditPool.deployedAssets(), 0, "the position did not close");
        assertGe(creditPool.bookedCash(), room, "the cash did not come back");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev Put a lender through a full deposit cycle so they hold real shares.
    function _giveShares(address who, uint256 amount) private {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(creditPool), amount);
        creditPool.requestDeposit(ICreditPool.Tranche.Senior, amount);
        vm.stopPrank();

        _closeEpoch();

        vm.prank(who);
        creditPool.claimShares(ICreditPool.Tranche.Senior);
    }

    function _queue(address who, uint256 shares) private returns (uint256 index) {
        TrancheToken senior = creditPool.seniorShares();
        vm.startPrank(who);
        senior.approve(address(creditPool), shares);
        index = creditPool.requestRedeem(ICreditPool.Tranche.Senior, shares);
        vm.stopPrank();
    }

    function _size(address who, uint256 index) private view returns (uint256) {
        TranchedCreditPool.RedeemTicket memory t =
            creditPool.redeemTicketAt(ICreditPool.Tranche.Senior, who, index);
        return t.hi - t.lo;
    }

    ConfigurablePlan internal drainStub;
    bytes32 internal drainId;
    uint256 internal drainAmount;

    /// @dev Lend the book's cash out so the queue has to wait for it.
    function _drainCashTo(uint256 keep) private {
        _fundReserveToTarget();
        creditPool.setOriginator(address(this));
        drainAmount = creditPool.bookedCash() - keep;

        drainStub = new ConfigurablePlan();
        drainStub.initHealthy(4, drainAmount, vm.getBlockTimestamp() + 365 days, 14 days);
        drainId = keccak256("drain");

        creditPool.front(
            drainId,
            address(drainStub),
            merchant,
            checkout.corridorOf(address(usdc)),
            drainAmount,
            0,
            0,
            address(this)
        );
    }

    /// @dev The drained plan repays, so cash returns to the book as natural runoff.
    function _repayStub() private {
        usdc.mint(address(creditPool), drainAmount);
        drainStub.setAccounting(0, drainAmount, 0, 0, 0);
        creditPool.recognise(drainId);
    }
}
