// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {OriginationFixture} from "./helpers/OriginationFixture.sol";

import {CheckoutRouter} from "../src/CheckoutRouter.sol";
import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {Tier0Underwriter} from "../src/Tier0Underwriter.sol";
import {ICreditPool} from "../src/interfaces/ICreditPool.sol";
import {IUnderwritingPartner} from "../src/interfaces/IUnderwritingPartner.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";
import {TermsDetail} from "../src/libraries/TermsDetail.sol";

/// @notice Tier 0: credit for a borrower with no history.
///
/// @dev Success criterion 2, and every assertion here is load-bearing rather than
///      descriptive. DEC-02 put Tier 0 on pool capital from day one against a
///      research recommendation for a shadow book, with the risk accepted knowingly.
///      That decision is only defensible if the caps below actually bind, so this
///      file spends most of its length proving that each of them does.
contract Tier0Test is OriginationFixture {
    IUnderwritingPartner.IdentityClass internal constant PSEUDONYMOUS =
    IUnderwritingPartner.IdentityClass.Pseudonymous;
    IUnderwritingPartner.IdentityClass internal constant IDENTIFIED =
    IUnderwritingPartner.IdentityClass.Identified;

    function setUp() public {
        _deployStack();
        _prepareOrigination();
    }

    // ─── Growth ──────────────────────────────────────────────────────────────

    /// @notice UW-01. ×1.25 per cleanly completed plan.
    function test_theLimitGrowsByAQuarterOnEachCleanCompletion() public {
        bytes32 person = _personId();
        uint256 initial = parameters.get(ParameterKeys.TIER0_INITIAL_LIMIT);

        assertEq(tier0.capFor(person, PSEUDONYMOUS, TermsDetail.SignerClass.EOA), initial);

        _completeCleanPlan(1);
        assertEq(
            tier0.capFor(person, PSEUDONYMOUS, TermsDetail.SignerClass.EOA),
            (initial * 12_500) / PlanParams.BPS,
            "one clean completion did not grow the limit by a quarter"
        );

        _completeCleanPlan(2);
        assertEq(
            tier0.capFor(person, PSEUDONYMOUS, TermsDetail.SignerClass.EOA),
            (((initial * 12_500) / PlanParams.BPS) * 12_500) / PlanParams.BPS,
            "growth did not compound"
        );
    }

    /// @notice A plan that was late and cured is not a clean completion.
    ///
    /// @dev The distinction the whole growth curve rests on. If curing counted as
    ///      clean, a borrower could establish a pattern of missing every payment and
    ///      paying a week late while their limit rose — and the book would be
    ///      rewarding exactly the behaviour that costs it money in servicing and
    ///      predicts the behaviour that costs it principal.
    function test_aLatePaymentIsNotACleanCompletion() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        _missFirstInstallment(p);
        _payOff(p);
        tier0.notePlanOutcome(id);

        Tier0Underwriter.Person memory person = tier0.personOf(_personId());
        assertEq(person.cleanCompletions, 0, "a marked plan counted as a clean completion");
        assertEq(person.activePlans, 0, "the active-plan slot did not reopen");
        assertEq(
            tier0.capFor(_personId(), PSEUDONYMOUS, TermsDetail.SignerClass.EOA),
            parameters.get(ParameterKeys.TIER0_INITIAL_LIMIT),
            "the limit grew after a missed installment"
        );
    }

    /// @notice Nobody can hand a borrower a limit increase.
    /// @dev Including the admin. Growth is derived from plan contracts anyone can
    ///      read, and `notePlanOutcome` takes no outcome argument precisely so a
    ///      caller-supplied "this one went fine" is not a limit increase anybody can
    ///      mint.
    function test_anUnfinishedPlanCannotBeSettled() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        vm.expectRevert(
            abi.encodeWithSelector(Tier0Underwriter.PlanNotTerminal.selector, id, uint8(p.state()))
        );
        tier0.notePlanOutcome(id);
    }

    // ─── Caps ────────────────────────────────────────────────────────────────

    /// @notice Pseudonymous and identity-linked borrowers cap separately.
    ///
    /// @dev The pseudonymous cap is what an attacker gets per wallet they are willing
    ///      to create. Sybil resistance for a permissionless credit product cannot
    ///      come from the identifier, so it comes from the number.
    function test_theTwoIdentityClassesCapSeparately() public {
        bytes32 person = _personId();

        // Eleven clean completions. 1.25¹¹ is 11.6×, so the growth curve would reach
        // $1,164 and both caps have to be the thing that stops it.
        for (uint256 i = 1; i <= 11; ++i) {
            _completeCleanPlan(i);
        }

        assertEq(
            tier0.capFor(person, PSEUDONYMOUS, TermsDetail.SignerClass.EOA),
            parameters.get(ParameterKeys.TIER0_PSEUDONYMOUS_CAP),
            "the pseudonymous cap did not bind"
        );
        assertEq(
            tier0.capFor(person, IDENTIFIED, TermsDetail.SignerClass.EOA),
            parameters.get(ParameterKeys.TIER0_IDENTIFIED_CAP),
            "the identity-linked cap did not bind"
        );
        assertGt(
            parameters.get(ParameterKeys.TIER0_IDENTIFIED_CAP),
            parameters.get(ParameterKeys.TIER0_PSEUDONYMOUS_CAP),
            "identity bought the borrower nothing"
        );
    }

    /// @notice UW-01. One active plan until the first completes.
    ///
    /// @dev Stacking is how BNPL borrowers get into trouble and how BNPL books do.
    ///      The protocol can only see its own book, so it enforces what it can see
    ///      completely rather than what it wishes it could see partially.
    function test_onlyOneActivePlanPerPerson() public {
        _checkout(_terms(PRINCIPAL, COUNT, 1), keccak256("s1"), 5000e6);
        InstallmentPlan first = plan;

        assertEq(
            tier0.capFor(_personId(), PSEUDONYMOUS, TermsDetail.SignerClass.EOA),
            0,
            "a second plan was available while the first was open"
        );

        CheckoutRouter.OriginationInput memory second =
            _originationInput(_terms(PRINCIPAL, COUNT, 2), keccak256("s2"), 5000e6);
        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.LimitExceeded.selector, PRINCIPAL, 0));
        checkout.originate(second);

        bytes32 firstId = first.planId();
        _payOff(first);
        tier0.notePlanOutcome(firstId);

        _checkout(_terms(PRINCIPAL, COUNT, 3), keccak256("s3"), 5000e6);
        assertEq(tier0.personOf(_personId()).activePlans, 1, "the slot did not reopen");
    }

    /// @notice Aggregation is per person, not per wallet.
    ///
    /// @dev Two wallets attested to the same `personId` share one limit and one
    ///      active-plan slot. The commitment says nothing about who they are; it says
    ///      only that the underwriter believes they are the same borrower.
    function test_twoWalletsUnderOnePersonShareOneSlot() public {
        bytes32 person = keccak256("an attested person");

        tier0.grantRole(tier0.ORIGINATOR_ROLE(), address(this));
        tier0.notePlan(person, IDENTIFIED, keccak256("plan-a"), 100e6);

        assertEq(
            tier0.capFor(person, IDENTIFIED, TermsDetail.SignerClass.EOA),
            0,
            "the same person got a second slot through a different wallet"
        );
    }

    /// @notice UW-10. A mutable signer carries a reduced cap.
    ///
    /// @dev An EOA's validation logic is its address and cannot change, so its strip
    ///      stays valid by construction. A contract account can change its validation
    ///      logic whenever it likes, so a strip it signed is only as good as the last
    ///      time someone checked — and that check is what the plan's bountied
    ///      `revalidate()` performs. The reduction is the price of the interval
    ///      between checks.
    function test_aContractSignerCarriesAReducedCap() public view {
        bytes32 person = _personId();
        uint256 eoa = tier0.capFor(person, PSEUDONYMOUS, TermsDetail.SignerClass.EOA);
        uint256 contractSigner = tier0.capFor(person, PSEUDONYMOUS, TermsDetail.SignerClass.Contract);

        assertEq(
            contractSigner,
            (eoa * parameters.get(ParameterKeys.CONTRACT_SIGNER_CAP_BPS)) / PlanParams.BPS,
            "the contract-signer reduction did not apply"
        );
        assertLt(contractSigner, eoa, "a mutable signer got the full cap");
    }

    /// @notice UW-02. Tier-0 paper is capped as a share of the book, onchain.
    ///
    /// @dev The constraint DEC-02 traded the shadow book for. A cap that lived in an
    ///      operator's configuration would be a cap that is off during the incident.
    function test_tierZeroPaperIsCappedAsAShareOfTheBook() public {
        uint256 assets = creditPool.totalAssets();
        uint256 shareBps = parameters.get(ParameterKeys.TIER0_BOOK_SHARE_BPS);
        assertEq(tier0.bookHeadroom(), (assets * shareBps) / PlanParams.BPS, "headroom is not the share");

        // Squeeze the share until the headroom is below the initial limit.
        _setParameter(ParameterKeys.TIER0_BOOK_SHARE_BPS, 100);
        uint256 squeezed = (assets * 100) / PlanParams.BPS;
        assertEq(tier0.bookHeadroom(), squeezed);

        // With exposure already at the ceiling, the cap is zero regardless of tier.
        tier0.grantRole(tier0.ORIGINATOR_ROLE(), address(this));
        tier0.notePlan(keccak256("whale"), IDENTIFIED, keccak256("plan-whale"), squeezed);

        assertEq(tier0.bookHeadroom(), 0, "headroom survived the book-share cap");
        assertEq(
            tier0.capFor(_personId(), IDENTIFIED, TermsDetail.SignerClass.EOA),
            0,
            "credit was available with the book-share cap exhausted"
        );
    }

    /// @notice A pseudonymous id cannot collide with an attested one.
    /// @dev Domain-separated, because a collision would let a borrower who cannot be
    ///      identified inherit the standing of one who can.
    function test_pseudonymousIdsAreDomainSeparated() public view {
        assertTrue(
            tier0.pseudonymousId(borrower) != keccak256(abi.encode(borrower)),
            "the pseudonymous id is a bare wallet hash"
        );
        assertTrue(
            tier0.pseudonymousId(borrower) != tier0.pseudonymousId(merchant),
            "two wallets share a pseudonymous id"
        );
    }

    // ─── Book share and exposure bookkeeping ─────────────────────────────────

    /// @notice Exposure comes back down when a plan finishes.
    function test_exposureIsReleasedOnSettlement() public {
        _checkoutDefault();
        assertEq(tier0.outstandingExposure(), PRINCIPAL, "exposure not taken");

        bytes32 id = planId;
        _payOff(plan);
        tier0.notePlanOutcome(id);

        assertEq(tier0.outstandingExposure(), 0, "exposure not released");
    }

    /// @notice A plan cannot be settled twice.
    function test_aPlanSettlesOnlyOnce() public {
        _checkoutDefault();
        bytes32 id = planId;
        _payOff(plan);
        tier0.notePlanOutcome(id);

        vm.expectRevert(abi.encodeWithSelector(Tier0Underwriter.PlanAlreadySettled.selector, id));
        tier0.notePlanOutcome(id);
    }
}
