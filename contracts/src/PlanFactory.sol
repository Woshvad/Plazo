// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PlanId} from "./libraries/PlanId.sol";
import {CloneAddress} from "./libraries/CloneAddress.sol";
import {PlanParams} from "./libraries/PlanParams.sol";
import {PlanAcceptance} from "./libraries/PlanAcceptance.sol";
import {TermsDetail} from "./libraries/TermsDetail.sol";
import {InstallmentPlan} from "./InstallmentPlan.sol";
import {JurisdictionRegistry} from "./JurisdictionRegistry.sol";

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
    using SafeERC20 for IERC20;

    /// @notice The plan implementation clones point at.
    /// @dev Immutable per vintage, and in the `planId` preimage. A new vintage is a
    ///      new factory deployment, so an outstanding strip can never be
    ///      reinterpreted by pointing existing plans at different logic.
    address public immutable implementation;

    /// @notice The jurisdiction parameter sets origination reads.
    /// @dev Read once, at origination, and copied into the plan. A live plan never
    ///      reads it again: a registry row that could move afterwards would let
    ///      governance re-price a deal the borrower has already signed.
    JurisdictionRegistry public immutable jurisdictions;

    /// @notice `planId` → deployed clone, zero until originated.
    mapping(bytes32 planId => address plan) public planOf;

    event PlanDeployed(bytes32 indexed planId, address indexed plan, address indexed implementation);

    error ImplementationZero();
    error JurisdictionsZero();
    error PlanAlreadyDeployed(bytes32 planId, address existing);
    error FactoryMismatch(address expected, address provided);
    error ChainIdMismatch(uint256 expected, uint256 provided);
    error ImplementationMismatch(address expected, address provided);
    error AddressMismatch(address predicted, address deployed);

    constructor(address implementation_, address jurisdictions_) {
        if (implementation_ == address(0)) revert ImplementationZero();
        if (jurisdictions_ == address(0)) revert JurisdictionsZero();
        implementation = implementation_;
        jurisdictions = JurisdictionRegistry(jurisdictions_);
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
        return _deploy(terms);
    }

    /// @notice Everything a plan needs to exist, in one call.
    struct OriginationRequest {
        PlanId.PlanTerms terms;
        TermsDetail.Detail detail;
        PlanAcceptance.Acceptance acceptance;
        bytes acceptanceSignature;
        /// @notice One EIP-3009 authorization per installment, in schedule order.
        bytes[] strip;
    }

    /// @notice Deploy a plan and bind it to a signed strip.
    ///
    /// @dev The clone is deployed first and funded before `initialize`, because the
    ///      plan verifies its own mark escrow is actually present rather than
    ///      trusting the factory to have sent it. That ordering is the difference
    ///      between a plan that can pay for its own delinquency signal and a plan
    ///      that will discover it cannot at the moment the signal is needed.
    ///
    ///      The jurisdiction parameter set is resolved here and copied in. Phase 3
    ///      makes this the only authorized origination path; today it is
    ///      permissionless so the vertical slice can exercise the real thing rather
    ///      than a test double.
    function originate(OriginationRequest calldata request) external returns (bytes32 planId, address plan) {
        (planId, plan) = _deploy(request.terms);

        IERC20(request.terms.token)
            .safeTransferFrom(msg.sender, plan, PlanParams.markEscrowFor(request.terms.installmentCount));

        JurisdictionRegistry.Params memory set = jurisdictions.paramsFor(request.detail.jurisdiction);

        InstallmentPlan(plan)
            .initialize(
                InstallmentPlan.InitParams({
                terms: request.terms,
                detail: request.detail,
                acceptance: request.acceptance,
                acceptanceSignature: request.acceptanceSignature,
                strip: request.strip,
                lateFeeCapBps: set.lateFeeCapBps,
                lateFeeCapAbsolute: set.lateFeeCapAbsolute,
                statementCadence: set.statementCadence,
                withdrawalWindow: set.withdrawalWindow
            })
            );
    }

    function _deploy(PlanId.PlanTerms memory terms) private returns (bytes32 planId, address plan) {
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
