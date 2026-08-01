// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {PoolInvariants} from "./PoolInvariants.sol";
import {ConfigurablePlan} from "./stubs/ConfigurablePlan.sol";

import {TranchedCreditPool} from "../../src/TranchedCreditPool.sol";
import {TrancheToken} from "../../src/TrancheToken.sol";
import {ParameterRegistry} from "../../src/ParameterRegistry.sol";
import {EligibilityRegistry} from "../../src/EligibilityRegistry.sol";
import {ICreditPool} from "../../src/interfaces/ICreditPool.sol";
import {IInstallmentPlan} from "../../src/interfaces/IInstallmentPlan.sol";
import {ParameterKeys} from "../../src/libraries/ParameterKeys.sol";
import {PlanParams} from "../../src/libraries/PlanParams.sol";
import {MockArcUsdc} from "../mocks/MockArcUsdc.sol";

/// @notice Drives the real pool the way a book actually moves.
///
/// @dev Plans here are `ConfigurablePlan` stubs rather than real originations, and
///      that is the right trade for this suite: what is under test is the pool's
///      accounting, and a real strip would spend most of the fuzzer's depth budget on
///      signature verification the plan suite already covers exhaustively. The stub
///      is only ever read the way the pool reads a real plan — `forwarded()`,
///      `outstandingPrincipal()`, `state()`, `installmentStatus()`, `graceEndsAt()` —
///      so nothing the pool does here is special-cased for it.
///
///      Cash is moved for real. When the handler says a plan forwarded money, the
///      money arrives; otherwise `bookedCash` would drift from the balance and the
///      suite would be proving a property about a fiction.
///
///      **Phase 5 made entry and exit asynchronous, so the handler runs epochs.** A
///      deposit is a request, a close is what prices it, and a claim is what collects
///      it — three separate actions the fuzzer interleaves freely with fronts,
///      collections, defaults and warps. That interleaving is the point: the
///      oscillation POOL-07 exists to prevent is exactly a deposit landing between a
///      provision and its release.
contract PoolHandler is Test {
    TranchedCreditPool internal immutable pool;
    MockArcUsdc internal immutable usdc;
    ParameterRegistry internal immutable parameters;

    bytes32[] public planIds;
    mapping(bytes32 => ConfigurablePlan) public planOf;
    mapping(bytes32 => uint256) public forwardedOf;
    mapping(bytes32 => uint256) public outstandingOf;

    address[] internal lenders;
    address internal constant MERCHANT = address(0xACCED);

    /// @notice Set if a loss ever reached a tranche out of turn.
    /// @dev Latched, never cleared. One out-of-order step anywhere in a campaign is a
    ///      failure of the property, and a flag that could be cleared by the next
    ///      well-behaved crank would hide it.
    bool public waterfallInverted;

    /// @notice Set if two redeemers filled in the same epoch at different fee rates.
    /// @dev POOL-09's whole anti-run argument is that the fee is struck on the epoch
    ///      rather than on a queue position. If two fills in one epoch could carry
    ///      different rates, redeeming early would pay again.
    bool public feeWasNotUniform;

    uint256 public deposits;
    uint256 public redemptions;
    uint256 public claims;
    uint256 public fronts;
    uint256 public recognitions;
    uint256 public defaults;
    uint256 public payments;
    uint256 public closes;

    constructor(TranchedCreditPool pool_, MockArcUsdc usdc_, ParameterRegistry parameters_) {
        pool = pool_;
        usdc = usdc_;
        parameters = parameters_;
        lenders.push(address(0xA11CE));
        lenders.push(address(0xB0B));
    }

    function lenderAt(uint256 seed) public view returns (address) {
        return lenders[seed % lenders.length];
    }

    function planCount() external view returns (uint256) {
        return planIds.length;
    }

    function _tranche(bool junior) private pure returns (ICreditPool.Tranche) {
        return junior ? ICreditPool.Tranche.Junior : ICreditPool.Tranche.Senior;
    }

    function _shareToken(bool junior) private view returns (TrancheToken) {
        return junior ? pool.juniorShares() : pool.seniorShares();
    }

    // ─── Capital in ──────────────────────────────────────────────────────────

    function requestDeposit(uint256 seed, uint256 amount, bool junior) external {
        address who = lenderAt(seed);
        amount = bound(amount, 1e6, 100_000e6);
        usdc.mint(who, amount);

        vm.startPrank(who);
        usdc.approve(address(pool), amount);
        try pool.requestDeposit(_tranche(junior), amount) {
            deposits++;
        } catch {}
        vm.stopPrank();
    }

    function cancelDeposit(uint256 seed, bool junior) external {
        vm.startPrank(lenderAt(seed));
        try pool.cancelDeposit(_tranche(junior)) {} catch {}
        vm.stopPrank();
    }

    function claimShares(uint256 seed, bool junior) external {
        vm.startPrank(lenderAt(seed));
        try pool.claimShares(_tranche(junior)) {
            claims++;
        } catch {}
        vm.stopPrank();
    }

    // ─── Capital out ─────────────────────────────────────────────────────────

    function requestRedeem(uint256 seed, uint256 shares, bool junior) external {
        address who = lenderAt(seed);
        TrancheToken share = _shareToken(junior);
        uint256 held = share.balanceOf(who);
        if (held == 0) return;
        shares = bound(shares, 1, held);

        vm.startPrank(who);
        share.approve(address(pool), shares);
        try pool.requestRedeem(_tranche(junior), shares) {
            redemptions++;
        } catch {}
        vm.stopPrank();
    }

    function claimRedemption(uint256 seed, uint256 index, bool junior) external {
        address who = lenderAt(seed);
        uint256 count = pool.redeemTicketCount(_tranche(junior), who);
        if (count == 0) return;

        vm.startPrank(who);
        try pool.claimRedemption(_tranche(junior), index % count, 8) {} catch {}
        vm.stopPrank();
    }

    function fundReserve(uint256 amount) external {
        amount = bound(amount, 1e6, 20_000e6);
        usdc.mint(address(this), amount);
        usdc.approve(address(pool), amount);
        try pool.fundReserve(amount) {} catch {}
    }

    // ─── The book ────────────────────────────────────────────────────────────

    function front(uint256 principal, uint256 mdrSeed) external {
        principal = bound(principal, 75e6, 5_000e6);
        uint256 mdr = bound(mdrSeed, 0, principal / 10);
        uint256 escrow = PlanParams.markEscrowFor(4);
        if (mdr < escrow) mdr = escrow;

        ConfigurablePlan p = new ConfigurablePlan();
        // Dated forward, so nothing is past grace until the handler warps.
        p.initHealthy(4, principal, vm.getBlockTimestamp() + 7 days, 14 days);

        bytes32 id = keccak256(abi.encode("plan", planIds.length, principal));

        try pool.front(
            id, address(p), MERCHANT, keccak256("corridor"), principal, mdr, escrow, address(this)
        ) {
            planIds.push(id);
            planOf[id] = p;
            outstandingOf[id] = principal;
            fronts++;
        } catch {}
    }

    /// @dev A collection, as the pool sees one: principal comes off the plan, cash
    ///      arrives net of the keeper's bounty, and the pool is told nothing until
    ///      someone cranks `recognise`.
    function collectOn(uint256 seed, uint256 amount) external {
        if (planIds.length == 0) return;
        bytes32 id = planIds[seed % planIds.length];
        ConfigurablePlan p = planOf[id];

        uint256 outstanding = outstandingOf[id];
        if (outstanding == 0) return;

        amount = bound(amount, 1, outstanding);
        // A three percent servicing cost, standing in for the Dutch bounty ramp.
        uint256 net = (amount * 97) / 100;

        outstandingOf[id] = outstanding - amount;
        forwardedOf[id] += net;

        usdc.mint(address(pool), net);
        p.setAccounting(outstandingOf[id], forwardedOf[id], 0, 0, 0);
        payments++;
    }

    function defaultPlan(uint256 seed) external {
        if (planIds.length == 0) return;
        bytes32 id = planIds[seed % planIds.length];
        planOf[id].setState(IInstallmentPlan.PlanState.Defaulted);
        defaults++;
    }

    /// @notice Move a plan into and out of delinquency. POOL-07's round trip.
    /// @dev The interesting half is the *cure*: a provision that releases something
    ///      other than exactly what it took is the harvestable oscillation D11 named,
    ///      and it only shows up when a plan goes both ways.
    function setDelinquent(uint256 seed, bool delinquent) external {
        if (planIds.length == 0) return;
        bytes32 id = planIds[seed % planIds.length];
        ConfigurablePlan p = planOf[id];
        if (p.state() == IInstallmentPlan.PlanState.Defaulted) return;
        if (p.state() == IInstallmentPlan.PlanState.Repaid) return;
        p.setState(
            delinquent ? IInstallmentPlan.PlanState.Delinquent : IInstallmentPlan.PlanState.Active
        );
    }

    function repayFully(uint256 seed) external {
        if (planIds.length == 0) return;
        bytes32 id = planIds[seed % planIds.length];
        ConfigurablePlan p = planOf[id];

        uint256 outstanding = outstandingOf[id];
        if (outstanding > 0) {
            uint256 net = (outstanding * 97) / 100;
            forwardedOf[id] += net;
            outstandingOf[id] = 0;
            usdc.mint(address(pool), net);
            p.setAccounting(0, forwardedOf[id], 0, 0, 0);
        }
        p.setState(IInstallmentPlan.PlanState.Repaid);
    }

    /// @notice Record every past-grace installment. COLL-04's unblocker.
    function markAll(uint256 seed) external {
        if (planIds.length == 0) return;
        ConfigurablePlan p = planOf[planIds[seed % planIds.length]];
        for (uint256 i = 0; i < 4; ++i) {
            if (p.installmentStatus(i) == IInstallmentPlan.InstallmentStatus.Pending) {
                p.setStatus(i, IInstallmentPlan.InstallmentStatus.Missed);
            }
        }
    }

    /// @notice Crank the book, and watch the waterfall while it runs.
    ///
    /// @dev `recognise` is the only action that can take a loss, so it is the only
    ///      place the ordering can be violated. The check is a *transition* rather
    ///      than a state read, because the balance sheet does not record when the
    ///      reserve was emptied: a pool that correctly struck the reserve to zero,
    ///      took the overflow out of junior, and was then replenished by a fee is
    ///      indistinguishable, after the fact, from one that struck junior first.
    ///      Only watching the step tells them apart.
    function recognise(uint256 seed) external {
        if (planIds.length == 0) return;

        uint256 juniorBefore = pool.trancheAssets(ICreditPool.Tranche.Junior);
        uint256 seniorBefore = pool.trancheAssets(ICreditPool.Tranche.Senior);

        try pool.recognise(planIds[seed % planIds.length]) {
            recognitions++;
        } catch {
            return;
        }

        _checkWaterfall(juniorBefore, seniorBefore);
    }

    function _checkWaterfall(uint256 juniorBefore, uint256 seniorBefore) private {
        if (pool.trancheAssets(ICreditPool.Tranche.Junior) < juniorBefore) {
            // Junior was struck. The reserve had to be exhausted for that to be legal.
            if (pool.reserveBalance() != 0) waterfallInverted = true;
        }
        if (pool.trancheAssets(ICreditPool.Tranche.Senior) < seniorBefore) {
            // Senior was struck. Both the reserve and junior had to be exhausted.
            if (pool.reserveBalance() != 0) waterfallInverted = true;
            if (pool.trancheAssets(ICreditPool.Tranche.Junior) != 0) waterfallInverted = true;
        }
    }

    // ─── Epochs ──────────────────────────────────────────────────────────────

    function markEpoch(uint256 limit) external {
        uint256 juniorBefore = pool.trancheAssets(ICreditPool.Tranche.Junior);
        uint256 seniorBefore = pool.trancheAssets(ICreditPool.Tranche.Senior);
        try pool.markEpoch(bound(limit, 1, 32)) {} catch {}
        _checkWaterfall(juniorBefore, seniorBefore);
    }

    /// @notice Try to close. It usually fails, and every reason it fails is a rule.
    function closeEpoch() external {
        uint256 seniorFills = pool.fillCount(ICreditPool.Tranche.Senior);
        uint256 juniorFills = pool.fillCount(ICreditPool.Tranche.Junior);

        try pool.closeEpoch() {
            closes++;
        } catch {
            return;
        }

        _checkFeeUniformity(ICreditPool.Tranche.Senior, seniorFills);
        _checkFeeUniformity(ICreditPool.Tranche.Junior, juniorFills);
    }

    /// @dev A close appends at most one fill per tranche, and both tranches' fills in
    ///      one epoch must carry the same rate. Anything else means a redeemer's price
    ///      depended on something other than which epoch they were in.
    function _checkFeeUniformity(ICreditPool.Tranche tranche, uint256 before) private {
        uint256 count = pool.fillCount(tranche);
        if (count <= before) return;
        if (count - before > 1) feeWasNotUniform = true;

        TranchedCreditPool.Fill memory latest = pool.fillAt(tranche, count - 1);
        ICreditPool.Tranche other =
            tranche == ICreditPool.Tranche.Senior ? ICreditPool.Tranche.Junior : ICreditPool.Tranche.Senior;
        uint256 otherCount = pool.fillCount(other);
        if (otherCount == 0) return;

        TranchedCreditPool.Fill memory peer = pool.fillAt(other, otherCount - 1);
        if (peer.epoch == latest.epoch && peer.feeBps != latest.feeBps) feeWasNotUniform = true;
    }

    function warp(uint256 seconds_) external {
        vm.warp(vm.getBlockTimestamp() + bound(seconds_, 1 hours, 30 days));
    }
}

/// @notice The Phase 1 pool properties, bound to a pool that exists.
///
/// @dev Phase 1 wrote these before any vault, deliberately — two of them are not
///      descriptions of a chosen implementation but constraints that rule
///      implementations out, and discovering during formal verification that the
///      accounting shape was wrong is a redesign at the worst possible moment.
///
///      Phase 3 bound them to a flat book. Phase 5 binds them, unchanged, to the
///      tranched one — which is the check that DEC-21's "refinement, not replacement"
///      is a true description rather than a comforting one.
contract PoolFuzzTest is StdInvariant, PoolInvariants {
    MockArcUsdc internal usdc;
    ParameterRegistry internal parameters;
    EligibilityRegistry internal eligibility;
    TranchedCreditPool internal subject;
    PoolHandler internal handler;

    uint256 internal constant SEED = 1e6;

    function setUp() public {
        usdc = new MockArcUsdc();
        parameters = new ParameterRegistry(address(this));
        eligibility = new EligibilityRegistry(address(this));

        subject = new TranchedCreditPool(
            TranchedCreditPool.Wiring({
                admin: address(this),
                token: address(usdc),
                parameters: address(parameters),
                eligibility: address(eligibility),
                productLine: keccak256("PLAZO.PAY_IN_4"),
                minInstallments: 2,
                maxInstallments: 6,
                minInterval: 7 days,
                maxInterval: 31 days
            })
        );

        handler = new PoolHandler(subject, usdc, parameters);
        subject.setOriginator(address(handler));

        eligibility.setGlobal(address(0xA11CE), true);
        eligibility.setGlobal(address(0xB0B), true);
        eligibility.setGlobal(address(this), true);
        eligibility.setGlobal(address(subject), true);

        // POOL-12's permanent seed, before anybody can be the first depositor.
        usdc.mint(address(this), 2 * SEED);
        usdc.approve(address(subject), 2 * SEED);
        subject.seed(ICreditPool.Tranche.Senior, SEED);
        subject.seed(ICreditPool.Tranche.Junior, SEED);

        pool = ICreditPool(address(subject));

        // Junior is sold as first-loss and is expected to reach zero against a large
        // enough loss. See the note on `check_sharesImplyAssets`.
        impairedTranche[uint256(ICreditPool.Tranche.Junior)] = true;
        impairedTranche[uint256(ICreditPool.Tranche.Senior)] = true;

        targetContract(address(handler));
        vm.warp(365 days);
    }

    // ─── The Phase 1 properties ──────────────────────────────────────────────

    function invariant_assetsEqualClaims() public view {
        check_assetsEqualClaims();
    }

    function invariant_sharesImplyAssets() public view {
        check_sharesImplyAssets();
    }

    function invariant_provisionBucketsSumToTotal() public view {
        check_provisionBucketsSumToTotal();
    }

    function invariant_provisionNeverExceedsAssets() public view {
        check_provisionNeverExceedsAssets();
    }

    /// @notice POOL-16, as the transition it actually is.
    ///
    /// @dev `check_reserveAbsorbsBeforeJunior` is bound here in its transition form
    ///      rather than its state form, and the reason is a genuine limit of the state
    ///      form that the Phase 3 campaign found.
    ///
    ///      The balance sheet does not record *when* the reserve was emptied. A pool
    ///      that correctly struck the reserve to zero, took the overflow out of
    ///      junior, and was then replenished — by a fee earning, by someone topping
    ///      the reserve up — sits in a state that reads identically to one whose
    ///      waterfall ran out of order. The state form flags the first as a violation,
    ///      and it is not one; the recovery is the system working.
    ///
    ///      So the handler watches every step that can take a loss and latches a flag
    ///      if a tranche was ever struck while something senior to it in the waterfall
    ///      still held assets. That is the property POOL-16 states, checked where it
    ///      happens.
    function invariant_theWaterfallWasNeverOutOfOrder() public view {
        assertFalse(
            handler.waterfallInverted(),
            "a loss reached a tranche while the layer beneath it still held assets"
        );
    }

    function invariant_subordinationIsDerived() public view {
        check_subordinationIsDerived();
    }

    function invariant_originationClosedBelowFloors() public view {
        check_originationClosedBelowFloors();
    }

    function invariant_epochBlocksOnUnmarkedDelinquency() public view {
        check_epochBlocksOnUnmarkedDelinquency();
    }

    // ─── The balance sheet ───────────────────────────────────────────────────

    /// @notice NAV is exactly what the book holds, less what it does not own.
    ///
    /// @dev The bridge between the two halves of the balance sheet. `totalAssets` is
    ///      the sum of the three claims; this asserts the sum of the *holdings* is the
    ///      same number. If they can diverge, one of them is wrong and nobody finds out
    ///      until a redemption fails.
    ///
    ///      Phase 5 added two terms and both are the point of their requirement: the
    ///      venue position (POOL-13) is an asset held somewhere else, and the provision
    ///      (POOL-07) is a valuation allowance against receivables the book has already
    ///      marked down. Pending deposits and unclaimed redemption proceeds appear on
    ///      neither side, because they are money in this contract that belongs to
    ///      somebody who is not a holder yet or is no longer one.
    function invariant_bookedIdentity() public view {
        assertEq(
            subject.totalAssets() + subject.deferredIncome() + subject.totalProvisioned(),
            subject.bookedCash() + subject.deployedAssets() + subject.bookedReceivables(),
            "the book's claims and its holdings disagree"
        );
    }

    /// @notice Every dollar the contract believes it is holding is really there.
    ///
    /// @dev POOL-11 from the other direction, and it now has to cover three pots. The
    ///      balance may be *higher* — that is a donation, and the whole point is that it
    ///      does not reach NAV. It may never be lower, because that would be a book that
    ///      believes it can pay redemptions it cannot.
    function invariant_bookedCashIsBacked() public view {
        assertLe(
            subject.bookedCash() + subject.pendingDepositAssets() + subject.pendingRedemptionAssets(),
            usdc.balanceOf(address(subject)),
            "the book counts cash it does not hold"
        );
    }

    /// @notice Unearned fees never exceed the receivables they sit against.
    /// @dev Deferred income is a claim on principal that has not come back yet. If it
    ///      could exceed the receivable it would be a negative asset in disguise.
    function invariant_deferredIncomeIsBounded() public view {
        assertLe(
            subject.deferredIncome(),
            subject.bookedReceivables(),
            "unearned fees exceed the receivables they are held against"
        );
    }

    /// @notice A pending deposit is never a claim.
    ///
    /// @dev DEC-22. Assets waiting for a price confer nothing: no shares, no NAV, no
    ///      vote in the loss waterfall. If they could reach `totalAssets` before being
    ///      priced, a large pending queue would move the very NAV it is about to be
    ///      struck at — which is the synchronous-deposit failure POOL-03 exists to
    ///      remove.
    function invariant_pendingDepositsAreNotClaims() public view {
        assertLe(
            subject.pendingDepositAssets(),
            usdc.balanceOf(address(subject)),
            "pending deposits exceed what the contract holds"
        );
        assertEq(
            subject.totalAssets(),
            subject.reserveBalance() + subject.trancheAssets(ICreditPool.Tranche.Junior)
                + subject.trancheAssets(ICreditPool.Tranche.Senior),
            "a pending deposit reached the claims side"
        );
    }

    /// @notice The redemption queue only ever moves forward, and never past its tail.
    /// @dev POOL-08's cumulative position is only meaningful if the fill line is
    ///      monotone. A line that could retreat would let a ticket be filled twice.
    function invariant_queueLineIsSane() public view {
        for (uint256 t = 0; t < 2; ++t) {
            (uint256 queued, uint256 filled) = subject.queueDepth(ICreditPool.Tranche(t));
            assertLe(filled, queued, "the fill line ran past the end of the queue");
        }
    }

    /// @notice Every redeemer filled in one epoch paid the same rate.
    /// @dev POOL-09 and DEC-23. If the fee depended on anything but the epoch, leaving
    ///      early would be profitable again and the gate would be back in all but name.
    function invariant_liquidityFeeIsUniform() public view {
        assertFalse(
            handler.feeWasNotUniform(), "two redeemers in one epoch were charged different rates"
        );
    }

    /// @notice The handler actually exercises the book.
    ///
    /// @dev Foundry resets state between invariant runs, so `afterInvariant` ghost
    ///      counters read zero however hard the fuzzer worked — the Phase 2 lesson.
    ///      This plays the actions in order and asserts each one moved its counter, so
    ///      a suite that silently stopped reaching the interesting paths fails rather
    ///      than passing quietly.
    function test_theHandlerDrivesTheBook() public {
        handler.requestDeposit(1, 20_000e6, true);
        handler.requestDeposit(0, 50_000e6, false);
        handler.fundReserve(10_000e6);
        assertEq(handler.deposits(), 2, "deposits did not land");

        handler.warp(2 days);
        handler.markEpoch(32);
        handler.closeEpoch();
        assertEq(handler.closes(), 1, "the epoch did not close");

        handler.claimShares(0, false);
        handler.claimShares(1, true);
        assertEq(handler.claims(), 2, "the shares were not claimed");

        handler.front(1_000e6, 40e6);
        assertEq(handler.fronts(), 1, "the front did not land");

        handler.collectOn(0, 250e6);
        assertEq(handler.payments(), 1, "the collection did not land");

        handler.recognise(0);
        assertEq(handler.recognitions(), 1, "recognition did not land");

        handler.requestRedeem(0, 1e9, false);
        assertEq(handler.redemptions(), 1, "the redemption request did not land");

        handler.defaultPlan(0);
        handler.recognise(0);
        assertEq(handler.defaults(), 1, "the default did not land");

        check_assetsEqualClaims();
        invariant_bookedIdentity();
        invariant_bookedCashIsBacked();
        invariant_pendingDepositsAreNotClaims();
    }
}
