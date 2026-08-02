// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ParameterRegistry} from "../src/ParameterRegistry.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";

/// @notice GOV-01 and D10 — every Appendix A hypothesis behind a hard band.
///
/// @dev The registry's job is not to hold numbers. It is to make the set of numbers
///      governance can reach a decision that was taken once, at deployment, in code
///      an auditor read. These tests are about that boundary rather than about the
///      values, which are hypotheses and are supposed to move.
contract ParameterRegistryTest is Test {
    ParameterRegistry internal parameters;
    address internal governance = address(0x6011E);
    address internal stranger = address(0xDECAF);

    function setUp() public {
        parameters = new ParameterRegistry(governance);
    }

    // ─── Reading ─────────────────────────────────────────────────────────────

    /// @notice An undefined key reverts rather than reading zero.
    ///
    /// @dev A registry that returned zero for a key nobody configured would turn a
    ///      typo in a deployment script into a plan originated at a zero minimum
    ///      ticket with a zero MDR — and it would originate quietly, which is worse.
    function test_anUndefinedKeyReverts() public {
        bytes32 nonsense = keccak256("plazo.does.not.exist");
        vm.expectRevert(abi.encodeWithSelector(ParameterRegistry.ParameterUndefined.selector, nonsense));
        parameters.get(nonsense);
    }

    /// @notice The seeded set is the Phase 2 constant set, where they overlap.
    /// @dev `PlanParams` is compiled into `InstallmentPlan` and cannot move; the
    ///      registry governs origination only. Where both name the same figure they
    ///      have to agree at deployment, or a plan would be originated under a
    ///      minimum the plan itself would reject.
    function test_theSeededMinimumTicketMatchesTheCompiledOne() public view {
        assertEq(parameters.get(ParameterKeys.MIN_TICKET), PlanParams.MIN_TICKET);
    }

    function test_everySeededKeyIsEnumerable() public view {
        bytes32[] memory keys = parameters.keys();
        assertEq(keys.length, parameters.keyCount());
        // Raised by three in Phase 6 with the settlement-escrow rows and by fifteen in
        // Phase 7 with the FX and tier rows — and tightened from a floor to an equality
        // at the same time. Fifteen rows landing in one commit is exactly the situation
        // where a declared-but-unseeded key hides, and a floor cannot see one. An exact
        // count fails on the sixteenth row added by accident, which is the point; the
        // fix when a row is added deliberately is to move this number in the same
        // commit, not to loosen it back into a floor.
        assertEq(keys.length, 57, "the seeded set moved without this assertion moving");

        for (uint256 i = 0; i < keys.length; ++i) {
            assertTrue(parameters.isDefined(keys[i]), "an enumerated key is not defined");
            ParameterRegistry.Parameter memory p = parameters.parameter(keys[i]);
            assertLe(p.min, p.value, "a seeded value sits below its own band");
            assertLe(p.value, p.max, "a seeded value sits above its own band");
        }
    }

    // ─── Bands ───────────────────────────────────────────────────────────────

    /// @notice Governance may move a value inside its band.
    function test_governanceCanMoveAValueInsideItsBand() public {
        vm.prank(governance);
        parameters.set(ParameterKeys.MDR_BPS, 250);
        assertEq(parameters.get(ParameterKeys.MDR_BPS), 250);
    }

    /// @notice And cannot move it outside.
    ///
    /// @dev The MDR band tops out at 10% because above that the product is not
    ///      competitive with what it is meant to displace. A governance key that can
    ///      set any value is a governance key that can set a usurious one, and "we
    ///      would never" is not a control.
    function test_governanceCannotLeaveTheBand() public {
        ParameterRegistry.Parameter memory p = parameters.parameter(ParameterKeys.MDR_BPS);

        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRegistry.OutOfBand.selector, ParameterKeys.MDR_BPS, p.max + 1, p.min, p.max
            )
        );
        parameters.set(ParameterKeys.MDR_BPS, p.max + 1);
    }

    /// @notice The Tier-0 book share cannot be raised past a quarter of the book.
    /// @dev DEC-02 put Tier 0 on pool capital from day one. This cap and the FPD
    ///      switch are the two things standing between an unproven scorecard and the
    ///      senior tranche, so the ceiling on it is not a preference.
    function test_theTierZeroBookShareIsCappedInCode() public {
        vm.prank(governance);
        vm.expectRevert();
        parameters.set(ParameterKeys.TIER0_BOOK_SHARE_BPS, 5000);
    }

    /// @notice Limit growth can be switched off but never reversed into a shrink.
    function test_growthCannotBecomeShrinkage() public {
        vm.prank(governance);
        vm.expectRevert();
        parameters.set(ParameterKeys.TIER0_GROWTH_BPS, 9000);

        vm.prank(governance);
        parameters.set(ParameterKeys.TIER0_GROWTH_BPS, 10_000);
        assertEq(parameters.get(ParameterKeys.TIER0_GROWTH_BPS), 10_000, "growth could not be switched off");
    }

    function test_onlyGovernanceCanSet() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        parameters.set(ParameterKeys.MDR_BPS, 250);
    }

    // ─── The ratchet ─────────────────────────────────────────────────────────

    /// @notice A band can be tightened, permanently.
    ///
    /// @dev A protocol that has learned its true risk appetite should be able to write
    ///      it down irreversibly. A protocol that can un-learn it has not written
    ///      anything down at all — which is why there is no widening function, not
    ///      even one behind a longer timelock.
    function test_aBandCanOnlyEverBeNarrowed() public {
        ParameterRegistry.Parameter memory before = parameters.parameter(ParameterKeys.MDR_BPS);

        vm.prank(governance);
        parameters.narrowBand(ParameterKeys.MDR_BPS, 300, 500);

        ParameterRegistry.Parameter memory after_ = parameters.parameter(ParameterKeys.MDR_BPS);
        assertEq(after_.min, 300);
        assertEq(after_.max, 500);
        assertGt(after_.min, before.min, "the floor did not rise");
        assertLt(after_.max, before.max, "the ceiling did not fall");

        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRegistry.BandNotNarrower.selector, ParameterKeys.MDR_BPS, before.min, before.max
            )
        );
        parameters.narrowBand(ParameterKeys.MDR_BPS, before.min, before.max);
    }

    /// @notice Narrowing cannot strand the current value outside its own band.
    function test_narrowingCannotStrandTheLiveValue() public {
        uint256 live = parameters.get(ParameterKeys.MDR_BPS);

        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRegistry.OutOfBand.selector, ParameterKeys.MDR_BPS, live, 600, 800
            )
        );
        parameters.narrowBand(ParameterKeys.MDR_BPS, 600, 800);
    }

    function test_aNarrowedBandBindsTheNextSet() public {
        vm.startPrank(governance);
        parameters.narrowBand(ParameterKeys.MDR_BPS, 300, 500);

        vm.expectRevert(
            abi.encodeWithSelector(ParameterRegistry.OutOfBand.selector, ParameterKeys.MDR_BPS, 550, 300, 500)
        );
        parameters.set(ParameterKeys.MDR_BPS, 550);
        vm.stopPrank();
    }

    function test_onlyGovernanceCanNarrow() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        parameters.narrowBand(ParameterKeys.MDR_BPS, 300, 500);
    }

    // ─── Settlement escrow (Phase 6) ─────────────────────────────────────────

    /// @notice All three escrow timers are seeded rows, not compiled constants.
    ///
    /// @dev D-08. They land in wave 1 so that neither escrow can take one as a
    ///      constructor immutable — a timer outside the registry is a timer outside
    ///      GOV-01, and the dispute timelock is the most dangerous control in the
    ///      phase to put there.
    function test_theEscrowTimersAreSeededRows() public view {
        assertEq(parameters.get(ParameterKeys.ESCROW_ATTESTATION_DEADLINE), 7 days);
        assertEq(parameters.get(ParameterKeys.ESCROW_RELEASE_TIMER), 72 hours);
        assertEq(parameters.get(ParameterKeys.ESCROW_DISPUTE_TIMELOCK), 72 hours);

        assertTrue(parameters.isDefined(ParameterKeys.ESCROW_ATTESTATION_DEADLINE));
        assertTrue(parameters.isDefined(ParameterKeys.ESCROW_RELEASE_TIMER));
        assertTrue(parameters.isDefined(ParameterKeys.ESCROW_DISPUTE_TIMELOCK));
    }

    /// @notice The attestation deadline moves inside its band and nowhere else.
    /// @dev A month is the ceiling because capital held that long against a shipment
    ///      nobody attested is capital the pool is not earning on.
    function test_theAttestationDeadlineIsBanded() public {
        vm.prank(governance);
        parameters.set(ParameterKeys.ESCROW_ATTESTATION_DEADLINE, 3 days);
        assertEq(parameters.get(ParameterKeys.ESCROW_ATTESTATION_DEADLINE), 3 days);

        vm.prank(governance);
        vm.expectRevert();
        parameters.set(ParameterKeys.ESCROW_ATTESTATION_DEADLINE, 23 hours);

        vm.prank(governance);
        vm.expectRevert();
        parameters.set(ParameterKeys.ESCROW_ATTESTATION_DEADLINE, 31 days);
    }

    /// @notice So does the post-shipment release timer.
    function test_theReleaseTimerIsBanded() public {
        vm.prank(governance);
        parameters.set(ParameterKeys.ESCROW_RELEASE_TIMER, 12 hours);
        assertEq(parameters.get(ParameterKeys.ESCROW_RELEASE_TIMER), 12 hours);

        vm.prank(governance);
        vm.expectRevert();
        parameters.set(ParameterKeys.ESCROW_RELEASE_TIMER, 59 minutes);

        vm.prank(governance);
        vm.expectRevert();
        parameters.set(ParameterKeys.ESCROW_RELEASE_TIMER, 15 days);
    }

    /// @notice Governance cannot shorten the window that protects a merchant's bond.
    ///
    /// @dev D-03, and the reason this row exists at all. The dispute timelock is the
    ///      only thing between an `ARBITER_ROLE` key and every merchant's bond. Zero
    ///      would make `SLASHER_ROLE` an instant key again, and twenty-three hours is
    ///      the nearest miss — both have to revert, and the floor has to be a compiled
    ///      band rather than a value governance happens to have chosen, because a
    ///      control that can be set to nothing is not a control.
    function test_disputeTimelockCannotBeSetBelowItsFloor() public {
        ParameterRegistry.Parameter memory p = parameters.parameter(ParameterKeys.ESCROW_DISPUTE_TIMELOCK);
        assertEq(p.min, 24 hours, "the floor is not a day");

        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRegistry.OutOfBand.selector, ParameterKeys.ESCROW_DISPUTE_TIMELOCK, 0, p.min, p.max
            )
        );
        parameters.set(ParameterKeys.ESCROW_DISPUTE_TIMELOCK, 0);

        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRegistry.OutOfBand.selector,
                ParameterKeys.ESCROW_DISPUTE_TIMELOCK,
                23 hours,
                p.min,
                p.max
            )
        );
        parameters.set(ParameterKeys.ESCROW_DISPUTE_TIMELOCK, 23 hours);

        // And the floor is exactly reachable, so the band is a floor rather than an
        // off-by-one that hides one.
        vm.prank(governance);
        parameters.set(ParameterKeys.ESCROW_DISPUTE_TIMELOCK, 24 hours);
        assertEq(parameters.get(ParameterKeys.ESCROW_DISPUTE_TIMELOCK), 24 hours);
    }

    /// @notice Nor can it be stretched past a month.
    /// @dev The ceiling matters for the opposite reason: a timelock long enough to
    ///      outlive the dispute is a bond nobody can ever reach, which turns the
    ///      merchant's stake into a deposit the protocol cannot use as a control.
    function test_theDisputeTimelockHasACeilingToo() public {
        vm.prank(governance);
        vm.expectRevert();
        parameters.set(ParameterKeys.ESCROW_DISPUTE_TIMELOCK, 31 days);
    }

    /// @notice The floor survives the ratchet — narrowing can only raise it.
    /// @dev `narrowBand` is the one path that changes a band after deployment, and it
    ///      is one-way. Confirming the timelock's floor cannot be walked down through
    ///      it is what makes "24 hours minimum" a property rather than a default.
    function test_narrowingCannotWalkTheDisputeFloorDown() public {
        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRegistry.BandNotNarrower.selector, ParameterKeys.ESCROW_DISPUTE_TIMELOCK, 0, 30 days
            )
        );
        parameters.narrowBand(ParameterKeys.ESCROW_DISPUTE_TIMELOCK, 0, 30 days);

        vm.prank(governance);
        parameters.narrowBand(ParameterKeys.ESCROW_DISPUTE_TIMELOCK, 48 hours, 7 days);

        vm.prank(governance);
        vm.expectRevert();
        parameters.set(ParameterKeys.ESCROW_DISPUTE_TIMELOCK, 24 hours);
    }

    // ─── FX corridor and tiered underwriting (Phase 7) ───────────────────────
    //
    // Fifteen rows landed together, and they are tested together rather than one
    // hand-written function each. A table is not laziness here: the property is
    // *uniform* — every one of the fifteen must be seeded, must be reachable at both
    // ends of its band and nowhere outside it, and must narrow one way — and fifteen
    // near-identical functions is fifteen places for one of them to be quietly
    // omitted. The table is enumerated once and every assertion runs over all of it.
    //
    // These rows exist on **neither deployed registry**. Plan 07-12 deploys the third
    // instance that carries them (`fxParameterRegistry`) and the fourth that reads the
    // same integers as euros (`eurcParameterRegistry`); nothing already deployed is
    // repointed. The tests run against a fresh `new ParameterRegistry(...)`, which is
    // what those instances will be.

    /// @dev The seeded value each new row is expected to carry. Order matches
    ///      `ParameterKeys`' two new sections.
    function _phase7Keys() internal pure returns (bytes32[] memory keys, uint256[] memory values) {
        keys = new bytes32[](15);
        values = new uint256[](15);

        keys[0] = ParameterKeys.FX_CORRIDOR_HAIRCUT_BPS;
        values[0] = 500;
        keys[1] = ParameterKeys.FX_MAX_DEVIATION_BPS;
        values[1] = 100;
        keys[2] = ParameterKeys.FX_MID_MAX_TTL;
        values[2] = 5 minutes;
        keys[3] = ParameterKeys.FX_QUOTE_MAX_AGE;
        values[3] = 15 minutes;
        keys[4] = ParameterKeys.FX_ROUNDTRIP_MAX_BPS;
        values[4] = 200;
        keys[5] = ParameterKeys.FX_PAR_BAND_BPS;
        values[5] = 500;

        keys[6] = ParameterKeys.TIER1_INCOME_MULTIPLE_BPS;
        values[6] = 2500;
        keys[7] = ParameterKeys.TIER1_PSEUDONYMOUS_CAP;
        values[7] = 500 * PlanParams.ONE_USDC;
        keys[8] = ParameterKeys.TIER1_PAYROLL_BONUS_BPS;
        values[8] = 2500;
        keys[9] = ParameterKeys.INFLOW_LOOKBACK;
        values[9] = 90 days;
        keys[10] = ParameterKeys.INFLOW_MIN_MONTHS;
        values[10] = 3;
        keys[11] = ParameterKeys.INFLOW_MIN_COUNTERPARTIES;
        values[11] = 2;

        keys[12] = ParameterKeys.TIER2_PLEDGE_HAIRCUT_BPS;
        values[12] = 2000;

        keys[13] = ParameterKeys.TIER3_PARTNER_CAP;
        values[13] = 5000 * PlanParams.ONE_USDC;
        keys[14] = ParameterKeys.TIER3_PARTNER_MAX_TTL;
        values[14] = 1 hours;
    }

    /// @notice All fifteen are defined rows carrying the values the plan states.
    /// @dev `get` on an undefined key reverts, so a row declared in `ParameterKeys`
    ///      and forgotten in the constructor is a failed origination rather than a
    ///      free one. This is the assertion that notices the forgetting.
    function test_thePhaseSevenRowsAreSeeded() public view {
        (bytes32[] memory keys, uint256[] memory values) = _phase7Keys();
        for (uint256 i = 0; i < keys.length; ++i) {
            assertTrue(parameters.isDefined(keys[i]), "a Phase 7 key is declared but not seeded");
            assertEq(parameters.get(keys[i]), values[i], "a Phase 7 row is not carrying its seeded value");
        }
    }

    /// @notice Every one of the fifteen bands is reachable at both ends and nowhere
    ///         outside them.
    ///
    /// @dev T-07-02-01. A band is only a control if both of its ends are exactly
    ///      attainable and one step past either reverts — a floor that is really a
    ///      floor-plus-one is an off-by-one hiding a control, and a ceiling that is
    ///      not reachable is a number nobody can use.
    function test_everyPhaseSevenBandBindsAtBothEnds() public {
        (bytes32[] memory keys,) = _phase7Keys();

        for (uint256 i = 0; i < keys.length; ++i) {
            ParameterRegistry.Parameter memory p = parameters.parameter(keys[i]);

            vm.prank(governance);
            parameters.set(keys[i], p.min);
            assertEq(parameters.get(keys[i]), p.min, "the floor is not reachable");

            vm.prank(governance);
            parameters.set(keys[i], p.max);
            assertEq(parameters.get(keys[i]), p.max, "the ceiling is not reachable");

            // Two of the fifteen floor at zero on purpose — the corridor haircut and
            // the payroll bonus are both benefits that must be switchable off without
            // a redeployment — so there is no "one below" for them to have.
            if (p.min > 0) {
                vm.prank(governance);
                vm.expectRevert(
                    abi.encodeWithSelector(
                        ParameterRegistry.OutOfBand.selector, keys[i], p.min - 1, p.min, p.max
                    )
                );
                parameters.set(keys[i], p.min - 1);
            }

            vm.prank(governance);
            vm.expectRevert(
                abi.encodeWithSelector(ParameterRegistry.OutOfBand.selector, keys[i], p.max + 1, p.min, p.max)
            );
            parameters.set(keys[i], p.max + 1);
        }
    }

    /// @notice And every one of them ratchets one way.
    function test_everyPhaseSevenBandNarrowsOnlyInwards() public {
        (bytes32[] memory keys,) = _phase7Keys();

        for (uint256 i = 0; i < keys.length; ++i) {
            ParameterRegistry.Parameter memory p = parameters.parameter(keys[i]);

            vm.prank(governance);
            parameters.narrowBand(keys[i], p.min + 1, p.max - 1);

            ParameterRegistry.Parameter memory after_ = parameters.parameter(keys[i]);
            assertEq(after_.min, p.min + 1, "the floor did not rise");
            assertEq(after_.max, p.max - 1, "the ceiling did not fall");
            assertEq(after_.value, p.value, "narrowing moved the value");

            vm.prank(governance);
            vm.expectRevert(
                abi.encodeWithSelector(ParameterRegistry.BandNotNarrower.selector, keys[i], p.min, p.max)
            );
            parameters.narrowBand(keys[i], p.min, p.max);
        }
    }

    /// @notice A pseudonymous Tier-1 limit can never outrank an attested Tier-0 one.
    ///
    /// @dev T-07-02-08, and the one cross-row relationship in the fifteen. Tier 1's
    ///      evidence is an inflow history a wallet can manufacture; Tier 0's
    ///      identified cap is a person the operator attested. If governance could
    ///      raise the first past the second, the tiers would stop expressing an
    ///      ordering — so `TIER1_PSEUDONYMOUS_CAP`'s ceiling *is*
    ///      `TIER0_IDENTIFIED_CAP`'s seeded default, in compiled code rather than in
    ///      an operator's discipline.
    function test_theTierOnePseudonymousCapCannotExceedTheTierZeroIdentifiedCap() public {
        ParameterRegistry.Parameter memory tier1 = parameters.parameter(ParameterKeys.TIER1_PSEUDONYMOUS_CAP);
        assertEq(tier1.max, parameters.get(ParameterKeys.TIER0_IDENTIFIED_CAP), "the ceilings have drifted");

        vm.prank(governance);
        vm.expectRevert();
        parameters.set(ParameterKeys.TIER1_PSEUDONYMOUS_CAP, tier1.max + 1);
    }

    /// @notice The FX mid decays faster than a credit attestation, by construction.
    /// @dev A credit limit is stable for a quarter of an hour and an FX mid is not.
    ///      Both are bearer credentials; asserting the ordering of their ceilings is
    ///      what stops a later recalibration from quietly making them the same thing.
    function test_theFxMidTtlIsTighterThanTheAttestationTtl() public view {
        ParameterRegistry.Parameter memory mid = parameters.parameter(ParameterKeys.FX_MID_MAX_TTL);
        ParameterRegistry.Parameter memory attestation =
            parameters.parameter(ParameterKeys.ATTESTATION_MAX_TTL);

        assertLt(mid.value, attestation.value, "the FX mid does not decay faster");
        assertLt(mid.max, attestation.max, "the FX mid's ceiling is not tighter");
    }

    /// @notice The corridor haircut can never be set past the corridor concentration cap.
    /// @dev The band's ceiling was chosen against a number that already exists rather
    ///      than invented: a risk loading larger than the corridor's own concentration
    ///      cap would make that cap unreachable, and a cap nothing can reach is not a
    ///      cap. The haircut loads credit headroom, never the merchant's payout.
    function test_theCorridorHaircutCeilingSitsUnderTheConcentrationCap() public view {
        ParameterRegistry.Parameter memory haircut =
            parameters.parameter(ParameterKeys.FX_CORRIDOR_HAIRCUT_BPS);
        assertLe(
            haircut.max,
            parameters.get(ParameterKeys.CORRIDOR_CONCENTRATION_BPS),
            "the haircut can exceed the corridor cap it loads against"
        );
    }

    // ─── Bulk reads ──────────────────────────────────────────────────────────

    function test_getManyReadsTheKeysItWasGiven() public view {
        bytes32[] memory wanted = new bytes32[](3);
        wanted[0] = ParameterKeys.MIN_TICKET;
        wanted[1] = ParameterKeys.MDR_BPS;
        wanted[2] = ParameterKeys.TIER0_INITIAL_LIMIT;

        uint256[] memory values = parameters.getMany(wanted);
        assertEq(values.length, 3);
        assertEq(values[0], parameters.get(ParameterKeys.MIN_TICKET));
        assertEq(values[1], parameters.get(ParameterKeys.MDR_BPS));
        assertEq(values[2], parameters.get(ParameterKeys.TIER0_INITIAL_LIMIT));
    }
}
