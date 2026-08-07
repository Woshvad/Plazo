// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IFxVenue} from "../interfaces/IFxVenue.sol";
import {FxMidAttestation} from "../libraries/FxMidAttestation.sol";
import {ParameterRegistry} from "../ParameterRegistry.sol";
import {ParameterKeys} from "../libraries/ParameterKeys.sol";
import {PlanParams} from "../libraries/PlanParams.sol";

/// @title FxDeviationGuard
/// @notice FX-05. The onchain floor a realised fill has to beat.
///
/// @dev **The guard is onchain, and it guards the fill rather than the quote.** FX-05
///      says the fallback venue "refuses any fill outside a deviation guard against
///      the last RFQ mid". The guard exists *precisely because* the quoting service
///      might be compromised, slow or wrong — so a guard the service applies to its
///      own quote guards nothing at all. The arithmetic therefore runs here, in
///      Solidity, on the `amountOut` the venue actually returned, after the transfer
///      has happened and while the transaction can still be undone.
///
///      That is also why `quote()` is never called from this file. A venue that
///      quotes honestly and fills badly is invisible to anything that reads the
///      quote, and it is the exact failure this contract exists to catch.
///
///      **Nothing here stores `midE18` past the transaction, and that is C1's line.**
///      The moment a rate this contract has seen could be read to answer "what is this
///      position worth", the protocol has an oracle, whatever the file is called. The
///      mid answers one question — *is this fill worse than what we were told* — and
///      the answer is thrown away. `tools/check-no-oracle.mjs` is the standing guard
///      on the distinction; `FxMidAttestation`'s header states it in full.
///
///      **One new role, and no second pauser.** `FX_SIGNER_ROLE` is the only role this
///      contract mints. The pausing role `OriginationPause` already declares is reused
///      unchanged wherever pausing is what is wanted; DEC-49's warning about
///      accumulating un-renounced authorities is the reason a second one would be a
///      defect rather than a convenience, and GOV-02 audits the whole graph in Phase 9.
///
///      **Both bounds are governance's, read at call time, inside a compiled band.**
///      `FX_MID_MAX_TTL` and `FX_MAX_DEVIATION_BPS` are `ParameterRegistry` rows, not
///      constants here. Governance may move either inside the band the registry
///      compiled and may narrow that band permanently; it can never widen one. So the
///      most a captured governance key buys is a tolerance the registry already
///      allowed, and the most a captured signing key buys is the ability to refuse.
///
///      **Calling this is permissionless, because it moves only the caller's money.**
///      `settleGuarded` pulls from `msg.sender` and pays `recipient`. There is nothing
///      to gate: an outsider who calls it spends their own balance through a public
///      venue and gets the protocol's floor applied to it for free.
///
///      **The residual that follows from that, stated rather than hidden.** Because
///      the call is permissionless and the mid binds no caller, anyone who sees a
///      signed mid before it is used can spend its `sessionId` on a one-unit fill of
///      their own, and the intended fill then meets `MidAlreadyUsed`. That is a denial
///      of service, not a theft — the griefer pays gas, moves only their own money,
///      and gets the same floor everybody else does. It is bounded by how long a mid
///      is visible before it is used, which on a 0.514 s deterministic chain is one
///      block when the mid is delivered in the same transaction as the origination
///      (plan 07-09), and by `FX_MID_MAX_TTL` in every other case. Binding the mid to
///      a caller would close it, and would mean a seventh field in a struct whose six
///      are already a signed commitment; that is a change to make deliberately, with
///      the strip's versioning in view, rather than as a footnote here.
contract FxDeviationGuard is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice May sign the mid a fill is floored against.
    bytes32 public constant FX_SIGNER_ROLE = keccak256("PLAZO.FX_SIGNER");

    ParameterRegistry public immutable parameters;

    /// @notice Sessions whose mid has already been spent.
    /// @dev Set before the external call, never cleared. `sessionId` is what tells two
    ///      quotes for the same pair in the same minute apart, so consuming it is what
    ///      stops a mid quoted before a real market move being replayed after it.
    mapping(bytes32 sessionId => bool) public midUsed;

    event FillGuarded(
        bytes32 indexed corridor, address indexed venue, uint256 amountIn, uint256 amountOut, uint256 floor
    );

    error MidExpired(uint256 validUntil);
    error MidTooLong(uint256 ttl, uint256 maxTtl);
    error MidSignerUnauthorized(address signer);
    error MidPairMismatch(address fromToken, address toToken);
    error MidAlreadyUsed(bytes32 sessionId);
    error FillOutsideGuard(uint256 amountOut, uint256 floor);
    error NothingToSettle();

    constructor(address admin, address parameters_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        parameters = ParameterRegistry(parameters_);
    }

    /// @notice Cross a currency through `venue`, and undo it if the fill is too far
    ///         from the mid the quoting service signed.
    ///
    /// @dev The mid *is* the request. There is no second copy of the pair for it to
    ///      disagree with, and asking the caller to state the pair twice would only
    ///      create a way for the two statements to differ. What the pair is checked
    ///      against is the venue: a mid naming a pair this venue does not trade —
    ///      the reversed direction most of all, where the correct floor is the
    ///      reciprocal and applying the mid unchanged would accept a fill wrong by the
    ///      square of the rate — is refused before anything moves.
    ///
    ///      `corridor` is not re-derived here. It is inside the digest, so a signer's
    ///      mid cannot be presented under a different corridor without breaking the
    ///      signature, and it is emitted so the indexer attributes the fill to the
    ///      bucket it was quoted for.
    function settleGuarded(
        IFxVenue venue,
        FxMidAttestation.Mid calldata mid,
        bytes calldata signature,
        uint256 amountIn,
        address recipient
    ) external nonReentrant returns (uint256 amountOut) {
        if (amountIn == 0) revert NothingToSettle();

        // `supportsPair` answers rather than reverts, by IFxVenue's contract, so this
        // is a question the guard can safely ask of an untrusted venue.
        if (!venue.supportsPair(mid.fromToken, mid.toToken)) {
            revert MidPairMismatch(mid.fromToken, mid.toToken);
        }

        if (block.timestamp > mid.validUntil) revert MidExpired(mid.validUntil);

        uint256 ttl = mid.validUntil - block.timestamp;
        uint256 maxTtl = parameters.get(ParameterKeys.FX_MID_MAX_TTL);
        if (ttl > maxTtl) revert MidTooLong(ttl, maxTtl);

        bytes32 digest = FxMidAttestation.digest(mid, block.chainid, address(this));
        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(FX_SIGNER_ROLE, signer)) revert MidSignerUnauthorized(signer);

        if (midUsed[mid.sessionId]) revert MidAlreadyUsed(mid.sessionId);
        midUsed[mid.sessionId] = true;

        uint256 floor_ = floorFor(amountIn, mid.midE18);

        IERC20 sold = IERC20(mid.fromToken);
        sold.safeTransferFrom(msg.sender, address(this), amountIn);
        sold.forceApprove(address(venue), amountIn);

        amountOut = venue.settle(mid.fromToken, mid.toToken, amountIn, floor_, recipient);

        // Both the `minOut` handed to the venue and this check are here on purpose and
        // neither is redundant. The first lets an honest venue fail cheaply, before it
        // has moved anything. The second is what holds when the venue is *not* honest:
        // a venue that ignores `minOut` and returns an inflated figure is caught here,
        // and a venue that fills short and reports it truthfully is caught here too.
        // Deleting either one leaves a venue that can take the money and say so.
        if (amountOut < floor_) revert FillOutsideGuard(amountOut, floor_);

        // No standing claim on this contract's balance survives the call. An allowance
        // left open to an external venue is a withdrawal right that outlives the trade
        // it was granted for.
        sold.forceApprove(address(venue), 0);

        emit FillGuarded(mid.corridor, address(venue), amountIn, amountOut, floor_);
    }

    /// @notice The least `amountIn` may fetch at `midE18` under today's tolerance.
    ///
    /// @dev Public so the quoting service, a keeper and this contract all evaluate one
    ///      implementation of the arithmetic rather than three. Two readings of the
    ///      same formula is exactly the kind of thing that stays wrong for a year, and
    ///      here being wrong means a service that believes a fill will clear when the
    ///      chain is about to refuse it.
    function floorFor(uint256 amountIn, uint256 midE18) public view returns (uint256) {
        uint256 expected = (amountIn * midE18) / 1e18;
        uint256 deviation = parameters.get(ParameterKeys.FX_MAX_DEVIATION_BPS);
        return (expected * (PlanParams.BPS - deviation)) / PlanParams.BPS;
    }
}
