// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ITransferEligibility} from "./interfaces/ITransferEligibility.sol";

/// @title EligibilityRegistry
/// @notice Who may hold a transfer-restricted protocol asset. Default deny.
///
/// @dev GOV-10 and the transfer-hook half of D5, in force from the first mint.
///
///      Two layers, because two different rules are being expressed. **Per-asset**
///      eligibility is the compliance decision: a Reg D tranche share has a narrower
///      holder set than a receivable. **Global** eligibility is the protocol's own
///      plumbing: the pool, the router and the payout contract need to hold assets
///      without being separately allowlisted for each one, and re-listing them per
///      asset is a step someone will forget on the deployment that matters.
///
///      An asset can be marked **unrestricted**, which is how Phase 8's factoring
///      market opens a receivable class to a wider set without a per-holder list.
///      It is a governance action with its own event, so opening a class is visible
///      rather than inferable from a holder distribution.
contract EligibilityRegistry is ITransferEligibility, Ownable {
    /// @notice Eligible to hold every asset.
    mapping(address account => bool) public globallyEligible;

    /// @notice Eligible to hold one asset.
    mapping(address asset => mapping(address account => bool)) public assetEligible;

    /// @notice Assets with no holder restriction.
    mapping(address asset => bool) public unrestricted;

    event GlobalEligibilitySet(address indexed account, bool eligible);
    event AssetEligibilitySet(address indexed asset, address indexed account, bool eligible);
    event AssetUnrestrictedSet(address indexed asset, bool unrestricted);

    error LengthMismatch(uint256 accounts, uint256 flags);

    constructor(address governance) Ownable(governance) {}

    /// @inheritdoc ITransferEligibility
    function isEligible(address asset, address account) public view returns (bool) {
        // Burning is always permitted. A restriction on who may hold an asset is not
        // a restriction on the asset ceasing to exist, and an eligibility system that
        // blocked burns would make a charged-off receivable permanently
        // untransferable to nowhere.
        if (account == address(0)) return true;
        if (unrestricted[asset]) return true;
        if (globallyEligible[account]) return true;
        return assetEligible[asset][account];
    }

    /// @inheritdoc ITransferEligibility
    /// @dev The recipient is what matters here. Sender-side restrictions — Phase 5's
    ///      junior lock-up, a jurisdiction that permits holding but not selling —
    ///      attach to those assets when they exist, and the pair-aware signature is
    ///      why they will not need a new interface.
    function isTransferPermitted(address asset, address, address to) external view returns (bool) {
        return isEligible(asset, to);
    }

    function setGlobal(address account, bool eligible) public onlyOwner {
        globallyEligible[account] = eligible;
        emit GlobalEligibilitySet(account, eligible);
    }

    function setGlobalBatch(address[] calldata accounts, bool[] calldata flags) external {
        if (accounts.length != flags.length) revert LengthMismatch(accounts.length, flags.length);
        for (uint256 i = 0; i < accounts.length; ++i) {
            setGlobal(accounts[i], flags[i]);
        }
    }

    function setForAsset(address asset, address account, bool eligible) public onlyOwner {
        assetEligible[asset][account] = eligible;
        emit AssetEligibilitySet(asset, account, eligible);
    }

    function setForAssetBatch(address asset, address[] calldata accounts, bool[] calldata flags)
        external
    {
        if (accounts.length != flags.length) revert LengthMismatch(accounts.length, flags.length);
        for (uint256 i = 0; i < accounts.length; ++i) {
            setForAsset(asset, accounts[i], flags[i]);
        }
    }

    /// @notice Open an asset class to any holder.
    /// @dev Reversible, and both directions emit. Phase 8's factoring market is the
    ///      intended use; nothing in Phase 3 sets it.
    function setUnrestricted(address asset, bool value) external onlyOwner {
        unrestricted[asset] = value;
        emit AssetUnrestrictedSet(asset, value);
    }
}
