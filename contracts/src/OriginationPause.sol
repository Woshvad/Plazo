// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title OriginationPause
/// @notice Global and per-corridor stop switches for *new* credit only.
///
/// @dev GOV-03: "per-corridor and global pause switches exist and never strand
///      borrower funds." The name is the guarantee. This contract can stop the
///      protocol extending new credit and nothing else, because nothing else asks
///      it anything.
///
///      **A live plan cannot reach this contract, and it cannot reach a live plan.**
///      `InstallmentPlan` has no owner, no pauser and no upgrade path, and `repay()`
///      and every cure path are explicitly never pausable (CURE-08, CURE-09). So a
///      borrower mid-strip is unaffected by any setting here: they can still cure,
///      still prepay, still pay off, and a keeper can still collect and still mark
///      the delinquency. That is proven by a test that pauses everything and then
///      drives a plan from bounce to payoff.
///
///      This matters more than it sounds. A collections system that can stop
///      accepting money is a collections system that can manufacture a default — the
///      borrower who tried to pay and could not is delinquent through no act of their
///      own, and the loss is real. Every incumbent's emergency lever has this
///      property. This one does not, structurally.
///
///      **Pausing is fast, unpausing is deliberate.** The pauser role can stop
///      anything immediately; only the admin can restart it. An incident response
///      key that can also declare the incident over is a key that will be used to
///      declare the incident over.
contract OriginationPause is AccessControl {
    /// @notice May pause. Cannot unpause.
    bytes32 public constant PAUSER_ROLE = keccak256("PLAZO.PAUSER");

    bool public globallyPaused;
    mapping(bytes32 corridor => bool) public corridorPaused;

    event GlobalPauseSet(bool paused, address indexed by);
    event CorridorPauseSet(bytes32 indexed corridor, bool paused, address indexed by);

    error OriginationPaused();
    error CorridorOriginationPaused(bytes32 corridor);

    constructor(address admin, address pauser) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, pauser);
    }

    /// @notice Whether new credit may be extended in `corridor`.
    function isOpen(bytes32 corridor) public view returns (bool) {
        return !globallyPaused && !corridorPaused[corridor];
    }

    /// @notice Revert unless new credit may be extended in `corridor`.
    /// @dev Two distinct errors rather than one. A merchant told "originations are
    ///      paused" when only the EURC corridor is down will escalate the wrong
    ///      thing, and an operator reading a support ticket needs to know which
    ///      switch someone threw.
    function requireOpen(bytes32 corridor) external view {
        if (globallyPaused) revert OriginationPaused();
        if (corridorPaused[corridor]) revert CorridorOriginationPaused(corridor);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        globallyPaused = true;
        emit GlobalPauseSet(true, msg.sender);
    }

    function pauseCorridor(bytes32 corridor) external onlyRole(PAUSER_ROLE) {
        corridorPaused[corridor] = true;
        emit CorridorPauseSet(corridor, true, msg.sender);
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        globallyPaused = false;
        emit GlobalPauseSet(false, msg.sender);
    }

    function unpauseCorridor(bytes32 corridor) external onlyRole(DEFAULT_ADMIN_ROLE) {
        corridorPaused[corridor] = false;
        emit CorridorPauseSet(corridor, false, msg.sender);
    }
}
