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

    /// @notice The only address permitted to deploy or originate.
    ///
    /// @dev `CheckoutRouter` in production. Gated from Phase 3 because a
    ///      permissionless `deploy` is a denial-of-service on a signed strip: anyone
    ///      who can read a pending origination can deploy an uninitialized clone to
    ///      the address it names, after which `originate` reverts forever and the
    ///      borrower's authorizations — whose nonces are bound to that `planId` —
    ///      are unusable until they re-sign under a different origination nonce.
    ///
    ///      The verification stays inside the plan regardless. This gate stops the
    ///      griefing; it is not what makes the terms trustworthy.
    ///
    ///      Set after deployment rather than in the constructor, because the router
    ///      needs this factory's address in its own constructor and this factory's
    ///      address is in the `planId` preimage — so neither can be an argument to the
    ///      other.
    ///
    ///      **Rotatable by the admin, and Phase 5 is why (DEC-15).** It was one-shot
    ///      through Phase 4. That made a router upgrade impossible without a new
    ///      factory, and a new factory changes every `planId` — so replacing the
    ///      funding book, which forces a new router, forced a new plan vintage and
    ///      orphaned every outstanding strip's derivation. Paying that cost once was
    ///      defensible; paying it every time anything upstream of the router moves is
    ///      not.
    ///
    ///      Rotation is safe for the reason this gate was always narrow: the plan
    ///      re-verifies `planId`, `termsHash` and the borrower's acceptance against its
    ///      own address, so a hostile originator cannot originate terms the borrower did
    ///      not sign. What it could do is deny service by squatting counterfactual
    ///      addresses, which is exactly what an admin-held rotation does not enable and
    ///      an open factory would.
    address public originator;

    /// @notice May name the originator.
    address public admin;

    /// @notice `planId` → deployed clone, zero until originated.
    mapping(bytes32 planId => address plan) public planOf;

    event PlanDeployed(bytes32 indexed planId, address indexed plan, address indexed implementation);
    event OriginatorSet(address indexed originator);
    event AdminSet(address indexed admin);

    error ImplementationZero();
    error JurisdictionsZero();
    error OriginatorZero();
    error OnlyOriginator(address caller);
    error OnlyAdmin(address caller);
    error PlanAlreadyDeployed(bytes32 planId, address existing);
    error FactoryMismatch(address expected, address provided);
    error ChainIdMismatch(uint256 expected, uint256 provided);
    error ImplementationMismatch(address expected, address provided);
    error AddressMismatch(address predicted, address deployed);

    /// @param admin_ The address permitted to name and rotate the originator.
    constructor(address implementation_, address jurisdictions_, address admin_) {
        if (implementation_ == address(0)) revert ImplementationZero();
        if (jurisdictions_ == address(0)) revert JurisdictionsZero();
        if (admin_ == address(0)) revert OriginatorZero();
        implementation = implementation_;
        jurisdictions = JurisdictionRegistry(jurisdictions_);
        admin = admin_;
    }

    /// @notice Name the sole originator.
    /// @dev One at a time, always. Two simultaneous originators would be two doors into
    ///      the book, which is the thing Phase 3 spent a phase closing.
    function setOriginator(address originator_) external {
        if (msg.sender != admin) revert OnlyAdmin(msg.sender);
        if (originator_ == address(0)) revert OriginatorZero();
        originator = originator_;
        emit OriginatorSet(originator_);
    }

    /// @notice Hand the rotation right on, or give it up entirely.
    /// @dev Setting it to the zero address freezes the originator permanently, which is
    ///      what a deployment does once it is finished moving.
    function setAdmin(address admin_) external {
        if (msg.sender != admin) revert OnlyAdmin(msg.sender);
        admin = admin_;
        emit AdminSet(admin_);
    }

    modifier onlyOriginator() {
        // An unset originator means the factory is mid-deployment. Refusing here
        // rather than defaulting to open is the difference between a half-wired
        // deployment that cannot originate and one that anyone can.
        if (originator == address(0) || msg.sender != originator) revert OnlyOriginator(msg.sender);
        _;
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
    /// @dev Originator-only. Deployment is idempotent-by-revert, so a duplicate
    ///      origination cannot silently produce a second plan at the same address.
    function deploy(PlanId.PlanTerms memory terms)
        external
        onlyOriginator
        returns (bytes32 planId, address plan)
    {
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
    ///      The jurisdiction parameter set is resolved here and copied in.
    ///
    ///      Only the **shortfall** is pulled from the caller. The plan's address is
    ///      known before it holds code, so the escrow can be — and in the router's
    ///      path is — sent to the counterfactual address before deployment. Pulling
    ///      unconditionally would double-fund it and strand the difference in a
    ///      contract that only forwards along the disclosed waterfall.
    function originate(OriginationRequest calldata request)
        external
        onlyOriginator
        returns (bytes32 planId, address plan)
    {
        (planId, plan) = _deploy(request.terms);

        uint256 escrow = PlanParams.markEscrowFor(request.terms.installmentCount);
        uint256 held = IERC20(request.terms.token).balanceOf(plan);
        if (held < escrow) {
            IERC20(request.terms.token).safeTransferFrom(msg.sender, plan, escrow - held);
        }

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
