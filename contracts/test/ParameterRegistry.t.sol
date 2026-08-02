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
        // Raised by three in Phase 6 with the settlement-escrow rows. The floor moves
        // with the seed set rather than being deleted, because a count assertion that
        // nobody maintains is a count assertion that stops noticing a dropped `_define`.
        assertGt(keys.length, 23, "the seeded set is suspiciously small");

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
        parameters.set(ParameterKeys.TIER0_BOOK_SHARE_BPS, 5_000);
    }

    /// @notice Limit growth can be switched off but never reversed into a shrink.
    function test_growthCannotBecomeShrinkage() public {
        vm.prank(governance);
        vm.expectRevert();
        parameters.set(ParameterKeys.TIER0_GROWTH_BPS, 9_000);

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
            abi.encodeWithSelector(
                ParameterRegistry.OutOfBand.selector, ParameterKeys.MDR_BPS, 550, 300, 500
            )
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
