// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {InstallmentPlan} from "../../src/InstallmentPlan.sol";
import {PlanFactory} from "../../src/PlanFactory.sol";
import {JurisdictionRegistry} from "../../src/JurisdictionRegistry.sol";
import {IdentityFXRouter} from "../../src/IdentityFXRouter.sol";
import {PlanId} from "../../src/libraries/PlanId.sol";
import {PlanParams} from "../../src/libraries/PlanParams.sol";
import {PlanAcceptance} from "../../src/libraries/PlanAcceptance.sol";
import {TermsDetail} from "../../src/libraries/TermsDetail.sol";
import {MockArcUsdc} from "../mocks/MockArcUsdc.sol";

/// @notice Everything needed to originate a real plan against a real strip.
///
/// @dev The point of building this once is that every test below originates the
///      same way a checkout would: the borrower signs a strip and an acceptance
///      offchain, the factory verifies both onchain, and no test is allowed to
///      shortcut a signature. A fixture that let tests poke state directly would
///      make the suite agree with itself rather than with the mechanism.
abstract contract PlanFixture is Test {
    MockArcUsdc internal usdc;
    JurisdictionRegistry internal jurisdictions;
    IdentityFXRouter internal router;
    address internal implementation;
    PlanFactory internal factory;
    InstallmentPlan internal plan;

    uint256 internal constant BORROWER_KEY = 0xB0BB0;
    address internal borrower;
    address internal merchant = address(0xACCED);
    address internal pool = address(0x9001);
    address internal keeper = address(0xBEEF);
    address internal stranger = address(0xDECAF);

    /// @dev $100 over four checks. Above the $75 minimum ticket, and it makes the
    ///      slice's "25% moved" assertion literal.
    uint256 internal constant PRINCIPAL = 100e6;
    uint256 internal constant COUNT = 4;
    uint256 internal constant INTERVAL = 14 days;

    bytes32 internal planId;
    uint256 internal firstDue;

    /// @dev Overridden by the signer-mutation suite, which points `borrower` at a
    ///      contract wallet. Everything else about origination is identical, which
    ///      is the property worth having: the plan does not branch on signer class
    ///      anywhere in the collection path.
    TermsDetail.SignerClass internal signerClass = TermsDetail.SignerClass.EOA;

    function _deployStack() internal {
        borrower = vm.addr(BORROWER_KEY);

        usdc = new MockArcUsdc();
        jurisdictions = new JurisdictionRegistry(address(this));
        router = new IdentityFXRouter(address(usdc));
        implementation = address(new InstallmentPlan());
        factory = new PlanFactory(implementation, address(jurisdictions));
    }

    function _detail() internal view returns (TermsDetail.Detail memory) {
        return TermsDetail.Detail({
            jurisdiction: jurisdictions.DEFAULT_JURISDICTION(),
            lineItemsHash: keccak256("one pair of boots"),
            mdrBps: 450,
            lateFeeFlat: PlanParams.LATE_FEE_FLAT,
            signerClass: signerClass,
            settlementRecipient: pool,
            fxRouter: address(router)
        });
    }

    function _terms(
        uint256 principal,
        uint256 count,
        uint256 nonce
    ) internal view returns (PlanId.PlanTerms memory) {
        return PlanId.PlanTerms({
            chainId: block.chainid,
            factory: address(factory),
            implementation: implementation,
            borrower: borrower,
            merchant: merchant,
            token: address(usdc),
            principal: principal,
            installmentCount: count,
            firstDueDate: block.timestamp,
            interval: INTERVAL,
            originationNonce: nonce,
            termsHash: TermsDetail.hash(_detail())
        });
    }

    /// @notice Originate the default plan: $100, four checks, fortnightly.
    function _originateDefault() internal returns (InstallmentPlan) {
        return _originate(_terms(PRINCIPAL, COUNT, 1));
    }

    /// @notice Build the origination request a checkout would submit.
    /// @dev Built as a value and returned, so a test expecting a revert can stage it
    ///      *before* arming `vm.expectRevert`. Building it inline would attach the
    ///      expectation to the first external call among the arguments, which is a
    ///      `DOMAIN_SEPARATOR()` read that does not revert — and the test would pass
    ///      for the wrong reason or fail for a confusing one.
    function _request(
        PlanId.PlanTerms memory terms,
        TermsDetail.Detail memory detail
    ) internal view returns (PlanFactory.OriginationRequest memory) {
        bytes32 id = PlanId.derive(terms);
        address predicted = factory.predictAddress(id);
        PlanAcceptance.Acceptance memory acceptance = _acceptance(terms, id);
        return PlanFactory.OriginationRequest({
            terms: terms,
            detail: detail,
            acceptance: acceptance,
            acceptanceSignature: _signAcceptance(acceptance, predicted),
            strip: _strip(terms, id, predicted)
        });
    }

    function _fundEscrow(uint256 count) internal {
        uint256 escrow = PlanParams.markEscrowFor(count);
        usdc.mint(address(this), escrow);
        usdc.approve(address(factory), escrow);
    }

    function _originate(PlanId.PlanTerms memory terms) internal returns (InstallmentPlan) {
        planId = PlanId.derive(terms);
        firstDue = terms.firstDueDate;
        address predicted = factory.predictAddress(planId);

        PlanFactory.OriginationRequest memory request = _request(terms, _detail());
        _fundEscrow(terms.installmentCount);

        (, address deployed) = factory.originate(request);
        assertEq(deployed, predicted, "deployment did not land on the predicted address");

        plan = InstallmentPlan(deployed);
        return plan;
    }

    // ─── Schedule, recomputed independently of the contract ──────────────────
    //
    // These deliberately do not call the plan. A test that asked the contract when a
    // payment was due and then asserted the contract agreed would prove nothing.

    function _dueDate(bytes32 id, uint256 start, uint256 index) internal pure returns (uint256) {
        return _dueDate(id, start, INTERVAL, index);
    }

    function _dueDate(bytes32 id, uint256 start, uint256 gap, uint256 index) internal pure returns (uint256) {
        if (index == 0) return start;
        int256 shifted = int256(start + index * gap) + PlanParams.jitter(id);
        return uint256(shifted);
    }

    function _amountAt(uint256 principal, uint256 count, uint256 index) internal pure returns (uint256) {
        uint256 base = principal / count;
        return index == 0 ? base + (principal % count) : base;
    }

    function _acceptance(
        PlanId.PlanTerms memory terms,
        bytes32 id
    ) internal pure returns (PlanAcceptance.Acceptance memory) {
        return PlanAcceptance.Acceptance({
            planId: id,
            borrower: terms.borrower,
            merchant: terms.merchant,
            token: terms.token,
            principal: terms.principal,
            installmentCount: terms.installmentCount,
            firstInstallment: _amountAt(terms.principal, terms.installmentCount, 0),
            laterInstallment: _amountAt(terms.principal, terms.installmentCount, 1),
            firstDueDate: terms.firstDueDate,
            finalDueDate: _dueDate(id, terms.firstDueDate, terms.interval, terms.installmentCount - 1),
            interval: terms.interval,
            termsHash: terms.termsHash,
            validUntil: terms.firstDueDate + 1 hours
        });
    }

    function _signAcceptance(
        PlanAcceptance.Acceptance memory acceptance,
        address planAddress
    ) internal view returns (bytes memory) {
        bytes32 digest = PlanAcceptance.digest(acceptance, block.chainid, planAddress);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BORROWER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _strip(
        PlanId.PlanTerms memory terms,
        bytes32 id,
        address payee
    ) internal view returns (bytes[] memory strip) {
        strip = new bytes[](terms.installmentCount);
        for (uint256 i = 0; i < terms.installmentCount; ++i) {
            strip[i] = _signCheck(terms, id, payee, i, BORROWER_KEY);
        }
    }

    function _signCheck(
        PlanId.PlanTerms memory terms,
        bytes32 id,
        address payee,
        uint256 index,
        uint256 key
    ) internal view returns (bytes memory) {
        uint256 due = _dueDate(id, terms.firstDueDate, terms.interval, index);
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                terms.borrower,
                payee,
                _amountAt(terms.principal, terms.installmentCount, index),
                due - 1,
                due + PlanParams.AUTHORIZATION_WINDOW,
                PlanId.checkNonce(id, index)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Sign the cancellation the borrower would submit to the token directly.
    function _signCancellation(uint256 index) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(usdc.CANCEL_AUTHORIZATION_TYPEHASH(), borrower, PlanId.checkNonce(planId, index))
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BORROWER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _fundBorrower(uint256 amount) internal {
        usdc.mint(borrower, amount);
    }
}
