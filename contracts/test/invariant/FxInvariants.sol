// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PlanFixture} from "../helpers/PlanFixture.sol";
import {InstallmentPlan} from "../../src/InstallmentPlan.sol";
import {IInstallmentPlan} from "../../src/interfaces/IInstallmentPlan.sol";
import {PayrollSweeper} from "../../src/underwriting/PayrollSweeper.sol";
import {MockArcUsdc} from "../mocks/MockArcUsdc.sol";

/// @title FxInvariants
/// @notice Properties for the cross-currency and payroll-deduction surfaces.
///
/// @dev Created by plan 07-05 with the one property UW-05 turns on; extended by 07-10
///      with the cross-pool isolation and corridor-counter properties.
///
///      Named `check_*` rather than `invariant_*` for the reason `PlanInvariants` gives:
///      the property module is bound by a harness, and the harness is what decides which
///      properties a given campaign asserts.
///
///      **Each property binds to something the system already exposes** — DEC-48. An
///      invariant that needs new storage on the contract under test in order to be
///      observable has changed the system it was meant to constrain, and then it is
///      describing the instrumentation rather than the design.
abstract contract FxInvariants is Test {
    /// @dev The token whose balance is watched, and the address it is watched at. Both
    ///      set by the harness; nothing is added to `PayrollSweeper` to make this
    ///      readable, because an ERC-20 balance already is.
    IERC20 internal sweptToken;
    address internal sweepContract;

    // ─── UW-05 / C3 ──────────────────────────────────────────────────────────

    /// @notice The sweeper never holds value.
    ///
    /// @dev The non-custody claim, stated over every reachable history rather than over
    ///      the two or three a scripted test can write down. "Borrower funds stay in the
    ///      borrower's wallet until each due date" is a project constraint, and payroll
    ///      deduction is the one mechanism in this phase whose plain-language description
    ///      — value splitting off an inbound flow — reads like a custody contract. So the
    ///      design receives and repays in one transaction, returns every unit of residue
    ///      to the borrower, and reverts `SweeperRetainedValue` if its own balance is
    ///      anything but zero when it finishes. This asserts the observable consequence:
    ///      between any two transactions, whatever sequence of sweeps, collections,
    ///      cures, opt-ins and opt-outs produced them, there is nothing there.
    ///
    ///      Stated over *protocol* flows. An unsolicited transfer straight to the
    ///      sweeper's address is not one — nothing in the tree performs it, and the next
    ///      sweep would forward it to that borrower rather than stranding it.
    ///
    /// @custom:certora sweeperNeverHoldsValue
    function check_sweeperNeverHoldsValue() public view {
        assertEq(
            sweptToken.balanceOf(sweepContract),
            0,
            "the payroll sweeper is holding borrower funds between transactions"
        );
    }
}

/// @notice The system's environment for the sweeper: a payroll deposit landing at random
///         moments, a borrower who opts in and out, a keeper cranking the ordinary rail,
///         and a clock that jumps.
///
/// @dev The handler signs its own sweep authorizations, because a handler that could only
///      replay one pre-built signature would exercise one value at one index and the
///      campaign would be a single scripted path wearing a fuzzer's clothes.
///
///      Every action swallows its own revert — `fail_on_revert = false`, and roughly half
///      of these calls are expected to be refused by design (a burned nonce, a closed
///      plan, a withdrawn opt-in). Which is also how an invariant suite quietly becomes
///      sixteen thousand no-ops reporting green, so the counters below exist and
///      `test_theHandlerDrivesTheSystem` requires each of them to move.
contract PayrollSweepHandler is Test {
    InstallmentPlan public plan;
    MockArcUsdc public usdc;
    PayrollSweeper public sweeper;

    address public borrower;
    uint256 internal borrowerKey;
    bytes32 public planId;

    uint256 public swept;
    uint256 public collected;
    uint256 public repaid;
    uint256 public optedOut;

    address internal constant KEEPER = address(0xA1);
    address internal constant STRANGER = address(0xB2);

    constructor(
        InstallmentPlan plan_,
        MockArcUsdc usdc_,
        PayrollSweeper sweeper_,
        address borrower_,
        uint256 borrowerKey_,
        bytes32 planId_
    ) {
        plan = plan_;
        usdc = usdc_;
        sweeper = sweeper_;
        borrower = borrower_;
        borrowerKey = borrowerKey_;
        planId = planId_;
    }

    modifier as_(address actor) {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    function _signSweep(
        uint256 index,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                borrower,
                address(sweeper),
                value,
                validAfter,
                validBefore,
                sweeper.sweepNonce(planId, index)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev A payroll deposit landing and a keeper acting on it. The value is fuzzed
    ///      across and beyond the payoff amount on purpose: the over-payment path is the
    ///      one where `repay` hands a rebate back to this contract, and therefore the one
    ///      where a custody bug would appear.
    function sweepAt(uint256 seed, uint256 amount) external as_(STRANGER) {
        uint256 index = bound(seed, 0, plan.installmentCount() - 1);
        uint256 value = bound(amount, 1, 300e6);
        uint256 validBefore = vm.getBlockTimestamp() + 30 days;

        try sweeper.sweep(
            address(plan), index, value, 0, validBefore, _signSweep(index, value, 0, validBefore)
        ) {
            swept++;
        } catch {}
    }

    function optIn() external as_(borrower) {
        sweeper.optIn(planId);
    }

    function optOut() external as_(borrower) {
        sweeper.optOut(planId);
        optedOut++;
    }

    function collect(uint256 seed) external as_(KEEPER) {
        try plan.collect(bound(seed, 0, plan.installmentCount() - 1)) returns (
            bool cleared, IInstallmentPlan.BounceReason
        ) {
            if (cleared) collected++;
        } catch {}
    }

    function repay(uint256 amount) external as_(borrower) {
        uint256 value = bound(amount, 1, 300e6);
        usdc.mint(borrower, value);
        usdc.approve(address(plan), value);
        try plan.repay(value) {
            repaid++;
        } catch {}
    }

    function fundBorrower(uint256 amount) external {
        usdc.mint(borrower, bound(amount, 1, 500e6));
    }

    /// @dev The borrower spending their balance elsewhere. On Arc that balance also pays
    ///      for gas, so it is routine rather than exotic.
    function drainBorrower() external {
        usdc.burnAll(borrower);
    }

    function warp(uint256 seconds_) external {
        vm.warp(vm.getBlockTimestamp() + bound(seconds_, 1 hours, 45 days));
    }
}

/// @title SweeperInvariantsTest
/// @notice `check_sweeperNeverHoldsValue`, bound to the real `PayrollSweeper` under a
///         handler that is actually able to sweep.
contract SweeperInvariantsTest is PlanFixture, FxInvariants {
    PayrollSweeper internal sweeper;
    PayrollSweepHandler internal handler;

    function setUp() public {
        _deployStack();
        vm.warp(1_800_000_000);
        sweeper = new PayrollSweeper(address(factory));
        _originateDefault();
        _fundBorrower(400e6);

        vm.prank(borrower);
        sweeper.optIn(planId);

        sweptToken = IERC20(address(usdc));
        sweepContract = address(sweeper);

        handler = new PayrollSweepHandler(plan, usdc, sweeper, borrower, borrowerKey, planId);
        targetContract(address(handler));
    }

    /// @notice The handler can drive the system it is supposed to fuzz.
    ///
    /// @dev Every handler action swallows its own revert, which is what stops a consumed
    ///      prank leaking into the next call and is also how a campaign becomes thousands
    ///      of no-ops that report green. If the sweep counter never moves, the invariant
    ///      below is asserting that an untouched contract holds no balance — true, and
    ///      about nothing. So the handler is exercised once by hand and each counter is
    ///      required to move.
    function test_theHandlerDrivesTheSystem() public {
        handler.fundBorrower(400e6);
        handler.sweepAt(1, 20e6);
        assertEq(handler.swept(), 1, "the handler cannot sweep");

        handler.collect(0);
        assertEq(handler.collected(), 1, "the handler cannot collect");

        handler.repay(10e6);
        assertEq(handler.repaid(), 1, "the handler cannot reach the push rail");

        handler.optOut();
        assertEq(handler.optedOut(), 1, "the handler cannot withdraw consent");
        handler.optIn();

        handler.warp(10 days);
        handler.drainBorrower();
    }

    function invariant_sweeperNeverHoldsValue() public view {
        check_sweeperNeverHoldsValue();
    }
}
