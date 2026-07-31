// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IComplianceOracle} from "./interfaces/IComplianceOracle.sol";

/// @title AllowlistCompliance
/// @notice The Phase 3 compliance oracle: an onchain mirror of the screening feed.
///
/// @dev Circle's Compliance Engine is request-gated and has the longest lead time on
///      the access list, so this ships behind `IComplianceOracle` and does the real
///      job in the meantime. When the Engine arrives it becomes the feed's upstream;
///      nothing in the origination path changes.
///
///      **Unknown is not clear.** The default status is `Unknown` and only `Clear`
///      passes. An account nobody has screened cannot originate. That will feel
///      wrong the first time a demo fails, and it is the only defensible default:
///      the alternative is that forgetting to run a screen is indistinguishable from
///      passing one.
///
///      **A status can be revoked at any time and the event is the product.** OPS-05
///      wants a borrower who becomes sanctioned mid-strip detected. A one-shot check
///      at checkout cannot do that, so status is mutable and every change emits. The
///      operator's stream consumer reads those events; so does the indexer, so does
///      the ops console. The chain is the record of when the protocol knew.
///
///      Screening is bulk work. `screenBatch` exists because a feed update is
///      hundreds of addresses and a hundred transactions is a hundred chances to
///      apply half an update.
contract AllowlistCompliance is IComplianceOracle, AccessControl {
    /// @notice May set an account's status.
    /// @dev Separate from the admin role so the operator's automated feed holds a key
    ///      that can screen and nothing else. A feed key that could also grant roles
    ///      would make the compliance system's blast radius the whole contract.
    bytes32 public constant SCREENER_ROLE = keccak256("PLAZO.SCREENER");

    struct Record {
        Status status;
        uint64 at;
    }

    mapping(address account => Record) private _records;

    error LengthMismatch(uint256 accounts, uint256 statuses);

    constructor(address admin, address screener) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SCREENER_ROLE, screener);
    }

    /// @inheritdoc IComplianceOracle
    function isClear(address account) external view returns (bool) {
        return _records[account].status == Status.Clear;
    }

    /// @inheritdoc IComplianceOracle
    function statusOf(address account) external view returns (Status) {
        return _records[account].status;
    }

    /// @inheritdoc IComplianceOracle
    function screenedAt(address account) external view returns (uint256) {
        return _records[account].at;
    }

    function screen(address account, Status status) public onlyRole(SCREENER_ROLE) {
        // Re-screening to the same status still stamps the time and still emits. The
        // router enforces a freshness window, so "we checked again and nothing
        // changed" is information, not a no-op.
        _records[account] = Record({status: status, at: uint64(block.timestamp)});
        emit ComplianceStatusChanged(account, status, block.timestamp);
    }

    function screenBatch(address[] calldata accounts, Status[] calldata statuses) external {
        if (accounts.length != statuses.length) revert LengthMismatch(accounts.length, statuses.length);
        for (uint256 i = 0; i < accounts.length; ++i) {
            screen(accounts[i], statuses[i]);
        }
    }
}
