// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {PoolInvariants} from "./PoolInvariants.sol";
import {ConfigurablePlan} from "./stubs/ConfigurablePlan.sol";

import {CreditPool} from "../../src/CreditPool.sol";
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
contract PoolHandler is Test {
    CreditPool internal immutable pool;
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

    uint256 public deposits;
    uint256 public redemptions;
    uint256 public fronts;
    uint256 public recognitions;
    uint256 public defaults;
    uint256 public payments;

    constructor(CreditPool pool_, MockArcUsdc usdc_, ParameterRegistry parameters_) {
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

    /// @dev Every action is wrapped so a revert does not abort the run and does not
    ///      leave a prank armed. A prank consumed by a reverting call stays armed and
    ///      poisons the next action — the same trap the plan fuzzer hit in Phase 2.
    modifier as_(address who) {
        vm.startPrank(who);
        _;
        vm.stopPrank();
    }

    // ─── Capital ─────────────────────────────────────────────────────────────

    function deposit(uint256 seed, uint256 amount, bool junior) external {
        address who = lenderAt(seed);
        amount = bound(amount, 1e6, 100_000e6);
        usdc.mint(who, amount);

        vm.startPrank(who);
        usdc.approve(address(pool), amount);
        try pool.deposit(junior ? ICreditPool.Tranche.Junior : ICreditPool.Tranche.Senior, amount) {
            deposits++;
        } catch {}
        vm.stopPrank();
    }

    function redeem(uint256 seed, uint256 shares, bool junior) external as_(lenderAt(seed)) {
        ICreditPool.Tranche tranche =
            junior ? ICreditPool.Tranche.Junior : ICreditPool.Tranche.Senior;
        uint256 held = pool.sharesOf(tranche, lenderAt(seed));
        if (held == 0) return;
        shares = bound(shares, 1, held);
        try pool.redeem(tranche, shares) {
            redemptions++;
        } catch {}
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
        p.initHealthy(4, principal, block.timestamp + 7 days, 14 days);

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

    function markMissed(uint256 seed) external {
        if (planIds.length == 0) return;
        bytes32 id = planIds[seed % planIds.length];
        planOf[id].setStatus(0, IInstallmentPlan.InstallmentStatus.Missed);
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

    function warp(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1 hours, 30 days));
    }
}

/// @notice The Phase 1 pool properties, bound to a pool that exists.
///
/// @dev Phase 1 wrote these before any vault, deliberately — two of them are not
///      descriptions of a chosen implementation but constraints that rule
///      implementations out, and discovering during formal verification that the
///      accounting shape was wrong is a redesign at the worst possible moment.
///
///      This is the moment they stop being aspirations.
contract PoolFuzzTest is StdInvariant, PoolInvariants {
    MockArcUsdc internal usdc;
    ParameterRegistry internal parameters;
    EligibilityRegistry internal eligibility;
    CreditPool internal subject;
    PoolHandler internal handler;

    function setUp() public {
        usdc = new MockArcUsdc();
        parameters = new ParameterRegistry(address(this));
        eligibility = new EligibilityRegistry(address(this));
        subject = new CreditPool(address(this), address(usdc), address(parameters), address(eligibility));

        handler = new PoolHandler(subject, usdc, parameters);
        subject.grantRole(subject.ORIGINATOR_ROLE(), address(handler));

        eligibility.setGlobal(address(0xA11CE), true);
        eligibility.setGlobal(address(0xB0B), true);

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
    ///      form that this campaign found.
    ///
    ///      The balance sheet does not record *when* the reserve was emptied. A pool
    ///      that correctly struck the reserve to zero, took the overflow out of
    ///      junior, and was then replenished — by a fee earning, by someone topping
    ///      the reserve up — sits in a state that reads identically to one whose
    ///      waterfall ran out of order. The state form flags the first as a violation,
    ///      and it is not one; the recovery is the system working.
    ///
    ///      So the handler watches every `recognise` and latches a flag if a tranche
    ///      was ever struck while something senior to it in the waterfall still held
    ///      assets. That is the property POOL-16 states, checked where it happens.
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

    // ─── Phase 3 additions ───────────────────────────────────────────────────

    /// @notice NAV is exactly cash plus receivables less unearned fees.
    ///
    /// @dev The bridge between the two halves of the balance sheet. `totalAssets` is
    ///      the sum of the three claims; this asserts the sum of the three *holdings*
    ///      is the same number. If they can diverge, one of them is wrong and nobody
    ///      finds out until a redemption fails.
    function invariant_bookedIdentity() public view {
        assertEq(
            subject.totalAssets(),
            subject.bookedCash() + subject.bookedReceivables() - subject.deferredIncome(),
            "the book's claims and its holdings disagree"
        );
    }

    /// @notice Booked cash never exceeds the cash actually held.
    ///
    /// @dev POOL-11 from the other direction. The balance may be *higher* — that is a
    ///      donation, and the whole point is that it does not reach NAV. It may never
    ///      be lower, because that would be a book that believes it can pay
    ///      redemptions it cannot.
    function invariant_bookedCashIsBacked() public view {
        assertLe(
            subject.bookedCash(),
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

    /// @notice The handler actually exercises the book.
    ///
    /// @dev Foundry resets state between invariant runs, so `afterInvariant` ghost
    ///      counters read zero however hard the fuzzer worked — the Phase 2 lesson.
    ///      This plays the actions in order and asserts each one moved its counter, so
    ///      a suite that silently stopped reaching the interesting paths fails rather
    ///      than passing quietly.
    function test_theHandlerDrivesTheBook() public {
        handler.deposit(0, 50_000e6, false);
        handler.deposit(1, 20_000e6, true);
        handler.fundReserve(10_000e6);
        assertEq(handler.deposits(), 2, "deposits did not land");

        handler.front(1_000e6, 40e6);
        assertEq(handler.fronts(), 1, "the front did not land");

        handler.collectOn(0, 250e6);
        assertEq(handler.payments(), 1, "the collection did not land");

        handler.recognise(0);
        assertEq(handler.recognitions(), 1, "recognition did not land");

        handler.redeem(0, 1e6, false);
        assertEq(handler.redemptions(), 1, "the redemption did not land");

        handler.defaultPlan(0);
        handler.recognise(0);
        assertEq(handler.defaults(), 1, "the default did not land");

        check_assetsEqualClaims();
        invariant_bookedIdentity();
        invariant_bookedCashIsBacked();
    }
}
