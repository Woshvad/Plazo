// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title ICreditPool
/// @notice The funding book's accounting surface, as the invariant suite sees it.
///
/// @dev Phase 1 defines only what the share-accounting invariants need to address.
///      The vault shape itself is a Phase 5 decision, and it is not ERC-4626: that
///      standard is synchronous and cannot express next-epoch-NAV deposits or
///      pro-rata queue fills. The intended shape is a CDO core with two plain
///      transfer-restricted tranche tokens and per-tranche async vaults over them.
interface ICreditPool {
    enum Tranche {
        Senior,
        Junior
    }

    /// @notice Total assets the pool believes it holds.
    /// @dev An internal booked accumulator, never `token.balanceOf(address(this))`.
    ///      A donation would otherwise inflate NAV for existing holders and, in the
    ///      junior vault, is half of the first-depositor attack.
    function totalAssets() external view returns (uint256);

    /// @notice First-loss reserve balance.
    function reserveBalance() external view returns (uint256);

    /// @notice Assets claimed by a tranche at the current epoch's NAV.
    function trancheAssets(Tranche tranche) external view returns (uint256);

    /// @notice Shares outstanding in a tranche.
    function trancheShares(Tranche tranche) external view returns (uint256);

    /// @notice Provision held against delinquent plans, bucketed by the epoch that
    ///         raised it.
    /// @dev Bucketing is what makes a cure release exactly what the delinquency
    ///      took. A flat provision with un-bucketed release is a harvestable NAV
    ///      oscillation: deposit at the trough, redeem after the cure wave, funded
    ///      by whoever redeemed at the trough — and it hits junior hardest.
    function provisionedAt(uint256 epoch) external view returns (uint256);

    /// @notice Total provision across all epochs.
    function totalProvisioned() external view returns (uint256);

    /// @notice Receivables carried at face, before the provision is netted off.
    /// @dev The base a provision is held against. A valuation allowance is bounded by
    ///      the book it sits on, not by the pool's net worth — measuring it against net
    ///      assets would impose an accidental fifty-percent ceiling on provisioning,
    ///      because every provision reduces net assets one-for-one.
    function grossReceivables() external view returns (uint256);

    /// @notice Junior assets as a fraction of total, in basis points.
    function subordinationBps() external view returns (uint256);

    /// @notice Whether origination is permitted at the current subordination and
    ///         reserve levels.
    function originationOpen() external view returns (bool);

    /// @notice Whether every plan past `grace + 1` has been marked.
    /// @dev Epoch settlement refuses to close otherwise. This is what makes the
    ///      bountied mark unavoidable rather than merely available: an unmarked
    ///      delinquency stops the book from closing, so someone is always motivated
    ///      to pay for the crank.
    function allDelinquenciesMarked() external view returns (bool);

    function currentEpoch() external view returns (uint256);
}
