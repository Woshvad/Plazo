// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {ITokenMessengerV2} from "../../src/interfaces/ITokenMessengerV2.sol";

/// @title MockTokenMessengerV2
/// @notice A recorder standing in for Circle's CCTP v2 `TokenMessengerV2`.
///
/// @dev It records rather than simulates. Nothing here burns anything, because what
///      `PayoutRouter` has to be held to is the *shape of the call it makes* — a burn
///      whose `mintRecipient` is right-padded is unrecoverable on a destination chain
///      and is not detectable by any amount of local accounting. So the seven arguments
///      are stored verbatim and asserted as a tuple.
///
///      Reproduced faithfully:
///
///      - The seven-argument `depositForBurn` signature, selector `0x8e0250ee`, matching
///        the deployed implementation on chain 5042002 and the call plan 06-01 executed
///        for real (finding 28).
///      - `remoteTokenMessengers` as a table that answers `bytes32(0)` for domain 26.
///        That is the live reading, and it is the reason `supportsDomain` must branch on
///        Arc first: CCTP has no self-domain route.
///      - `messageBodyVersion() == 1` and a `localMessageTransmitter` distinct from this
///        contract — the live `MessageSent` came from the transmitter, not the messenger.
///      - Reverting on demand (`setRevertOnBurn`). Circle holds three kill switches Plazo
///        does not: transmitter pause, minter pause, and the messenger denylist. Each one
///        surfaces here as "the burn reverts", which is exactly the failure that must not
///        be able to reach an origination.
///
///      Deliberately not reproduced: the attester set and its two-of-N signature
///      threshold, the fee oracle (`maxFee` is 0 from Arc to every domain, measured as a
///      balance delta, so there is nothing to price), the burn-limit ceiling, the message
///      body encoding and the `MessageSent` emission, the denylist as a mapping, and the
///      nonce — which the live chain does not supply either. The nonce in a sent message
///      is all zeros; the real `eventNonce` is assigned by Iris at attestation time, so a
///      mock that invented one would teach the tests a fact that is false on chain.
contract MockTokenMessengerV2 is ITokenMessengerV2 {
    // ─── Recorded burn ───────────────────────────────────────────────────────

    uint256 public lastAmount;
    uint32 public lastDestinationDomain;
    bytes32 public lastMintRecipient;
    address public lastBurnToken;
    bytes32 public lastDestinationCaller;
    uint256 public lastMaxFee;
    uint32 public lastMinFinalityThreshold;

    /// @notice How many times `depositForBurn` has been called and not reverted.
    uint256 public burnCount;

    // ─── Test controls ───────────────────────────────────────────────────────

    /// @notice When true, every `depositForBurn` reverts.
    /// @dev The stand-in for all three of Circle's kill switches at once.
    bool public revertOnBurn;

    mapping(uint32 domain => bytes32 messenger) internal _remoteTokenMessengers;

    address public localMessageTransmitter;
    uint32 public messageBodyVersion = 1;

    error BurnHalted();

    constructor(address transmitter) {
        localMessageTransmitter = transmitter;
    }

    /// @notice Populate the routing table. Domain 26 must stay `bytes32(0)` to mirror
    ///         the chain.
    function setRemoteTokenMessenger(uint32 domain, bytes32 messenger) external {
        _remoteTokenMessengers[domain] = messenger;
    }

    /// @notice Make the burn fail, as a Circle pause or a denylisting would.
    function setRevertOnBurn(bool value) external {
        revertOnBurn = value;
    }

    // ─── ITokenMessengerV2 ───────────────────────────────────────────────────

    /// @inheritdoc ITokenMessengerV2
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        if (revertOnBurn) revert BurnHalted();

        lastAmount = amount;
        lastDestinationDomain = destinationDomain;
        lastMintRecipient = mintRecipient;
        lastBurnToken = burnToken;
        lastDestinationCaller = destinationCaller;
        lastMaxFee = maxFee;
        lastMinFinalityThreshold = minFinalityThreshold;

        burnCount += 1;
    }

    /// @inheritdoc ITokenMessengerV2
    /// @dev Unset domains answer `bytes32(0)`, and `ARC_DOMAIN` is left unset by every
    ///      fixture — that is what the live contract answers for its own domain, and a
    ///      test that populates it is deliberately departing from the chain.
    function remoteTokenMessengers(uint32 domain) external view returns (bytes32) {
        return _remoteTokenMessengers[domain];
    }
}
