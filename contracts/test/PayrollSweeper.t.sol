// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PlanFixture} from "./helpers/PlanFixture.sol";
import {PayrollSweeper} from "../src/underwriting/PayrollSweeper.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {PlanId} from "../src/libraries/PlanId.sol";

/// @title PayrollSweeperTest
/// @notice UW-05's three load-bearing claims, each asserted rather than assumed: the
///         sweeper takes no custody, its nonce cannot be mistaken for a scheduled
///         check's, and cancelling a sweep is an opt-out rather than a default.
///
/// @dev Every clock read is `vm.getBlockTimestamp()`. `via_ir` is on and the IR
///      optimizer hoists `block.timestamp` past `vm.warp`, so a due-date test written
///      the obvious way silently stops testing (DEC-30, finding 14). `check-test-clock`
///      fails the build otherwise.
contract PayrollSweeperTest is PlanFixture {
    PayrollSweeper internal sweeper;

    /// @dev The installment a payroll deposit would land against: not yet due, so a
    ///      sweep is early money rather than a late collection. Index 0 is due the
    ///      moment the plan opens and cannot carry a `validBefore` in the future.
    uint256 internal constant INDEX = 1;

    address internal outsider = address(0xF00D);

    function setUp() public {
        _deployStack();
        vm.warp(1_800_000_000);
        sweeper = new PayrollSweeper(address(factory));
        _originateDefault();
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev The extra authorization an opted-in borrower signs: payee is the sweeper,
    ///      the nonce is the sweeper's own domain, and nothing about the plan's strip
    ///      changes. Built here rather than in `PlanFixture` because it is not part of
    ///      a strip and must not look like one.
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

    /// @dev The cancellation a borrower submits to the token to withdraw a sweep
    ///      authorization. Distinct from `PlanFixture._signCancellation`, which cancels
    ///      a scheduled check — the whole point of this file is that the two are
    ///      different acts with different consequences.
    function _signSweepCancellation(uint256 index) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(usdc.CANCEL_AUTHORIZATION_TYPEHASH(), borrower, sweeper.sweepNonce(planId, index))
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _optIn() internal {
        vm.prank(borrower);
        sweeper.optIn(planId);
    }

    // Every revert test below stages its signature into a local *before* arming
    // `vm.expectRevert`. `_signSweep` reads the token's typehash, the token's domain
    // separator and the sweeper's nonce, so inlining it into the call's arguments
    // attaches the expectation to the first of those reads — which does not revert, and
    // the test then fails with "next call did not revert as expected" while the contract
    // is behaving exactly as specified. `PlanFixture._request` carries the same warning
    // for the same reason; this is that hazard, met again.

    function _assertNoDelinquencyLogged(Vm.Log[] memory logs) internal pure {
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(
                logs[i].topics[0] != IInstallmentPlan.PlanDelinquent.selector,
                "withdrawing consent to payroll deduction accrued a late fee and marked the plan delinquent"
            );
            assertTrue(
                logs[i].topics[0] != IInstallmentPlan.PlanChargedOff.selector,
                "withdrawing consent to payroll deduction charged the plan off"
            );
        }
    }

    // ─── C3: the sweeper is not a custodian ──────────────────────────────────

    /// @notice The sweeper's balance is zero on both sides of every sweep, and residue
    ///         reaches the borrower rather than the caller.
    ///
    /// @dev The claim the whole design turns on. "Borrower funds stay in the borrower's
    ///      wallet until each due date" is a project constraint, not a preference, and a
    ///      payroll feature is the one place in this phase where an implementation could
    ///      quietly break it — a contract that held wages for one block would still look
    ///      like it worked. The intra-transaction half cannot be observed from a test at
    ///      all, which is why `sweep` reverts `SweeperRetainedValue` on a non-zero
    ///      closing balance and why `check_sweeperNeverHoldsValue` runs under the fuzzer.
    function test_sweeperHoldsNothing() public {
        _optIn();
        _fundBorrower(200e6);

        assertEq(usdc.balanceOf(address(sweeper)), 0, "the sweeper held value before it was ever called");

        uint256 value = plan.installmentAmount(INDEX);
        uint256 borrowerBefore = usdc.balanceOf(borrower);

        vm.prank(outsider);
        sweeper.sweep(
            address(plan),
            INDEX,
            value,
            0,
            plan.dueDate(INDEX),
            _signSweep(INDEX, value, 0, plan.dueDate(INDEX))
        );

        assertEq(
            usdc.balanceOf(address(sweeper)), 0, "the sweeper retained value after an exact-amount sweep"
        );
        assertEq(
            borrowerBefore - usdc.balanceOf(borrower),
            value,
            "the borrower's balance did not fall by exactly the swept amount"
        );
        assertEq(plan.outstandingPrincipal(), 75e6, "the swept value did not reach the plan");
        assertEq(usdc.balanceOf(outsider), 0, "the caller was paid for sweeping");

        // The overpaying case, which is where a custodian would show itself: `repay`
        // returns the rebate to `msg.sender`, and `msg.sender` is the sweeper.
        uint256 payoff = plan.payoffAmount();
        uint256 over = payoff + 25e6;
        borrowerBefore = usdc.balanceOf(borrower);

        vm.prank(outsider);
        sweeper.sweep(address(plan), 2, over, 0, plan.dueDate(2), _signSweep(2, over, 0, plan.dueDate(2)));

        assertEq(usdc.balanceOf(address(sweeper)), 0, "the sweeper kept the rebate from an overpaying sweep");
        assertEq(usdc.balanceOf(outsider), 0, "the rebate from an overpaying sweep was paid to the caller");
        assertEq(
            borrowerBefore - usdc.balanceOf(borrower),
            payoff,
            "the borrower paid more than their payoff amount; the residue did not come back to them"
        );
        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Repaid), "the plan did not settle");
    }

    // ─── The nonce domain ────────────────────────────────────────────────────

    /// @notice No `(planId, index)` pair produces a sweep nonce equal to a check nonce.
    ///
    /// @dev Fuzzed rather than sampled, because the claim is about every preimage and a
    ///      hand-picked pair is evidence of nothing. The sweep index runs the full
    ///      `uint256` range; the check index is bounded to a real strip's width, and the
    ///      `i == j` case — the only one a naive implementation would ever hit — is
    ///      asserted separately so shrinking cannot hide it.
    function testFuzz_sweepNonceNeverCollidesWithCheckNonce(bytes32 id, uint256 i, uint8 j) public view {
        assertTrue(
            sweeper.sweepNonce(id, i) != PlanId.checkNonce(id, uint256(j)),
            "a sweep nonce collided with a scheduled check's nonce"
        );
        assertTrue(
            sweeper.sweepNonce(id, uint256(j)) != PlanId.checkNonce(id, uint256(j)),
            "a sweep nonce collided with the scheduled check's nonce at the same index"
        );
    }

    // ─── CURE-05: an opt-out is not a default ────────────────────────────────

    /// @notice Cancelling a sweep authorization stops the sweep and touches nothing else.
    ///
    /// @dev **The test the feature turns on.** `InstallmentPlan.noteCancellation` reads
    ///      `authorizationState` for `PlanId.checkNonce(planId, index)` and, when it is
    ///      set while the obligation stands, records an anticipatory default: the
    ///      installment goes `Missed`, the late fee accrues and the plan transitions to
    ///      `Delinquent`. Had the sweep reused that nonce, a borrower withdrawing consent
    ///      to payroll deduction would have manufactured their own delinquency — and any
    ///      passer-by could have crystallised it for a bounty. So the assertion is not
    ///      merely that the plan's state is unchanged: it is that `noteCancellation`
    ///      cannot be made to fire at all.
    function test_sweepCancelIsNotADefault() public {
        _optIn();
        _fundBorrower(200e6);

        uint256 value = plan.installmentAmount(INDEX);
        uint256 validBefore = plan.dueDate(INDEX);
        bytes memory signature = _signSweep(INDEX, value, 0, validBefore);

        IInstallmentPlan.PlanState before = plan.state();

        vm.recordLogs();

        // The opt-out, exercised the only way an outstanding authorization can be.
        vm.prank(borrower);
        usdc.cancelAuthorization(borrower, sweeper.sweepNonce(planId, INDEX), _signSweepCancellation(INDEX));

        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        vm.prank(outsider);
        sweeper.sweep(address(plan), INDEX, value, 0, validBefore, signature);

        assertEq(
            uint256(plan.state()), uint256(before), "opting out of payroll deduction moved the plan's state"
        );

        // The strip is untouched: the scheduled check for the same index is unused, and
        // an observer cannot convert the opt-out into an anticipatory default.
        assertFalse(
            usdc.authorizationState(borrower, PlanId.checkNonce(planId, INDEX)),
            "cancelling the sweep authorization also burned the scheduled check's nonce"
        );
        vm.expectRevert(abi.encodeWithSelector(InstallmentPlan.NotCancelled.selector, INDEX));
        plan.noteCancellation(INDEX);

        _assertNoDelinquencyLogged(vm.getRecordedLogs());

        // And the ordinary rail still works: a keeper collects on the due date exactly
        // as it would for a borrower who never opted in.
        vm.warp(plan.dueDate(INDEX));
        vm.prank(keeper);
        (bool cleared, IInstallmentPlan.BounceReason reason) = plan.collect(INDEX);
        assertTrue(cleared, "the scheduled check stopped being collectible after a sweep was cancelled");
        assertEq(uint256(reason), uint256(IInstallmentPlan.BounceReason.None), "the collection bounced");
    }

    /// @notice The negative control: cancelling the *scheduled* check does all the things
    ///         cancelling a sweep does not.
    ///
    /// @dev Without this, `test_sweepCancelIsNotADefault` would be consistent with a
    ///      system in which no cancellation ever means anything. The two cancellations
    ///      have to produce visibly different outcomes or the domain separation bought
    ///      nothing at all.
    function test_cancellingAScheduledCheckStillBounces() public {
        _optIn();
        _fundBorrower(200e6);

        vm.prank(borrower);
        usdc.cancelAuthorization(borrower, PlanId.checkNonce(planId, INDEX), _signCancellation(INDEX));

        vm.warp(plan.dueDate(INDEX));
        vm.prank(keeper);
        (bool cleared, IInstallmentPlan.BounceReason reason) = plan.collect(INDEX);

        assertFalse(cleared, "a cancelled scheduled check still cleared");
        assertEq(
            uint256(reason),
            uint256(IInstallmentPlan.BounceReason.AuthorizationUsed),
            "a cancelled scheduled check did not bounce as AuthorizationUsed"
        );

        // And it is markable as the anticipatory default it is — the outcome the sweep
        // cancellation is proven above to be incapable of producing.
        vm.prank(outsider);
        plan.noteCancellation(INDEX);
        assertEq(
            uint256(plan.installmentStatus(INDEX)),
            uint256(IInstallmentPlan.InstallmentStatus.Missed),
            "cancelling a scheduled check did not record a missed installment"
        );
        assertEq(
            uint256(plan.state()),
            uint256(IInstallmentPlan.PlanState.Delinquent),
            "cancelling a scheduled check did not make the plan delinquent"
        );
    }

    // ─── Consent ─────────────────────────────────────────────────────────────

    /// @notice A valid signature is not consent. The opt-in is.
    function test_sweepRequiresOptIn() public {
        _fundBorrower(200e6);

        uint256 value = plan.installmentAmount(INDEX);
        uint256 validBefore = plan.dueDate(INDEX);
        bytes memory signature = _signSweep(INDEX, value, 0, validBefore);

        vm.expectRevert(abi.encodeWithSelector(PayrollSweeper.NotOptedIn.selector, planId, borrower));
        vm.prank(outsider);
        sweeper.sweep(address(plan), INDEX, value, 0, validBefore, signature);
    }

    /// @notice A third party calling `optIn` opts only themselves in.
    ///
    /// @dev An operator able to enrol a borrower would be an operator able to establish a
    ///      standing claim on someone else's balance. That the claim would still need a
    ///      signature to exercise is not a reason to let the consent record be written by
    ///      anyone but the borrower.
    function test_optInIsBorrowerOnly() public {
        vm.prank(outsider);
        sweeper.optIn(planId);

        assertTrue(sweeper.isOptedIn(planId, outsider), "the caller did not opt themselves in");
        assertFalse(sweeper.isOptedIn(planId, borrower), "a third party opted the borrower into deduction");

        _fundBorrower(200e6);
        uint256 value = plan.installmentAmount(INDEX);
        uint256 validBefore = plan.dueDate(INDEX);
        bytes memory signature = _signSweep(INDEX, value, 0, validBefore);

        vm.expectRevert(abi.encodeWithSelector(PayrollSweeper.NotOptedIn.selector, planId, borrower));
        vm.prank(outsider);
        sweeper.sweep(address(plan), INDEX, value, 0, validBefore, signature);
    }

    /// @notice And the borrower can withdraw that consent without touching a signature.
    function test_optOutStopsFutureSweeps() public {
        _optIn();
        _fundBorrower(200e6);

        vm.prank(borrower);
        sweeper.optOut(planId);
        assertFalse(sweeper.isOptedIn(planId, borrower), "opting out left the consent record set");

        uint256 value = plan.installmentAmount(INDEX);
        uint256 validBefore = plan.dueDate(INDEX);
        bytes memory signature = _signSweep(INDEX, value, 0, validBefore);

        vm.expectRevert(abi.encodeWithSelector(PayrollSweeper.NotOptedIn.selector, planId, borrower));
        vm.prank(outsider);
        sweeper.sweep(address(plan), INDEX, value, 0, validBefore, signature);

        assertEq(
            uint256(plan.state()),
            uint256(IInstallmentPlan.PlanState.Pending),
            "opting out of payroll deduction moved the plan's state"
        );
    }

    // ─── The sweep is permissionless and unpaid ──────────────────────────────

    /// @notice Anyone may sweep, and doing so pays them nothing.
    ///
    /// @dev GOV-08's standard: a repayment path that needs an operator to be alive is a
    ///      repayment path that fails when it is needed. The other half is that the
    ///      caller earns nothing — a sweeper with a rake is a sweeper with a reason to
    ///      hold value, which is the one property this contract may not have.
    function test_sweepIsPermissionless() public {
        _optIn();
        _fundBorrower(200e6);

        address nobody = address(0xC0FFEE);
        assertEq(usdc.balanceOf(nobody), 0, "the fixture pre-funded the caller");

        uint256 value = plan.installmentAmount(INDEX);
        uint256 validBefore = plan.dueDate(INDEX);

        vm.prank(nobody);
        sweeper.sweep(address(plan), INDEX, value, 0, validBefore, _signSweep(INDEX, value, 0, validBefore));

        assertEq(plan.outstandingPrincipal(), 75e6, "an unroled caller could not sweep");
        assertEq(usdc.balanceOf(nobody), 0, "sweeping paid the caller");
    }

    // ─── Stale authorizations and closed plans ───────────────────────────────

    /// @notice A settled plan refuses the sweep rather than pulling against it.
    function test_sweepAfterRepaidReverts() public {
        _optIn();
        _fundBorrower(200e6);

        vm.startPrank(borrower);
        usdc.approve(address(plan), 100e6);
        plan.repay(100e6);
        vm.stopPrank();
        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Repaid), "the plan did not settle");

        uint256 value = 25e6;
        uint256 validBefore = vm.getBlockTimestamp() + 30 days;
        bytes memory signature = _signSweep(INDEX, value, 0, validBefore);

        vm.expectRevert(
            abi.encodeWithSelector(
                PayrollSweeper.PlanNotCollectible.selector, uint8(IInstallmentPlan.PlanState.Repaid)
            )
        );
        vm.prank(outsider);
        sweeper.sweep(address(plan), INDEX, value, 0, validBefore, signature);

        assertFalse(
            usdc.authorizationState(borrower, sweeper.sweepNonce(planId, INDEX)),
            "a refused sweep still burned the borrower's authorization"
        );
    }

    /// @notice A sweep is a prepayment, and the plan's own accounting retires the tail.
    ///
    /// @dev Two halves, because only stating both is honest. `repay` — which is what a
    ///      sweep becomes — does not call `_suppressCoveredTail`; that path belongs to
    ///      `creditRefund`. A partial prepayment therefore leaves the tail live and
    ///      collectible, and what stops a double charge is `_account` applying against
    ///      the remaining balance rather than against the installment's face value. A
    ///      prepayment that reaches zero outstanding is what retires the schedule, via
    ///      `_resolveOutstanding`. Asserting the composition rather than reimplementing
    ///      it is the point; asserting the wrong mechanism would have been worse than
    ///      asserting nothing.
    function test_sweepPrepaymentSuppressesTheTail() public {
        _optIn();
        _fundBorrower(200e6);

        uint256 prepayment = 40e6;
        uint256 validBefore = plan.dueDate(3);

        vm.prank(outsider);
        sweeper.sweep(
            address(plan), INDEX, prepayment, 0, validBefore, _signSweep(INDEX, prepayment, 0, validBefore)
        );

        assertEq(plan.outstandingPrincipal(), 60e6, "a partial sweep did not reduce outstanding principal");
        assertEq(
            uint256(plan.installmentStatus(3)),
            uint256(IInstallmentPlan.InstallmentStatus.Pending),
            "a partial prepayment retired a tail installment it had not covered"
        );

        // The rest, and the tail retires with it.
        uint256 payoff = plan.payoffAmount();
        uint256 borrowerBefore = usdc.balanceOf(borrower);

        vm.prank(outsider);
        sweeper.sweep(address(plan), 2, payoff, 0, plan.dueDate(3), _signSweep(2, payoff, 0, plan.dueDate(3)));

        assertEq(
            uint256(plan.installmentStatus(3)),
            uint256(IInstallmentPlan.InstallmentStatus.Cleared),
            "the final installment was not retired by a sweep that covered it"
        );
        assertFalse(
            usdc.authorizationState(borrower, PlanId.checkNonce(planId, 3)),
            "the covered tail check was pulled from the borrower as well as prepaid"
        );

        // And a keeper cranking the retired index cannot pull the borrower again.
        vm.warp(plan.dueDate(3));
        vm.expectRevert(
            abi.encodeWithSelector(
                InstallmentPlan.PlanNotCollectible.selector, IInstallmentPlan.PlanState.Repaid
            )
        );
        vm.prank(keeper);
        plan.collect(3);

        assertEq(
            borrowerBefore - usdc.balanceOf(borrower),
            payoff,
            "the borrower paid more than the payoff amount across the covering sweep"
        );
        assertEq(
            usdc.balanceOf(borrower), 100e6, "the borrower paid something other than the principal in total"
        );
    }

    /// @notice A plan address that is not the CREATE2 address its own id predicts is
    ///         refused before any value moves.
    ///
    /// @dev Every other input to `sweep` is read off a caller-supplied address, so
    ///      without this the permissionless entry point is a theft: a stranger deploys a
    ///      contract reporting a real borrower's `planId`, `borrower` and `token`,
    ///      presents a signature the borrower legitimately produced, and has the value
    ///      approved to a `repay` that keeps it. `factory.predictAddress(planId)` is the
    ///      address the borrower's own strip was signed against, which is what binds the
    ///      money to the deal the signature commits to (§3.6).
    function test_sweepRefusesAPlanTheFactoryDidNotDeploy() public {
        _optIn();
        _fundBorrower(200e6);

        ThievingPlan fake = new ThievingPlan(planId, borrower, address(usdc), outsider);

        uint256 value = plan.installmentAmount(INDEX);
        uint256 validBefore = plan.dueDate(INDEX);
        uint256 borrowerBefore = usdc.balanceOf(borrower);
        bytes memory signature = _signSweep(INDEX, value, 0, validBefore);

        vm.expectRevert(abi.encodeWithSelector(PayrollSweeper.PlanNotBound.selector, planId, address(fake)));
        vm.prank(outsider);
        sweeper.sweep(address(fake), INDEX, value, 0, validBefore, signature);

        assertEq(usdc.balanceOf(borrower), borrowerBefore, "an impostor plan moved the borrower's money");
        assertEq(usdc.balanceOf(outsider), 0, "an impostor plan's beneficiary was paid");
        assertFalse(
            usdc.authorizationState(borrower, sweeper.sweepNonce(planId, INDEX)),
            "an impostor plan burned the borrower's sweep authorization"
        );
    }

    /// @notice A zero-value sweep is refused rather than approved and repaid.
    function test_sweepOfNothingReverts() public {
        _optIn();
        uint256 validBefore = plan.dueDate(INDEX);

        vm.expectRevert(PayrollSweeper.NothingToSweep.selector);
        vm.prank(outsider);
        sweeper.sweep(address(plan), INDEX, 0, 0, validBefore, hex"");
    }
}

/// @notice A plan-shaped impostor whose `repay` keeps the money.
///
/// @dev Deliberately faithful to the four members `sweep` reads, because a double that
///      failed on shape would prove only that the sweeper reverts on malformed input.
///      What it must prove is that a *well-formed* impostor is refused.
contract ThievingPlan {
    bytes32 public immutable id;
    address public immutable borrower;
    address public immutable token;
    address public immutable thief;

    constructor(bytes32 id_, address borrower_, address token_, address thief_) {
        id = id_;
        borrower = borrower_;
        token = token_;
        thief = thief_;
    }

    function planId() external view returns (bytes32) {
        return id;
    }

    /// @dev `Active`. Anything terminal would be refused for the wrong reason.
    function state() external pure returns (uint8) {
        return uint8(IInstallmentPlan.PlanState.Active);
    }

    function repay(uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, thief, amount);
    }
}
