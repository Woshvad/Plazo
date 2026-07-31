// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title ITransferEligibility
/// @notice Who may hold a transfer-restricted protocol asset.
///
/// @dev GOV-10 and the transfer-hook half of D5, and it lands at the *first*
///      origination rather than in a later compliance phase for a specific reason:
///      NYDFS licenses transferees, not just originators, and Reg D restricts who
///      may hold a tranche share. Retrofitting an eligibility hook onto assets that
///      have already circulated means a holder snapshot, a migration, and possibly
///      rescinding transfers that were valid when they happened.
///
///      **Default deny.** An implementation that returns `true` for an address
///      nobody has considered is not a compliance control, it is a compliance
///      theatre. The consequence is that a new deployment can transfer nothing until
///      someone decides who may hold it, which is the correct failure direction.
///
///      One interface for both asset classes: `ReceivableToken` here, and Phase 5's
///      senior and junior tranche shares. Two eligibility systems would drift.
interface ITransferEligibility {
    /// @notice Whether `account` may receive `asset`.
    function isEligible(address asset, address account) external view returns (bool);

    /// @notice Whether a transfer of `asset` from `from` to `to` is permitted.
    /// @dev Separate from `isEligible` because some restrictions are about the pair,
    ///      not the party — a jurisdiction that permits holding but not selling
    ///      across a border, a lock-up that binds the sender. Implementations that
    ///      only care about the recipient defer to `isEligible(asset, to)`.
    function isTransferPermitted(address asset, address from, address to)
        external
        view
        returns (bool);
}
