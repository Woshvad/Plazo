// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";

import {OriginationFixture} from "./helpers/OriginationFixture.sol";

import {CheckoutRouter} from "../src/CheckoutRouter.sol";
import {TranchedCreditPool} from "../src/TranchedCreditPool.sol";
import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {PlanFactory} from "../src/PlanFactory.sol";
import {IComplianceOracle} from "../src/interfaces/IComplianceOracle.sol";
import {ICreditPool} from "../src/interfaces/ICreditPool.sol";
import {IUnderwritingPartner} from "../src/interfaces/IUnderwritingPartner.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {LimitAttestation} from "../src/libraries/LimitAttestation.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
import {PlanId} from "../src/libraries/PlanId.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";
import {TermsDetail} from "../src/libraries/TermsDetail.sol";

/// @notice The origination transaction, end to end.
///
/// @dev Success criteria 1 and 5. What is being asserted is not that each contract
///      works — the component suites do that — but that the *ordering* is right: the
///      merchant is paid before the transaction ends, the escrow is in the plan
///      before the plan can refuse to exist without it, the book is exactly as rich
///      afterwards as before, and nothing about the plan a router produced differs
///      from a plan the factory produced directly.
contract OriginationTest is OriginationFixture {
    function setUp() public {
        _deployStack();
        _prepareOrigination();
    }

    // ─── The happy path ──────────────────────────────────────────────────────

    /// @notice CHKT-04. The merchant has the money when the transaction ends.
    ///
    /// @dev Not "within one block" — within one *transaction*. Arc finalises in about
    ///      half a second with no reorgs, so there is no pending state for a merchant
    ///      to reconcile and no window in which the goods have gone and the money has
    ///      not. Every incumbent's T+2 exists because their rail cannot do this.
    ///
    ///      **The merchant here is `Instant`, and that is the claim, not a workaround
    ///      (D-09).** CHKT-04 was written about digital and low-risk categories, and
    ///      MERCH-04 explicitly carves physical goods out of it rather than regressing
    ///      it. Reaching `Instant` needs both halves of D-06 — a seasoned merchant and
    ///      a governance opt-out — so the setup below is the only route there is, and
    ///      running it here is what keeps this test a statement about the path CHKT-04
    ///      describes. The escrowed path's own settlement timing is
    ///      `SettlementEscrow.t.sol`'s to assert.
    function test_theMerchantIsPaidInFullMinusMdrInTheSameTransaction() public {
        vm.warp(vm.getBlockTimestamp() + parameters.get(ParameterKeys.MERCHANT_VESTING_WINDOW) + 1);
        merchants.setCategory(merchant, MerchantRegistry.SettlementCategory.Instant);
        _screenClear(borrower);
        _screenClear(merchant);

        uint256 mdr = checkout.mdrFor(PRINCIPAL);
        uint256 net = PRINCIPAL - mdr;
        uint256 withheld = (net * merchants.vestingBpsFor(merchant)) / PlanParams.BPS;

        uint256 before = usdc.balanceOf(merchantPayout);
        _checkoutDefault();

        assertEq(
            usdc.balanceOf(merchantPayout) - before,
            net - withheld,
            "the merchant was not credited the full principal less MDR and the vesting withholding"
        );
        assertEq(mdr, (PRINCIPAL * 400) / PlanParams.BPS, "MDR was not read from the registry");
    }

    /// @notice The book is no richer for having originated.
    ///
    /// @dev The single most important assertion in this file. A pool that recognised
    ///      MDR at checkout would show a profit the moment it lent money, which is
    ///      how a book flatters itself into a loss: every origination looks like
    ///      income, and the reversal only arrives when the borrower does not pay.
    function test_originationIsNavNeutral() public {
        uint256 before = creditPool.totalAssets();
        _checkoutDefault();
        assertEq(creditPool.totalAssets(), before, "origination moved NAV");
    }

    /// @notice The plan is funded to pay for its own delinquency mark.
    /// @dev And funded *before* it exists — the escrow is sent to the counterfactual
    ///      address so `initialize` can check its own balance rather than trust the
    ///      factory. STATE.md's requirement that the escrow come out of MDR is the
    ///      other half: the pool books `mdr − escrow` as deferred income, so the
    ///      delinquency budget is paid for by the merchant's discount and not by an
    ///      operator's float.
    function test_thePlanIsFundedWithItsOwnMarkEscrowOutOfMdr() public {
        InstallmentPlan p = _checkoutDefault();

        uint256 escrow = PlanParams.markEscrowFor(COUNT);
        assertEq(p.markEscrow(), escrow, "the plan did not record its escrow");
        assertEq(usdc.balanceOf(address(p)), escrow, "the plan does not hold its escrow");
        assertTrue(p.markBudgetIsFunded(), "the plan cannot afford its own marks");

        TranchedCreditPool.PlanBook memory book = creditPool.bookOf(planId);
        assertEq(
            book.deferredIncome, checkout.mdrFor(PRINCIPAL) - escrow, "the escrow was not funded out of MDR"
        );
    }

    /// @notice GOV-10. The receivable exists from the first origination.
    function test_theReceivableIsMintedToThePool() public {
        _checkoutDefault();
        assertTrue(receivable.exists(planId), "no receivable was minted");
        assertEq(receivable.ownerOf(uint256(planId)), address(creditPool), "the pool does not hold it");
    }

    /// @notice The plan the router produced is the plan the borrower signed against.
    function test_thePlanLandsOnTheAddressTheBorrowerSigned() public {
        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        address predicted = factory.predictAddress(PlanId.derive(terms));

        InstallmentPlan p = _checkout(terms, keccak256("session-1"), 200e6);

        assertEq(address(p), predicted, "the clone did not land on the predicted address");
        assertEq(p.settlementRecipient(), address(creditPool), "the plan settles somewhere else");
        assertEq(uint8(p.state()), uint8(IInstallmentPlan.PlanState.Pending), "plan not pending");
    }

    /// @notice Everything downstream of origination knows the plan exists.
    function test_originationRegistersWithEveryDownstreamLedger() public {
        InstallmentPlan p = _checkoutDefault();

        assertEq(creditPool.merchantExposure(merchant), PRINCIPAL, "pool exposure not recorded");
        assertEq(merchants.outstandingFrontedFor(merchant), PRINCIPAL, "merchant exposure not recorded");
        assertEq(tier0.outstandingExposure(), PRINCIPAL, "tier-0 exposure not recorded");
        assertEq(tier0.personOf(_personId()).activePlans, 1, "the active-plan slot did not close");
        assertEq(killSwitch.registrationOf(planId).plan, address(p), "the kill switch was not told");
        assertEq(checkout.sessionPlan(keccak256("session-1")), planId, "the session was not recorded");
    }

    // ─── The attestation (CHKT-05) ───────────────────────────────────────────

    /// @notice A stolen underwriting key cannot mint credit.
    ///
    /// @dev The attestation is one input among five and it is only ever the smallest
    ///      that binds. Here it claims a limit ten times the Tier-0 cap and the
    ///      origination still fails at the cap — so the answer to "what can someone
    ///      do with the signing key" is "decline business", not "lend the book out".
    function test_anAttestationCannotRaiseWhatTheChainWouldAllow() public {
        PlanId.PlanTerms memory terms = _terms(1000e6, COUNT, 7);
        CheckoutRouter.OriginationInput memory input =
            _originationInput(terms, keccak256("session-greedy"), 5000e6);

        // The Tier-0 cap for a borrower with no history is the initial limit.
        uint256 tierCap = parameters.get(ParameterKeys.TIER0_INITIAL_LIMIT);
        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.LimitExceeded.selector, 1000e6, tierCap));
        checkout.originate(input);
    }

    function test_anAttestationFromAnUnauthorizedKeyIsRefused() public {
        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        bytes32 id = PlanId.derive(terms);
        LimitAttestation.Attestation memory a = _attestation(keccak256("s"), id, 200e6);

        uint256 impostor = 0xBADBAD;
        CheckoutRouter.OriginationInput memory input = CheckoutRouter.OriginationInput({
            request: _request(terms, _detail()),
            attestation: a,
            attestationSignature: _signAttestation(a, impostor),
            fxMid: _noMid(),
            fxMidSignature: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(CheckoutRouter.AttestationSignerUnauthorized.selector, vm.addr(impostor))
        );
        checkout.originate(input);
    }

    /// @notice An attestation is not a bearer credential.
    function test_anExpiredAttestationIsRefused() public {
        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        CheckoutRouter.OriginationInput memory input = _originationInput(terms, keccak256("s"), 200e6);

        vm.warp(vm.getBlockTimestamp() + 6 minutes);

        vm.expectRevert(
            abi.encodeWithSelector(CheckoutRouter.AttestationExpired.selector, input.attestation.validUntil)
        );
        checkout.originate(input);
    }

    /// @notice A long-dated attestation is refused even before it expires.
    /// @dev The ceiling on time-to-live is what makes "short-expiry" a property rather
    ///      than a convention the issuing service happens to follow. An underwriting
    ///      service that started issuing week-long attestations would be issuing
    ///      bearer credentials, and the chain should not accept them.
    function test_anAttestationValidTooLongIsRefused() public {
        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        bytes32 id = PlanId.derive(terms);

        LimitAttestation.Attestation memory a = _attestation(keccak256("s"), id, 200e6);
        a.validUntil = vm.getBlockTimestamp() + 2 days;

        CheckoutRouter.OriginationInput memory input = CheckoutRouter.OriginationInput({
            request: _request(terms, _detail()),
            attestation: a,
            attestationSignature: _signAttestation(a, UNDERWRITER_KEY),
            fxMid: _noMid(),
            fxMidSignature: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                CheckoutRouter.AttestationTooLong.selector,
                2 days,
                parameters.get(ParameterKeys.ATTESTATION_MAX_TTL)
            )
        );
        checkout.originate(input);
    }

    /// @notice An attestation issued for one plan cannot originate another.
    function test_anAttestationIsBoundToItsPlan() public {
        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        bytes32 wrongId = PlanId.derive(_terms(PRINCIPAL, COUNT, 99));

        LimitAttestation.Attestation memory a = _attestation(keccak256("s"), wrongId, 200e6);
        CheckoutRouter.OriginationInput memory input = CheckoutRouter.OriginationInput({
            request: _request(terms, _detail()),
            attestation: a,
            attestationSignature: _signAttestation(a, UNDERWRITER_KEY),
            fxMid: _noMid(),
            fxMidSignature: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                CheckoutRouter.AttestationPlanMismatch.selector, PlanId.derive(terms), wrongId
            )
        );
        checkout.originate(input);
    }

    /// @notice CHKT-02's replay boundary. A session originates once.
    function test_aSessionCannotOriginateTwice() public {
        bytes32 session = keccak256("session-1");
        _checkout(_terms(PRINCIPAL, COUNT, 1), session, 200e6);

        // A second plan, same session. Different origination nonce, so the plan id
        // and every authorization nonce differ — only the session collides.
        PlanId.PlanTerms memory second = _terms(PRINCIPAL, COUNT, 2);
        CheckoutRouter.OriginationInput memory input = _originationInput(second, session, 200e6);

        vm.expectRevert(
            abi.encodeWithSelector(CheckoutRouter.SessionAlreadyOriginated.selector, session, planId)
        );
        checkout.originate(input);
    }

    /// @notice Only a band reaches the log, never the figure.
    ///
    /// @dev CHKT-05's detectability half. A band is enough for an operator to see an
    ///      anomalous distribution from a compromised key and enough for an LP to see
    ///      the book's shape; it is not enough to reconstruct a borrower's exact
    ///      credit line from a public log, which is a permanent, uncorrectable
    ///      disclosure about a person.
    function test_theEmittedLimitIsABandNotAFigure() public {
        uint256 attested = 200e6;

        vm.recordLogs();
        _checkout(_terms(PRINCIPAL, COUNT, 1), keccak256("session-1"), attested);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("LimitAttested(bytes32,uint8,address)");

        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] != topic) continue;
            found = true;
            uint8 band = abi.decode(logs[i].data, (uint8));
            assertEq(band, checkout.bandOf(attested), "the emitted band is not the band");
            assertTrue(logs[i].data.length == 32, "the attestation log carries more than a single band word");
        }
        assertTrue(found, "no LimitAttested was emitted");

        // Two limits inside one band are indistinguishable in the log, which is the
        // property. 150 and 200 both land in band 1.
        assertEq(checkout.bandOf(150e6), checkout.bandOf(200e6), "the band separates what it should not");
    }

    // ─── Compliance (CHKT-03) ────────────────────────────────────────────────

    /// @notice An unscreened borrower cannot originate. Unknown is not clear.
    function test_anUnscreenedBorrowerCannotOriginate() public {
        compliance.screen(borrower, IComplianceOracle.Status.Unknown);

        CheckoutRouter.OriginationInput memory input =
            _originationInput(_terms(PRINCIPAL, COUNT, 1), keccak256("s"), 200e6);

        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.BorrowerNotScreened.selector, borrower));
        checkout.originate(input);
    }

    function test_aDeniedMerchantCannotOriginate() public {
        compliance.screen(merchant, IComplianceOracle.Status.Denied);

        CheckoutRouter.OriginationInput memory input =
            _originationInput(_terms(PRINCIPAL, COUNT, 1), keccak256("s"), 200e6);

        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.MerchantNotScreened.selector, merchant));
        checkout.originate(input);
    }

    /// @notice OPS-05. A screen has a shelf life.
    /// @dev A `Clear` from six months ago is a record of a question nobody has asked
    ///      recently, and the entire point of consuming compliance as a stream is that
    ///      a party's standing changes between screens.
    function test_aStaleScreenIsNotAScreen() public {
        uint256 screenedAt = vm.getBlockTimestamp();
        vm.warp(vm.getBlockTimestamp() + 8 days);

        CheckoutRouter.OriginationInput memory input =
            _originationInput(_terms(PRINCIPAL, COUNT, 1), keccak256("s"), 200e6);

        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.ScreenStale.selector, borrower, screenedAt));
        checkout.originate(input);
    }

    // ─── Structural refusals ─────────────────────────────────────────────────

    /// @notice A merchant cannot name themselves the settlement recipient.
    ///
    /// @dev Without this check the merchant is paid twice: once by the pool at
    ///      checkout and again by every installment the borrower makes. It is the
    ///      cheapest attack in the whole design and the check is one comparison.
    function test_theSettlementRecipientMustBeThePool() public {
        TermsDetail.Detail memory detail = _detail();
        detail.settlementRecipient = merchant;

        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);
        terms.termsHash = TermsDetail.hash(detail);

        bytes32 id = PlanId.derive(terms);
        LimitAttestation.Attestation memory a = _attestation(keccak256("s"), id, 200e6);
        CheckoutRouter.OriginationInput memory input = CheckoutRouter.OriginationInput({
            request: _request(terms, detail),
            attestation: a,
            attestationSignature: _signAttestation(a, UNDERWRITER_KEY),
            fxMid: _noMid(),
            fxMidSignature: ""
        });

        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.SettlementRecipientNotAPool.selector, merchant));
        checkout.originate(input);
    }

    /// @notice The factory is the router's alone.
    ///
    /// @dev A permissionless `deploy` is a denial-of-service on a signed strip: anyone
    ///      watching a pending origination could deploy an uninitialized clone to the
    ///      address it names, after which the borrower's authorizations — whose nonces
    ///      are bound to that plan id — are unusable until they re-sign.
    function test_nobodyButTheRouterCanDeployAPlan() public {
        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 1);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PlanFactory.OnlyOriginator.selector, stranger));
        factory.deploy(terms);
    }

    /// @notice Only the factory's admin may name the originator.
    /// @dev It was one-shot through Phase 4 and is rotatable from Phase 5 (DEC-15),
    ///      because a one-shot gate made replacing the funding book cost a migration of
    ///      every outstanding strip. What has not changed is that a stranger cannot
    ///      touch it, which is the part the gate was ever for.
    function test_onlyTheAdminCanNameTheOriginator() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PlanFactory.OnlyAdmin.selector, stranger));
        factory.setOriginator(stranger);
    }

    /// @notice The admin can give up the rotation right, and then nobody has it.
    function test_theOriginatorCanBeFrozen() public {
        factory.setAdmin(address(0));
        vm.expectRevert(abi.encodeWithSelector(PlanFactory.OnlyAdmin.selector, address(this)));
        factory.setOriginator(stranger);
    }

    /// @notice POOL-05. No origination before the reserve is prefunded to target.
    function test_originationIsClosedUntilTheReserveIsPrefunded() public {
        // A fresh stack with capital but no reserve.
        _deployStack();
        _onboardMerchant(merchant, 500e6);
        _screenClear(borrower);
        _screenClear(merchant);
        _seedTranche(ICreditPool.Tranche.Senior);
        _seedTranche(ICreditPool.Tranche.Junior);
        _requestDeposit(ICreditPool.Tranche.Junior, JUNIOR_SEED);
        _requestDeposit(ICreditPool.Tranche.Senior, SENIOR_SEED);
        _closeEpoch();

        assertFalse(creditPool.originationOpen(), "the gate is open with no reserve");

        CheckoutRouter.OriginationInput memory input =
            _originationInput(_terms(PRINCIPAL, COUNT, 1), keccak256("s"), 200e6);
        vm.expectRevert(TranchedCreditPool.OriginationClosed.selector);
        checkout.originate(input);

        _fundReserve((creditPool.totalAssets() * 600) / PlanParams.BPS);
        assertTrue(creditPool.originationOpen(), "the gate stayed shut after prefunding");
    }

    /// @notice A ticket below the protocol minimum is refused at the router.
    /// @dev The plan refuses it too. Both checks exist because they answer different
    ///      questions: the plan's is about whether the keeper market can service it,
    ///      the router's is about whether this deployment currently wants to.
    function test_aTicketBelowTheMinimumIsRefused() public {
        PlanId.PlanTerms memory terms = _terms(50e6, COUNT, 1);
        CheckoutRouter.OriginationInput memory input = _originationInput(terms, keccak256("s"), 200e6);

        vm.expectRevert(
            abi.encodeWithSelector(
                CheckoutRouter.TicketOutOfRange.selector,
                50e6,
                parameters.get(ParameterKeys.MIN_TICKET),
                parameters.get(ParameterKeys.MAX_TICKET)
            )
        );
        checkout.originate(input);
    }

    /// @notice A merchant who has not passed KYB cannot originate.
    function test_anUnverifiedMerchantCannotOriginate() public {
        _deployStack();
        _seedPool();
        _screenClear(borrower);
        _screenClear(merchant);
        uint32 domain = payout.ARC_DOMAIN();
        vm.prank(merchant);
        merchants.register(merchantPayout, domain);

        CheckoutRouter.OriginationInput memory input =
            _originationInput(_terms(PRINCIPAL, COUNT, 1), keccak256("s"), 200e6);

        vm.expectRevert(
            abi.encodeWithSelector(CheckoutRouter.MerchantIneligible.selector, "merchant not KYB verified")
        );
        checkout.originate(input);
    }

    // ─── The quote surface (CHKT-01, CHKT-08) ────────────────────────────────

    /// @notice The quote and the chain agree, so a fallback offer is not a guess.
    ///
    /// @dev CHKT-08 asks for a smaller-installment fallback rather than a flat
    ///      decline. That is only honest if the service can size the fallback against
    ///      the same number the router will enforce — otherwise "we can do $180 of
    ///      this $240 order" is a statement about the service's model rather than
    ///      about the chain.
    function test_theQuotedMaximumIsExactlyWhatTheRouterWillAccept() public {
        uint256 max = checkout.maxPrincipalFor(
            _personId(),
            IUnderwritingPartner.IdentityClass.Pseudonymous,
            TermsDetail.SignerClass.EOA,
            merchant,
            address(usdc),
            address(creditPool)
        );
        assertEq(max, parameters.get(ParameterKeys.TIER0_INITIAL_LIMIT), "the quote is not the tier cap");

        // One unit over is refused.
        PlanId.PlanTerms memory over = _terms(max + 1, COUNT, 3);
        CheckoutRouter.OriginationInput memory input = _originationInput(over, keccak256("s1"), max + 1);
        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.LimitExceeded.selector, max + 1, max));
        checkout.originate(input);

        // Exactly the quote goes through.
        _checkout(_terms(max, COUNT, 4), keccak256("s2"), max);
        assertEq(plan.principal(), max, "the quoted maximum did not originate");
    }

    function test_theQuoteIsZeroWhileTheBookIsShut() public {
        pauses.pause();
        uint256 max = checkout.maxPrincipalFor(
            _personId(),
            IUnderwritingPartner.IdentityClass.Pseudonymous,
            TermsDetail.SignerClass.EOA,
            merchant,
            address(usdc),
            address(creditPool)
        );
        assertEq(max, 0, "the quote offered credit while origination was paused");
    }
}
