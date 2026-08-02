// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title ITokenMessengerV2
/// @notice The four calls Plazo makes against Circle's CCTP v2 `TokenMessengerV2`.
///
/// @dev Authored locally rather than vendored. `circlefin/evm-cctp-contracts` would be a
///      new submodule under a tree pinned to OpenZeppelin 5.6.1, and CLAUDE.md pins no
///      new Solidity dependency; four signatures do not earn that. Every selector below
///      was extracted from the deployed implementation's bytecode on chain 5042002, and
///      `depositForBurn` was executed for real out of Arc in plan 06-01 (finding 28).
///
///      **This seven-argument form is the only one that exists on Arc.** The CCTP **v1**
///      four-argument `depositForBurn(uint256,uint32,bytes32,address)` — selector
///      `0x6fd3504e` — and `depositForBurnWithCaller` — `0xf856ddb6` — are *absent* from
///      the deployed implementation. Code written against v1 compiles against a mock and
///      fails at integration, which is why `pnpm arc:verify` asserts their absence with a
///      v2-selector presence control on the same bytecode scan.
///
///      **`maxFee` is `0` and `minFinalityThreshold` is `2000`, always, from Arc.**
///      Circle's fee oracle returns `minimumFee: 0` from domain 26 to every destination
///      domain at *both* the fast (1000) and standard (2000) thresholds, and 06-01
///      confirmed a zero protocol fee by exact balance delta rather than by quote. Fast
///      buys nothing when standard is priced identically and Arc finalises in ~0.514 s
///      anyway, so there is no fast/standard toggle to build (D-15).
///
///      **The hook-carrying variant of the burn is deliberately not declared**, though
///      its selector (`0x779b432d`) is present on chain. CCTP does not execute hooks in the core
///      protocol: `hookData` is opaque metadata that only a destination-side contract
///      implementing `IMessageHandlerV2` can interpret, and that contract would have to
///      be deployed and gas-funded by Plazo on every destination chain. D-12 says build
///      no Plazo contract on any chain but Arc, and XCH-02 needs none — the mint
///      recipient *is* the merchant. A declared-but-unused interface member is an
///      invitation to use it.
interface ITokenMessengerV2 {
    /// @notice Burn `amount` of `burnToken` on Arc for minting to `mintRecipient` on
    ///         `destinationDomain`.
    /// @dev Selector `0x8e0250ee`. `mintRecipient` and `destinationCaller` are `bytes32`
    ///      because CCTP addresses non-EVM domains too; an EVM address is **left**-padded
    ///      (`bytes32(uint256(uint160(addr)))`). A `destinationCaller` of `bytes32(0)`
    ///      leaves `receiveMessage` on the destination callable by anyone, which is what
    ///      makes the destination leg operator-free (D-12).
    ///
    ///      `amount` is the 6-decimal ERC-20 figure. Arc USDC holds balances at 18
    ///      decimals natively and presents them at 6; the 6-decimal figure is what
    ///      crosses the CCTP boundary, and nothing anywhere should scale it.
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;

    /// @notice The `TokenMessenger` CCTP acknowledges on `domain`, or `bytes32(0)`.
    /// @dev The routing table, read from chain rather than mirrored into an allowlist:
    ///      a new CCTP domain then works with no Plazo deployment (D-11). On Arc this
    ///      returns the same testnet address for every remote domain and **`bytes32(0)`
    ///      for domain 26 itself** — CCTP has no self-domain route, which is why a
    ///      caller must branch on Arc before consulting this table.
    function remoteTokenMessengers(uint32 domain) external view returns (bytes32);

    /// @notice The `MessageTransmitterV2` this messenger sends through.
    /// @dev `MessageSent` is emitted by the transmitter, not by the messenger. An
    ///      indexer that watches the messenger for it sees nothing.
    function localMessageTransmitter() external view returns (address);

    /// @notice The version stamped into the burn message body. Reads `1` on Arc.
    function messageBodyVersion() external view returns (uint32);
}
