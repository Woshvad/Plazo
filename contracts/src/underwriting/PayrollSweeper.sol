// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {InstallmentPlan} from "../InstallmentPlan.sol";
import {PlanFactory} from "../PlanFactory.sol";
import {IERC3009} from "../interfaces/IERC3009.sol";
import {IInstallmentPlan} from "../interfaces/IInstallmentPlan.sol";

/// @title PayrollSweeper
/// @notice UW-05. Salary-source deduction built as a **sweeper, not a splitter**: the
///         borrower's authorised value is received and applied to their plan in one
///         transaction, and this contract holds nothing on either side of it.
///
/// @dev **The requirement's own wording is the trap.** "The installment splits from
///      inbound payroll before it reaches spendable balance" describes a contract that
///      stands between an employer and a borrower and takes custody of wages. Plazo's
///      stated core value is that a borrower signs once and the money moves on schedule
///      *without anyone ever holding their funds*, and C3 makes non-custody a
///      construction constraint rather than a preference. A contract that holds payroll
///      — even for a block, even with the best intentions about giving it back — is a
///      deposit-taking contract, and it is exactly the thing this protocol exists not to
///      be. So the deduction is not a split of an inbound flow. It is a second,
///      **opt-in** authorization the borrower signs against their own balance, payable
///      to this contract, which this contract may only ever exercise by handing the
///      proceeds straight to the plan.
///
///      Three properties make the non-custody claim structural rather than aspirational:
///
///      1. `receiveWithAuthorization` and `InstallmentPlan.repay` happen in one
///         transaction, so there is no boundary across which a balance could be held.
///      2. Whatever `repay` hands back — it returns any over-payment to `msg.sender`,
///         which is this contract, and that money is the borrower's — is forwarded to
///         the borrower before the call returns. Not to the caller, not to a recipient
///         anyone can name.
///      3. The transaction reverts with `SweeperRetainedValue` if this contract's
///         balance is anything other than zero when it finishes. A structural claim
///         deserves an on-chain check and not only a test, and
///         `check_sweeperNeverHoldsValue` then asserts the same thing across every
///         handler sequence the invariant fuzzer can build.
///
///      **No second signature slot on the plan, because that is a vintage bump.**
///      `InstallmentPlan._signature[i]` is one mapping and the implementation address is
///      in the `planId` preimage (DEC-05), so widening it would move every `planId`,
///      migrate every outstanding strip and re-open the formal-verification gate. This
///      contract is external to the plan, signs nothing into it, and changes no signed
///      term. Opting in and opting out are both invisible to the strip.
///
///      **What opting in buys is a limit, not a rate (E-09).** Pay-in-4 is 0%-on-time;
///      there is no interest rate on this product line to discount, so "materially better
///      pricing" for a payroll-deducted borrower can only be expressed as capacity. The
///      lever is `TIER1_PAYROLL_BONUS_BPS` — a higher limit multiple and preferential
///      Tier-1 headroom — applied by `TieredUnderwriter`, which reads `isOptedIn` through
///      the five-argument `capFor` of `IUnderwritingPartnerV2`. **The interest-rate
///      reading of that benefit is unavailable here and stating so is the honest form of
///      it**; it becomes available in Phase 8, when Flex ships a rate there is something
///      to move. This contract reads no parameter and prices nothing.
///
///      **The risk, written down rather than discovered.** A sweep authorization is a
///      live, immediately-exercisable claim on the borrower's balance for the whole term
///      — that is what makes the mechanism work at all, since payroll lands when it lands
///      and a keeper has to be able to act on it within the same minute. The opt-out is
///      `cancelAuthorization` on the token, and it is offered rather than merely
///      tolerated. `optOut` here stops future sweeps; cancelling the authorization stops
///      the outstanding one. Which is why the nonce domain below is load-bearing.
contract PayrollSweeper is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The domain tag that separates a sweep authorization from a scheduled check.
    bytes32 public constant SWEEP_NONCE_DOMAIN = keccak256("PLAZO.PAYROLL_SWEEP.V1");

    /// @notice The factory whose CREATE2 addresses this sweeper will accept.
    /// @dev See `sweep`. One factory is one plan vintage (DEC-05), so a sweeper is
    ///      deployed alongside the vintage it serves.
    PlanFactory public immutable factory;

    /// @dev Consent, keyed on the borrower's own address. Never on an operator's word.
    mapping(bytes32 planId => mapping(address borrower => bool)) private _optedIn;

    event SweepOptedIn(bytes32 indexed planId, address indexed borrower);
    event SweepOptedOut(bytes32 indexed planId, address indexed borrower);
    event Swept(
        bytes32 indexed planId,
        uint256 indexed index,
        address indexed borrower,
        uint256 value,
        uint256 residue
    );

    error NotOptedIn(bytes32 planId, address borrower);
    error PlanNotCollectible(uint8 state);
    error SweeperRetainedValue(uint256 amount);
    error NothingToSweep();
    error PlanNotBound(bytes32 planId, address plan);

    constructor(address factory_) {
        factory = PlanFactory(factory_);
    }

    // ─── The nonce domain ────────────────────────────────────────────────────

    /// @notice The EIP-3009 nonce a sweep authorization for `index` must carry.
    ///
    /// @dev **This can never equal `PlanId.checkNonce(planId, index)`, and the reason is
    ///      structural rather than probabilistic.** `checkNonce` hashes a 64-byte packed
    ///      preimage that is exactly `planId` followed by `index` and carries no tag.
    ///      This hashes a 96-byte standard-encoded preimage whose *first* word is
    ///      `SWEEP_NONCE_DOMAIN`. The two preimages differ in length and in content, so
    ///      no `(planId, index)` pair can produce the same nonce from both — and
    ///      `testFuzz_sweepNonceNeverCollidesWithCheckNonce` asserts it over a fuzzed
    ///      range rather than at one hand-picked point, because the claim is about all
    ///      preimages.
    ///
    ///      **Why a shared domain would be a defect and not an economy.** CURE-05 makes
    ///      `cancelAuthorization` on a *scheduled* check, while the obligation stands, an
    ///      anticipatory default — `InstallmentPlan.noteCancellation` reads
    ///      `authorizationState` for exactly that nonce, marks the installment `Missed`,
    ///      accrues the late fee and transitions the plan to `Delinquent`. Cancelling a
    ///      *sweep* authorization is the opposite: it is the borrower exercising the
    ///      opt-out this feature is obliged to offer. Share the nonce and no observer —
    ///      not the plan, not the indexer, not a lender reading the loss data — can tell
    ///      the two apart, and the system manufactures defaults out of opt-outs. The
    ///      separation is what makes withdrawing consent legible instead of punitive.
    function sweepNonce(bytes32 planId, uint256 index) public pure returns (bytes32) {
        return keccak256(abi.encode(SWEEP_NONCE_DOMAIN, planId, index));
    }

    // ─── The opt-in registry ─────────────────────────────────────────────────

    /// @notice Consent to salary-source deduction on `planId`.
    /// @dev Keyed on `msg.sender` and on nothing else. There is deliberately no
    ///      operator-side enrolment: an operator who could opt a borrower in would be an
    ///      operator who could establish a standing claim on someone else's balance, and
    ///      the fact that exercising that claim still needs a signature is not a reason
    ///      to make the consent record forgeable.
    function optIn(bytes32 planId) external {
        _optedIn[planId][msg.sender] = true;
        emit SweepOptedIn(planId, msg.sender);
    }

    /// @notice Withdraw that consent.
    /// @dev Stops future sweeps. It does not reach an authorization that is already
    ///      signed and outstanding — only `cancelAuthorization` on the token does that,
    ///      and doing so is an opt-out rather than a default precisely because
    ///      `sweepNonce` puts it in its own domain.
    function optOut(bytes32 planId) external {
        _optedIn[planId][msg.sender] = false;
        emit SweepOptedOut(planId, msg.sender);
    }

    /// @notice Whether `borrower` has consented to deduction on `planId`.
    ///
    /// @dev The on-chain fact the scorer reads. `TieredUnderwriter` reaches it in plan
    ///      07-07 through `IUnderwritingPartnerV2.capFor`, whose five-argument form
    ///      carries `borrower` and `planId` for exactly this reason — the three-argument
    ///      predecessor could not see a wallet and so could not see this.
    ///
    ///      **What it is worth is a limit, never a rate.** `TIER1_PAYROLL_BONUS_BPS`
    ///      raises the multiple; there is no rate on a 0%-on-time product to discount
    ///      (E-09). This function reports a fact and applies no benefit: the parameter is
    ///      read by the underwriter, not here.
    function isOptedIn(bytes32 planId, address borrower) public view returns (bool) {
        return _optedIn[planId][borrower];
    }

    // ─── The sweep ───────────────────────────────────────────────────────────

    /// @notice Receive an opted-in borrower's authorised value and apply it to their
    ///         plan, in one transaction, keeping none of it.
    ///
    /// @dev **Permissionless, and for the same reason `collect` is.** A repayment path
    ///      that depends on an operator being alive is a repayment path that fails when
    ///      it is needed; GOV-08's standard is that the loop still closes with every
    ///      operator role at the zero address. There is no role in this contract to hold.
    ///      Nor is there a fee, a rake or a caller-side payment of any kind — a sweeper
    ///      that earned something would be a sweeper with a reason to retain value, which
    ///      is the one thing it must never have.
    ///
    ///      What makes an unauthenticated entry point safe here is that the caller
    ///      chooses almost nothing:
    ///
    ///      - **The nonce is derived, not supplied.** `sweepNonce(planId, index)` is
    ///        computed from the plan's own id, so a caller cannot hand this function a
    ///        scheduled check's nonce and consume a strip authorization through it.
    ///      - **The payee is enforced by the token.** `receiveWithAuthorization` requires
    ///        `to == msg.sender`, verified live against Arc USDC with the revert
    ///        `FiatTokenV2: caller must be the payee`. Nobody but this contract can
    ///        exercise a sweep authorization, and this contract's only destination is the
    ///        plan and then the borrower.
    ///      - **The plan is proved genuine before a single unit moves.** `plan` is a
    ///        caller-supplied address and every other input is read off it, so without
    ///        this check a stranger could deploy a contract that reports a real
    ///        borrower's `planId`, `borrower` and `token`, present a signature the
    ///        borrower legitimately produced, and have the value approved to a `repay`
    ///        that simply kept it. `factory.predictAddress(planId)` is the CREATE2
    ///        address the borrower's own strip was signed against, so requiring the two
    ///        to agree binds the money to the deal the signature commits to.
    ///
    ///      **The value is not the installment amount and does not have to be.** As far
    ///      as `InstallmentPlan` is concerned a sweep is a prepayment: `_account` applies
    ///      it principal-first and `_suppressCoveredTail` retires whatever it covers.
    ///      Anything above `payoffAmount` comes back as a rebate — to `msg.sender`, which
    ///      is this contract — and is forwarded to the borrower below.
    function sweep(
        address plan,
        uint256 index,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata signature
    ) external nonReentrant {
        if (value == 0) revert NothingToSweep();

        bytes32 id = IInstallmentPlan(plan).planId();
        if (factory.predictAddress(id) != plan) revert PlanNotBound(id, plan);

        address borrower = InstallmentPlan(plan).borrower();
        address token = InstallmentPlan(plan).token();

        IInstallmentPlan.PlanState state = IInstallmentPlan(plan).state();
        if (
            state == IInstallmentPlan.PlanState.Repaid || state == IInstallmentPlan.PlanState.Cancelled
                || state == IInstallmentPlan.PlanState.Refunded
        ) {
            revert PlanNotCollectible(uint8(state));
        }

        if (!isOptedIn(id, borrower)) revert NotOptedIn(id, borrower);

        IERC3009(token)
            .receiveWithAuthorization(
                borrower, address(this), value, validAfter, validBefore, sweepNonce(id, index), signature
            );

        IERC20(token).forceApprove(plan, value);
        IInstallmentPlan(plan).repay(value);
        IERC20(token).forceApprove(plan, 0);

        // Everything left is the borrower's, whatever route it took to get here.
        uint256 residue = IERC20(token).balanceOf(address(this));
        if (residue > 0) IERC20(token).safeTransfer(borrower, residue);

        uint256 retained = IERC20(token).balanceOf(address(this));
        if (retained != 0) revert SweeperRetainedValue(retained);

        emit Swept(id, index, borrower, value, residue);
    }
}
