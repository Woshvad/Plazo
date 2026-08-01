// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {PlanFixture} from "../helpers/PlanFixture.sol";
import {PlanInvariants} from "./PlanInvariants.sol";
import {InstallmentPlan} from "../../src/InstallmentPlan.sol";
import {IInstallmentPlan} from "../../src/interfaces/IInstallmentPlan.sol";
import {PlanParams} from "../../src/libraries/PlanParams.sol";
import {MockArcUsdc} from "../mocks/MockArcUsdc.sol";

/// @notice Drives a real plan through arbitrary histories.
///
/// @dev The handler is the system's environment: a keeper who cranks at random
///      moments, a borrower whose balance appears and vanishes, a merchant who
///      refunds, a token that pauses, and a clock that jumps. Every action is
///      allowed to revert — `fail_on_revert = false` — because what is being tested
///      is that no *reachable* sequence breaks an invariant, not that every random
///      call is well-formed.
contract PlanHandler is Test {
    InstallmentPlan public plan;
    MockArcUsdc public usdc;
    address public borrower;
    address public merchant;

    uint256 public collected;
    uint256 public bounced;
    uint256 public marked;
    uint256 public repaid;
    uint256 public refunded;

    address internal constant KEEPER_A = address(0xA1);
    address internal constant KEEPER_B = address(0xB2);

    constructor(InstallmentPlan plan_, MockArcUsdc usdc_, address borrower_, address merchant_) {
        plan = plan_;
        usdc = usdc_;
        borrower = borrower_;
        merchant = merchant_;
    }

    function _index(uint256 seed) internal view returns (uint256) {
        return bound(seed, 0, plan.installmentCount() - 1);
    }

    /// @dev Every action pranks through `startPrank`/`stopPrank` and swallows the
    ///      revert itself. A `vm.prank` consumed by a call that reverts stays armed
    ///      into the next handler invocation, and the fuzzer reverts on roughly half
    ///      its calls by design — so an unguarded prank leaks across the campaign and
    ///      eventually collides with the invariant's own.
    modifier as_(address actor) {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    function collect(uint256 seed, bool alternateKeeper) external as_(alternateKeeper ? KEEPER_B : KEEPER_A) {
        try plan.collect(_index(seed)) returns (bool cleared, IInstallmentPlan.BounceReason) {
            if (cleared) collected++;
            else bounced++;
        } catch {}
    }

    function collectBatch(uint256 seed) external as_(KEEPER_A) {
        uint256 count = plan.installmentCount();
        uint256[] memory indices = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            indices[i] = (bound(seed, 0, count - 1) + i) % count;
        }
        try plan.collectBatch(indices) {} catch {}
    }

    function markMissed(uint256 seed) external as_(KEEPER_B) {
        try plan.markMissed(_index(seed)) {
            marked++;
        } catch {}
    }

    function markExpired(uint256 seed) external as_(KEEPER_B) {
        try plan.markExpired(_index(seed)) {
            marked++;
        } catch {}
    }

    function repay(uint256 amount) external as_(borrower) {
        uint256 value = bound(amount, 1, 500e6);
        usdc.mint(borrower, value);
        usdc.approve(address(plan), value);
        try plan.repay(value) {
            repaid++;
        } catch {}
    }

    function creditRefund(uint256 amount) external as_(merchant) {
        uint256 value = bound(amount, 1, 200e6);
        usdc.mint(merchant, value);
        usdc.approve(address(plan), value);
        try plan.creditRefund(value) {
            refunded++;
        } catch {}
    }

    function fundBorrower(uint256 amount) external {
        usdc.mint(borrower, bound(amount, 1, 500e6));
    }

    /// @dev The borrower spending their balance somewhere else. On Arc this is the
    ///      same balance that pays for gas, which is why it is a routine event
    ///      rather than an exotic one.
    function drainBorrower() external {
        usdc.burnAll(borrower);
    }

    function warp(uint256 seconds_) external {
        vm.warp(vm.getBlockTimestamp() + bound(seconds_, 1 hours, 45 days));
    }

    function pauseToken(bool value) external {
        usdc.setPaused(value);
    }

    function resume() external as_(KEEPER_A) {
        try plan.resume() {} catch {}
    }

    function halt() external as_(KEEPER_B) {
        try plan.halt() {} catch {}
    }

    function revalidate() external as_(KEEPER_A) {
        try plan.revalidate() {} catch {}
    }

    function sweep() external as_(KEEPER_A) {
        try plan.sweep() {} catch {}
    }
}

/// @title PlanFuzzTest
/// @notice The Phase 1 invariant suite, bound to the contract it was written for.
///
/// @dev Phase 1 wrote these properties before any implementation existed and proved
///      they bite by driving each one into failure against a breakable stub. This is
///      the other half: the same assertions, against the real plan, under a fuzzer
///      that is trying to find a history where one of them does not hold.
///
///      Note which property is *not* asserted here.
///      `check_everyOverdueInstallmentIsAccountedFor` is a liveness claim — it holds
///      "given at least one honest keeper", and the fuzzer is explicitly not obliged
///      to be one. Asserting it would mean asserting that a random walk always
///      happens to include a crank, which is false and would say nothing about the
///      contract. What the contract *can* guarantee unconditionally is that the
///      crank is always available and always paid, and that is asserted below as
///      `invariant_everyOverdueInstallmentIsRecordable` — a stronger statement about
///      the protocol and a weaker one about luck.
contract PlanFuzzTest is PlanFixture, PlanInvariants {
    PlanHandler internal handler;

    function setUp() public {
        _deployStack();
        vm.warp(1_800_000_000);
        _originateDefault();
        _fundBorrower(200e6);

        subject = IInstallmentPlan(address(plan));
        handler = new PlanHandler(plan, usdc, borrower, merchant);

        targetContract(address(handler));
    }

    /// @notice The handler can actually drive the system it is supposed to fuzz.
    ///
    /// @dev Every handler action swallows its own revert — which is what keeps a
    ///      pranked call from leaking into the next one, and is also how an invariant
    ///      suite quietly becomes sixteen thousand no-ops that report green. So the
    ///      handler is exercised once by hand, in a scripted order, and each counter
    ///      is required to move. If this fails, none of the invariants below mean
    ///      anything, whatever they say.
    function test_theHandlerDrivesTheSystem() public {
        handler.collect(0, false);
        assertEq(handler.collected(), 1, "the handler cannot collect");

        handler.drainBorrower();
        handler.warp(20 days);
        handler.collect(1, true);
        assertEq(handler.bounced(), 1, "the handler cannot produce a bounce");

        handler.warp(5 days);
        handler.markMissed(1);
        assertEq(handler.marked(), 1, "the handler cannot record a delinquency");

        handler.repay(500e6);
        assertEq(handler.repaid(), 1, "the handler cannot reach the push rail");

        handler.pauseToken(true);
        handler.halt();
        handler.pauseToken(false);
        handler.resume();
        handler.revalidate();
        handler.sweep();
    }

    // ─── The Phase 1 properties, now bound to a real system ──────────────────

    function invariant_valueIsConserved() public view {
        check_valueIsConserved();
    }

    function invariant_outstandingNeverExceedsPrincipal() public view {
        check_outstandingNeverExceedsPrincipal();
    }

    function invariant_payoffCoversOutstanding() public view {
        check_payoffCoversOutstanding();
    }

    function invariant_noInstallmentClearsTwice() public view {
        check_noInstallmentClearsTwice();
    }

    function invariant_scheduleIsMonotone() public view {
        check_scheduleIsMonotone();
    }

    function invariant_graceFollowsDueDate() public view {
        check_graceFollowsDueDate();
    }

    function invariant_terminalStatesAreClean() public view {
        check_terminalStatesAreClean();
    }

    function invariant_settledWithFeeOutstandingIsCoherent() public view {
        check_settledWithFeeOutstandingIsCoherent();
    }

    // ─── Properties the implementation adds ──────────────────────────────────

    /// @notice The plan holds no float.
    ///
    /// @dev Every unit that arrives leaves in the same transaction — to the keeper
    ///      who cranked, back to the borrower as a rebate, or forward to the
    ///      disclosed settlement recipient. The only balance a plan carries is its
    ///      own crank escrow. A plan that accumulated a balance would be custody by
    ///      accident, which is the one thing this design is not allowed to be.
    function invariant_planHoldsNoFloat() public view {
        assertEq(
            usdc.balanceOf(address(plan)),
            plan.markEscrow(),
            "the plan is holding value that is neither escrow nor in transit"
        );
    }

    /// @notice The delinquency signal can always be paid for.
    /// @dev The reservation that stops `revalidate()` eating the mark budget. If this
    ///      breaks, a plan reaches the moment it needs to record its own default and
    ///      cannot afford to.
    function invariant_markBudgetStaysFunded() public view {
        assertTrue(plan.markBudgetIsFunded(), "a plan cannot afford to record its own delinquency");
    }

    /// @notice Any overdue installment with no recorded outcome can be recorded, now,
    ///         by an address with no relationship to the protocol — and doing so pays.
    ///
    /// @dev This is the collection guarantee stated as something a contract can
    ///      actually promise. The specification's form — "every installment reaches a
    ///      terminal status within `validBefore + 1`" — is conditional on a keeper
    ///      turning up, and no contract can guarantee that anyone turns up. What it
    ///      can guarantee is that turning up always works and always pays, which is
    ///      the part the incentive design is responsible for.
    ///
    ///      Checked by actually performing the crank and rolling the state back, so
    ///      the assertion is about what the contract does rather than about what its
    ///      view functions claim.
    function invariant_everyOverdueInstallmentIsRecordable() public {
        // Not while the rail is down. A mark during an outage would provision NAV
        // and put a default on a Passport for a borrower whose only failing was that
        // USDC was paused — which is what `HALTED` and the suspended clocks exist to
        // prevent, so refusing here is the behaviour rather than a gap in it.
        if (usdc.paused()) return;

        uint256 snapshot = vm.snapshotState();
        address honest = address(0xA11CE);

        for (uint256 i = 0; i < plan.installmentCount(); ++i) {
            if (vm.getBlockTimestamp() <= plan.graceEndsAt(i)) continue;

            IInstallmentPlan.InstallmentStatus status = plan.installmentStatus(i);
            if (
                status != IInstallmentPlan.InstallmentStatus.Pending
                    && status != IInstallmentPlan.InstallmentStatus.Bounced
            ) continue;

            uint256 before = usdc.balanceOf(honest);
            vm.prank(honest);
            plan.markMissed(i);

            assertTrue(plan.isMarked(i), "an overdue installment could not be recorded");
            assertGt(usdc.balanceOf(honest), before, "recording a delinquency paid nothing");
        }

        vm.revertToState(snapshot);
    }
}
