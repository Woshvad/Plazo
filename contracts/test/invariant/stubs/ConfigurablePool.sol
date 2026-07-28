// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {ICreditPool} from "../../../src/interfaces/ICreditPool.sol";

/// @notice A pool whose balance sheet can be set to anything, including states no
///         solvent book should reach.
///
/// @dev Counterpart to `ConfigurablePlan`. Every assertion in `PoolInvariants` is
///      driven into failure against it, one at a time, so the suite is known to bite
///      before Phase 5 has a vault to point it at.
contract ConfigurablePool is ICreditPool {
    uint256 public totalAssets;
    uint256 public reserveBalance;
    uint256 public totalProvisioned;
    uint256 public currentEpoch;
    bool public originationOpen = true;
    bool public allDelinquenciesMarked = true;

    mapping(Tranche => uint256) internal _trancheAssets;
    mapping(Tranche => uint256) internal _trancheShares;
    mapping(uint256 => uint256) internal _provisionedAt;

    /// @notice A coherent book: 12% junior, 3% reserve, no provision, nothing unmarked.
    function initHealthy(uint256 assets) external {
        totalAssets = assets;
        reserveBalance = (assets * 300) / 10_000;
        _trancheAssets[Tranche.Junior] = (assets * 1_200) / 10_000;
        _trancheAssets[Tranche.Senior] = assets - reserveBalance - _trancheAssets[Tranche.Junior];
        _trancheShares[Tranche.Junior] = _trancheAssets[Tranche.Junior];
        _trancheShares[Tranche.Senior] = _trancheAssets[Tranche.Senior];
    }

    function setBalanceSheet(uint256 assets, uint256 reserve, uint256 junior, uint256 senior)
        external
    {
        totalAssets = assets;
        reserveBalance = reserve;
        _trancheAssets[Tranche.Junior] = junior;
        _trancheAssets[Tranche.Senior] = senior;
    }

    function setShares(Tranche tranche, uint256 shares) external {
        _trancheShares[tranche] = shares;
    }

    function setProvision(uint256 epoch, uint256 amount) external {
        _provisionedAt[epoch] = amount;
    }

    function setTotalProvisioned(uint256 amount) external {
        totalProvisioned = amount;
    }

    function setEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }

    function setOriginationOpen(bool open) external {
        originationOpen = open;
    }

    function setAllDelinquenciesMarked(bool marked) external {
        allDelinquenciesMarked = marked;
    }

    function trancheAssets(Tranche tranche) external view returns (uint256) {
        return _trancheAssets[tranche];
    }

    function trancheShares(Tranche tranche) external view returns (uint256) {
        return _trancheShares[tranche];
    }

    function provisionedAt(uint256 epoch) external view returns (uint256) {
        return _provisionedAt[epoch];
    }

    function subordinationBps() external view returns (uint256) {
        if (totalAssets == 0) return 0;
        return (_trancheAssets[Tranche.Junior] * 10_000) / totalAssets;
    }
}
