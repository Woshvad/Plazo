// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";

import {OriginationFixture} from "./helpers/OriginationFixture.sol";
import {MockArcStablecoin} from "./mocks/MockArcStablecoin.sol";

import {CheckoutRouter} from "../src/CheckoutRouter.sol";
import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {Tier0Underwriter} from "../src/Tier0Underwriter.sol";
import {ParameterRegistry} from "../src/ParameterRegistry.sol";
import {PledgeVault} from "../src/underwriting/PledgeVault.sol";
import {PayrollSweeper} from "../src/underwriting/PayrollSweeper.sol";
import {TieredUnderwriter} from "../src/underwriting/TieredUnderwriter.sol";
import {PartnerUnderwriterStub} from "../src/underwriting/PartnerUnderwriterStub.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {IUnderwritingPartner} from "../src/interfaces/IUnderwritingPartner.sol";
import {IUnderwritingPartnerV2} from "../src/interfaces/IUnderwritingPartnerV2.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";
import {TermsDetail} from "../src/libraries/TermsDetail.sol";

/// @notice UW-04…UW-07. Four tier signals composed into one number, and the four bounds
///         that keep the composition from becoming a way around a credit control.
///
/// @dev Three properties carry this suite:
///
///      1. **Tier 0's zero is a veto and it is checked first.** Three independent causes
///         of a Tier-0 zero each survive a large pledge *and* an unbounded partner figure.
///         Without that ordering, collateral is a route around UW-01, UW-03 and UW-02.
///      2. **A partner can only ever refuse.** Fuzzed to `type(uint256).max`, the
///         partner's figure is bounded by `TIER3_PARTNER_CAP` before it can influence the
///         maximum, then by the book-share headroom, and then independently by the
///         router's own minimum.
///      3. **Tiers 1 and 2 are reachable at all (B-1).** A first-time pledger with **no
///         plan record** receives a Tier-2 limit through the same function that grants a
///         Tier-0 one — and the identical call through the *published* three-argument
///         signature returns only the Tier-0 figure. That gap is the whole reason
///         `IUnderwritingPartnerV2` exists.
///
///      Every clock read is `vm.getBlockTimestamp()` (DEC-30, finding 14).
///
///      **The router is not rewired here.** `CheckoutRouter` still holds the concrete
///      `Tier0Underwriter`; plan 07-09 moves it to the widened type. So the composite's
///      origination path is driven exactly as `_register` drives it — `notePlan` then
///      `bindPlan`, from an address holding `ORIGINATOR_ROLE`, with the composite holding
///      `ORIGINATOR_ROLE` on Tier 0 and `BINDER_ROLE` on the vault. That is the wiring plan
///      07-12 creates, and it is the same two calls in the same order.
contract TieredUnderwriterTest is OriginationFixture {
    IUnderwritingPartner.IdentityClass internal constant PSEUDONYMOUS =
    IUnderwritingPartner.IdentityClass.Pseudonymous;
    TermsDetail.SignerClass internal constant EOA = TermsDetail.SignerClass.EOA;

    /// @dev A plan id the composite is asked about *before* any plan exists, which is
    ///      exactly what `_prepare` hands `_sizeCheck`: the prospective id.
    bytes32 internal constant PROSPECTIVE = keccak256("uw07-prospective-plan");

    MockArcStablecoin internal usyc;
    PledgeVault internal pledges;
    PayrollSweeper internal sweeper;
    TieredUnderwriter internal tiered;
    MockPartner internal mockPartner;
    PartnerUnderwriterStub internal partnerStub;

    /// @dev A person who has never originated anything. `Tier0Underwriter` holds no plan
    ///      record for them and `activePlans == 0`, which is the only state in which a
    ///      Tier-2 limit is observable — see `test_firstTimePledgerReachesTierTwo`.
    address internal fresh;
    address internal saver;
    address internal funder;
    address internal outsider;

    uint256 internal constant PLEDGE = 1000e6;

    function setUp() public {
        _deployStack();
        _prepareOrigination();

        fresh = makeAddr("uw07-first-time-pledger-with-no-plan-record");
        saver = makeAddr("uw07-second-person");
        funder = makeAddr("uw07-yield-funder");
        outsider = makeAddr("uw07-outsider-holding-nothing");

        usyc = new MockArcStablecoin("USYC", "USYC");
        pledges = new PledgeVault(address(this), address(usyc), address(parameters));
        sweeper = new PayrollSweeper(address(factory));
        mockPartner = new MockPartner();
        partnerStub = new PartnerUnderwriterStub();

        tiered = new TieredUnderwriter(
            address(this),
            address(tier0),
            address(pledges),
            address(sweeper),
            address(parameters),
            address(mockPartner)
        );

        // The grants plan 07-12 makes. Without the first two the composite cannot lock a
        // pledge or move Tier 0's slot; without the third nothing may originate through it.
        pledges.grantRole(pledges.BINDER_ROLE(), address(tiered));
        tier0.grantRole(tier0.ORIGINATOR_ROLE(), address(tiered));
        tiered.grantRole(tiered.ORIGINATOR_ROLE(), address(this));
        tiered.grantRole(tiered.PARTNER_ADMIN_ROLE(), address(this));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The partner, who may only ever refuse
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A partner returning any figure at all, including `type(uint256).max`,
    ///         cannot raise anyone's credit past the registry row or the book's headroom.
    ///
    /// @dev The headline. `TIER3_PARTNER_CAP` is applied to the partner's figure *before*
    ///      the maximum, so an unbounded return cannot dominate the expression at any
    ///      intermediate step; `bookHeadroom` re-binds afterwards regardless.
    ///
    ///      The person here holds no pledge and no payroll opt-in, so the only two things
    ///      that can bind are the Tier-0 figure and the partner row — which is what makes
    ///      the ceiling below exact rather than merely an upper bound.
    function testFuzz_partnerCanOnlyRefuse(uint256 proposed) public {
        bytes32 person = tier0.pseudonymousId(fresh);
        uint256 tier0Cap = tier0.capFor(person, PSEUDONYMOUS, EOA);
        uint256 hardCap = parameters.get(ParameterKeys.TIER3_PARTNER_CAP);
        uint256 ceiling = tier0Cap > hardCap ? tier0Cap : hardCap;

        mockPartner.setCap(proposed);
        uint256 offer = tiered.capFor(person, PSEUDONYMOUS, EOA, fresh, PROSPECTIVE);

        assertLe(
            offer, ceiling, "a partner-supplied figure raised credit past the registry row that bounds it"
        );
        assertLe(
            offer,
            tier0.bookHeadroom(),
            "a partner-supplied figure pushed paper past the book's share of the pool"
        );

        // The extreme, named rather than left to the fuzzer to find.
        mockPartner.setCap(type(uint256).max);
        uint256 extreme = tiered.capFor(person, PSEUDONYMOUS, EOA, fresh, PROSPECTIVE);
        assertLe(extreme, ceiling, "an unbounded partner figure was trusted without bound");
        assertEq(extreme, hardCap, "the partner row is not what bounds an unbounded partner");
    }

    /// @notice The bound is applied before the maximum, and the figure that survives is
    ///         the registry row rather than the partner's number.
    function test_partnerCapIsBoundedBeforeTheMaximum() public {
        bytes32 person = tier0.pseudonymousId(fresh);
        uint256 hardCap = parameters.get(ParameterKeys.TIER3_PARTNER_CAP);

        mockPartner.setCap(hardCap * 3);
        assertEq(
            tiered.capFor(person, PSEUDONYMOUS, EOA, fresh, PROSPECTIVE),
            hardCap,
            "a partner asking for three times the row got more than the row"
        );

        // Governance moves the row inside its compiled band; the ceiling follows it, and
        // the partner's own figure never does.
        parameters.set(ParameterKeys.TIER3_PARTNER_CAP, 1000e6);
        assertEq(
            tiered.capFor(person, PSEUDONYMOUS, EOA, fresh, PROSPECTIVE),
            1000e6,
            "the Tier-3 ceiling did not follow the registry row down"
        );
    }

    /// @notice The composite proposes; the chain refuses independently.
    ///
    /// @dev Two separate properties, and this is the second. `_sizeCheck` takes the
    ///      minimum against every onchain cap, so a partner that has been compromised
    ///      outright still cannot originate a ticket the chain would not already have
    ///      allowed. Asserted against the live router, which in this phase still consults
    ///      Tier 0 directly — 07-09 moves it to the widened type and the property is the
    ///      same either way, because the refusal is the router's and not the composite's.
    ///
    ///      Split out of `testFuzz_partnerCanOnlyRefuse` deliberately: a full origination
    ///      inside a 512-run fuzz body is 512 originations, and the assertion does not
    ///      depend on the fuzzed value.
    function test_theChainRefusesWhatTheCompositeProposes() public {
        mockPartner.setCap(type(uint256).max);

        CheckoutRouter.OriginationInput memory input =
            _originationInput(_terms(1000e6, COUNT, 42), keccak256("uw07-oversized"), 5000e6);

        vm.expectPartialRevert(CheckoutRouter.LimitExceeded.selector);
        checkout.originate(input);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The veto
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice When Tier 0 says zero the composite says zero — with a large pledge and an
    ///         unbounded partner figure both present, and for three independent reasons.
    ///
    /// @dev The test that stops collateral being a route around a credit control. Each
    ///      sub-case gives the person every reason a higher tier could offer and asserts
    ///      the answer is still **exactly** zero.
    ///
    ///      One sub-case behaves differently from the other two under the
    ///      deliberate-failure check and it is worth naming: the book-share case is
    ///      protected *twice*, by the veto and again by the headroom re-bind at step 6, so
    ///      removing the veto leaves it green. UW-01 and UW-03 are guarded by the veto
    ///      alone. That asymmetry is recorded rather than smoothed over.
    function test_tier0ZeroIsAVeto() public {
        _vetoWhenAPlanIsAlreadyOpen();
        _vetoWhenTheKillSwitchIsAtFullStop();
        _vetoWhenTheBookShareIsExhausted();
    }

    /// @dev (a) UW-01. The person holds an active plan, so a pledge must not buy a second.
    function _vetoWhenAPlanIsAlreadyOpen() internal {
        _pledge(borrower, PLEDGE);
        mockPartner.setCap(type(uint256).max);

        _checkoutDefault();
        bytes32 person = _personId();

        assertEq(tier0.capFor(person, PSEUDONYMOUS, EOA), 0, "Tier 0 did not refuse a second concurrent plan");
        assertGt(pledges.limitFor(borrower), 0, "the pledge that must not help was never made");
        assertEq(
            tiered.capFor(person, PSEUDONYMOUS, EOA, borrower, PROSPECTIVE),
            0,
            "a pledge originated a second concurrent plan for a person who already holds one"
        );
    }

    /// @dev (b) UW-03. The first-payment-default switch is at full stop, so nothing
    ///      originates — least of all something backed by collateral.
    function _vetoWhenTheKillSwitchIsAtFullStop() internal {
        _pledge(fresh, PLEDGE);
        mockPartner.setCap(type(uint256).max);

        _driveKillSwitchToFullStop();
        assertEq(killSwitch.throttleBps(), 0, "the kill switch did not reach full stop");

        bytes32 person = tier0.pseudonymousId(fresh);
        assertEq(tier0.capFor(person, PSEUDONYMOUS, EOA), 0, "the throttle did not zero the Tier-0 limit");
        assertGt(tier0.bookHeadroom(), 0, "the book ran out of room, so this case tested the wrong control");
        assertEq(
            tiered.capFor(person, PSEUDONYMOUS, EOA, fresh, PROSPECTIVE),
            0,
            "credit was extended against collateral while the kill switch had stopped the book"
        );

        // Reopen the switch so the next sub-case tests the control it means to. The cohort
        // is left in place; only the minimum that makes it readable moves back.
        _setParameter(ParameterKeys.FPD_MIN_COHORT, 50);
        assertEq(killSwitch.throttleBps(), PlanParams.BPS, "the switch did not reopen");
    }

    /// @dev (c) UW-02. Tier-0 paper is already at its share of the book.
    function _vetoWhenTheBookShareIsExhausted() internal {
        _pledge(saver, PLEDGE);
        mockPartner.setCap(type(uint256).max);

        _setParameter(ParameterKeys.TIER0_BOOK_SHARE_BPS, 100);
        uint256 squeezed = (creditPool.totalAssets() * 100) / PlanParams.BPS;

        tier0.grantRole(tier0.ORIGINATOR_ROLE(), address(this));
        tier0.notePlan(keccak256("uw07-whale"), PSEUDONYMOUS, keccak256("uw07-whale-plan"), squeezed);
        assertEq(tier0.bookHeadroom(), 0, "the book-share cap left headroom");

        bytes32 person = tier0.pseudonymousId(saver);
        assertEq(
            tiered.capFor(person, PSEUDONYMOUS, EOA, saver, PROSPECTIVE),
            0,
            "credit was extended against collateral with the book-share cap exhausted"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // B-1: Tiers 1 and 2 are reachable at all
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A first-time pledger with **no plan record** receives a Tier-2 limit
    ///         through the same function that grants a Tier-0 one.
    ///
    /// @dev **Without the widened signature this test cannot be written**, and UW-06's
    ///      "instant Tier-2 limit" would be unreachable through the only function that
    ///      grants a limit. `PledgeVault.limitFor` is keyed by `address`,
    ///      `Tier0Underwriter` exposes no view mapping a `personId` back to a wallet, and
    ///      `pseudonymousId(address)` is one-way.
    ///
    ///      **And the person must hold no plan record.** An earlier drafting proposed
    ///      resolving the wallet through Tier 0's existing plan record; that route is dead
    ///      behind the veto, because `Tier0Underwriter.capFor` returns zero the moment a
    ///      person holds an active plan and the composite returns immediately on that zero.
    ///      By the time a plan record exists to read, the answer is already no.
    function test_firstTimePledgerReachesTierTwo() public {
        assertEq(
            tier0.personOf(tier0.pseudonymousId(fresh)).activePlans,
            0,
            "the pledger already held a plan, so the veto would have fired before Tier 2 was consulted"
        );

        _pledge(fresh, PLEDGE);

        bytes32 person = tier0.pseudonymousId(fresh);
        uint256 tier0Cap = tier0.capFor(person, PSEUDONYMOUS, EOA);
        uint256 pledgeLimit = pledges.limitFor(fresh);
        assertGt(pledgeLimit, tier0Cap, "the pledge was too small for this test to prove anything");

        uint256 widened = tiered.capFor(person, PSEUDONYMOUS, EOA, fresh, PROSPECTIVE);
        assertEq(
            widened,
            pledgeLimit,
            "the widened signature did not reach the pledge that was supposed to raise the offer"
        );

        uint256 published = tiered.capFor(person, PSEUDONYMOUS, EOA);
        assertEq(published, tier0Cap, "the published three-argument form returned more than Tier 0 alone");
        assertGt(
            widened,
            published,
            "the borrower argument bought nothing, so Tier 2 is unreachable and UW-06 does not ship"
        );
    }

    /// @notice The Tier-1 half of the same point: the payroll opt-in is readable only
    ///         through the widened signature.
    ///
    /// @dev `PayrollSweeper.isOptedIn` is keyed by `(planId, address)` and neither is
    ///      derivable from a `personId`, so the reachability property has to be asserted
    ///      for Tier 1 as well as for Tier 2 rather than inferred from one of them.
    function test_payrollOptInIsReadableOnlyThroughTheWidenedSignature() public {
        bytes32 person = tier0.pseudonymousId(fresh);
        uint256 tier0Cap = tier0.capFor(person, PSEUDONYMOUS, EOA);

        vm.prank(fresh);
        sweeper.optIn(PROSPECTIVE);
        assertTrue(sweeper.isOptedIn(PROSPECTIVE, fresh), "the opt-in did not take");

        uint256 bonus = parameters.get(ParameterKeys.TIER1_PAYROLL_BONUS_BPS);
        assertEq(
            tiered.capFor(person, PSEUDONYMOUS, EOA, fresh, PROSPECTIVE),
            tier0Cap + (tier0Cap * bonus) / PlanParams.BPS,
            "the payroll uplift did not apply through the widened signature"
        );
        assertEq(
            tiered.capFor(person, PSEUDONYMOUS, EOA),
            tier0Cap,
            "the published signature saw a per-plan opt-in it cannot possibly reach"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tier 2 and Tier 1, as limits
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A pledge raises the offer to par minus the governed haircut, exactly.
    function test_tier2PledgeRaisesTheOffer() public {
        bytes32 person = tier0.pseudonymousId(fresh);
        uint256 tier0Cap = tier0.capFor(person, PSEUDONYMOUS, EOA);

        _pledge(fresh, PLEDGE);

        uint256 haircut = parameters.get(ParameterKeys.TIER2_PLEDGE_HAIRCUT_BPS);
        uint256 expected = (PLEDGE * (PlanParams.BPS - haircut)) / PlanParams.BPS;
        assertEq(pledges.limitFor(fresh), expected, "the pledge is not valued at par minus the haircut");

        uint256 offer = tiered.capFor(person, PSEUDONYMOUS, EOA, fresh, PROSPECTIVE);
        assertEq(
            offer, expected > tier0Cap ? expected : tier0Cap, "the offer is not the maximum across tiers"
        );
        assertGt(offer, tier0Cap, "collateral bought the borrower nothing");
    }

    /// @notice E-09 as a test: the payroll opt-in moves a limit and moves no price.
    ///
    /// @dev Pay-in-4 is 0%-on-time, so there is no rate to discount. A "materially better
    ///      pricing" reading of UW-05 on this product line would have to invent a number,
    ///      which is the same class of defect as a fabricated FX rate.
    function test_payrollOptInRaisesTheLimitAndNoRate() public {
        bytes32 person = tier0.pseudonymousId(fresh);

        uint256 lateFeeBefore = _detail().lateFeeFlat;
        uint256 mdrBefore = _detail().mdrBps;
        uint256 without = tiered.capFor(person, PSEUDONYMOUS, EOA, fresh, PROSPECTIVE);

        vm.prank(fresh);
        sweeper.optIn(PROSPECTIVE);

        uint256 bonus = parameters.get(ParameterKeys.TIER1_PAYROLL_BONUS_BPS);
        uint256 with = tiered.capFor(person, PSEUDONYMOUS, EOA, fresh, PROSPECTIVE);

        assertEq(
            with, without + (without * bonus) / PlanParams.BPS, "the uplift is not exactly the registry row"
        );
        assertGt(with, without, "opting into salary deduction bought the borrower nothing");
        assertEq(_detail().lateFeeFlat, lateFeeBefore, "the late fee moved with a payroll opt-in");
        assertEq(_detail().mdrBps, mdrBefore, "the merchant discount rate moved with a payroll opt-in");

        // And nothing on the composite's external surface is priced at all. Asserted over
        // the compiled method identifiers rather than the source, for the same reason
        // `PledgeVault`'s EIP-3009 prohibition is (DEC-98): the artifact is what an
        // attacker — or an integrator — can actually call.
        string memory artifact = vm.readFile("out/TieredUnderwriter.sol/TieredUnderwriter.json");
        string[] memory signatures = vm.parseJsonKeys(artifact, ".methodIdentifiers");
        assertGe(signatures.length, 10, "the artifact was not read, so this test asserted nothing");
        for (uint256 i = 0; i < signatures.length; ++i) {
            assertFalse(vm.contains(signatures[i], "apr"), "the composite grew an APR");
            assertFalse(vm.contains(signatures[i], "ate("), "the composite grew a rate");
            assertFalse(vm.contains(signatures[i], "ee("), "the composite grew a fee");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Origination through the composite
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A Tier-2 offer locks the collateral behind it, and it stays locked until
    ///         the plan it backed terminates.
    ///
    /// @dev `capFor` is a `view` and cannot bind, so the binding happens on the recording
    ///      path the router already calls. Without it the pledge that bought the limit
    ///      could be withdrawn before the first due date — plan 07-04's `freeOf` control
    ///      seen from the other side.
    function test_originationBindsThePledge() public {
        _pledge(fresh, PLEDGE);
        bytes32 person = tier0.pseudonymousId(fresh);
        bytes32 id = keccak256("uw07-tier2-origination");
        StubPlan target = new StubPlan(address(creditPool));

        assertEq(pledges.freeOf(fresh), PLEDGE, "the pledge was not free before origination");

        tiered.notePlan(person, PSEUDONYMOUS, id, PLEDGE);
        tiered.bindPlan(id, address(target), fresh);

        assertEq(pledges.lockedOf(fresh), PLEDGE, "the origination did not lock the collateral behind it");
        assertEq(pledges.freeOf(fresh), 0, "collateral backing a live plan was still free to withdraw");
        assertEq(tiered.tierOfPlan(id), 2, "the plan was not recorded as Tier 2");

        vm.prank(fresh);
        assertEq(pledges.release(PLEDGE), 0, "collateral backing an open plan was withdrawn");

        // And it comes back when the plan does.
        target.setState(IInstallmentPlan.PlanState.Repaid);
        tiered.notePlanOutcome(id);
        assertEq(pledges.lockedOf(fresh), 0, "the lock survived the plan it backed");

        vm.prank(fresh);
        assertEq(pledges.release(PLEDGE), PLEDGE, "the pledger could not recover collateral after payoff");
    }

    /// @notice Limit growth cannot depend on an operator being alive.
    ///
    /// @dev `notePlanOutcome` carries no modifier, which is `IUnderwritingPartner`'s
    ///      published contract and its stated reason. Called here by an address holding no
    ///      role anywhere in the tree.
    function test_notePlanOutcomeIsPermissionless() public {
        _pledge(fresh, PLEDGE);
        bytes32 person = tier0.pseudonymousId(fresh);
        bytes32 id = keccak256("uw07-permissionless-outcome");
        StubPlan target = new StubPlan(address(creditPool));

        tiered.notePlan(person, PSEUDONYMOUS, id, PLEDGE);
        tiered.bindPlan(id, address(target), fresh);
        assertEq(tier0.personOf(person).activePlans, 1, "the slot did not open");

        target.setState(IInstallmentPlan.PlanState.Repaid);

        vm.prank(outsider);
        tiered.notePlanOutcome(id);

        assertEq(tier0.personOf(person).activePlans, 0, "the active-plan slot did not reopen");
        assertEq(tier0.personOf(person).cleanCompletions, 1, "a clean completion did not grow the limit");
        assertEq(pledges.lockedOf(fresh), 0, "the pledge was not unbound when its plan terminated");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UW-07 and E-10: nothing but the limit and the tier
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice No log emitted through the composite's origination path carries the person
    ///         id, asserted against the captured logs rather than against the source.
    ///
    /// @dev A pseudonymous person id is computable from a wallet, so an emitted one is an
    ///      emitted wallet wearing a hash — and the log stream becomes a permanent,
    ///      public, uncorrectable credit file. `Tier0Underwriter`'s events already withhold
    ///      it; this asserts the composite did not put it back.
    ///
    ///      The borrower-address half is scoped to logs emitted **by the composite**.
    ///      `PledgeVault.PledgeBound` indexes the pledger by construction — a pledge is
    ///      per-wallet capital and always was — and that is not a field this interface
    ///      added.
    function test_noPersonIdInAnyEvent() public {
        _pledge(fresh, PLEDGE);
        bytes32 person = tier0.pseudonymousId(fresh);
        bytes32 id = keccak256("uw07-log-inspection");
        StubPlan target = new StubPlan(address(creditPool));

        vm.recordLogs();
        tiered.notePlan(person, PSEUDONYMOUS, id, PLEDGE);
        tiered.bindPlan(id, address(target), fresh);
        target.setState(IInstallmentPlan.PlanState.Repaid);
        tiered.notePlanOutcome(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertGt(logs.length, 0, "no logs were captured, so this test asserted nothing");

        bytes32 walletWord = bytes32(uint256(uint160(fresh)));
        for (uint256 i = 0; i < logs.length; ++i) {
            bool fromComposite = logs[i].emitter == address(tiered);

            for (uint256 t = 0; t < logs[i].topics.length; ++t) {
                assertTrue(logs[i].topics[t] != person, "a log topic carried the person id");
                if (fromComposite) {
                    assertTrue(logs[i].topics[t] != walletWord, "the composite indexed the borrower's wallet");
                }
            }

            bytes memory data = logs[i].data;
            for (uint256 o = 0; o + 32 <= data.length; o += 32) {
                bytes32 word;
                assembly {
                    word := mload(add(add(data, 32), o))
                }
                assertTrue(word != person, "a log data field carried the person id");
                if (fromComposite) {
                    assertTrue(word != walletWord, "the composite emitted the borrower's wallet");
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The unengaged partner
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice With the shipped stub installed, the product still works.
    ///
    /// @dev A partner that is not in hand must cost a borrower a tier, not a product.
    function test_partnerStubIsHarmless() public {
        tiered.setPartner(address(partnerStub));
        _pledge(fresh, PLEDGE);

        bytes32 person = tier0.pseudonymousId(fresh);
        uint256 tier0Cap = tier0.capFor(person, PSEUDONYMOUS, EOA);
        uint256 pledgeLimit = pledges.limitFor(fresh);

        assertEq(
            tiered.capFor(person, PSEUDONYMOUS, EOA, fresh, PROSPECTIVE),
            pledgeLimit > tier0Cap ? pledgeLimit : tier0Cap,
            "an unengaged partner changed the figure the lower tiers would have given"
        );
        assertEq(tiered.tierOf(person, fresh, PROSPECTIVE), 2, "an unengaged partner reported a Tier-3 offer");
        assertTrue(tiered.tierOf(person, fresh, PROSPECTIVE) != 3, "the stub claimed a partner limit");

        // And an origination through the composite still completes.
        bytes32 id = keccak256("uw07-stub-origination");
        StubPlan target = new StubPlan(address(creditPool));
        tiered.notePlan(person, PSEUDONYMOUS, id, PRINCIPAL);
        tiered.bindPlan(id, address(target), fresh);
        assertEq(tier0.personOf(person).activePlans, 1, "an unengaged partner blocked an origination");
    }

    /// @notice The stub's own writes revert, and the composite contains them.
    ///
    /// @dev A stub that silently accepted a write would look like a partner that had
    ///      recorded something. So it refuses — and the composite is what makes that
    ///      refusal survivable, rather than the stub pretending.
    function test_partnerWriteRevertsAreContained() public {
        tiered.setPartner(address(partnerStub));
        bytes32 person = tier0.pseudonymousId(fresh);
        bytes32 id = keccak256("uw07-contained-revert");

        // The stub really does refuse, directly.
        vm.expectRevert(PartnerUnderwriterStub.PartnerNotEngaged.selector);
        partnerStub.notePlan(person, PSEUDONYMOUS, id, PRINCIPAL);

        // And the composite originates anyway.
        tiered.notePlan(person, PSEUDONYMOUS, id, PRINCIPAL);
        assertEq(tier0.personOf(person).activePlans, 1, "a refusing partner failed the origination");

        StubPlan target = new StubPlan(address(creditPool));
        tiered.bindPlan(id, address(target), fresh);
        target.setState(IInstallmentPlan.PlanState.Repaid);
        tiered.notePlanOutcome(id);
        assertEq(tier0.personOf(person).activePlans, 0, "a refusing partner failed the settlement");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pitfall 4, closed by the compiler
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A router-shaped holder of the widened interface compiles and calls the two
    ///         functions the published interface never declared.
    ///
    /// @dev `CheckoutRouter._register` calls `isSeasoned` and `bindPlan`. A composite
    ///      implementing only `IUnderwritingPartner` would not compile into it, which is
    ///      why the widening is a new file rather than a comment. This proves it by
    ///      compilation, not by assertion — the assertions below merely confirm the calls
    ///      reached the composite.
    function test_widenedInterfaceCompilesIntoARouterShapedHolder() public {
        RouterShapedHolder holder = new RouterShapedHolder(address(tiered));
        tiered.grantRole(tiered.ORIGINATOR_ROLE(), address(holder));

        bytes32 person = tier0.pseudonymousId(fresh);
        bytes32 id = keccak256("uw07-router-shaped");
        StubPlan target = new StubPlan(address(creditPool));

        assertFalse(holder.seasoned(person), "a person with no completions read as seasoned");

        tiered.notePlan(person, PSEUDONYMOUS, id, PRINCIPAL);
        holder.register(id, address(target), fresh);

        assertEq(
            tier0.planRecordOf(id).plan,
            address(target),
            "bindPlan through the widened type did not reach Tier 0"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _pledge(address who, uint256 amount) internal {
        usyc.mint(who, amount);
        vm.startPrank(who);
        usyc.approve(address(pledges), amount);
        pledges.pledge(amount);
        vm.stopPrank();
    }

    /// @dev Ten observations, five of them first-payment defaults on unseasoned wallets.
    ///      Weighted at `FPD_NEW_WALLET_WEIGHT_BPS` that is 1250bps of the cohort, which
    ///      is past a full stop once the trigger and the stop are moved to the bottom of
    ///      their compiled bands. Doubles rather than real plans, because the switch reads
    ///      only `installmentStatus(0)` and this test is about the composite.
    function _driveKillSwitchToFullStop() internal {
        _setParameter(ParameterKeys.FPD_MIN_COHORT, 10);
        _setParameter(ParameterKeys.FPD_TRIGGER_BPS, 100);
        _setParameter(ParameterKeys.FPD_FULL_STOP_BPS, 200);
        killSwitch.grantRole(killSwitch.REGISTRAR_ROLE(), address(this));

        for (uint256 i = 0; i < 10; ++i) {
            StubPlan observed = new StubPlan(address(creditPool));
            observed.setInstallmentStatus(
                i < 5 ? IInstallmentPlan.InstallmentStatus.Missed : IInstallmentPlan.InstallmentStatus.Cleared
            );
            bytes32 id = keccak256(abi.encodePacked("uw07-fpd", i));
            killSwitch.noteOrigination(id, address(observed), false);
            killSwitch.observe(id);
        }
    }
}

/// @notice A partner whose figure is whatever the test says it is.
contract MockPartner is IUnderwritingPartnerV2 {
    uint256 public cap;

    function setCap(uint256 cap_) external {
        cap = cap_;
    }

    function capFor(bytes32, IdentityClass, TermsDetail.SignerClass) external view returns (uint256) {
        return cap;
    }

    function capFor(
        bytes32,
        IdentityClass,
        TermsDetail.SignerClass,
        address,
        bytes32
    ) external view returns (uint256) {
        return cap;
    }

    function tierOf(bytes32) external view returns (uint8) {
        return cap > 0 ? 3 : 0;
    }

    function isSeasoned(bytes32) external pure returns (bool) {
        return false;
    }

    function outstandingExposure() external pure returns (uint256) {
        return 0;
    }

    function notePlan(bytes32, IdentityClass, bytes32, uint256) external {}

    function notePlanOutcome(bytes32) external {}

    function bindPlan(bytes32, address, address) external {}
}

/// @notice A plan-shaped double whose state and first-installment status are settable.
///
/// @dev The composite's recording path reads a plan only through `Tier0Underwriter` and
///      `PledgeVault`, both of which ask it for its own state. A double is the right
///      subject here precisely because the thing under test is the composite's ordering,
///      not the plan's state machine — which Phases 2 and 3 already prove exhaustively.
contract StubPlan {
    IInstallmentPlan.PlanState public state;
    IInstallmentPlan.InstallmentStatus private _status;
    address public settlementRecipient;

    constructor(address recipient) {
        settlementRecipient = recipient;
        _status = IInstallmentPlan.InstallmentStatus.Cleared;
    }

    function setState(IInstallmentPlan.PlanState state_) external {
        state = state_;
    }

    function setInstallmentStatus(IInstallmentPlan.InstallmentStatus status_) external {
        _status = status_;
    }

    function installmentCount() external pure returns (uint256) {
        return 4;
    }

    function installmentStatus(uint256) external view returns (IInstallmentPlan.InstallmentStatus) {
        return _status;
    }

    /// @dev Zero, meaning grace has already passed. `FirstPaymentDefaultSwitch.observe`
    ///      reads this only on the Pending/Bounced/Refunded branch, which a double whose
    ///      status is always terminal never presents — and reading the clock here would
    ///      trip `check-test-clock.mjs`, which exempts `mocks/` and `stubs/` directories
    ///      and not doubles declared beside the suite that uses them.
    function graceEndsAt(uint256) external pure returns (uint256) {
        return 0;
    }
}

/// @notice A holder shaped exactly like `CheckoutRouter`: it declares the widened type and
///         calls the two functions the published interface never had.
contract RouterShapedHolder {
    IUnderwritingPartnerV2 public immutable underwriter;

    constructor(address underwriter_) {
        underwriter = IUnderwritingPartnerV2(underwriter_);
    }

    function seasoned(bytes32 personId) external view returns (bool) {
        return underwriter.isSeasoned(personId);
    }

    function register(bytes32 planId, address plan, address borrower) external {
        underwriter.bindPlan(planId, plan, borrower);
    }
}
