// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {PlanId} from "./libraries/PlanId.sol";
import {CloneAddress} from "./libraries/CloneAddress.sol";

/// @title PlanFactory
/// @notice Derives plan identity and deploys plan clones to their predicted address.
///
/// @dev Phase 1 scope. This factory establishes the address a borrower signs
///      against and proves that prediction and deployment agree. The origination
///      path — pool draw, merchant payout, acceptance verification, underwriting —
///      arrives with `CheckoutRouter`, which will be the only authorized caller.
///
///      Plans are deployed here and never through the shared permissionless CREATE2
///      deployer. A strip is signed against an address that does not yet hold code;
///      if anyone could deploy to that address, a third party could occupy it
///      between signing and origination and receive checks the borrower intended
///      for a plan.
contract PlanFactory {
    using PlanId for PlanId.PlanTerms;

    /// @notice The plan implementation clones point at.
    /// @dev Immutable per vintage, and in the `planId` preimage. A new vintage is a
    ///      new factory deployment, so an outstanding strip can never be
    ///      reinterpreted by pointing existing plans at different logic.
    address public immutable implementation;

    /// @notice `planId` → deployed clone, zero until originated.
    mapping(bytes32 planId => address plan) public planOf;

    event PlanDeployed(bytes32 indexed planId, address indexed plan, address indexed implementation);

    error ImplementationZero();
    error PlanAlreadyDeployed(bytes32 planId, address existing);
    error FactoryMismatch(address expected, address provided);
    error ChainIdMismatch(uint256 expected, uint256 provided);
    error ImplementationMismatch(address expected, address provided);
    error AddressMismatch(address predicted, address deployed);

    constructor(address implementation_) {
        if (implementation_ == address(0)) revert ImplementationZero();
        implementation = implementation_;
    }

    /// @notice Derive `planId` for terms this factory would accept.
    /// @dev Reverts rather than silently deriving an id for a plan that could never
    ///      be deployed here. A `planId` naming a different factory, chain or
    ///      implementation is a valid hash of something — just not of a plan this
    ///      contract can originate, and a checkout that got one would produce a
    ///      strip payable to an address that never receives code.
    function derivePlanId(PlanId.PlanTerms memory terms) public view returns (bytes32) {
        _requireBound(terms);
        terms.validate();
        return terms.derive();
    }

    /// @notice The address a plan with these terms will occupy.
    function predictPlanAddress(PlanId.PlanTerms memory terms) external view returns (address) {
        return CloneAddress.predict(address(this), implementation, derivePlanId(terms));
    }

    /// @notice The address a plan with this id will occupy.
    /// @dev Takes the id directly so a borrower's wallet, an indexer or an auditor
    ///      can verify the payee of a signed authorization without reconstructing
    ///      the terms.
    function predictAddress(bytes32 planId) public view returns (address) {
        return CloneAddress.predict(address(this), implementation, planId);
    }

    /// @notice The EIP-3009 nonce for one installment of a plan.
    function checkNonce(bytes32 planId, uint256 index) external pure returns (bytes32) {
        return PlanId.checkNonce(planId, index);
    }

    /// @notice Every EIP-3009 nonce in a plan's strip, in installment order.
    function checkNonces(bytes32 planId, uint256 installmentCount) external pure returns (bytes32[] memory) {
        return PlanId.checkNonces(planId, installmentCount);
    }

    /// @notice Deploy the clone for these terms.
    /// @dev Permissionless in Phase 1 so the parity test can exercise the real
    ///      deployment path. `CheckoutRouter` becomes the sole authorized caller in
    ///      Phase 3; deployment is idempotent-by-revert either way, so a duplicate
    ///      origination cannot silently produce a second plan at the same address.
    function deploy(PlanId.PlanTerms memory terms) external returns (bytes32 planId, address plan) {
        planId = derivePlanId(terms);

        address existing = planOf[planId];
        if (existing != address(0)) revert PlanAlreadyDeployed(planId, existing);

        address predicted = CloneAddress.predict(address(this), implementation, planId);
        plan = CloneAddress.deploy(implementation, planId);

        // Belt and braces. If these ever diverge, every outstanding strip is payable
        // to an address that will not hold the plan, so fail loudly at origination
        // rather than quietly at first collection.
        if (plan != predicted) revert AddressMismatch(predicted, plan);

        planOf[planId] = plan;
        emit PlanDeployed(planId, plan, implementation);
    }

    function _requireBound(PlanId.PlanTerms memory terms) private view {
        if (terms.chainId != block.chainid) revert ChainIdMismatch(block.chainid, terms.chainId);
        if (terms.factory != address(this)) revert FactoryMismatch(address(this), terms.factory);
        if (terms.implementation != implementation) {
            revert ImplementationMismatch(implementation, terms.implementation);
        }
    }
}
