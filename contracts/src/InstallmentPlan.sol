// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {IInstallmentPlan} from "./interfaces/IInstallmentPlan.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {IFXRouter} from "./interfaces/IFXRouter.sol";
import {PlanId} from "./libraries/PlanId.sol";
import {PlanParams} from "./libraries/PlanParams.sol";
import {PlanAcceptance} from "./libraries/PlanAcceptance.sol";
import {TermsDetail} from "./libraries/TermsDetail.sol";

/// @title InstallmentPlan
/// @notice One borrower's dated authorization strip, collected permissionlessly.
///
/// @dev This is the contract the whole protocol is downstream of. Everything else —
///      the capital market, the corridors, Passport, the merchant plane — is a
///      claim on what happens here, so the properties below are the ones worth
///      stating plainly:
///
///      **The borrower's money never moves early and never moves elsewhere.** Funds
///      stay in the borrower's own wallet until each due date, and the only thing
///      that moves them is an EIP-3009 authorization the borrower signed, payable
///      to this address, dated to that installment, and single-use by nonce. There
///      is no custody, no allowance to a spender who could drain the balance, and
///      no administrative path that moves value anywhere except back to the
///      borrower or forward along the disclosed waterfall.
///
///      **A failed pull is recorded, not reverted.** A revert emits nothing,
///      changes nothing and pays nobody, which leaves the delinquency signal
///      uncreated — and grace transitions, Passport marks, NAV provisioning, the
///      subordination gate and the first-payment-default kill switch all read that
///      signal. `collect()` therefore catches, types and emits the failure, and a
///      separately bountied `markMissed()` exists because nobody profits from
///      cranking a collection that cannot succeed.
///
///      **The logic cannot change after the borrower signs.** This is deployed as a
///      minimal proxy whose implementation address is inside the `planId` preimage,
///      so a new vintage produces different plan ids, different nonces and a
///      different payee address. There is no upgrade path from here and there is
///      not meant to be one: a signature over a digest is only a commitment to a
///      deal if the code that interprets it is fixed.
///
///      **The strip lives onchain.** Storing four signatures costs a few thousandths
///      of a dollar on Arc and it is what makes the keeper market real: a keeper
///      needs the network and nothing else. If signatures lived in an operator's
///      database, "permissionless collection" would mean "permissioned on the
///      operator's API", and the claim that the operator is non-essential would be
///      false in the one place it matters.
contract InstallmentPlan is IInstallmentPlan {
    using SafeERC20 for IERC20;
    using PlanAcceptance for PlanAcceptance.Acceptance;
    using TermsDetail for TermsDetail.Detail;

    // ─── Identity and configuration, written once ────────────────────────────

    bytes32 private _planId;
    address public factory;
    address public token;
    address public borrower;
    address public merchant;
    address public settlementRecipient;
    address public fxRouter;
    bytes32 public jurisdiction;
    TermsDetail.SignerClass public signerClass;

    uint256 private _principal;
    uint256 private _installmentCount;
    /// @notice Due date of installment 0. The down payment; no jitter.
    uint256 public firstDueDate;
    uint256 public interval;
    /// @notice Deterministic ±12h offset applied to every installment after the first.
    int256 public scheduleJitter;

    uint256 private _firstInstallment;
    uint256 private _laterInstallment;

    /// @notice Late fee, already reduced to the jurisdiction's ceiling.
    /// @dev Resolved at initialisation and copied into the plan. A registry row that
    ///      could move afterwards would let governance re-price a plan the borrower
    ///      has already signed.
    uint256 public lateFee;
    uint256 public statementCadence;
    uint256 public withdrawalWindow;

    // ─── The strip ───────────────────────────────────────────────────────────

    mapping(uint256 index => bytes signature) private _signature;

    // ─── Accounting ──────────────────────────────────────────────────────────

    PlanState private _state;
    uint256 private _outstandingPrincipal;
    uint256 private _totalCollected;
    uint256 private _feesOutstanding;
    uint256 private _feesPaid;
    uint256 private _refundCredit;

    mapping(uint256 index => InstallmentStatus) private _status;

    /// @notice USDC held to pay for marks the borrower will never fund.
    uint256 public markEscrow;

    /// @notice Seconds the grace and delinquency clocks have been suspended for.
    uint256 public haltOffset;
    uint256 public haltStartedAt;

    /// @notice When the outstanding strip was last confirmed to still validate.
    uint256 public revalidatedAt;

    bool private _initialized;
    /// @notice Re-entrancy latch. Not OZ's, because a clone cannot use a constructor
    ///         and the guard has to survive `initialize` being the first call.
    uint256 private _entered;

    // ─── Events beyond the frozen schema ─────────────────────────────────────
    //
    // The event schema in `packages/events` is frozen and hash-committed; the three
    // below are operational rather than part of the indexed API, and are declared
    // here rather than added to it. Anything a surface or an LP report reads goes
    // through the schema and a version bump.

    event PlanInitialized(
        bytes32 indexed planId, address indexed implementationOwner, uint256 installmentCount
    );
    event BountyPaid(bytes32 indexed planId, uint256 indexed index, address keeper, uint256 amount);
    event Revalidated(bytes32 indexed planId, bool allValid, uint256 checkedAt);
    event ClocksResumed(bytes32 indexed planId, uint256 suspendedFor);
    event AnticipatoryDefault(bytes32 indexed planId, uint256 indexed index);

    error AlreadyInitialized();
    error Reentrancy();
    error IndexOutOfRange(uint256 index, uint256 installmentCount);
    error InstallmentAlreadyResolved(uint256 index, InstallmentStatus status);
    error NotYetDue(uint256 index, uint256 dueAt);
    error StillInGrace(uint256 index, uint256 graceEndsAt);
    error NotExpired(uint256 index, uint256 validBefore);
    error PlanNotCollectible(PlanState state);
    error PlanNotTerminal(PlanState state);
    error NothingToRepay();
    error AcceptanceInvalid();
    error AcceptanceExpired(uint256 validUntil);
    error TermsHashMismatch(bytes32 expected, bytes32 computed);
    error PlanIdMismatch(bytes32 expected, bytes32 computed);
    error StripLengthMismatch(uint256 expected, uint256 provided);
    error IntervalTooShort(uint256 interval, uint256 minimum);
    error TicketBelowMinimum(uint256 principal, uint256 minimum);
    error RouterCannotPrice(address token);
    error EscrowUnderfunded(uint256 held, uint256 required);
    error NotHalted();
    error StillHalted();
    error TokenPaused();
    error NotCancelled(uint256 index);
    error RevalidationTooSoon(uint256 nextAllowedAt);
    error ChargeOffTooEarly(uint256 eligibleAt);
    error OnlyMerchant(address caller);

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Initialisation
    // ─────────────────────────────────────────────────────────────────────────

    struct InitParams {
        PlanId.PlanTerms terms;
        TermsDetail.Detail detail;
        PlanAcceptance.Acceptance acceptance;
        bytes acceptanceSignature;
        bytes[] strip;
        uint256 lateFeeCapBps;
        uint256 lateFeeCapAbsolute;
        uint256 statementCadence;
        uint256 withdrawalWindow;
    }

    /// @notice Bind the clone to a signed plan. Callable once, by the factory.
    ///
    /// @dev Everything here is a check rather than a configuration. The factory
    ///      supplies terms, the disclosed detail, the borrower's acceptance and the
    ///      strip; this function recomputes `planId` from the terms, recomputes
    ///      `termsHash` from the detail, and verifies the acceptance signature
    ///      against the plan's own address. If any of the three disagree the plan
    ///      does not exist. A plan that trusted its factory to have checked would
    ///      be a plan whose disclosed terms are an operator's assertion.
    function initialize(InitParams calldata params) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        factory = msg.sender;

        PlanId.PlanTerms calldata terms = params.terms;
        PlanId.validate(terms);

        bytes32 id = PlanId.derive(terms);

        // The disclosed detail must be the detail the borrower's signature commits
        // to. Everything that can move value — jurisdiction, settlement recipient,
        // FX router, the fee schedule — is inside this hash precisely so it cannot
        // be chosen after signing.
        bytes32 computedTerms = params.detail.hash();
        if (computedTerms != terms.termsHash) {
            revert TermsHashMismatch(terms.termsHash, computedTerms);
        }

        if (terms.principal < PlanParams.MIN_TICKET) {
            revert TicketBelowMinimum(terms.principal, PlanParams.MIN_TICKET);
        }
        // Jitter shifts every installment after the first. An interval shorter than
        // the jitter's half-width could push installment 1 back past installment 0
        // and make "past due" ambiguous for every downstream decision.
        if (terms.interval <= PlanParams.JITTER_HALF_WIDTH) {
            revert IntervalTooShort(terms.interval, PlanParams.JITTER_HALF_WIDTH + 1);
        }
        // `validAfter` sits one second before the due date, so a schedule anchored
        // at the epoch would underflow. It would also be a plan whose down payment
        // fell due in 1970.
        if (terms.firstDueDate == 0) revert NotYetDue(0, 0);
        if (params.strip.length != terms.installmentCount) {
            revert StripLengthMismatch(terms.installmentCount, params.strip.length);
        }

        _planId = id;
        token = terms.token;
        borrower = terms.borrower;
        merchant = terms.merchant;
        _principal = terms.principal;
        _installmentCount = terms.installmentCount;
        firstDueDate = terms.firstDueDate;
        interval = terms.interval;
        scheduleJitter = PlanParams.jitter(id);

        jurisdiction = params.detail.jurisdiction;
        signerClass = params.detail.signerClass;
        settlementRecipient = params.detail.settlementRecipient;
        fxRouter = params.detail.fxRouter;
        statementCadence = params.statementCadence;
        withdrawalWindow = params.withdrawalWindow;

        // The router must be able to price this plan's currency before the plan
        // exists. Discovering at the first collection that the waterfall has no
        // rate is discovering it with the borrower's money already pulled.
        if (!IFXRouter(params.detail.fxRouter).isSupported(terms.token)) {
            revert RouterCannotPrice(terms.token);
        }

        // The disclosed fee, reduced to the jurisdiction's ceiling. Both bind: the
        // borrower cannot be charged more than they were shown, and neither can be
        // charged more than the law where they live allows.
        uint256 cappedByBps =
            (_installmentAmountAt(_installmentCount - 1) * params.lateFeeCapBps) / PlanParams.BPS;
        uint256 fee = params.detail.lateFeeFlat;
        if (fee > cappedByBps) fee = cappedByBps;
        if (fee > params.lateFeeCapAbsolute) fee = params.lateFeeCapAbsolute;
        lateFee = fee;

        _verifyAcceptance(id, params.acceptance, params.acceptanceSignature, terms);

        for (uint256 i = 0; i < params.strip.length; ++i) {
            _signature[i] = params.strip[i];
        }

        uint256 required = PlanParams.markEscrowFor(terms.installmentCount);
        uint256 held = IERC20(terms.token).balanceOf(address(this));
        if (held < required) revert EscrowUnderfunded(held, required);
        markEscrow = required;

        _outstandingPrincipal = terms.principal;
        _state = PlanState.Pending;

        emit PlanInitialized(id, terms.implementation, terms.installmentCount);
        emit PlanStateChanged(id, PlanState.Pending, PlanState.Pending);
    }

    function _verifyAcceptance(
        bytes32 id,
        PlanAcceptance.Acceptance calldata acceptance,
        bytes calldata signature,
        PlanId.PlanTerms calldata terms
    ) private view {
        if (acceptance.validUntil < block.timestamp) {
            revert AcceptanceExpired(acceptance.validUntil);
        }

        // Every field is checked against the plan the contract will actually run,
        // not merely present. An acceptance that renders a total the schedule does
        // not produce is a disclosure that was never true.
        bool consistent = acceptance.planId == id && acceptance.borrower == terms.borrower
            && acceptance.merchant == terms.merchant && acceptance.token == terms.token
            && acceptance.principal == terms.principal
            && acceptance.installmentCount == terms.installmentCount
            && acceptance.firstInstallment == _installmentAmountAt(0)
            && acceptance.laterInstallment == _installmentAmountAt(1)
            && acceptance.firstDueDate == _dueDateAt(0)
            && acceptance.finalDueDate == _dueDateAt(terms.installmentCount - 1)
            && acceptance.interval == terms.interval && acceptance.termsHash == terms.termsHash;
        if (!consistent) revert PlanIdMismatch(id, acceptance.planId);

        bytes32 digest = acceptance.digest(block.chainid, address(this));
        if (!SignatureChecker.isValidSignatureNow(terms.borrower, digest, signature)) {
            revert AcceptanceInvalid();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Schedule
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IInstallmentPlan
    function dueDate(uint256 index) public view returns (uint256) {
        _requireIndex(index);
        return _dueDateAt(index);
    }

    /// @dev The jitter applies from installment 1 onward. The down payment is due at
    ///      checkout and there is no wave to spread; what needs breaking up is the
    ///      recurring schedule, where a cohort originated on one afternoon would
    ///      otherwise all come due in the same block and every keeper's pull would
    ///      be a race it usually loses.
    ///
    ///      Uniform across those installments, not per-installment. Jittering each
    ///      one independently would let two adjacent due dates cross, and "past due"
    ///      is the predicate every collection and provisioning decision keys off.
    function _dueDateAt(uint256 index) private view returns (uint256) {
        if (index == 0) return firstDueDate;
        // Both casts are safe: `firstDueDate` and `interval` are bounded at
        // initialisation, `installmentCount` is small, and the jitter is ±12h — the
        // sum cannot approach int256's range, and the result cannot go negative
        // because `interval > JITTER_HALF_WIDTH` is enforced before a plan exists.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 shifted = int256(firstDueDate + index * interval) + scheduleJitter;
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(shifted);
    }

    /// @inheritdoc IInstallmentPlan
    /// @dev Carries the suspension. A USDC pause or a chain halt stops the clock
    ///      rather than running it against a borrower who could not have paid.
    function graceEndsAt(uint256 index) public view returns (uint256) {
        _requireIndex(index);
        return _dueDateAt(index) + PlanParams.GRACE_WINDOW + _suspendedFor();
    }

    /// @notice When the authorization for `index` stops being usable.
    function validBefore(uint256 index) public view returns (uint256) {
        _requireIndex(index);
        return _dueDateAt(index) + PlanParams.AUTHORIZATION_WINDOW;
    }

    /// @notice When the authorization for `index` becomes usable.
    /// @dev One second before the due date, because the token's check is a strict
    ///      `now > validAfter`. Without the offset an installment due at `T` would
    ///      not be collectible until `T + 1`, and the down payment — due at
    ///      checkout — could not be taken in the transaction that originated it.
    function validAfter(uint256 index) public view returns (uint256) {
        _requireIndex(index);
        return _dueDateAt(index) - 1;
    }

    /// @inheritdoc IInstallmentPlan
    /// @dev The division remainder rides on installment 0. It settles at checkout
    ///      rather than surfacing on the final check, and every installment the
    ///      borrower has left to pay is the uniform figure the merchant advertised.
    function installmentAmount(uint256 index) public view returns (uint256) {
        _requireIndex(index);
        return _installmentAmountAt(index);
    }

    function _installmentAmountAt(uint256 index) private view returns (uint256) {
        uint256 base = _principal / _installmentCount;
        if (index == 0) return base + (_principal % _installmentCount);
        return base;
    }

    /// @notice The EIP-3009 nonce for `index`.
    function checkNonce(uint256 index) public view returns (bytes32) {
        _requireIndex(index);
        return PlanId.checkNonce(_planId, index);
    }

    /// @notice The stored authorization for `index`.
    /// @dev Public so a keeper needs nothing but the chain, and so a borrower can
    ///      confirm the bytes held against them are the bytes they signed.
    function stripSignature(uint256 index) external view returns (bytes memory) {
        _requireIndex(index);
        return _signature[index];
    }

    /// @notice Face value of every installment due on or before `at`.
    function scheduledThrough(uint256 at) public view returns (uint256 total) {
        for (uint256 i = 0; i < _installmentCount; ++i) {
            if (_dueDateAt(i) <= at) total += _installmentAmountAt(i);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    function planId() external view returns (bytes32) {
        return _planId;
    }

    function state() external view returns (PlanState) {
        return _state;
    }

    function installmentCount() external view returns (uint256) {
        return _installmentCount;
    }

    function principal() external view returns (uint256) {
        return _principal;
    }

    function outstandingPrincipal() external view returns (uint256) {
        return _outstandingPrincipal;
    }

    function feesOutstanding() external view returns (uint256) {
        return _feesOutstanding;
    }

    function feesPaid() external view returns (uint256) {
        return _feesPaid;
    }

    function totalCollected() external view returns (uint256) {
        return _totalCollected;
    }

    function refundCredit() external view returns (uint256) {
        return _refundCredit;
    }

    function payoffAmount() public view returns (uint256) {
        return _outstandingPrincipal + _feesOutstanding;
    }

    function installmentStatus(uint256 index) external view returns (InstallmentStatus) {
        _requireIndex(index);
        return _status[index];
    }

    function isCleared(uint256 index) external view returns (bool) {
        _requireIndex(index);
        return _status[index] == InstallmentStatus.Cleared;
    }

    /// @inheritdoc IInstallmentPlan
    /// @dev Phase 5's epoch settlement refuses to close while a plan past
    ///      `grace + 1` reads false here. That is what makes the bountied mark
    ///      unavoidable rather than merely available.
    function isMarked(uint256 index) external view returns (bool) {
        _requireIndex(index);
        InstallmentStatus status = _status[index];
        return status == InstallmentStatus.Missed || status == InstallmentStatus.Expired;
    }

    /// @notice Whether the borrower owes nothing that is already due.
    function isCurrent() public view returns (bool) {
        if (_feesOutstanding > 0) return false;
        uint256 retired = _principal - _outstandingPrincipal;
        return retired >= scheduledThrough(block.timestamp);
    }

    /// @notice The bounty `collect(index)` would pay right now.
    /// @dev Public so a keeper can price a crank before sending it, which is the
    ///      difference between a market and a lottery.
    function bountyFor(uint256 index) public view returns (uint256) {
        _requireIndex(index);
        uint256 due = _dueDateAt(index);
        uint256 elapsed = block.timestamp > due ? block.timestamp - due : 0;
        return PlanParams.collectBounty(_installmentAmountAt(index), elapsed, PlanParams.GRACE_WINDOW);
    }

    function _suspendedFor() private view returns (uint256) {
        if (_state == PlanState.HALTED && haltStartedAt != 0) {
            return haltOffset + (block.timestamp - haltStartedAt);
        }
        return haltOffset;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Collection
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IInstallmentPlan
    /// @dev Permissionless, bountied, and it does not revert on a failed pull.
    ///
    ///      The pre-checks below are not an optimisation. `receiveWithAuthorization`
    ///      reverts with a string, and a string is not a signal: a pool cannot
    ///      provision against `"FiatTokenV2: ..."`. Each condition is therefore
    ///      tested before the call so the bounce carries a typed reason — a
    ///      blocklisted borrower is a compliance event, a paused token is an
    ///      infrastructure event, and only insufficient funds is a credit event.
    ///      Collapsing them would make the loss data unreadable and the kill switch
    ///      unarmable.
    function collect(uint256 index) public nonReentrant returns (bool cleared, BounceReason reason) {
        return _collect(index);
    }

    /// @notice Clear a whole due-date wave in one transaction.
    /// @dev COLL-05. Batching must be a convenience, never a requirement: each
    ///      index pays its own bounty at its own point on the ramp, so the sum of
    ///      a batch equals the sum of the same cranks sent singly. A batch discount
    ///      would quietly make single collection unprofitable and hand the keeper
    ///      market to whoever can afford to aggregate.
    function collectBatch(uint256[] calldata indices)
        external
        nonReentrant
        returns (bool[] memory clearedOut, BounceReason[] memory reasons)
    {
        clearedOut = new bool[](indices.length);
        reasons = new BounceReason[](indices.length);
        for (uint256 i = 0; i < indices.length; ++i) {
            (clearedOut[i], reasons[i]) = _collect(indices[i]);
        }
    }

    function _collect(uint256 index) private returns (bool, BounceReason) {
        _requireIndex(index);
        _requireCollectible();

        InstallmentStatus status = _status[index];
        if (status != InstallmentStatus.Pending && status != InstallmentStatus.Bounced) {
            revert InstallmentAlreadyResolved(index, status);
        }
        if (block.timestamp < _dueDateAt(index)) revert NotYetDue(index, _dueDateAt(index));

        BounceReason reason = _diagnose(index);
        if (reason != BounceReason.None) {
            if (reason == BounceReason.Halted) _enterHalt();
            if (reason == BounceReason.Blocked) _transition(PlanState.Blocked);
            return _bounce(index, reason);
        }

        if (!_pull(index)) {
            // Everything discriminable has already been discriminated. Anything
            // left is the token declining to move the money.
            return _bounce(index, BounceReason.InsufficientFunds);
        }

        _settleCleared(index);
        return (true, BounceReason.None);
    }

    /// @dev Every reason a pull would fail, tested before the pull so the bounce can
    ///      carry a type. `receiveWithAuthorization` reverts with a string, and a
    ///      string is not a signal — a pool cannot provision against
    ///      `"FiatTokenV2: ..."`.
    function _diagnose(uint256 index) private view returns (BounceReason) {
        IERC3009 rail = IERC3009(token);

        // Infrastructure before credit. A paused token or a blocklisted borrower is
        // not a missed payment, and recording it as one poisons the loss data the
        // whole book is priced from.
        if (rail.paused()) return BounceReason.Halted;
        if (rail.isBlacklisted(borrower)) return BounceReason.Blocked;

        // The token's window is strict at both ends: `now > validAfter` and
        // `now < validBefore`. At exactly `validBefore` the authorization is already
        // dead, and letting it through would surface as an untyped catch and be
        // filed as a credit event.
        if (block.timestamp >= validBefore(index)) return BounceReason.AuthorizationExpired;

        bytes32 nonce = PlanId.checkNonce(_planId, index);
        // True after a successful pull *or* after the borrower cancelled. The
        // installment is not cleared here, so this is a cancellation.
        if (rail.authorizationState(borrower, nonce)) return BounceReason.AuthorizationUsed;

        uint256 amount = _installmentAmountAt(index);
        if (!_signatureValid(index, amount, nonce)) return BounceReason.SignerInvalid;
        if (rail.balanceOf(borrower) < amount) return BounceReason.InsufficientFunds;

        return BounceReason.None;
    }

    function _pull(uint256 index) private returns (bool) {
        uint256 amount = _installmentAmountAt(index);
        try IERC3009(token)
            .receiveWithAuthorization(
                borrower,
                address(this),
                amount,
                validAfter(index),
                validBefore(index),
                PlanId.checkNonce(_planId, index),
                _signature[index]
            ) {
            return true;
        } catch {
            return false;
        }
    }

    function _settleCleared(uint256 index) private {
        _status[index] = InstallmentStatus.Cleared;

        uint256 amount = _installmentAmountAt(index);
        uint256 bounty =
            PlanParams.collectBounty(amount, block.timestamp - _dueDateAt(index), PlanParams.GRACE_WINDOW);
        (uint256 applied, uint256 rebate) = _account(amount);
        if (bounty > applied) bounty = applied;

        emit CheckCleared(_planId, index, amount, msg.sender);

        // The bounty is a servicing cost carried by the book, not a deduction from
        // the borrower's credit: their debt fell by the full installment. When the
        // borrower cranks their own plan they are `msg.sender`, so curing yourself
        // returns the bounty to you — COLL-09 without a special case.
        if (bounty > 0) {
            IERC20(token).safeTransfer(msg.sender, bounty);
            emit BountyPaid(_planId, index, msg.sender, bounty);
        }
        if (rebate > 0) IERC20(token).safeTransfer(borrower, rebate);
        _forward(applied - bounty);

        _afterInflow(index);
    }

    function _bounce(uint256 index, BounceReason reason) private returns (bool, BounceReason) {
        _status[index] = InstallmentStatus.Bounced;
        emit CheckBounced(_planId, index, reason);

        // A bounce on a token that is paused or a borrower who is blocklisted has
        // already set the state that describes it, and neither is a grace event.
        if (reason != BounceReason.Halted && reason != BounceReason.Blocked && _state != PlanState.Delinquent)
        {
            _transition(PlanState.Grace);
        }
        return (false, reason);
    }

    /// @dev Recomputes the exact digest the token will check, from the token's own
    ///      `DOMAIN_SEPARATOR` and typehash read at runtime. Never hardcoded: the
    ///      separator embeds `chainId` and `verifyingContract`, both of which change
    ///      on mainnet, and a baked-in value would make every outstanding strip fail
    ///      to validate the day the config flips.
    ///
    ///      This is also what lets a bounce distinguish a signer that no longer
    ///      validates from a borrower who is simply short — the two carry opposite
    ///      credit treatments.
    function _signatureValid(uint256 index, uint256 amount, bytes32 nonce) private view returns (bool) {
        IERC3009 rail = IERC3009(token);
        bytes32 structHash = keccak256(
            abi.encode(
                rail.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                borrower,
                address(this),
                amount,
                validAfter(index),
                validBefore(index),
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", rail.DOMAIN_SEPARATOR(), structHash));
        return SignatureChecker.isValidSignatureNow(borrower, digest, _signature[index]);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Marking — the paid negative signal
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IInstallmentPlan
    function markMissed(uint256 index) external nonReentrant {
        _requireIndex(index);
        _requireRailLive();
        InstallmentStatus status = _status[index];
        if (status != InstallmentStatus.Pending && status != InstallmentStatus.Bounced) {
            revert InstallmentAlreadyResolved(index, status);
        }

        uint256 graceEnd = graceEndsAt(index);
        if (block.timestamp <= graceEnd) revert StillInGrace(index, graceEnd);

        _status[index] = InstallmentStatus.Missed;
        emit CheckMissed(_planId, index, msg.sender);

        _accrueLateFee();
        _transition(PlanState.Delinquent);
        _payMarkBounty();
    }

    /// @inheritdoc IInstallmentPlan
    function markExpired(uint256 index) external nonReentrant {
        _requireIndex(index);
        _requireRailLive();
        InstallmentStatus status = _status[index];
        if (status != InstallmentStatus.Pending && status != InstallmentStatus.Bounced) {
            revert InstallmentAlreadyResolved(index, status);
        }

        uint256 expiry = validBefore(index);
        if (block.timestamp < expiry) revert NotExpired(index, expiry);

        _status[index] = InstallmentStatus.Expired;
        emit CheckExpired(_planId, index, msg.sender);

        // The authorization died; the debt did not. An expired check on an unpaid
        // installment is a receivable that can now only be settled by push.
        _accrueLateFee();
        _transition(PlanState.Delinquent);
        _payMarkBounty();
    }

    /// @notice Record that the borrower cancelled an authorization they still owed.
    ///
    /// @dev CURE-05. Cancelling after payoff, refund or cancellation is a borrower
    ///      tidying up their wallet and carries no penalty — the plan is terminal
    ///      and this function refuses to record anything against it. Cancelling
    ///      while the obligation stands is a statement that the remaining checks
    ///      will not be honoured, which is an anticipatory default and is recorded
    ///      as one.
    function noteCancellation(uint256 index) external nonReentrant {
        _requireIndex(index);
        _requireRailLive();
        InstallmentStatus status = _status[index];
        if (status != InstallmentStatus.Pending && status != InstallmentStatus.Bounced) {
            revert InstallmentAlreadyResolved(index, status);
        }
        if (!IERC3009(token).authorizationState(borrower, PlanId.checkNonce(_planId, index))) {
            revert NotCancelled(index);
        }

        if (_isTerminal(_state) || _outstandingPrincipal == 0) {
            // Nothing owed. No penalty, and nothing to record.
            _status[index] = InstallmentStatus.Cleared;
            return;
        }

        _status[index] = InstallmentStatus.Missed;
        emit CheckMissed(_planId, index, msg.sender);
        emit AnticipatoryDefault(_planId, index);
        _accrueLateFee();
        _transition(PlanState.Delinquent);
        _payMarkBounty();
    }

    /// @dev Paid for recording a delinquency. Always available, because the escrow
    ///      reserves `unresolved × MARK_BOUNTY` and both this and the mark it pays
    ///      for reduce that reservation by the same step.
    function _payMarkBounty() private {
        _payFromEscrow(PlanParams.MARK_BOUNTY);
    }

    /// @dev Paid for observing something that might be nothing. Spends only the
    ///      surplus above the reserved mark budget, so a plan whose signer keeps
    ///      changing cannot be revalidated until it can no longer afford to record
    ///      its own default.
    function _payObservationBounty() private {
        uint256 reserved = _reservedForMarks();
        if (markEscrow <= reserved) return;
        uint256 available = markEscrow - reserved;
        _payFromEscrow(available < PlanParams.MARK_BOUNTY ? available : PlanParams.MARK_BOUNTY);
    }

    function _payFromEscrow(uint256 amount) private {
        uint256 bounty = amount > markEscrow ? markEscrow : amount;
        if (bounty == 0) return;
        markEscrow -= bounty;
        IERC20(token).safeTransfer(msg.sender, bounty);
        emit BountyPaid(_planId, type(uint256).max, msg.sender, bounty);
    }

    /// @notice What the escrow is holding back so every remaining mark can be paid.
    function _reservedForMarks() private view returns (uint256 reserved) {
        for (uint256 i = 0; i < _installmentCount; ++i) {
            InstallmentStatus status = _status[i];
            if (status == InstallmentStatus.Pending || status == InstallmentStatus.Bounced) {
                reserved += PlanParams.MARK_BOUNTY;
            }
        }
    }

    /// @notice Whether every installment that could still need marking can be paid for.
    /// @dev The safety property underneath the collection guarantee. The guarantee
    ///      itself — that every overdue installment reaches a recorded outcome — is a
    ///      liveness claim and holds only given a keeper who shows up. What the
    ///      contract can guarantee unconditionally is that showing up always pays.
    function markBudgetIsFunded() external view returns (bool) {
        return markEscrow >= _reservedForMarks();
    }

    function _accrueLateFee() private {
        if (lateFee == 0) return;
        // One late fee per plan, not one per installment. A cascade of flat fees on
        // a $75 ticket is how a small balance becomes uncollectable, and the
        // jurisdiction cap is expressed per plan for the same reason.
        if (_feesOutstanding > 0 || _feesPaid > 0) return;
        _feesOutstanding = lateFee;
        emit PlanDelinquent(_planId, lateFee);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cure, prepayment and refunds
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IInstallmentPlan
    ///
    /// @dev Never pausable, and deliberately without any access control, guard or
    ///      state precondition beyond the plan not already being settled. A
    ///      borrower must be able to cure or prepay at any time — including after
    ///      the strip has expired, when no keeper can help them, and including
    ///      while the protocol is in whatever emergency posture led someone to
    ///      reach for a pause. A collections system that can stop accepting money
    ///      is a collections system that can manufacture a default.
    ///
    ///      No bounty is deducted here at all, so a borrower who cures by push
    ///      keeps the whole servicing fee rather than merely earning it back.
    function repay(uint256 amount) external nonReentrant {
        if (amount == 0) revert NothingToRepay();
        if (_state == PlanState.Repaid || _state == PlanState.Cancelled) {
            revert PlanNotCollectible(_state);
        }

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        (uint256 applied, uint256 rebate) = _account(amount);

        if (rebate > 0) IERC20(token).safeTransfer(msg.sender, rebate);
        _forward(applied);
        _afterInflow(_firstUnresolved());
    }

    /// @notice Apply a merchant refund as a plan-level credit.
    ///
    /// @dev D9. A fixed-value check cannot be reduced — there is no way to turn
    ///      check #3 from $50 into $20 — and requiring the borrower to re-sign a
    ///      shorter strip fails whenever they are offline, which is most of the
    ///      time. So a refund reaches the schedule as a credit that retires
    ///      principal and suppresses the tail checks it covers.
    ///
    ///      **Ordering: principal first, borrower cash second.** The pool fronted
    ///      the merchant the whole amount. If a refund repaid the borrower's
    ///      completed installments first, the pool would still carry a receivable
    ///      against a plan the borrower had no reason to keep paying, and a
    ///      merchant's unilateral action would move a loss onto the book. Retiring
    ///      principal first reduces exactly the exposure the refund is meant to
    ///      reduce — and a fully refunded borrower still gets their paid
    ///      installments back, because a full refund exceeds outstanding principal
    ///      by precisely that amount.
    ///
    ///      Fees already assessed survive. A merchant taking goods back does not
    ///      undo that a payment was late, and `SettledWithFeeOutstanding` exists so
    ///      this never blocks payoff. Waiving a fee is an operator decision, not an
    ///      accounting rule.
    function creditRefund(uint256 amount) external nonReentrant {
        if (msg.sender != merchant) revert OnlyMerchant(msg.sender);
        if (amount == 0) revert NothingToRepay();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 normalized = IFXRouter(fxRouter).normalize(token, amount);

        uint256 applied = normalized > _outstandingPrincipal ? _outstandingPrincipal : normalized;
        _outstandingPrincipal -= applied;
        _refundCredit += applied;
        emit RefundCredited(_planId, applied);

        _suppressCoveredTail();

        uint256 toBorrower = normalized - applied;
        if (toBorrower > 0) IERC20(token).safeTransfer(borrower, toBorrower);
        _forward(applied);

        if (_outstandingPrincipal == 0) {
            _resolveOutstanding(InstallmentStatus.Refunded);
            _transition(_feesOutstanding > 0 ? PlanState.SettledWithFeeOutstanding : PlanState.Refunded);
            _releaseEscrow();
        } else {
            _afterInflow(_firstUnresolved());
        }
    }

    /// @dev Walk the schedule forward, keeping live exactly as many checks as the
    ///      remaining principal needs and retiring the rest. The checks a refund
    ///      suppresses are therefore the ones furthest out — a borrower whose order
    ///      was half refunded keeps paying their next installment on the date they
    ///      expected to, and the schedule shortens from the end rather than becoming
    ///      an unrecognisable set of dates.
    function _suppressCoveredTail() private {
        uint256 remaining = _outstandingPrincipal;
        for (uint256 index = 0; index < _installmentCount; ++index) {
            InstallmentStatus status = _status[index];
            if (status != InstallmentStatus.Pending && status != InstallmentStatus.Bounced) continue;

            uint256 amount = _installmentAmountAt(index);
            if (remaining >= amount) {
                remaining -= amount;
                continue;
            }
            _status[index] = InstallmentStatus.Refunded;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Signer mutation, halts and charge-off
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IInstallmentPlan
    ///
    /// @dev PLAN-10, and the half of D1 that turns a vendor question into a
    ///      protocol mechanism. An EOA's validation logic is its address and cannot
    ///      change, so its strip stays valid by construction. A contract account can
    ///      change its validation logic whenever it likes, so a strip it signed is
    ///      only as good as the last time someone checked. The roadmap made the
    ///      unsecured cap depend on whether a wallet vendor exposes a key-rotation
    ///      webhook; this makes it depend on an onchain fact anyone can establish
    ///      and anyone is paid to establish.
    ///
    ///      Rate-limited to one paid call per freshness window, so the escrow funds
    ///      observation rather than a drain.
    function revalidate() external nonReentrant {
        uint256 nextAllowed = revalidatedAt + PlanParams.REVALIDATION_WINDOW;
        if (revalidatedAt != 0 && block.timestamp < nextAllowed) {
            revert RevalidationTooSoon(nextAllowed);
        }
        revalidatedAt = block.timestamp;

        bool allValid = true;
        for (uint256 i = 0; i < _installmentCount; ++i) {
            InstallmentStatus status = _status[i];
            if (status != InstallmentStatus.Pending && status != InstallmentStatus.Bounced) continue;

            if (!_signatureValid(i, _installmentAmountAt(i), PlanId.checkNonce(_planId, i))) {
                allValid = false;
                _status[i] = InstallmentStatus.Bounced;
                emit CheckBounced(_planId, i, BounceReason.SignerInvalid);
            }
        }

        emit Revalidated(_planId, allValid, block.timestamp);

        // Only a contract signer can go stale, so only a contract signer's
        // revalidation is work worth paying for.
        if (signerClass == TermsDetail.SignerClass.Contract) _payObservationBounty();
    }

    /// @notice Record that the rail is down, and start banking the suspension.
    ///
    /// @dev A pause the plan never observed is a pause whose clock never stopped.
    ///      `collect()` halts automatically when it runs into a paused token, but a
    ///      plan with nothing due that week never calls `collect()` and would sit
    ///      there burning grace against an outage nobody could have paid through.
    ///
    ///      Unpaid, and it has to be: the bounty would be a transfer of the token
    ///      that is paused. The incentive is structural instead — the borrower whose
    ///      grace window is running and the holder of the receivable are both
    ///      motivated to call this, and both can. `resume()` carries the bounty,
    ///      which is also where the transfer becomes possible again.
    ///
    ///      Stated plainly, because it is a real residue: the token exposes that it
    ///      is paused, never when it started. A suspension can only be banked from
    ///      the moment someone tells the plan, so an outage nobody observes for its
    ///      whole duration does consume grace.
    function halt() external nonReentrant {
        if (!IERC3009(token).paused()) revert NotHalted();
        if (_state == PlanState.HALTED) revert StillHalted();
        if (_isTerminal(_state)) revert PlanNotCollectible(_state);
        _enterHalt();
    }

    function _enterHalt() private {
        if (_state == PlanState.HALTED) return;
        haltStartedAt = block.timestamp;
        _transition(PlanState.HALTED);
    }

    /// @dev A default cannot be recorded while the rail is down. Nobody could have
    ///      paid, the bounty could not be transferred if they had, and a mark written
    ///      during an outage provisions NAV and marks a Passport against a borrower
    ///      whose only failing was that USDC was paused.
    function _requireRailLive() private view {
        if (IERC3009(token).paused()) revert TokenPaused();
    }

    /// @notice Restart the grace and delinquency clocks once the token is live again.
    /// @dev CURE-06. Permissionless: the borrower whose clock is suspended has the
    ///      most to lose from it restarting, so leaving this to them would leave
    ///      plans halted forever. The suspended interval is added to every grace
    ///      window on the plan, so a pause postpones delinquency rather than
    ///      manufacturing it.
    function resume() external nonReentrant {
        if (_state != PlanState.HALTED) revert NotHalted();
        if (IERC3009(token).paused()) revert StillHalted();

        uint256 suspended = block.timestamp - haltStartedAt;
        haltOffset += suspended;
        haltStartedAt = 0;
        emit ClocksResumed(_planId, suspended);

        _transition(isCurrent() ? PlanState.Active : PlanState.Grace);

        // The bounty for the whole halt cycle lands here, because this is the first
        // moment the token can move it. Whoever restarts the clock is doing the work
        // that makes the plan collectible again.
        _payObservationBounty();
    }

    /// @notice Charge the plan off once it is 60 days past its oldest unpaid due date.
    /// @dev CURE-04's loss flow is Phase 5's; the transition is here because
    ///      `Defaulted` is an absorbing state in the frozen machine and a state
    ///      nothing can reach is a state nothing was verified about.
    function chargeOff() external nonReentrant {
        _requireRailLive();
        uint256 index = _firstUnresolved();
        if (index == type(uint256).max) revert PlanNotCollectible(_state);

        uint256 eligibleAt = _dueDateAt(index) + PlanParams.CHARGE_OFF_AFTER + _suspendedFor();
        if (block.timestamp <= eligibleAt) revert ChargeOffTooEarly(eligibleAt);

        _transition(PlanState.Defaulted);
        emit PlanChargedOff(_planId, payoffAmount());
        // From the surplus. A charge-off is the last thing that happens to a plan and
        // there is nothing left to reserve for, but taking it from the mark budget
        // would let a caller front-run the marks that establish the default.
        _payObservationBounty();
        _releaseEscrow();
    }

    /// @notice Forward any balance the plan is not holding as escrow.
    /// @dev The plan is not a wallet. Stray value — a mis-sent transfer, dust from a
    ///      rounding path — is forwarded rather than stranded, and it can only go
    ///      where a settlement would have gone. There is no address parameter here
    ///      on purpose.
    function sweep() external nonReentrant {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance <= markEscrow) return;
        _forward(balance - markEscrow);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal accounting
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Currency normalization happens here, before a single unit reaches the
    ///      waterfall. FX-06: a fee assessed against an un-normalized amount is a
    ///      fee assessed at an undefined rate, and in v1 — where the router is the
    ///      identity — the ordering is invisible at runtime and load-bearing in the
    ///      audit. Phase 7 supplies the EURC corridor behind the same call.
    ///
    ///      **Principal before fees.** Fees-first is incumbent servicing practice
    ///      and it is precisely how a $7 fee becomes a permanent delinquency: every
    ///      payment lands on the fee, principal never moves, the account never
    ///      cures. Principal-first means a borrower who keeps paying always
    ///      converges to zero debt, and a fee left over lands in
    ///      `SettledWithFeeOutstanding` — which is the entire reason that state
    ///      exists.
    function _account(uint256 gross) private returns (uint256 applied, uint256 rebate) {
        uint256 normalized = IFXRouter(fxRouter).normalize(token, gross);

        uint256 owed = _outstandingPrincipal + _feesOutstanding;
        applied = normalized > owed ? owed : normalized;
        rebate = normalized - applied;

        uint256 toPrincipal = applied > _outstandingPrincipal ? _outstandingPrincipal : applied;
        _outstandingPrincipal -= toPrincipal;

        uint256 toFees = applied - toPrincipal;
        _feesOutstanding -= toFees;
        _feesPaid += toFees;

        _totalCollected += applied;
    }

    function _forward(uint256 amount) private {
        if (amount == 0) return;
        IERC20(token).safeTransfer(settlementRecipient, amount);
    }

    function _afterInflow(uint256 index) private {
        if (_outstandingPrincipal == 0 && _feesOutstanding == 0) {
            _resolveOutstanding(InstallmentStatus.Cleared);
            _transition(PlanState.Repaid);
            emit PlanRepaid(_planId, _totalCollected);
            _releaseEscrow();
            return;
        }

        if (_outstandingPrincipal == 0) {
            _resolveOutstanding(InstallmentStatus.Cleared);
            _transition(PlanState.SettledWithFeeOutstanding);
            return;
        }

        if (_state == PlanState.Grace || _state == PlanState.Delinquent) {
            if (isCurrent()) {
                _transition(PlanState.Active);
                emit PlanCured(_planId, index);
            }
            return;
        }

        if (_state == PlanState.Pending) _transition(PlanState.Active);
    }

    /// @dev A plan whose debt is settled has no live obligations left, whatever the
    ///      route. Resolving the remaining statuses is what stops a keeper cranking
    ///      an authorization that would pull money the plan would only hand straight
    ///      back — and it leaves no installment sitting past grace with no recorded
    ///      outcome, which is the invariant the whole delinquency signal rests on.
    ///      Installments already `Missed` keep that status: a late payment stays a
    ///      historical fact for Passport even after the plan is paid.
    function _resolveOutstanding(InstallmentStatus resolution) private {
        for (uint256 i = 0; i < _installmentCount; ++i) {
            InstallmentStatus status = _status[i];
            if (status == InstallmentStatus.Pending || status == InstallmentStatus.Bounced) {
                _status[i] = resolution;
            }
        }
    }

    function _releaseEscrow() private {
        uint256 remaining = markEscrow;
        if (remaining == 0) return;
        markEscrow = 0;
        _forward(remaining);
    }

    function _firstUnresolved() private view returns (uint256) {
        for (uint256 i = 0; i < _installmentCount; ++i) {
            InstallmentStatus status = _status[i];
            if (status == InstallmentStatus.Pending || status == InstallmentStatus.Bounced) return i;
        }
        return type(uint256).max;
    }

    function _transition(PlanState next) private {
        PlanState current = _state;
        if (current == next) return;
        // Absorbing means absorbing. There is no path from `Repaid` back to `Grace`:
        // a borrower who paid in full cannot be made delinquent by a late keeper
        // crank, and a charged-off plan cannot resurrect and be counted twice
        // against the waterfall.
        if (_isTerminal(current)) return;
        _state = next;
        emit PlanStateChanged(_planId, current, next);
    }

    function _isTerminal(PlanState value) private pure returns (bool) {
        return value == PlanState.Repaid || value == PlanState.Defaulted || value == PlanState.Cancelled
            || value == PlanState.Refunded;
    }

    function _requireCollectible() private view {
        PlanState current = _state;
        if (
            _isTerminal(current) || current == PlanState.Disputed || current == PlanState.Hold
                || current == PlanState.SettledWithFeeOutstanding
        ) {
            revert PlanNotCollectible(current);
        }
    }

    function _requireIndex(uint256 index) private view {
        if (index >= _installmentCount) revert IndexOutOfRange(index, _installmentCount);
    }
}
