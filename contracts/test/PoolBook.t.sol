// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {OriginationFixture} from "./helpers/OriginationFixture.sol";

import {TranchedCreditPool} from "../src/TranchedCreditPool.sol";
import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {ICreditPool} from "../src/interfaces/ICreditPool.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";
import {ConfigurablePlan} from "./invariant/stubs/ConfigurablePlan.sol";

/// @notice The funding book — POOL-05, POOL-11 and POOL-16.
///
/// @dev Three claims are being tested and each of them is an accounting decision
///      someone could reasonably have made the other way:
///
///      that the book learns what it received from the *plans* rather than from its
///      own balance; that MDR earns as principal is recovered rather than at
///      checkout; and that a loss goes reserve → junior → senior in that order and
///      no other.
contract PoolBookTest is OriginationFixture {
    function setUp() public {
        _deployStack();
        _prepareOrigination();
    }

    // ─── POOL-11 ─────────────────────────────────────────────────────────────

    /// @notice A donation moves the balance and not the book.
    ///
    /// @dev `totalAssets` is three accumulators this contract maintains, never
    ///      `token.balanceOf(this)`. If it were the balance, a donation would inflate
    ///      NAV for existing holders — and against an empty junior tranche that is
    ///      half of the first-depositor inflation attack, handed to the attacker for
    ///      the price of a transfer.
    function test_aDonationDoesNotMoveNav() public {
        uint256 before = creditPool.totalAssets();
        uint256 balanceBefore = usdc.balanceOf(address(creditPool));

        usdc.mint(address(this), 50_000e6);
        usdc.transfer(address(creditPool), 50_000e6);

        assertEq(
            usdc.balanceOf(address(creditPool)), balanceBefore + 50_000e6, "the transfer did not land"
        );
        assertEq(creditPool.totalAssets(), before, "a donation moved NAV");
        assertEq(creditPool.bookedCash(), balanceBefore, "a donation moved booked cash");
    }

    /// @notice The identity holds: assets are reserve plus the two tranches.
    function test_assetsEqualClaims() public view {
        assertEq(
            creditPool.totalAssets(),
            creditPool.reserveBalance() + creditPool.trancheAssets(ICreditPool.Tranche.Junior)
                + creditPool.trancheAssets(ICreditPool.Tranche.Senior),
            "assets do not equal the sum of claims"
        );
    }

    // ─── Recognition (DEC-08) ────────────────────────────────────────────────

    /// @notice The book learns from the plan, and moves no money doing it.
    function test_recognitionBooksTheDeltaAndMovesNothing() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        // Clear the down payment through the real collection path.
        _fundBorrower(p.installmentAmount(0));
        vm.warp(p.dueDate(0) + 1);
        vm.prank(keeper);
        p.collect(0);

        uint256 balanceBefore = usdc.balanceOf(address(creditPool));
        uint256 cashBefore = creditPool.bookedCash();

        creditPool.recognise(id);

        assertEq(usdc.balanceOf(address(creditPool)), balanceBefore, "recognition moved money");
        assertEq(
            creditPool.bookedCash() - cashBefore,
            p.forwarded(),
            "the book did not count what the plan forwarded"
        );
        assertEq(
            creditPool.bookOf(id).carrying,
            p.outstandingPrincipal(),
            "the carrying value did not follow the plan"
        );
    }

    /// @notice Recognition is idempotent.
    /// @dev It has to be: it is permissionless, so it will be called twice in the
    ///      same block by two keepers who both wanted the book fresh.
    function test_recognitionIsIdempotent() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        _fundBorrower(p.installmentAmount(0));
        vm.warp(p.dueDate(0) + 1);
        vm.prank(keeper);
        p.collect(0);

        creditPool.recognise(id);
        uint256 assets = creditPool.totalAssets();
        uint256 cash = creditPool.bookedCash();

        creditPool.recognise(id);
        creditPool.recognise(id);

        assertEq(creditPool.totalAssets(), assets, "a second recognition moved NAV");
        assertEq(creditPool.bookedCash(), cash, "a second recognition moved cash");
    }

    /// @notice MDR earns as principal comes back, never at checkout.
    ///
    /// @dev A fee recognised on a loan nobody has begun repaying is profit the book
    ///      has not made. Booking it at origination makes every origination look like
    ///      income, and the reversal only arrives when the borrower does not pay —
    ///      which is how a book flatters itself into a loss.
    function test_mdrEarnsProRataAsPrincipalIsRecovered() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        uint256 deferredAtOrigination = creditPool.bookOf(id).deferredIncome;
        assertEq(deferredAtOrigination, checkout.mdrFor(PRINCIPAL) - PlanParams.markEscrowFor(COUNT));

        _fundBorrower(p.installmentAmount(0));
        vm.warp(p.dueDate(0) + 1);
        vm.prank(keeper);
        p.collect(0);
        creditPool.recognise(id);

        // A quarter of the principal came back, so a quarter of the fee is earned.
        assertApproxEqAbs(
            creditPool.bookOf(id).deferredIncome,
            (deferredAtOrigination * 3) / 4,
            2,
            "the fee did not earn in proportion to the principal recovered"
        );
    }

    /// @notice The keeper's bounty is a servicing cost the book carries.
    ///
    /// @dev The borrower's debt fell by the full installment; the book received the
    ///      installment less the bounty. That gap is the cost of a collections system
    ///      nobody has to be paid a salary to operate, and it should show up as a cost
    ///      rather than as a smaller repayment.
    function test_theKeeperBountyLandsOnTheBookNotOnTheBorrower() public {
        InstallmentPlan p = _checkoutDefault();

        uint256 installment = p.installmentAmount(0);
        _fundBorrower(installment);
        vm.warp(p.dueDate(0) + 1);

        uint256 quoted = p.bountyFor(0);
        vm.prank(keeper);
        p.collect(0);

        assertEq(usdc.balanceOf(keeper), quoted, "the keeper was not paid the quote");
        assertEq(
            p.principal() - p.outstandingPrincipal(),
            installment,
            "the borrower's debt fell by less than the installment"
        );
        assertEq(p.forwarded(), installment - quoted, "the book received more than the net");
    }

    // ─── The waterfall (POOL-16) ─────────────────────────────────────────────

    /// @notice A charge-off strikes the reserve first, then junior, then senior.
    ///
    /// @dev Senior's entire claim is that it is struck last. If junior can be impaired
    ///      while the reserve still holds assets, the subordination the senior tranche
    ///      was sold on is not the subordination it has.
    function test_aChargeOffStrikesTheReserveBeforeJunior() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        uint256 reserveBefore = creditPool.reserveBalance();
        uint256 juniorBefore = creditPool.trancheAssets(ICreditPool.Tranche.Junior);
        uint256 seniorBefore = creditPool.trancheAssets(ICreditPool.Tranche.Senior);

        uint256 assetsBefore = creditPool.totalAssets();
        uint256 outstanding = p.outstandingPrincipal();

        _chargeOff(p);
        creditPool.recognise(id);

        assertEq(
            uint8(p.state()), uint8(IInstallmentPlan.PlanState.Defaulted), "the plan did not charge off"
        );

        // The whole loss landed on the reserve, and neither tranche fell.
        //
        // Junior and senior are asserted `Ge` rather than `Eq` because a charged-off
        // plan returns its unspent delinquency escrow to the book on the way out —
        // real income, distributed pro rata in the same crank that takes the loss.
        // Insisting on equality would be asserting that a defaulted plan hands nothing
        // back, which is not what the mechanism does.
        assertLt(creditPool.reserveBalance(), reserveBefore, "the reserve absorbed nothing");
        assertGe(
            creditPool.trancheAssets(ICreditPool.Tranche.Junior),
            juniorBefore,
            "junior was impaired while the first-loss reserve still held assets"
        );
        assertGe(
            creditPool.trancheAssets(ICreditPool.Tranche.Senior),
            seniorBefore,
            "senior was struck while the reserve and junior still held assets"
        );
        assertLt(creditPool.totalAssets(), assetsBefore, "a charge-off cost the book nothing");

        // The loss is what the pool actually paid out, not the face value of the
        // receivable. Two things reduce it: the MDR the pool never handed to the
        // merchant, and whatever the plan returned from its unspent delinquency
        // escrow on the way out.
        uint256 unearned = checkout.mdrFor(PRINCIPAL) - PlanParams.markEscrowFor(COUNT);
        assertEq(
            assetsBefore - creditPool.totalAssets(),
            outstanding - unearned - p.forwarded(),
            "the loss was not the outlay net of the unearned fee and the returned escrow"
        );
        assertLt(
            assetsBefore - creditPool.totalAssets(),
            outstanding,
            "the book wrote off more than it had paid out"
        );
        assertEq(creditPool.bookOf(id).open, false, "the book stayed open on a charged-off plan");
    }

    /// @notice A loss larger than the reserve reaches junior, and stops before senior.
    function test_aLossLargerThanTheReserveReachesJuniorAndStopsThere() public {
        // Shrink the reserve to a token amount so the loss overruns it.
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        creditPool.setOriginator(address(this));
        uint256 seniorBefore = creditPool.trancheAssets(ICreditPool.Tranche.Senior);
        uint256 juniorBefore = creditPool.trancheAssets(ICreditPool.Tranche.Junior);
        uint256 reserveBefore = creditPool.reserveBalance();

        // A synthetic write-off far larger than the reserve.
        _forceLoss(reserveBefore + 1_000e6);

        assertEq(creditPool.reserveBalance(), 0, "the reserve was not exhausted first");
        assertEq(
            juniorBefore - creditPool.trancheAssets(ICreditPool.Tranche.Junior),
            1_000e6,
            "junior did not absorb the overflow"
        );
        assertEq(
            creditPool.trancheAssets(ICreditPool.Tranche.Senior),
            seniorBefore,
            "senior was struck while junior still had assets"
        );

        // Silence the unused-plan warning without weakening the assertion above.
        assertEq(creditPool.bookOf(id).plan, address(p));
    }

    // ─── The gate ────────────────────────────────────────────────────────────

    /// @notice An unmarked delinquency shuts the book.
    ///
    /// @dev What makes the bountied mark unavoidable rather than merely available.
    ///      Nobody profits from cranking a collection that cannot succeed, so the
    ///      negative signal has to be paid for — and the payment only reliably happens
    ///      if the book cannot keep lending without it.
    function test_anUnmarkedDelinquencyClosesOrigination() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        vm.warp(p.graceEndsAt(0) + 1);
        creditPool.recognise(id);

        assertFalse(creditPool.allDelinquenciesMarked(), "the pool did not see the delinquency");
        assertFalse(creditPool.originationOpen(), "the book kept lending on an unrecognised loss");

        vm.prank(keeper);
        p.markMissed(0);
        creditPool.recognise(id);

        assertTrue(creditPool.allDelinquenciesMarked(), "the mark did not clear the flag");
        assertTrue(creditPool.originationOpen(), "the gate stayed shut after the mark");
    }

    // ─── Capital ─────────────────────────────────────────────────────────────

    /// @notice Deposits are eligibility-gated from the request, not from the fill.
    /// @dev POOL-02. Gating the entry means the holder set is correct from the
    ///      beginning rather than needing a snapshot the day the shares move.
    function test_depositsAreEligibilityGated() public {
        usdc.mint(stranger, 1_000e6);
        vm.startPrank(stranger);
        usdc.approve(address(creditPool), 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(TranchedCreditPool.NotEligible.selector, stranger));
        creditPool.requestDeposit(ICreditPool.Tranche.Senior, 1_000e6);
        vm.stopPrank();
    }

    /// @notice A redemption pays the tranche price, less the epoch's liquidity fee.
    ///
    /// @dev Three transactions now, because POOL-03 made exit asynchronous: request,
    ///      close, claim. The price is struck once for the whole epoch, so what a
    ///      redeemer gets cannot depend on when inside the epoch they asked.
    ///
    ///      Half the senior tranche leaving in one epoch is far past the ten-percent
    ///      threshold, so POOL-09's fee is on — and the one percent it takes stays in
    ///      the tranche for the holders who did not redeem. That is the whole
    ///      mechanism: the exit is priced, so being first through the door buys nothing.
    function test_aRedemptionPaysTheTranchePriceLessTheEpochFee() public {
        uint256 shares = creditPool.seniorShares().balanceOf(lender);

        vm.startPrank(lender);
        creditPool.seniorShares().approve(address(creditPool), shares / 2);
        uint256 index = creditPool.requestRedeem(ICreditPool.Tranche.Senior, shares / 2);
        vm.stopPrank();

        _closeEpoch();

        vm.prank(lender);
        uint256 assets = creditPool.claimRedemption(ICreditPool.Tranche.Senior, index, 8);

        uint256 feeBps = parameters.get(ParameterKeys.LIQUIDITY_FEE_BPS);
        uint256 expected = (SENIOR_SEED / 2) * (PlanParams.BPS - feeBps) / PlanParams.BPS;

        assertEq(usdc.balanceOf(lender), assets, "the redemption paid something else");
        assertApproxEqRel(assets, expected, 1e15, "half the shares were not worth half the stake");

        TranchedCreditPool.Fill memory fill =
            creditPool.fillAt(ICreditPool.Tranche.Senior, creditPool.fillCount(ICreditPool.Tranche.Senior) - 1);
        assertEq(fill.feeBps, feeBps, "the epoch's fill did not carry the liquidity fee");
    }

    /// @notice A small exit pays par. The fee is a threshold, not a toll.
    /// @dev POOL-09 is about runs, not about discouraging redemption. Ordinary runoff —
    ///      here, well under a tenth of the book — costs nothing, because a fee that
    ///      applied always would just be a worse product.
    function test_anOrdinaryRedemptionPaysPar() public {
        uint256 shares = creditPool.seniorShares().balanceOf(lender) / 100;

        vm.startPrank(lender);
        creditPool.seniorShares().approve(address(creditPool), shares);
        uint256 index = creditPool.requestRedeem(ICreditPool.Tranche.Senior, shares);
        vm.stopPrank();

        _closeEpoch();

        vm.prank(lender);
        uint256 assets = creditPool.claimRedemption(ICreditPool.Tranche.Senior, index, 8);

        assertApproxEqRel(assets, SENIOR_SEED / 100, 1e15, "an ordinary exit was charged a fee");
    }

    /// @notice A redemption the book cannot fund waits in the queue instead of failing.
    ///
    /// @dev POOL-08, and the difference from a synchronous vault is the whole point. A
    ///      redeemer who cannot be paid today keeps their cumulative position and is
    ///      filled by natural runoff; the alternative is either a revert, which tells
    ///      them nothing about when they will be paid, or a fire sale of a receivable
    ///      at whatever price is available in a hurry.
    function test_aRedemptionTheBookCannotFundWaitsInTheQueue() public {
        creditPool.setOriginator(address(this));
        bytes32 corridor = checkout.corridorOf(address(usdc));

        // Nearly all the book's cash into receivables.
        uint256 drain = creditPool.bookedCash() - 10e6;
        creditPool.front(keccak256("drain"), address(0xF11), merchant, corridor, drain, 0, 0, address(this));

        uint256 shares = creditPool.seniorShares().balanceOf(lender);
        vm.startPrank(lender);
        creditPool.seniorShares().approve(address(creditPool), shares);
        uint256 index = creditPool.requestRedeem(ICreditPool.Tranche.Senior, shares);
        vm.stopPrank();

        _closeEpoch();

        (uint256 ahead, uint256 size, uint256 filled) =
            _position(ICreditPool.Tranche.Senior, lender, index);
        assertEq(ahead, 0, "the ticket was not at the head of the queue");
        assertLt(filled, size, "the whole request filled out of a book that could not fund it");

        vm.prank(lender);
        uint256 paid = creditPool.claimRedemption(ICreditPool.Tranche.Senior, index, 8);
        assertLe(paid, 10e6, "the fill paid out more cash than the book held");
    }

    /// @dev The queue position, as the lender app reads it.
    function _position(ICreditPool.Tranche tranche, address holder, uint256 index)
        private
        view
        returns (uint256 ahead, uint256 size, uint256 filled)
    {
        TranchedCreditPool.RedeemTicket memory ticket =
            creditPool.redeemTicketAt(tranche, holder, index);
        (, uint256 line) = creditPool.queueDepth(tranche);
        ahead = ticket.lo > line ? ticket.lo - line : 0;
        size = ticket.hi - ticket.lo;
        filled = line > ticket.lo ? (line < ticket.hi ? line - ticket.lo : size) : 0;
    }

    function test_reserveFundingIsPermissionless() public {
        uint256 before = creditPool.reserveBalance();
        usdc.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usdc.approve(address(creditPool), 100e6);
        creditPool.fundReserve(100e6);
        vm.stopPrank();
        assertEq(creditPool.reserveBalance(), before + 100e6, "the reserve refused a gift");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _chargeOff(InstallmentPlan p) private {
        vm.warp(p.graceEndsAt(0) + 1);
        vm.prank(keeper);
        p.markMissed(0);
        // Sixty days past the oldest *unpaid* installment — which is the one that was
        // missed, not the one after it.
        vm.warp(p.dueDate(0) + PlanParams.CHARGE_OFF_AFTER + 1);
        vm.prank(keeper);
        p.chargeOff();
    }

    /// @dev A synthetic front against a stub plan that then reports itself defaulted,
    ///      so a loss of an arbitrary size can be aimed at the waterfall without
    ///      originating a real plan large enough to produce it. The pool's own path is
    ///      unchanged — it reads the plan, sees `Defaulted`, and writes down what it
    ///      is still carrying.
    function _forceLoss(uint256 amount) private {
        ConfigurablePlan stub = new ConfigurablePlan();
        stub.initHealthy(4, amount, vm.getBlockTimestamp() + 365 days, 14 days);

        bytes32 id = keccak256("synthetic");
        bytes32 corridor = checkout.corridorOf(address(usdc));

        creditPool.front(id, address(stub), merchant, corridor, amount, 0, 0, address(this));
        stub.setState(IInstallmentPlan.PlanState.Defaulted);
        creditPool.recognise(id);
    }
}
