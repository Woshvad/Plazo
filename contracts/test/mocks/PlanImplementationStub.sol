// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @notice Stands in for `InstallmentPlan` so Phase 1 can prove that CREATE2
///         prediction matches an actual deployment.
///
/// @dev Deliberately empty of plan logic. Phase 1 owns the identity derivation and
///      the address a borrower signs against; Phase 2 owns the mechanism. Giving
///      this stub behaviour would let a test pass here that has nothing backing it
///      in the phase that actually implements collection.
contract PlanImplementationStub {
    bytes32 public planId;
    address public factory;

    error AlreadyInitialized();

    function initialize(bytes32 planId_) external {
        if (factory != address(0)) revert AlreadyInitialized();
        planId = planId_;
        factory = msg.sender;
    }
}
