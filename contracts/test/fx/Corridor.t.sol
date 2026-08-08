// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {CorridorFixture} from "../helpers/CorridorFixture.sol";

import {CheckoutRouter} from "../../src/CheckoutRouter.sol";
import {InstallmentPlan} from "../../src/InstallmentPlan.sol";
import {PlanFactory} from "../../src/PlanFactory.sol";
import {SettlementEscrow} from "../../src/SettlementEscrow.sol";
import {IInstallmentPlan} from "../../src/interfaces/IInstallmentPlan.sol";
import {IUnderwritingPartner} from "../../src/interfaces/IUnderwritingPartner.sol";
import {FxMidAttestation} from "../../src/libraries/FxMidAttestation.sol";
import {LimitAttestation} from "../../src/libraries/LimitAttestation.sol";
import {ParameterKeys} from "../../src/libraries/ParameterKeys.sol";
import {PlanAcceptance} from "../../src/libraries/PlanAcceptance.sol";
import {PlanId} from "../../src/libraries/PlanId.sol";
import {PlanParams} from "../../src/libraries/PlanParams.sol";
import {TermsDetail} from "../../src/libraries/TermsDetail.sol";
import {MockArcStablecoin} from "../mocks/MockArcStablecoin.sol";

/// @title CorridorTest
/// @notice The corridor, proved: everything the earlier plans built, driven end to end
///         against the EURC book.
///
/// @dev **This file exists because plan 07-09 measured a hole rather than guessed at
///      one.** Its section C applied two wrong-money mutations to `CheckoutRouter` —
///      `MIN_TICKET` read from the base registry instead of the corridor's, and
///      `merchantRoom` compared against `_bondEquivalent(ctx)` instead of the
///      corridor-currency `loaded` — and **all 444 tests passed under both**. Only two
///      grep gates caught them, and a grep gate is a statement about a file rather than
///      about behaviour.
///
///      The two escapes had different causes and each dictates the shape of the test
///      that closes it:
///
///      - **C1 escaped because of parity.** The EURC registry is the same bytecode with
///        the same seeded integers, so reading a money row from the wrong instance
///        changes no observable number. `test_creditBandsAreReadFromTheCorridorsOwnRegistry`
///        therefore **breaks parity first** — it moves `MIN_TICKET` on one registry only
///        — because a test that asserted against two identical registries would pass
///        against the defect.
///      - **C2 escaped because of slack.** The fixture's merchant room is an order of
///        magnitude larger than either operand, so comparing the wrong one changes no
///        outcome. `test_merchantRoomIsComparedInCorridorCurrency` therefore constructs
///        a book whose merchant room lies **between** the two readings: the corridor
///        figure fits and the converted figure does not, so substituting one for the
///        other is the difference between an origination and a revert.
///
///      Every clock read is `vm.getBlockTimestamp()` (DEC-30, finding 14): `via_ir`
///      hoists a bare `block.timestamp` past `vm.warp`, and a four-installment drive is
///      exactly the loop that would then assert forty times against one instant.
contract CorridorTest is CorridorFixture {
    /// @dev Distinct people, because Tier-0 allows one active plan each (UW-01) and
    ///      several of these tests need more than one plan open at a time. A person is
    ///      an address that can sign, so a second person is a second key.
    uint256 internal constant BORROWER_2 = 0xB0BB2;
    uint256 internal constant BORROWER_3 = 0xB0BB3;
    uint256 internal constant BORROWER_4 = 0xB0BB4;

    /// @dev USD→EUR, the exact reciprocal the fixture handed its venue. Written as the
    ///      same expression rather than as a literal so the two can never disagree: a
    ///      mid the venue does not fill at is refused by `FxDeviationGuard`'s floor, and
    ///      the test would then be about the guard rather than about the router.
    uint256 internal constant USD_EUR_E18 = (1e18 * 1e18) / EUR_USD_E18;

    /// @dev Inside the ticket band and under the Tier-0 cap once loaded by the 5%
    ///      corridor haircut: 90 × 1.05 = 94.5, against a first-timer's 100.
    uint256 internal constant EURC_PRINCIPAL = 90e6;

    function setUp() public {
        _deployStack();
        _prepareCorridorOrigination();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FX-02 — a EURC plan, end to end
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A EURC-denominated plan originates, collects four EURC checks, and
    ///         reaches `Repaid` with its three figures agreeing.
    ///
    /// @dev **The units check, and the reason it is three figures rather than one.**
    ///      Pitfall 2 is the silent half of the corridor: a EURC plan pointed at the
    ///      dollar identity router would have `_account` subtract dollar-scaled figures
    ///      while `_forward` moves euro. `outstandingPrincipal` reaching zero would
    ///      still look right on its own. What cannot survive that bug is the *identity*
    ///      between what the plan forwarded, what the keepers were paid, the escrow the
    ///      plan gave back, and what the book received — so all four are asserted
    ///      against each other rather than against a literal.
    function test_eurcPlanOriginatesAndRepays() public {
        InstallmentPlan p = _originateEurcPlan(EURC_PRINCIPAL, 1, keccak256("eurc-repay"), 5000e6);
        bytes32 id = planId;

        assertEq(address(p.token()), address(eurc), "the plan is not denominated in EURC");
        assertEq(p.fxRouter(), address(eurcFxRouter), "the plan did not take the corridor's own router");
        assertEq(
            p.settlementRecipient(), address(eurcPool), "the plan does not settle to the corridor's book"
        );

        uint256 escrow = PlanParams.markEscrowFor(COUNT);
        uint256 cashAfterFront = eurcPool.bookedCash();

        // Four collections by a keeper with no relationship to anything, each priced
        // before it is sent so the bounty total is an independent figure rather than a
        // reading of the balance the assertion is about.
        eurc.mint(borrower, 400e6);
        uint256 bounties;
        for (uint256 i = 0; i < COUNT; ++i) {
            vm.warp(p.dueDate(i));
            bounties += p.bountyFor(i);
            vm.prank(keeper);
            (bool cleared,) = p.collect(i);
            assertTrue(cleared, "a EURC check did not clear");
        }

        assertEq(uint8(p.state()), uint8(IInstallmentPlan.PlanState.Repaid), "the EURC plan did not repay");
        assertEq(p.outstandingPrincipal(), 0, "a repaid EURC plan still carries principal");
        assertEq(eurc.balanceOf(keeper), bounties, "the keepers were not paid what they were quoted");

        // Figure one against figure two: everything collected, less the servicing the
        // keepers took, plus the delinquency escrow the plan gave back on settlement.
        assertEq(
            p.forwarded(),
            EURC_PRINCIPAL + escrow - bounties,
            "the plan forwarded a figure that is not its principal net of servicing"
        );

        // Figure three: the book received exactly that, in its own currency.
        eurcPool.recognise(id);
        assertEq(
            eurcPool.bookedCash() - cashAfterFront,
            p.forwarded(),
            "the EURC book's cash and the plan's own forwarded total disagree"
        );
        assertEq(eurcPool.bookOf(id).carrying, 0, "the EURC book still carries a repaid plan");

        // And the dollar book saw none of it.
        assertEq(creditPool.bookOf(id).plan, address(0), "a EURC plan appears in the dollar book");
    }

    /// @notice FX-02's headline: the borrower's currency and the merchant's are
    ///         independent, in all four combinations.
    ///
    /// @dev Independence is not a claim about architecture — it is four originations.
    ///      The two same-currency cases are the regression controls: if either moved,
    ///      the legacy path moved.
    ///
    ///      The fixture's merchant is `Escrowed` (the zero ordinal, and the only safe
    ///      default for a merchant the protocol knows nothing about), so the settlement
    ///      is held rather than pushed. That is the stronger assertion surface, not a
    ///      weaker one: `SettlementEscrow` stamps the **converted token** onto its own
    ///      row, so the row states the currency as well as the amount. The receipt is
    ///      then followed all the way to the merchant's payout route below.
    function test_currencyLegsAreIndependent() public {
        uint256 mdr = (PRINCIPAL * 400) / PlanParams.BPS;
        uint256 vesting = merchants.vestingBpsFor(merchant);

        // ── 1. USDC plan, merchant elects nothing. The pre-Phase-7 path. ──────
        _checkout(_terms(PRINCIPAL, COUNT, 11), keccak256("legs-usdc-usdc"), 5000e6);
        _assertReceipt(planId, address(usdc), PRINCIPAL, mdr, vesting, 0);

        // ── 2. USDC plan, merchant elects EURC. Only the payment crosses. ─────
        _asBorrower(BORROWER_2);
        _setMerchantPayoutCurrency(merchant, address(eurc));
        bytes32 s2 = keccak256("legs-usdc-eurc");
        PlanId.PlanTerms memory second = _terms(PRINCIPAL, COUNT, 12);
        checkout.originate(
            _usdcInputWithMid(second, s2, 5000e6, _midFor(address(usdc), address(eurc), USD_EUR_E18, s2))
        );
        _assertReceipt(PlanId.derive(second), address(eurc), PRINCIPAL, mdr, vesting, USD_EUR_E18);

        // ── 3. EURC plan, merchant elects USDC. Both legs cross, together. ────
        _asBorrower(BORROWER_3);
        _setMerchantPayoutCurrency(merchant, address(usdc));
        _originateEurcPlan(EURC_PRINCIPAL, 13, keccak256("legs-eurc-usdc"), 5000e6);
        _assertReceipt(
            planId,
            address(usdc),
            EURC_PRINCIPAL,
            (EURC_PRINCIPAL * 400) / PlanParams.BPS,
            vesting,
            EUR_USD_E18
        );

        // ── 4. EURC plan, merchant elects EURC. Only the withholding crosses. ─
        _asBorrower(BORROWER_4);
        _setMerchantPayoutCurrency(merchant, address(eurc));
        _originateEurcPlan(EURC_PRINCIPAL, 14, keccak256("legs-eurc-eurc"), 5000e6);
        bytes32 fourth = planId;
        _assertReceipt(
            fourth, address(eurc), EURC_PRINCIPAL, (EURC_PRINCIPAL * 400) / PlanParams.BPS, vesting, 0
        );

        // And the plan's own currency is untouched by any of it: the merchant's
        // preference lives on a side-car and reaches neither `TermsDetail`, `termsHash`,
        // `planId` nor `InstallmentPlan`.
        assertEq(address(plan.token()), address(eurc), "the merchant's election changed the plan's currency");

        // The receipt is followed to the merchant's own route on one leg, so the escrow
        // row above is a waypoint rather than the destination.
        vm.prank(merchant);
        settlementEscrow.attestShipment(fourth, keccak256("carrier"));
        vm.warp(vm.getBlockTimestamp() + parameters.get(ParameterKeys.ESCROW_RELEASE_TIMER) + 1);
        uint256 held = settlementEscrow.escrowOf(fourth).amount;
        uint256 before = eurc.balanceOf(merchantPayout);
        settlementEscrow.release(fourth);
        assertEq(
            eurc.balanceOf(merchantPayout) - before,
            held,
            "the merchant's own payout route did not receive the elected currency"
        );
    }

    /// @notice FX-03. The locked rate is enforced by the acceptance payload the
    ///         borrower signed, and by nothing else.
    ///
    /// @dev Pitfall 10, stated as the failure it excludes: a checkout that re-computes
    ///      the EURC principal after quoting it, so the borrower signs one deal and gets
    ///      another. `PlanAcceptance` already checks `principal`, `firstInstallment`,
    ///      `laterInstallment` and `termsHash` field-by-field against the plan the
    ///      contract will actually run — and for a EURC-native plan those figures are
    ///      **already in euro**. So the enforcement exists; what this asserts is that it
    ///      bites on the corridor.
    ///
    ///      **No rate field was added, and that is asserted rather than promised.** The
    ///      two typehashes below are the commitments; a rate field on either struct
    ///      changes its typehash and turns this red. A field the acceptance does not
    ///      verify would be strictly worse than no field, because it would read as a
    ///      guarantee to everyone downstream while guaranteeing nothing.
    function test_lockedRateIsEnforcedByAcceptance() public {
        PlanId.PlanTerms memory terms = _eurcTerms(EURC_PRINCIPAL, COUNT, 21);
        bytes32 id = PlanId.derive(terms);
        address predicted = factory.predictAddress(id);

        // The deal the borrower actually signed: 80 euro. The deal submitted: 90.
        PlanAcceptance.Acceptance memory signed = _acceptance(terms, id);
        signed.principal = 80e6;
        signed.firstInstallment = _amountAt(80e6, COUNT, 0);
        signed.laterInstallment = _amountAt(80e6, COUNT, 1);

        bytes32 session = keccak256("locked-rate");
        LimitAttestation.Attestation memory a = LimitAttestation.Attestation({
            sessionId: session,
            planId: id,
            borrower: borrower,
            personId: eurcTier0.pseudonymousId(borrower),
            identityClass: uint8(IUnderwritingPartner.IdentityClass.Pseudonymous),
            limit: 5000e6,
            validUntil: vm.getBlockTimestamp() + 5 minutes
        });
        CheckoutRouter.OriginationInput memory input = CheckoutRouter.OriginationInput({
            request: PlanFactory.OriginationRequest({
                terms: terms,
                detail: _eurcDetail(),
                acceptance: signed,
                acceptanceSignature: _signAcceptance(signed, predicted),
                strip: _eurcStrip(terms, id, predicted)
            }),
            attestation: a,
            attestationSignature: _signAttestation(a, UNDERWRITER_KEY),
            fxMid: _eurcMid(session),
            fxMidSignature: _signMid(_eurcMid(session))
        });

        // `initialize` refuses, because the figures it would run are not the figures the
        // borrower committed to. The two ids are equal: what disagrees is the principal.
        vm.expectRevert(abi.encodeWithSelector(InstallmentPlan.PlanIdMismatch.selector, id, id));
        checkout.originate(input);

        // The positive control: the same plan with the acceptance the borrower signed.
        _originateEurcPlan(EURC_PRINCIPAL, 21, keccak256("locked-rate-ok"), 5000e6);
        assertEq(plan.principal(), EURC_PRINCIPAL, "the honest EURC principal did not originate");

        // And no unverified rate rode along. Both typehashes are the commitment; adding
        // a field to either struct changes the string and fails here.
        assertEq(
            TermsDetail.TERMS_DETAIL_TYPEHASH,
            keccak256(
                "TermsDetail(bytes32 jurisdiction,bytes32 lineItemsHash,uint256 mdrBps,uint256 lateFeeFlat,uint8 signerClass,address settlementRecipient,address fxRouter)"
            ),
            "TermsDetail gained a field the acceptance does not verify"
        );
        assertEq(
            PlanAcceptance.ACCEPTANCE_TYPEHASH,
            keccak256(
                "PlanAcceptance(bytes32 planId,address borrower,address merchant,address token,uint256 principal,uint256 installmentCount,uint256 firstInstallment,uint256 laterInstallment,uint256 firstDueDate,uint256 finalDueDate,uint256 interval,bytes32 termsHash,uint256 validUntil)"
            ),
            "PlanAcceptance gained a rate field"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FX-04 — the haircut, the caps, the two books
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The corridor haircut loads credit and leaves every payment identical.
    ///
    /// @dev **A correction to the plan text, made deliberately rather than silently.**
    ///      The plan asked this test to assert that a EURC origination "consumes
    ///      `principal + principal × haircut / BPS` of `corridorExposure`". It does not,
    ///      and asserting it would encode a false statement: `TranchedCreditPool.front`
    ///      adds the **raw** principal to `_corridorExposure` and `_merchantExposure`,
    ///      and `notePlan` adds the raw principal to the underwriter's exposure scalar.
    ///      The haircut lives in the *comparison* inside `_sizeCheck`, not in any
    ///      counter. That is the correct design — a counter inflated by a risk loading
    ///      would make `check_corridorExposureSumsToOpenPaper` false and would mean the
    ///      book reported exposure it does not hold — so what is fuzzed here is the
    ///      property that is actually true, in both directions:
    ///
    ///      - the loaded figure is what the limit is compared against, exactly, at the
    ///        boundary in both directions; and
    ///      - every counter moves by the unloaded principal; and
    ///      - the merchant's receipt is byte-identical to the same origination with the
    ///        haircut switched off.
    ///
    ///      FX-04's rejected alternative is the reason the third clause exists: reducing
    ///      what the merchant is fronted would make the borrower's signed principal and
    ///      the merchant's receipt disagree about the same deal.
    function testFuzz_corridorHaircut(uint256 seedPrincipal, uint256 seedHaircut) public {
        uint256 haircut = bound(seedHaircut, 0, 2500);
        // The Tier-0 cap for a pseudonymous first-timer is 100e6, so the loaded figure
        // has to fit under it for the origination to be about the haircut at all.
        uint256 ceiling = (100e6 * PlanParams.BPS) / (PlanParams.BPS + haircut);
        uint256 principal = bound(seedPrincipal, PlanParams.MIN_TICKET, ceiling);

        eurcParameters.set(ParameterKeys.FX_CORRIDOR_HAIRCUT_BPS, haircut);
        uint256 loaded = principal + (principal * haircut) / PlanParams.BPS;

        // One unit below the loaded figure is refused, and the error names both sides.
        CheckoutRouter.OriginationInput memory tight = _eurcOriginationInput(
            _eurcTerms(principal, COUNT, 31),
            keccak256("haircut-tight"),
            loaded - 1,
            _eurcMid(keccak256("ht"))
        );
        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.LimitExceeded.selector, loaded, loaded - 1));
        checkout.originate(tight);

        // Exactly the loaded figure originates.
        uint256 corridorBefore = eurcPool.corridorExposure(checkout.corridorOf(address(eurc)));
        uint256 exposureBefore = eurcTier0.outstandingExposure();
        _originateEurcPlan(principal, 31, keccak256("haircut-loaded"), loaded);
        bytes32 loadedPlan = planId;

        // Every counter moved by the *unloaded* principal. The haircut is a comparison,
        // not a ledger entry.
        assertEq(
            eurcPool.corridorExposure(checkout.corridorOf(address(eurc))) - corridorBefore,
            principal,
            "the corridor counter recorded a risk loading rather than the paper it holds"
        );
        assertEq(
            eurcTier0.outstandingExposure() - exposureBefore,
            principal,
            "the corridor underwriter recorded a loaded principal"
        );

        // The same plan, on a corridor with no haircut at all, for a different person.
        _asBorrower(BORROWER_2);
        eurcParameters.set(ParameterKeys.FX_CORRIDOR_HAIRCUT_BPS, 0);
        _originateEurcPlan(principal, 32, keccak256("haircut-none"), principal);

        assertEq(
            settlementEscrow.escrowOf(loadedPlan).amount,
            settlementEscrow.escrowOf(planId).amount,
            "the corridor haircut came out of the merchant's settlement"
        );
        assertEq(
            settlementEscrow.escrowOf(loadedPlan).token,
            settlementEscrow.escrowOf(planId).token,
            "the corridor haircut changed the settlement currency"
        );
    }

    /// @notice CHKT-01. The quote and the enforcement agree at the corridor boundary.
    ///
    /// @dev A quote the chain can contradict at the moment of signing is worth nothing,
    ///      so `maxPrincipalFor`'s answer must actually originate. It deflates rather
    ///      than discounts — the largest `P` with `P·(1+h) ≤ limit` — because
    ///      `_sizeCheck` loads the principal rather than shrinking the limit.
    ///
    ///      **The one-unit truncation seam is asserted rather than glossed.** Both sides
    ///      divide by `BPS` with integer arithmetic, so the smallest figure the chain
    ///      actually refuses can be two units above the quote rather than one. That
    ///      direction is the safe one — the quote under-promises — and pretending it is
    ///      exact would be the kind of statement that is wrong for a year.
    function test_quoteAndEnforcementAgreeOnTheHaircut() public {
        uint256 quoted = checkout.maxPrincipalFor(
            eurcTier0.pseudonymousId(borrower),
            IUnderwritingPartner.IdentityClass.Pseudonymous,
            signerClass,
            merchant,
            address(eurc),
            address(eurcPool)
        );
        assertGt(quoted, 0, "the corridor quoted nothing at all");

        uint256 haircut = eurcParameters.get(ParameterKeys.FX_CORRIDOR_HAIRCUT_BPS);
        uint256 tierCap = eurcTiered.capFor(
            eurcTier0.pseudonymousId(borrower), IUnderwritingPartner.IdentityClass.Pseudonymous, signerClass
        );

        // The quote sits at the boundary: its own loading fits, and two units above it
        // does not. One unit above is inside the shared truncation and is left unclaimed.
        assertLe(quoted + (quoted * haircut) / PlanParams.BPS, tierCap, "the quote does not fit its own load");
        uint256 over = quoted + 2;
        assertGt((over + (over * haircut) / PlanParams.BPS), tierCap, "two units above the quote still fits");

        CheckoutRouter.OriginationInput memory tooBig = _eurcOriginationInput(
            _eurcTerms(over, COUNT, 41), keccak256("quote-over"), 5000e6, _eurcMid(keccak256("qo"))
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                CheckoutRouter.LimitExceeded.selector, over + (over * haircut) / PlanParams.BPS, tierCap
            )
        );
        checkout.originate(tooBig);

        // And the quote itself originates. That is the whole of CHKT-01.
        _originateEurcPlan(quoted, 42, keccak256("quote-exact"), 5000e6);
        assertEq(plan.principal(), quoted, "the chain contradicted the corridor's own quote");
    }

    /// @notice FX-04, E-06. The corridor cap binds through the machinery Phase 3
    ///         already deployed — not through a second ledger Phase 7 built.
    ///
    /// @dev The expectation is computed live from `CORRIDOR_CONCENTRATION_BPS` and the
    ///      pool's own `totalAssets()`, read from the same registry and the same pool
    ///      the contract reads. A literal here would pass against a Phase 7 counter that
    ///      happened to agree, which is precisely what this is evidence against.
    function test_eurcCorridorConcentrationBinds() public {
        // Narrowed to the compiled floor so the cap is reachable in a handful of
        // originations rather than three hundred. This is `set` inside the band the
        // registry compiled — the same lever governance has, on the corridor's own
        // instance, which is also a second demonstration that the two registries are two.
        eurcParameters.set(ParameterKeys.CORRIDOR_CONCENTRATION_BPS, 100);

        bytes32 corridor = checkout.corridorOf(address(eurc));
        uint256 cap = (eurcPool.totalAssets() * eurcParameters.get(ParameterKeys.CORRIDOR_CONCENTRATION_BPS))
            / PlanParams.BPS;
        uint256 haircut = eurcParameters.get(ParameterKeys.FX_CORRIDOR_HAIRCUT_BPS);
        uint256 loaded = EURC_PRINCIPAL + (EURC_PRINCIPAL * haircut) / PlanParams.BPS;

        uint256 filled;
        while (cap - eurcPool.corridorExposure(corridor) >= loaded) {
            _asBorrower(BORROWER_2 + filled);
            _originateEurcPlan(EURC_PRINCIPAL, 51 + filled, keccak256(abi.encode("cap", filled)), 5000e6);
            filled += 1;
        }
        assertGt(filled, 1, "the corridor cap was reached without the counter ever moving");
        assertEq(
            eurcPool.corridorExposure(corridor),
            filled * EURC_PRINCIPAL,
            "the corridor counter is not the sum of the paper it gated"
        );

        // The next one is refused, and the error carries both figures the pool computed.
        uint256 room = cap - eurcPool.corridorExposure(corridor);
        _asBorrower(BORROWER_2 + filled);
        CheckoutRouter.OriginationInput memory over = _eurcOriginationInput(
            _eurcTerms(EURC_PRINCIPAL, COUNT, 90), keccak256("cap-over"), 5000e6, _eurcMid(keccak256("co"))
        );
        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.CorridorConcentration.selector, loaded, room));
        checkout.originate(over);

        // The figure in that error is the pool's own headroom view, read here rather
        // than reconstructed — the machinery E-06 says Phase 7 supplied a value to.
        (, uint256 corridorRoom) = eurcPool.concentrationHeadroom(merchant, corridor);
        assertEq(corridorRoom, room, "the cap did not bind through concentrationHeadroom");
    }

    /// @notice The corridors are separate buckets, because `corridorOf(token)` keys them
    ///         apart and each pool counts only its own.
    function test_usdcCorridorIsUnaffectedByEurcExposure() public {
        bytes32 eurcCorridor = checkout.corridorOf(address(eurc));
        bytes32 usdcCorridor = checkout.corridorOf(address(usdc));

        _originateEurcPlan(EURC_PRINCIPAL, 61, keccak256("bucket-eurc"), 5000e6);

        assertEq(
            eurcPool.corridorExposure(eurcCorridor), EURC_PRINCIPAL, "the EURC bucket did not record its own"
        );
        assertEq(eurcPool.corridorExposure(usdcCorridor), 0, "a EURC plan landed in the dollar bucket");
        assertEq(creditPool.corridorExposure(eurcCorridor), 0, "the dollar book recorded a EURC corridor");
        assertEq(creditPool.corridorExposure(usdcCorridor), 0, "the dollar bucket moved on a EURC plan");

        // And the dollar corridor still originates at full size.
        _asBorrower(BORROWER_2);
        _checkout(_terms(PRINCIPAL, COUNT, 62), keccak256("bucket-usdc"), 5000e6);
        assertEq(
            creditPool.corridorExposure(usdcCorridor),
            PRINCIPAL,
            "exhausting one corridor's room reached another's"
        );
    }

    /// @notice B-2c. A EURC origination consumes no part of the dollar book.
    ///
    /// @dev **The single assertion that makes the two-balance-sheet ruling real rather
    ///      than prose, and the one no other test in this file would notice failing.**
    ///      What it excludes is a EURC principal consuming the dollar book's Tier-0
    ///      headroom at 1:1 — a plan denominated in euro quietly using up the room the
    ///      dollar book keeps for dollar paper it never wrote. `Tier0Underwriter`
    ///      divides by `totalAssets()` on its single settable pool and
    ///      `outstandingExposure` is one scalar, so a corridor pointed at the dollar
    ///      instance produces perfectly plausible numbers and no revert anywhere.
    ///
    ///      Four figures, and the mirror, because a leak in either direction is the same
    ///      defect seen from the other book.
    function test_eurcOriginationDoesNotConsumeUsdcBookHeadroom() public {
        bytes32 usdcCorridor = checkout.corridorOf(address(usdc));
        bytes32 eurcCorridor = checkout.corridorOf(address(eurc));

        uint256 usdcHeadroom = tier0.bookHeadroom();
        uint256 usdcExposure = tier0.outstandingExposure();
        uint256 usdcCorridorExposure = creditPool.corridorExposure(usdcCorridor);
        uint256 usdcAssets = creditPool.totalAssets();

        uint256 eurcHeadroom = eurcTier0.bookHeadroom();
        uint256 eurcAssets = eurcPool.totalAssets();

        _originateEurcPlan(EURC_PRINCIPAL, 71, keccak256("no-leak-eurc"), 5000e6);

        assertEq(tier0.bookHeadroom(), usdcHeadroom, "a EURC plan consumed the dollar book's Tier-0 headroom");
        assertEq(tier0.outstandingExposure(), usdcExposure, "a EURC plan entered the dollar exposure scalar");
        assertEq(
            creditPool.corridorExposure(usdcCorridor),
            usdcCorridorExposure,
            "a EURC plan consumed the dollar corridor's room"
        );
        assertEq(creditPool.totalAssets(), usdcAssets, "a EURC origination moved the dollar book's NAV");

        // The EURC instances moved instead, by exactly the principal.
        assertEq(
            eurcHeadroom - eurcTier0.bookHeadroom(),
            EURC_PRINCIPAL,
            "the EURC book's own headroom did not fall by the plan it wrote"
        );
        assertEq(eurcTier0.outstandingExposure(), EURC_PRINCIPAL, "the EURC exposure scalar did not move");
        assertEq(
            eurcPool.corridorExposure(eurcCorridor), EURC_PRINCIPAL, "the EURC corridor counter did not move"
        );
        // Fronting exchanges cash for a receivable at par, so NAV is unchanged on both
        // books. That is the property, not an omission: a book that showed a profit for
        // having lent money would be flattering itself.
        assertEq(eurcPool.totalAssets(), eurcAssets, "a EURC origination moved the EURC book's NAV");

        // ── The mirror ───────────────────────────────────────────────────────
        uint256 eurcHeadroomNow = eurcTier0.bookHeadroom();
        uint256 eurcExposureNow = eurcTier0.outstandingExposure();
        uint256 eurcCorridorNow = eurcPool.corridorExposure(eurcCorridor);
        uint256 eurcAssetsNow = eurcPool.totalAssets();

        _asBorrower(BORROWER_2);
        _checkout(_terms(PRINCIPAL, COUNT, 72), keccak256("no-leak-usdc"), 5000e6);

        assertEq(eurcTier0.bookHeadroom(), eurcHeadroomNow, "a dollar plan consumed the EURC book's headroom");
        assertEq(
            eurcTier0.outstandingExposure(), eurcExposureNow, "a dollar plan entered the EURC exposure scalar"
        );
        assertEq(
            eurcPool.corridorExposure(eurcCorridor),
            eurcCorridorNow,
            "a dollar plan consumed the EURC corridor's room"
        );
        assertEq(eurcPool.totalAssets(), eurcAssetsNow, "a dollar origination moved the EURC book's NAV");
    }

    /// @notice B-2a's other half: two `ParameterRegistry` instances that behave
    ///         differently, in both directions.
    ///
    /// @dev **Parity is what hid this, so the test breaks parity before it asserts.**
    ///      Plan 07-09 ran the mutation — `_sizeCheck` reading `MIN_TICKET` from the base
    ///      registry rather than `cc.parameters` — against the whole suite and got 444
    ///      green, because the two registries are the same bytecode with the same seeded
    ///      integers and a wrong-instance read is therefore indistinguishable at runtime.
    ///      Moving one row on one instance is what makes the two distinguishable at all,
    ///      and **two registries that could not be told apart by behaviour would not be
    ///      two registries.**
    function test_creditBandsAreReadFromTheCorridorsOwnRegistry() public {
        uint256 raised = 95e6;
        assertEq(
            eurcParameters.get(ParameterKeys.MIN_TICKET),
            parameters.get(ParameterKeys.MIN_TICKET),
            "the two registries already differ, so this test proves nothing about which was read"
        );

        // ── Move the EURC floor only ─────────────────────────────────────────
        eurcParameters.set(ParameterKeys.MIN_TICKET, raised);

        CheckoutRouter.OriginationInput memory small = _eurcOriginationInput(
            _eurcTerms(EURC_PRINCIPAL, COUNT, 81), keccak256("bands-eurc"), 5000e6, _eurcMid(keccak256("be"))
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                CheckoutRouter.TicketOutOfRange.selector,
                EURC_PRINCIPAL,
                raised,
                eurcParameters.get(ParameterKeys.MAX_TICKET)
            )
        );
        checkout.originate(small);

        // The dollar corridor is untouched by the euro floor.
        _checkout(_terms(EURC_PRINCIPAL, COUNT, 82), keccak256("bands-usdc-ok"), 5000e6);
        assertEq(plan.principal(), EURC_PRINCIPAL, "raising the EURC floor refused a dollar plan");

        // ── Now the reverse ──────────────────────────────────────────────────
        eurcParameters.set(ParameterKeys.MIN_TICKET, PlanParams.MIN_TICKET);
        parameters.set(ParameterKeys.MIN_TICKET, raised);

        _asBorrower(BORROWER_2);
        CheckoutRouter.OriginationInput memory smallUsdc =
            _originationInput(_terms(EURC_PRINCIPAL, COUNT, 83), keccak256("bands-usdc"), 5000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                CheckoutRouter.TicketOutOfRange.selector,
                EURC_PRINCIPAL,
                raised,
                parameters.get(ParameterKeys.MAX_TICKET)
            )
        );
        checkout.originate(smallUsdc);

        _originateEurcPlan(EURC_PRINCIPAL, 84, keccak256("bands-eurc-ok"), 5000e6);
        assertEq(plan.principal(), EURC_PRINCIPAL, "raising the dollar floor refused a EURC plan");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // B-2b — the one conversion, bounded and fail-closed
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A cross-currency origination fails closed without a fresh signed mid.
    ///
    /// @dev The merchant bond is a **fraud control**, and it is priced off a figure the
    ///      registry keeps in one currency. A bond check performed against a rate nobody
    ///      attested is a fraud control that silently is not one — so absent, expired,
    ///      over-TTL and unsigned all reach the same refusal, and the refusal is the only
    ///      outcome. One error for "there is no usable mid", however it came to be
    ///      unusable, is what makes the fail-closed claim checkable from outside.
    function test_crossCurrencyOriginationFailsClosedWithoutAFreshMid() public {
        bytes32 session = keccak256("no-mid");
        PlanId.PlanTerms memory terms = _eurcTerms(EURC_PRINCIPAL, COUNT, 91);

        // ── Absent ───────────────────────────────────────────────────────────
        CheckoutRouter.OriginationInput memory absent =
            _eurcOriginationInput(terms, session, 5000e6, _noMid());
        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.FxMidRequired.selector, address(eurc)));
        checkout.originate(absent);

        // ── Signed, well-formed, but longer-lived than a mid may be ──────────
        FxMidAttestation.Mid memory longDated = _eurcMid(session);
        longDated.validUntil =
            vm.getBlockTimestamp() + parameters.get(ParameterKeys.FX_MID_MAX_TTL) + 1 minutes;
        CheckoutRouter.OriginationInput memory tooLong =
            _eurcOriginationInput(terms, session, 5000e6, longDated);
        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.FxMidRequired.selector, address(eurc)));
        checkout.originate(tooLong);

        // ── Signed and well-formed, but stale by the time it arrives ─────────
        CheckoutRouter.OriginationInput memory stale =
            _eurcOriginationInput(terms, session, 5000e6, _eurcMid(session));
        vm.warp(vm.getBlockTimestamp() + 3 minutes);
        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.FxMidRequired.selector, address(eurc)));
        checkout.originate(stale);

        // ── Fresh, well-formed, and signed by nobody ─────────────────────────
        CheckoutRouter.OriginationInput memory unsigned_ =
            _eurcOriginationInput(terms, session, 5000e6, _eurcMid(session));
        unsigned_.fxMidSignature = "";
        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.FxMidRequired.selector, address(eurc)));
        checkout.originate(unsigned_);

        // ── And the positive control, so the four above are about the mid ────
        _originateEurcPlan(EURC_PRINCIPAL, 91, session, 5000e6);
        assertEq(
            merchants.outstandingFrontedFor(merchant),
            (EURC_PRINCIPAL * EUR_USD_E18) / 1e18,
            "the fresh mid did not reach the single-currency exposure ledger"
        );
    }

    /// @notice B-2b's bound, asserted rather than asserted-in-prose.
    ///
    /// @dev The conversion's whole defence is that its error is **named, bounded and
    ///      stated**: one unit of integer truncation, plus whatever the mid itself is
    ///      wrong by, which the guard bounds in width by `FX_MAX_DEVIATION_BPS` and this
    ///      contract bounds in age by `FX_MID_MAX_TTL`. The mid is fuzzed across exactly
    ///      that width, and the observable is the figure that actually reached the
    ///      single-currency ledger — `_bondEquivalent`'s two call sites, seen from the
    ///      ledger's own side.
    ///
    ///      Monotonicity is asserted by originating twice at two mids rather than by
    ///      restating the formula, because a test that recomputed the expression it is
    ///      checking would agree with itself and with nothing else.
    function testFuzz_bondEquivalentIsBounded(uint256 seedMid, uint256 seedPrincipal) public {
        uint256 band = parameters.get(ParameterKeys.FX_MAX_DEVIATION_BPS);
        uint256 lo = (EUR_USD_E18 * (PlanParams.BPS - band)) / PlanParams.BPS;
        uint256 hi = (EUR_USD_E18 * (PlanParams.BPS + band)) / PlanParams.BPS;
        uint256 mid = bound(seedMid, lo, hi);
        uint256 principal = bound(seedPrincipal, PlanParams.MIN_TICKET, 95e6);

        // ── The identity branch: no crossing, and therefore no error at all ──
        uint256 dollarBefore = merchants.outstandingFrontedFor(merchant);
        _checkout(_terms(principal, COUNT, 101), keccak256("bond-usdc"), 5000e6);
        assertEq(
            merchants.outstandingFrontedFor(merchant) - dollarBefore,
            principal,
            "a base-currency principal was converted when nothing had to cross"
        );

        // ── The corridor branch, at the fuzzed mid ───────────────────────────
        _asBorrower(BORROWER_2);
        corridorVenue.setRate(address(eurc), address(usdc), mid);
        uint256 before = merchants.outstandingFrontedFor(merchant);
        _originateEurcWithMid(principal, 102, keccak256("bond-eurc-a"), mid);
        uint256 low = merchants.outstandingFrontedFor(merchant) - before;

        assertEq(low, (principal * mid) / 1e18, "the exposure ledger did not receive the converted principal");
        // The stated tolerance, as a number a test defends: the exact product minus what
        // was booked is strictly less than one whole unit of the ledger's currency.
        assertLt(principal * mid - low * 1e18, 1e18, "the conversion lost more than one unit to truncation");

        // ── Monotone in the mid ──────────────────────────────────────────────
        uint256 higher = mid + (mid / 1000);
        _asBorrower(BORROWER_3);
        corridorVenue.setRate(address(eurc), address(usdc), higher);
        before = merchants.outstandingFrontedFor(merchant);
        _originateEurcWithMid(principal, 103, keccak256("bond-eurc-b"), higher);
        uint256 high = merchants.outstandingFrontedFor(merchant) - before;

        assertGe(high, low, "a higher mid produced a smaller bond requirement");
    }

    /// @notice T-07-10-15. `merchantRoom` is compared in the corridor's own currency.
    ///
    /// @dev **The assertion no other test in this file makes, and the one plan 07-09
    ///      measured the absence of.** Its mutation C2 — comparing `merchantRoom`
    ///      against `_bondEquivalent(ctx)` rather than the corridor-currency `loaded` —
    ///      passed all 444 tests, because the fixture's merchant room is far larger than
    ///      either operand and no test in the tree asserts *which ledger* an operand
    ///      belongs to.
    ///
    ///      So the book here is built so the two readings **cannot** coincide: the
    ///      merchant concentration cap is narrowed to its compiled floor and the mid is
    ///      set far from parity, which puts the room strictly between the corridor figure
    ///      and the converted one. The corridor reading fits; the converted reading does
    ///      not; substituting one for the other is the difference between an origination
    ///      and a `MerchantConcentration` revert.
    ///
    ///      Both halves of the split are pinned. `merchantRoom` comes from
    ///      `TranchedCreditPool.concentrationHeadroom` on the **corridor's** pool — it is
    ///      `totalAssets() × MERCHANT_CONCENTRATION_BPS / BPS` minus that merchant's
    ///      exposure on that pool, and on a EURC origination every term of that is EURC —
    ///      while `canOriginate` genuinely *does* receive the converted figure, because
    ///      the ledger behind it has one currency and must not gain a second.
    function test_merchantRoomIsComparedInCorridorCurrency() public {
        // A mid far from parity, and a merchant cap at the compiled floor. Neither is a
        // contrivance the chain forbids: the floor is a value governance may set, and a
        // corridor whose rate is not near 1.0 is the ordinary case for every currency
        // this program names beyond the euro.
        uint256 mid = 8e18;
        eurcParameters.set(ParameterKeys.MERCHANT_CONCENTRATION_BPS, 100);
        corridorVenue.setRate(address(eurc), address(usdc), mid);

        bytes32 corridor = checkout.corridorOf(address(eurc));
        (uint256 merchantRoom,) = eurcPool.concentrationHeadroom(merchant, corridor);

        // Computed live from the corridor pool's own assets and the corridor registry's
        // own row — not from a literal, and not from the dollar pool.
        uint256 expected =
            (eurcPool.totalAssets() * eurcParameters.get(ParameterKeys.MERCHANT_CONCENTRATION_BPS))
                / PlanParams.BPS - eurcPool.merchantExposure(merchant);
        assertEq(merchantRoom, expected, "merchantRoom is not the corridor pool's own merchant arm");

        (uint256 dollarRoom,) = creditPool.concentrationHeadroom(merchant, checkout.corridorOf(address(usdc)));
        assertTrue(dollarRoom != merchantRoom, "the two pools' merchant rooms agree, so this proves nothing");

        uint256 haircut = eurcParameters.get(ParameterKeys.FX_CORRIDOR_HAIRCUT_BPS);
        uint256 loaded = EURC_PRINCIPAL + (EURC_PRINCIPAL * haircut) / PlanParams.BPS;
        uint256 converted = (EURC_PRINCIPAL * mid) / 1e18;

        // The construction, stated as an assertion so a future change to the fixture's
        // capitalisation cannot quietly turn this test back into the one that passed
        // against the defect.
        assertLe(loaded, merchantRoom, "the corridor reading does not fit, so the success below is not one");
        assertGt(converted, merchantRoom, "the converted reading also fits, so the mutation would stay green");

        uint256 exposureBefore = merchants.outstandingFrontedFor(merchant);
        _originateEurcWithMid(EURC_PRINCIPAL, 111, keccak256("room-currency"), mid);

        assertEq(
            eurcPool.merchantExposure(merchant),
            EURC_PRINCIPAL,
            "the corridor pool's merchant exposure is not in the corridor's currency"
        );

        // The other side of the split, pinned in the same origination: the bond ledger
        // *did* receive the converted figure. Asserting only the half that changed would
        // leave a router that converted nothing at all passing this test.
        assertEq(
            merchants.outstandingFrontedFor(merchant) - exposureBefore,
            converted,
            "the single-currency bond ledger did not receive the converted figure"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Refusals, ordering and the bond
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A token with no corridor is refused, never quietly treated as dollars.
    ///
    /// @dev The silent fallback is the failure `IdentityFXRouter`'s own header names as
    ///      worse than having no router at all: a plausible number the waterfall has no
    ///      way to tell is a currency error rather than a payment.
    function test_unconfiguredCorridorRefuses() public {
        MockArcStablecoin third = new MockArcStablecoin("BRLA", "BRLA");
        assertEq(
            checkout.fxRouterOf(address(third)), address(0), "an unconfigured corridor resolved a router"
        );

        PlanId.PlanTerms memory terms = _terms(PRINCIPAL, COUNT, 121);
        terms.token = address(third);
        terms.termsHash = TermsDetail.hash(_detail());

        CheckoutRouter.OriginationInput memory input =
            _originationInput(terms, keccak256("third-currency"), 5000e6);

        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.CorridorNotConfigured.selector, address(third)));
        checkout.originate(input);

        // And the quote answers zero rather than offering the base corridor's figure.
        assertEq(
            checkout.maxPrincipalFor(
                eurcTier0.pseudonymousId(borrower),
                IUnderwritingPartner.IdentityClass.Pseudonymous,
                signerClass,
                merchant,
                address(third),
                address(creditPool)
            ),
            0,
            "an unconfigured corridor was quoted a limit"
        );
    }

    /// @notice FX-06. Normalization still precedes the settlement waterfall.
    ///
    /// @dev The regression guard, on the deployed vintage-3 plan. `InstallmentPlan._account`
    ///      calls `IFXRouter(fxRouter).normalize` on its first line and only then splits
    ///      the proceeds — principal before fees. In v1 the router is the identity, so the
    ///      *ordering* is invisible at runtime and load-bearing in the audit: a future
    ///      "optimisation" that moved the call below the split would change nothing
    ///      measurable on a dollar plan and would assess a euro fee at an undefined rate
    ///      on a corridor one.
    ///
    ///      What is observable is the consequence, and it is asserted on a EURC plan
    ///      carrying a live fee: a payment smaller than the outstanding principal moves
    ///      principal and leaves the fee whole. Fees-first is how a €7 fee becomes a
    ///      permanent delinquency; principal-first is why a borrower who keeps paying
    ///      always converges.
    function test_normalizeOrderedBeforeWaterfall() public {
        InstallmentPlan p = _originateEurcPlan(EURC_PRINCIPAL, 131, keccak256("fx06"), 5000e6);

        // Drive it to a late fee: miss the first installment past grace and mark it.
        vm.warp(p.graceEndsAt(0) + 1);
        vm.prank(keeper);
        p.markMissed(0);
        assertGt(p.feesOutstanding(), 0, "the plan carries no fee, so the ordering is unobservable");

        uint256 fee = p.feesOutstanding();
        uint256 principalBefore = p.outstandingPrincipal();
        uint256 payment = 10e6;

        eurc.mint(borrower, payment);
        vm.startPrank(borrower);
        eurc.approve(address(p), payment);
        p.repay(payment);
        vm.stopPrank();

        assertEq(
            p.outstandingPrincipal(),
            principalBefore - payment,
            "the payment did not reach principal first, in the plan's own currency"
        );
        assertEq(p.feesOutstanding(), fee, "a fee was taken ahead of principal");
        assertEq(p.feesPaid(), 0, "a fee was assessed against a figure the waterfall had not normalized");
    }

    /// @notice MERCH-07's currency half does not disturb the bond ledger.
    ///
    /// @dev **A correction to the plan text, recorded rather than smoothed over.** The
    ///      plan asked this to assert that "the withholding stayed in the plan's
    ///      currency". It does not, and it must not: `MerchantRegistry` custodies bond
    ///      and withholding in one currency and has no way to know it has been handed a
    ///      second, so posting euro into it would leave `requiredBond` comparing two
    ///      currencies at 1:1 — which is B-2's bug relocated rather than fixed (DEC-113).
    ///      What is asserted instead is the property that makes the ledger safe: it has
    ///      exactly one currency, before and after a corridor origination, whichever
    ///      currency the merchant elected, and withdrawal still returns that one.
    function test_merchantWithdrawalAndBondAreUnaffected() public {
        assertEq(address(merchants.token()), address(usdc), "the bond ledger is not in the base currency");

        // ── A dollar plan, merchant electing euro: nothing crosses on the bond ─
        _setMerchantPayoutCurrency(merchant, address(eurc));
        uint256 bondBefore = merchants.bondOf(merchant);
        bytes32 s = keccak256("bond-usdc-eurc");
        checkout.originate(
            _usdcInputWithMid(
                _terms(PRINCIPAL, COUNT, 141),
                s,
                5000e6,
                _midFor(address(usdc), address(eurc), USD_EUR_E18, s)
            )
        );
        uint256 netUsdc = PRINCIPAL - (PRINCIPAL * 400) / PlanParams.BPS;
        uint256 withheldUsdc = (netUsdc * merchants.vestingBpsFor(merchant)) / PlanParams.BPS;
        assertEq(
            merchants.bondOf(merchant) - bondBefore,
            withheldUsdc,
            "a base-currency withholding was converted on its way to the bond ledger"
        );

        // ── A euro plan: the withholding crosses into the ledger's currency ───
        _asBorrower(BORROWER_2);
        _setMerchantPayoutCurrency(merchant, address(eurc));
        bondBefore = merchants.bondOf(merchant);
        _originateEurcPlan(EURC_PRINCIPAL, 142, keccak256("bond-eurc-eurc"), 5000e6);
        uint256 netEurc = EURC_PRINCIPAL - (EURC_PRINCIPAL * 400) / PlanParams.BPS;
        uint256 withheldEurc = (netEurc * merchants.vestingBpsFor(merchant)) / PlanParams.BPS;
        assertEq(
            merchants.bondOf(merchant) - bondBefore,
            (withheldEurc * EUR_USD_E18) / 1e18,
            "the corridor withholding did not arrive in the ledger's own currency"
        );

        // The requirement is the ordinary one, computed off the same converted exposure.
        uint256 required = merchants.requiredBond(merchant);
        assertEq(
            required,
            _max(
                parameters.get(ParameterKeys.MERCHANT_BOND_FLOOR),
                (merchants.outstandingFrontedFor(merchant) * parameters.get(ParameterKeys.MERCHANT_BOND_BPS))
                    / PlanParams.BPS
            ),
            "the bond requirement changed shape on a corridor origination"
        );

        // And the merchant still withdraws down to it, in dollars.
        uint256 spare = merchants.bondOf(merchant) - required;
        assertGt(spare, 0, "the merchant has no spare bond, so the withdrawal below asserts nothing");
        uint256 walletBefore = usdc.balanceOf(merchant);
        vm.prank(merchant);
        merchants.withdrawBond(spare);
        assertEq(
            usdc.balanceOf(merchant) - walletBefore, spare, "the bond did not come back in the base currency"
        );
        assertEq(merchants.bondOf(merchant), required, "the withdrawal did not stop at the requirement");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Local helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev A second, third or fourth person. Tier 0 allows one active plan each, so a
    ///      test that needs two plans open needs two people — and a person is an address
    ///      that can sign. Both fields move together or the strip signs for a stranger.
    function _asBorrower(uint256 key) internal {
        borrower = vm.addr(key);
        borrowerKey = key;
        _screenClear(borrower);
    }

    /// @dev A base-currency origination that carries a mid, for the case where the plan
    ///      is in dollars and the merchant elected something else. The fixture's own
    ///      `_originationInput` passes `_noMid()`, which is correct for every pre-Phase-7
    ///      test and insufficient here.
    function _usdcInputWithMid(
        PlanId.PlanTerms memory terms,
        bytes32 sessionId,
        uint256 limit,
        FxMidAttestation.Mid memory mid
    ) internal view returns (CheckoutRouter.OriginationInput memory) {
        LimitAttestation.Attestation memory a = _attestation(sessionId, PlanId.derive(terms), limit);
        return CheckoutRouter.OriginationInput({
            request: _request(terms, _detail()),
            attestation: a,
            attestationSignature: _signAttestation(a, UNDERWRITER_KEY),
            fxMid: mid,
            fxMidSignature: _signMid(mid)
        });
    }

    /// @dev A EURC origination at a mid the caller chose. The venue's rate must already
    ///      match it, or `FxDeviationGuard`'s floor refuses the fill and the test becomes
    ///      one about the guard.
    function _originateEurcWithMid(
        uint256 principal,
        uint256 nonce,
        bytes32 sessionId,
        uint256 midE18
    ) internal returns (InstallmentPlan) {
        PlanId.PlanTerms memory terms = _eurcTerms(principal, COUNT, nonce);
        planId = PlanId.derive(terms);
        firstDue = terms.firstDueDate;

        FxMidAttestation.Mid memory mid = _midFor(address(eurc), address(usdc), midE18, sessionId);
        (, address deployed) = checkout.originate(_eurcOriginationInput(terms, sessionId, 5000e6, mid));

        plan = InstallmentPlan(deployed);
        return plan;
    }

    /// @dev The merchant's receipt for one plan, asserted on the escrow row that stamps
    ///      the currency as well as the amount. `rate` of zero means no crossing.
    function _assertReceipt(
        bytes32 id,
        address want,
        uint256 principal,
        uint256 mdr,
        uint256 vestingBps,
        uint256 rate
    ) internal view {
        uint256 net = principal - mdr;
        uint256 withheld = (net * vestingBps) / PlanParams.BPS;
        uint256 payable_ = net - withheld;

        uint256 expected;
        if (rate == 0) {
            expected = payable_;
        } else if (want == address(usdc)) {
            // Both legs cross together, in one guarded settlement, and the proceeds are
            // split at the ratio the withholding was computed at (DEC-113).
            uint256 out = ((withheld + payable_) * rate) / 1e18;
            expected = out - (out * withheld) / (withheld + payable_);
        } else {
            expected = (payable_ * rate) / 1e18;
        }

        SettlementEscrow.Escrow memory row = settlementEscrow.escrowOf(id);
        assertEq(row.token, want, "the settlement was not held in the merchant's elected currency");
        assertEq(row.recipient, merchantPayout, "the settlement was routed away from the merchant");
        assertEq(row.amount, expected, "the merchant was not held their invoice less MDR and withholding");
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
