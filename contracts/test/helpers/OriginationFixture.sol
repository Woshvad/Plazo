// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {PlanFixture} from "./PlanFixture.sol";

import {InstallmentPlan} from "../../src/InstallmentPlan.sol";
import {PlanFactory} from "../../src/PlanFactory.sol";
import {JurisdictionRegistry} from "../../src/JurisdictionRegistry.sol";
import {IdentityFXRouter} from "../../src/IdentityFXRouter.sol";
import {ParameterRegistry} from "../../src/ParameterRegistry.sol";
import {EligibilityRegistry} from "../../src/EligibilityRegistry.sol";
import {AllowlistCompliance} from "../../src/AllowlistCompliance.sol";
import {ArcLocalPayout} from "../../src/ArcLocalPayout.sol";
import {ReceivableToken} from "../../src/ReceivableToken.sol";
import {MerchantRegistry} from "../../src/MerchantRegistry.sol";
import {CreditPool} from "../../src/CreditPool.sol";
import {FirstPaymentDefaultSwitch} from "../../src/FirstPaymentDefaultSwitch.sol";
import {Tier0Underwriter} from "../../src/Tier0Underwriter.sol";
import {OriginationPause} from "../../src/OriginationPause.sol";
import {CheckoutRouter} from "../../src/CheckoutRouter.sol";
import {IComplianceOracle} from "../../src/interfaces/IComplianceOracle.sol";
import {ICreditPool} from "../../src/interfaces/ICreditPool.sol";
import {IUnderwritingPartner} from "../../src/interfaces/IUnderwritingPartner.sol";
import {LimitAttestation} from "../../src/libraries/LimitAttestation.sol";
import {ParameterKeys} from "../../src/libraries/ParameterKeys.sol";
import {PlanId} from "../../src/libraries/PlanId.sol";
import {PlanParams} from "../../src/libraries/PlanParams.sol";
import {TermsDetail} from "../../src/libraries/TermsDetail.sol";
import {MockArcUsdc} from "../mocks/MockArcUsdc.sol";

/// @notice The whole Phase 3 origination stack, wired the way `Deploy.s.sol` wires it.
///
/// @dev Extends `PlanFixture` rather than replacing it, so every plan a Phase 3 test
///      originates carries a real strip and a real acceptance signed by the same
///      helpers Phase 2 used. The point is that origination is the only thing that
///      changed: a plan produced through the router is byte-identical to a plan
///      produced by calling the factory directly, and the tests would notice if it
///      were not.
///
///      The deployment order here mirrors the script exactly, including the
///      `setOriginator` handshake that resolves the factory/router circularity. A
///      fixture that wired the stack more conveniently than production would be a
///      fixture that tests a deployment nobody runs.
abstract contract OriginationFixture is PlanFixture {
    ParameterRegistry internal parameters;
    EligibilityRegistry internal eligibility;
    AllowlistCompliance internal compliance;
    ArcLocalPayout internal payout;
    ReceivableToken internal receivable;
    MerchantRegistry internal merchants;
    CreditPool internal creditPool;
    FirstPaymentDefaultSwitch internal killSwitch;
    Tier0Underwriter internal tier0;
    OriginationPause internal pauses;
    CheckoutRouter internal checkout;

    uint256 internal constant UNDERWRITER_KEY = 0x0DDE511;
    address internal underwriterKey;

    address internal merchantPayout = address(0xBADA55);
    address internal lender = address(0x11EDE7);

    /// @dev Seed capital. Large enough that the 10% Tier-0 book share and the 20%
    ///      per-merchant concentration cap do not bind on a $100 plan, so a test that
    ///      trips a cap tripped the cap it meant to.
    uint256 internal constant SENIOR_SEED = 80_000e6;
    uint256 internal constant JUNIOR_SEED = 20_000e6;

    function _deployStack() internal virtual override {
        borrower = vm.addr(BORROWER_KEY);
        underwriterKey = vm.addr(UNDERWRITER_KEY);

        usdc = new MockArcUsdc();
        jurisdictions = new JurisdictionRegistry(address(this));
        router = new IdentityFXRouter(address(usdc));

        parameters = new ParameterRegistry(address(this));
        eligibility = new EligibilityRegistry(address(this));
        compliance = new AllowlistCompliance(address(this), address(this));
        payout = new ArcLocalPayout();

        receivable = new ReceivableToken(address(this), address(eligibility));
        merchants = new MerchantRegistry(address(this), address(usdc), address(parameters));
        creditPool = new CreditPool(address(this), address(usdc), address(parameters), address(eligibility));

        killSwitch = new FirstPaymentDefaultSwitch(address(this), address(parameters));
        tier0 = new Tier0Underwriter(address(this), address(parameters), address(killSwitch));
        pauses = new OriginationPause(address(this), address(this));

        implementation = address(new InstallmentPlan());
        factory = new PlanFactory(implementation, address(jurisdictions), address(this));

        checkout = new CheckoutRouter(
            address(this),
            CheckoutRouter.Wiring({
                factory: address(factory),
                pool: address(creditPool),
                merchants: address(merchants),
                receivable: address(receivable),
                underwriter: address(tier0),
                killSwitch: address(killSwitch),
                pauses: address(pauses),
                parameters: address(parameters),
                compliance: address(compliance),
                payout: address(payout),
                fxRouter: address(router)
            })
        );

        factory.setOriginator(address(checkout));
        creditPool.grantRole(creditPool.ORIGINATOR_ROLE(), address(checkout));
        receivable.grantRole(receivable.ISSUER_ROLE(), address(checkout));
        tier0.grantRole(tier0.ORIGINATOR_ROLE(), address(checkout));
        killSwitch.grantRole(killSwitch.REGISTRAR_ROLE(), address(checkout));
        merchants.grantRole(merchants.BOOKKEEPER_ROLE(), address(checkout));
        merchants.grantRole(merchants.KYB_ROLE(), address(this));
        checkout.grantRole(checkout.UNDERWRITER_ROLE(), underwriterKey);

        eligibility.setGlobal(address(creditPool), true);
        eligibility.setGlobal(address(checkout), true);
        eligibility.setGlobal(lender, true);
        tier0.setPool(address(creditPool));

        pool = address(creditPool);
    }

    /// @notice Capitalise the book and open the gate.
    function _seedPool() internal {
        _deposit(ICreditPool.Tranche.Senior, SENIOR_SEED);
        _deposit(ICreditPool.Tranche.Junior, JUNIOR_SEED);
        _fundReserve((creditPool.totalAssets() * 600) / PlanParams.BPS);
    }

    function _deposit(ICreditPool.Tranche tranche, uint256 amount) internal {
        usdc.mint(lender, amount);
        vm.startPrank(lender);
        usdc.approve(address(creditPool), amount);
        creditPool.deposit(tranche, amount);
        vm.stopPrank();
    }

    function _fundReserve(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(creditPool), amount);
        creditPool.fundReserve(amount);
    }

    /// @notice Onboard a merchant the way a real one would be onboarded.
    /// @dev The domain is read into a local first. `vm.prank` is consumed by the next
    ///      external call, and an argument that is itself an external call consumes it
    ///      — so `register(recipient, payout.ARC_DOMAIN())` would prank the domain
    ///      read and register the *test contract* as the merchant.
    function _onboardMerchant(address who, uint256 bond) internal {
        uint32 domain = payout.ARC_DOMAIN();
        vm.prank(who);
        merchants.register(merchantPayout, domain);
        merchants.attestKyb(who, true);
        if (bond > 0) {
            usdc.mint(address(this), bond);
            usdc.approve(address(merchants), bond);
            merchants.postBond(who, bond);
        }
    }

    function _screenClear(address account) internal {
        compliance.screen(account, IComplianceOracle.Status.Clear);
    }

    /// @dev Everything origination needs, short of the plan itself.
    function _prepareOrigination() internal {
        _seedPool();
        _onboardMerchant(merchant, 500e6);
        _screenClear(borrower);
        _screenClear(merchant);
    }

    // ─── Terms and detail ────────────────────────────────────────────────────

    /// @dev The settlement recipient is the pool, and the router refuses anything
    ///      else. A merchant naming themselves here would be paid twice — once by the
    ///      pool at checkout and again by every installment the borrower makes.
    function _detail() internal view virtual override returns (TermsDetail.Detail memory) {
        return TermsDetail.Detail({
            jurisdiction: jurisdictions.DEFAULT_JURISDICTION(),
            lineItemsHash: keccak256("one pair of boots"),
            mdrBps: 400,
            lateFeeFlat: PlanParams.LATE_FEE_FLAT,
            signerClass: signerClass,
            settlementRecipient: address(creditPool),
            fxRouter: address(router)
        });
    }

    // ─── Attestation ─────────────────────────────────────────────────────────

    function _attestation(
        bytes32 sessionId,
        bytes32 id,
        uint256 limit
    ) internal view returns (LimitAttestation.Attestation memory) {
        return LimitAttestation.Attestation({
            sessionId: sessionId,
            planId: id,
            borrower: borrower,
            personId: tier0.pseudonymousId(borrower),
            identityClass: uint8(IUnderwritingPartner.IdentityClass.Pseudonymous),
            limit: limit,
            validUntil: block.timestamp + 5 minutes
        });
    }

    function _signAttestation(LimitAttestation.Attestation memory attestation, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = LimitAttestation.digest(attestation, block.chainid, address(checkout));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // ─── Origination through the router ──────────────────────────────────────

    function _originationInput(PlanId.PlanTerms memory terms, bytes32 sessionId, uint256 limit)
        internal
        view
        returns (CheckoutRouter.OriginationInput memory)
    {
        bytes32 id = PlanId.derive(terms);
        LimitAttestation.Attestation memory attestation = _attestation(sessionId, id, limit);
        return CheckoutRouter.OriginationInput({
            request: _request(terms, _detail()),
            attestation: attestation,
            attestationSignature: _signAttestation(attestation, UNDERWRITER_KEY)
        });
    }

    /// @notice Originate through the router, as a checkout would.
    function _checkout(PlanId.PlanTerms memory terms, bytes32 sessionId, uint256 limit)
        internal
        returns (InstallmentPlan)
    {
        planId = PlanId.derive(terms);
        firstDue = terms.firstDueDate;

        CheckoutRouter.OriginationInput memory input = _originationInput(terms, sessionId, limit);
        (, address deployed) = checkout.originate(input);

        plan = InstallmentPlan(deployed);
        return plan;
    }

    /// @notice The default $100 four-check plan, through the router.
    function _checkoutDefault() internal returns (InstallmentPlan) {
        return _checkout(_terms(PRINCIPAL, COUNT, 1), keccak256("session-1"), 200e6);
    }

    function _setParameter(bytes32 key, uint256 value) internal {
        parameters.set(key, value);
    }

    // ─── Driving a plan to a terminal state ──────────────────────────────────

    /// @notice Pay a plan off by push, as a borrower curing early would.
    /// @dev `repay` rather than four collections because these tests are about what
    ///      happens *after* a plan finishes, and Phase 2 already proved the
    ///      collection path exhaustively. Using the cheap route here keeps a Tier-0
    ///      growth test about growth.
    function _payOff(InstallmentPlan p) internal {
        uint256 owed = p.payoffAmount();
        usdc.mint(borrower, owed);
        vm.startPrank(borrower);
        usdc.approve(address(p), owed);
        p.repay(owed);
        vm.stopPrank();
    }

    /// @notice Let the first installment go unpaid and record the miss.
    function _missFirstInstallment(InstallmentPlan p) internal {
        vm.warp(p.graceEndsAt(0) + 1);
        vm.prank(keeper);
        p.markMissed(0);
    }

    /// @notice Originate, pay off, and settle the outcome with the underwriter.
    /// @dev Returns the plan id, because the caller usually wants to assert against
    ///      the person's standing rather than the plan.
    function _completeCleanPlan(uint256 nonce) internal returns (bytes32) {
        InstallmentPlan p = _checkout(
            _terms(PRINCIPAL, COUNT, nonce), keccak256(abi.encode("session", nonce)), 5_000e6
        );
        bytes32 id = planId;
        _payOff(p);
        tier0.notePlanOutcome(id);
        return id;
    }

    function _personId() internal view returns (bytes32) {
        return tier0.pseudonymousId(borrower);
    }

    /// @dev A parameter key list the fixture reaches for often enough to name.
    function _minTicket() internal view returns (uint256) {
        return parameters.get(ParameterKeys.MIN_TICKET);
    }
}
