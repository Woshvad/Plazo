// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title IFXRouter
/// @notice Currency normalization seam.
///
/// @dev One of five interfaces installed early so that later product lines cannot
///      reach backwards into the audited core. Phase 1 defines it; Phase 2 wires an
///      identity no-op adapter into settlement, ordered *before* the waterfall;
///      Phase 7 supplies the EURC corridor. Only EURC is buildable — it is the one
///      non-USDC token on Arc with full EIP-3009 — and every other corridor named
///      in the specification is configuration for contracts that do not exist.
interface IFXRouter {
    /// @notice Normalize `amount` of `fromToken` into the pool's accounting currency.
    /// @dev The identity adapter returns `amount` unchanged when `fromToken` is
    ///      already the accounting currency. Callers must treat a normalized amount
    ///      as the only figure the waterfall ever sees; mixing currencies inside the
    ///      waterfall is how rounding becomes a solvency question.
    function normalize(address fromToken, uint256 amount) external view returns (uint256);

    /// @notice Whether this router can normalize `fromToken` at all.
    function isSupported(address fromToken) external view returns (bool);
}
