// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {PlanFixture} from "./helpers/PlanFixture.sol";
import {MockArcStablecoin} from "./mocks/MockArcStablecoin.sol";

import {PledgeVault} from "../src/underwriting/PledgeVault.sol";
import {ParameterRegistry} from "../src/ParameterRegistry.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";

/// @notice UW-06. The accrual, the lock, and the seizure nobody has to authorise.
///
/// @dev Three properties carry this suite and each is stated as its own consequence:
///
///      1. **A pledge keeps earning while it is locked.** The lock is on *par*, not on
///         the position, so the yield accrues to the pledger throughout and is
///         withdrawable while the plan it backs is still open. A design that parked the
///         asset somewhere it stopped accruing would satisfy the limit and fail UW-06.
///      2. **A pledge cannot leave while the credit it bought is live.** `release` is
///         bounded by `freeOf` and never by `pledgedValueOf`. Both halves are tested —
///         the refusal while bound, and the release once the plan terminates — and a
///         deliberate-failure check confirmed the bound is load-bearing rather than
///         decorative.
///      3. **A Tier-2 default is collectable with every operator role at the zero
///         address.** GOV-08's standard, applied to collateral.
///
///      Every clock read is `vm.getBlockTimestamp()` (DEC-30, finding 14). `MockArcUsdc`
///      is the plan's token and `usyc` is a second `MockArcStablecoin` standing in for
///      USYC — 6-decimal, which finding 31 measured, and whose EIP-3009 surface this
///      suite never calls, because the real USYC has none (E-07, finding 32).
contract PledgeTest is PlanFixture {
    MockArcStablecoin internal usyc;
    ParameterRegistry internal params;
    PledgeVault internal vault;

    address internal pledger;
    address internal pledger2;
    address internal funder;
    address internal binder;
    address internal outsider;

    uint256 internal constant PLEDGE = 1000e6;

    function setUp() public {
        _deployStack();

        pledger = makeAddr("uw06-pledger");
        pledger2 = makeAddr("uw06-second-pledger");
        funder = makeAddr("uw06-yield-funder");
        binder = makeAddr("uw06-tiered-underwriter");
        outsider = makeAddr("uw06-outsider-holding-nothing");

        // USYC is 6-decimal and permit-only. This mock carries an EIP-3009 surface
        // because USDC's does; nothing below ever calls it, and that is the point —
        // a pledge that took a signature would pass here and revert on Arc.
        usyc = new MockArcStablecoin("USYC", "USYC");
        params = new ParameterRegistry(address(this));
        vault = new PledgeVault(address(this), address(usyc), address(params));
        vault.grantRole(vault.BINDER_ROLE(), binder);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The accrual
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Two pledgers, one yield payment, and every unit ends up somewhere.
    ///
    /// @dev The yield is bounded at the total pledged — a 100% return, which is already
    ///      absurd for a treasury instrument. That bound is what makes a two-unit
    ///      absolute tolerance an honest assertion rather than a fudge: the inflation
    ///      guard's `+1` costs at most `a / (a + b + 1)` of a unit against the exact
    ///      pro-rata figure, which is under one unit for any `y <= a + b`.
    function testFuzz_pledgeAccruesToPledger(uint256 a, uint256 b, uint256 y) public {
        a = bound(a, 1e6, 1e12);
        b = bound(b, 1e6, 1e12);
        y = bound(y, 0, a + b);

        _pledge(pledger, a);
        _pledge(pledger2, b);
        _payYield(y);

        uint256 takenA = _release(pledger, type(uint256).max);
        uint256 takenB = _release(pledger2, type(uint256).max);

        assertGe(takenA, a, "a pledger got back less principal than they put in");
        assertGe(takenB, b, "a pledger got back less principal than they put in");

        // The inflation-guard property. Nobody may withdraw more than their own
        // deposit plus the whole yield, which is what a share-rounding attack on the
        // first pledge would buy.
        assertLe(takenA, a + y, "a pledger withdrew more than their deposit plus the entire yield");
        assertLe(takenB, b + y, "a pledger withdrew more than their deposit plus the entire yield");
        assertLe(takenA + takenB, a + b + y, "the vault paid out more than it ever held");

        assertApproxEqAbs(takenA - a, (a * y) / (a + b), 2, "the yield did not split pro rata");
        assertApproxEqAbs(takenB - b, (b * y) / (a + b), 2, "the yield did not split pro rata");

        assertLe(
            usyc.balanceOf(address(vault)),
            4,
            "the vault kept more than virtual-share dust after both pledgers left"
        );
    }

    /// @notice The requirement's actual content: locked capital still earns.
    ///
    /// @dev A pledge that stopped accruing the moment it backed a plan would satisfy
    ///      every other assertion in this file and still fail UW-06. The lock is on par,
    ///      so the accrual sits *above* it and is withdrawable while the plan is open —
    ///      the pledger keeps their yield without ever weakening the collateral.
    function test_pledgeKeepsAccruingWhileLocked() public {
        _pledge(pledger, PLEDGE);

        InstallmentPlan openPlan = _originateDefault();
        bytes32 boundId = planId;
        vm.prank(binder);
        vault.bindPlan(boundId, address(openPlan), pledger, PLEDGE);

        assertEq(vault.freeOf(pledger), 0, "a fully bound pledge started with a free balance");

        _payYield(100e6);

        assertApproxEqAbs(
            vault.pledgedValueOf(pledger), PLEDGE + 100e6, 1, "the pledge stopped accruing once it was locked"
        );
        assertApproxEqAbs(
            vault.freeOf(pledger), 100e6, 1, "the accrual on a locked pledge was not free to withdraw"
        );

        uint256 taken = _release(pledger, type(uint256).max);
        assertApproxEqAbs(taken, 100e6, 1, "the pledger could not take the yield their locked capital earned");
        assertEq(vault.lockedOf(pledger), PLEDGE, "taking the yield reduced what the plan was backed by");
        assertApproxEqAbs(
            vault.pledgedValueOf(pledger), PLEDGE, 1, "taking the yield ate into the pledged principal"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The valuation
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice `limitFor` follows the registry row and nothing else.
    ///
    /// @dev The observable difference between a haircut and a mark is that a haircut does
    ///      not move when nothing but time passes. A mark would — which is the whole
    ///      reason C1 forbids reading USYC's Teller oracle to size this limit.
    function test_limitIsParMinusHaircutAndNeverAMark() public {
        _pledge(pledger, PLEDGE);

        uint256 haircut = params.get(ParameterKeys.TIER2_PLEDGE_HAIRCUT_BPS);
        assertEq(haircut, 2000, "the seeded Tier-2 haircut moved");
        assertEq(
            vault.limitFor(pledger),
            (vault.pledgedValueOf(pledger) * (PlanParams.BPS - haircut)) / PlanParams.BPS,
            "the limit is not par minus the governed haircut"
        );
        assertEq(vault.limitFor(pledger), 800e6, "a 20% haircut on 1000 did not leave 800");

        // Governance moves the row inside its compiled band; the limit follows.
        params.set(ParameterKeys.TIER2_PLEDGE_HAIRCUT_BPS, 500);
        assertEq(vault.limitFor(pledger), 950e6, "the limit did not follow the row down");
        params.set(ParameterKeys.TIER2_PLEDGE_HAIRCUT_BPS, 5000);
        assertEq(vault.limitFor(pledger), 500e6, "the limit did not follow the row up");

        params.set(ParameterKeys.TIER2_PLEDGE_HAIRCUT_BPS, 2000);
        uint256 before = vault.limitFor(pledger);
        vm.warp(vm.getBlockTimestamp() + 365 days);
        assertEq(vault.limitFor(pledger), before, "the limit moved with time, which is what a mark does");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The lock
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The threat's negative and positive halves in one test.
    ///
    /// @dev Without the bound a pledger could back a plan, watch it originate, and
    ///      withdraw the collateral before the first due date — an unsecured loan
    ///      wearing a secured loan's paperwork.
    function test_boundPledgeCannotBeReleased() public {
        _pledge(pledger, PLEDGE);

        InstallmentPlan openPlan = _originateDefault();
        bytes32 boundId = planId;
        vm.prank(binder);
        vault.bindPlan(boundId, address(openPlan), pledger, PLEDGE);

        assertEq(vault.freeOf(pledger), 0, "a fully bound pledge still had a free balance");
        assertEq(vault.lockedOf(pledger), PLEDGE, "the binding did not lock the principal it backed");

        uint256 taken = _release(pledger, PLEDGE);
        assertEq(taken, 0, "collateral backing an open plan was withdrawn before the first due date");
        assertEq(usyc.balanceOf(pledger), 0, "the pledger received asset while their plan was still open");

        _driveToRepaid(openPlan);

        // Permissionless, and called by somebody holding no role anywhere: a pledger
        // whose plan is repaid must not need an operator to be alive.
        vm.prank(outsider);
        vault.unbindPlan(boundId);

        assertEq(vault.lockedOf(pledger), 0, "the lock survived the plan it backed");
        assertApproxEqAbs(vault.freeOf(pledger), PLEDGE, 1, "a repaid plan did not free its collateral");

        uint256 after_ = _release(pledger, type(uint256).max);
        assertApproxEqAbs(after_, PLEDGE, 1, "the pledger could not recover their collateral after payoff");
    }

    /// @notice A second binding cannot reach past what the first one left.
    function test_bindCannotExceedFreeBalance() public {
        _pledge(pledger, PLEDGE);

        StubPlan first = new StubPlan(pool);
        StubPlan second = new StubPlan(pool);

        vm.prank(binder);
        vault.bindPlan(keccak256("bind-first"), address(first), pledger, 600e6);
        assertEq(vault.freeOf(pledger), 400e6, "the first binding did not lock exactly what it took");

        vm.prank(binder);
        vm.expectRevert(abi.encodeWithSelector(PledgeVault.InsufficientFreePledge.selector, 500e6, 400e6));
        vault.bindPlan(keccak256("bind-second"), address(second), pledger, 500e6);

        // And the amount that does fit still binds, so the refusal is about the excess
        // rather than about there being a second plan.
        vm.prank(binder);
        vault.bindPlan(keccak256("bind-second"), address(second), pledger, 400e6);
        assertEq(vault.lockedOf(pledger), PLEDGE, "the second binding did not lock the remainder");
        assertEq(vault.freeOf(pledger), 0, "two bindings totalling the pledge left a free balance");
    }

    /// @notice A live plan cannot be unbound, so the permissionless path is not an
    ///         early exit from the lock.
    function test_unbindBeforeTerminalReverts() public {
        _pledge(pledger, 100e6);
        StubPlan stub = new StubPlan(pool);

        uint256 refused;
        for (uint256 ordinal = 0; ordinal <= uint256(type(IInstallmentPlan.PlanState).max); ++ordinal) {
            IInstallmentPlan.PlanState state = IInstallmentPlan.PlanState(ordinal);
            if (_isNonDefaultedTerminal(state)) continue;

            bytes32 id = keccak256(abi.encodePacked("unbind-refusal", ordinal));
            vm.prank(binder);
            vault.bindPlan(id, address(stub), pledger, 1e6);
            stub.setState(state);

            vm.expectRevert(abi.encodeWithSelector(PledgeVault.PlanNotTerminal.selector, id, uint8(ordinal)));
            vm.prank(outsider);
            vault.unbindPlan(id);
            ++refused;
        }
        assertEq(refused, 10, "the non-terminal state set changed without this test noticing");

        // The four that do release, driven through the same path.
        stub.setState(IInstallmentPlan.PlanState.Repaid);
        _bindAndUnbind(stub, "unbind-repaid");
        stub.setState(IInstallmentPlan.PlanState.Cancelled);
        _bindAndUnbind(stub, "unbind-cancelled");
        stub.setState(IInstallmentPlan.PlanState.Refunded);
        _bindAndUnbind(stub, "unbind-refunded");
        stub.setState(IInstallmentPlan.PlanState.SettledWithFeeOutstanding);
        _bindAndUnbind(stub, "unbind-settled-with-fee");

        // And a real, live plan — Pending, nothing collected — refuses too.
        InstallmentPlan openPlan = _originateDefault();
        bytes32 liveId = planId;
        vm.prank(binder);
        vault.bindPlan(liveId, address(openPlan), pledger, 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                PledgeVault.PlanNotTerminal.selector, liveId, uint8(IInstallmentPlan.PlanState.Pending)
            )
        );
        vault.unbindPlan(liveId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The seizure
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice GOV-08 applied to collateral: a defaulted plan's pledge is seized by an
    ///         address holding no role, on a vault holding no admin.
    ///
    /// @dev **The roles are granted before they are revoked (DEC-46).** A fixture that
    ///      never granted `BINDER_ROLE` would let this test report the sharpest assertion
    ///      in the file green against a gate that had never been armed. `binder` holds it
    ///      from `setUp`, uses it, and then loses it here.
    function test_pledgeSeizureIsOperatorFree() public {
        _pledge(pledger, PLEDGE);

        InstallmentPlan defaulted = _originateDefault();
        bytes32 boundId = planId;
        address recipient = defaulted.settlementRecipient();

        vm.prank(binder);
        vault.bindPlan(boundId, address(defaulted), pledger, PLEDGE);

        // ── The zeroing ──────────────────────────────────────────────────────
        //
        // `DEFAULT_ADMIN_ROLE` last, because it authorises every revocation above it.
        vault.revokeRole(vault.BINDER_ROLE(), binder);
        vault.renounceRole(vault.DEFAULT_ADMIN_ROLE(), address(this));

        assertFalse(vault.hasRole(vault.BINDER_ROLE(), binder), "the binder kept its role");
        assertFalse(vault.hasRole(vault.BINDER_ROLE(), address(this)), "the deployer held BINDER_ROLE");
        assertFalse(vault.hasRole(vault.BINDER_ROLE(), outsider), "an outsider held BINDER_ROLE");
        // AccessControl without the enumerable extension cannot count holders, so this
        // asserts over every address this test has ever handed to `grantRole` plus every
        // address that appears in the seizure, and then closes the door: with no
        // `DEFAULT_ADMIN_ROLE` holder there is no path to grant either role again.
        assertFalse(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), address(this)), "the deployer kept admin");
        assertFalse(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), binder), "the binder held admin");
        assertFalse(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), outsider), "an outsider held admin");
        assertFalse(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), pledger), "the pledger held admin");
        assertEq(
            vault.getRoleAdmin(vault.BINDER_ROLE()),
            vault.DEFAULT_ADMIN_ROLE(),
            "BINDER_ROLE is administered by something other than the role nobody now holds"
        );

        _driveToDefaulted(defaulted);
        assertEq(
            uint8(defaulted.state()),
            uint8(IInstallmentPlan.PlanState.Defaulted),
            "the plan did not reach charge-off"
        );

        uint256 recipientBefore = usyc.balanceOf(recipient);

        vm.prank(outsider);
        vault.seize(boundId);

        assertEq(
            usyc.balanceOf(recipient) - recipientBefore,
            PLEDGE,
            "the collateral did not reach the address the borrower's signed terms named"
        );
        assertEq(usyc.balanceOf(outsider), 0, "the caller of a permissionless seizure was paid");
        assertEq(vault.lockedOf(pledger), 0, "the seizure left the pledger's capital locked");
        assertEq(
            vault.pledgedValueOf(pledger), 0, "the seizure left the pledger a claim on seized collateral"
        );
        assertFalse(vault.bindingOf(boundId).active, "the binding survived its own seizure");
    }

    /// @notice The destination is unforgeable, which is what makes permissionlessness
    ///         safe.
    function test_seizeDestinationIsNotCallerChosen() public {
        // By inspection: one parameter, and it is the plan id.
        assertEq(
            PledgeVault.seize.selector,
            bytes4(keccak256("seize(bytes32)")),
            "seize grew a parameter, and the only parameter it may have is the plan id"
        );

        _pledge(pledger, PLEDGE);
        InstallmentPlan defaulted = _originateDefault();
        bytes32 boundId = planId;

        vm.prank(binder);
        vault.bindPlan(boundId, address(defaulted), pledger, PLEDGE);
        _driveToDefaulted(defaulted);

        // A greedy caller who is himself a perfectly valid payment address. There is no
        // argument through which he could name himself, and the balances say so.
        address greedy = makeAddr("uw06-greedy-keeper");
        vm.prank(greedy);
        vault.seize(boundId);

        assertEq(usyc.balanceOf(greedy), 0, "a permissionless seizure paid its caller");
        assertEq(
            usyc.balanceOf(defaulted.settlementRecipient()),
            PLEDGE,
            "the collateral went somewhere other than the plan's own settlement recipient"
        );
    }

    /// @notice Every state short of charge-off refuses, including `Delinquent`.
    ///
    /// @dev Seizing at delinquency rather than at charge-off would take collateral from a
    ///      borrower who still has a cure path, which is exactly what CURE-08/09 exist to
    ///      protect. Sixty days, not three.
    function test_seizeBeforeDefaultReverts() public {
        _pledge(pledger, 100e6);
        StubPlan stub = new StubPlan(pool);

        uint256 refused;
        for (uint256 ordinal = 0; ordinal <= uint256(type(IInstallmentPlan.PlanState).max); ++ordinal) {
            if (ordinal == uint256(IInstallmentPlan.PlanState.Defaulted)) continue;

            bytes32 id = keccak256(abi.encodePacked("seize-refusal", ordinal));
            vm.prank(binder);
            vault.bindPlan(id, address(stub), pledger, 1e6);
            stub.setState(IInstallmentPlan.PlanState(ordinal));

            vm.expectRevert(abi.encodeWithSelector(PledgeVault.PlanNotDefaulted.selector, id, uint8(ordinal)));
            vm.prank(outsider);
            vault.seize(id);
            ++refused;
        }
        assertEq(refused, 13, "the plan state set changed without this test noticing");

        // Named explicitly, because it is the one whose refusal is a policy rather than
        // a technicality: a delinquent borrower is inside their cure window.
        assertEq(uint8(IInstallmentPlan.PlanState.Delinquent), 3, "Delinquent's ordinal moved");
        assertEq(usyc.balanceOf(pool), 0, "collateral moved on a plan that had not charged off");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // E-07 as a test rather than a comment
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The vault exposes no signature-taking entry point of any kind.
    ///
    /// @dev Asserted over the **compiled external surface** rather than over the `.sol`
    ///      text: `fs_permissions` grants read on `./out` and not on `./src`, and the
    ///      artifact's method identifiers are the stronger subject anyway — they are what
    ///      an attacker can actually call, and they cannot be defeated by a NatSpec
    ///      paragraph that happens to name the forbidden word.
    ///
    ///      USYC has no EIP-3009 (E-07, finding 32). A pledge path that took a signature
    ///      would verify against a local mock, which does have one, and revert on Arc —
    ///      green in CI, dead in production, and discovered by a borrower.
    function test_noEip3009PathExists() public view {
        string memory artifact = vm.readFile("out/PledgeVault.sol/PledgeVault.json");
        string[] memory signatures = vm.parseJsonKeys(artifact, ".methodIdentifiers");

        assertGe(signatures.length, 12, "the artifact was not read, so this test asserted nothing");

        for (uint256 i = 0; i < signatures.length; ++i) {
            assertFalse(vm.contains(signatures[i], "permit"), "the vault grew a permit path");
            assertFalse(
                vm.contains(signatures[i], "uthorization"), "the vault grew an EIP-3009 authorization path"
            );
            assertFalse(
                vm.contains(signatures[i], "ignature"), "the vault grew a signature-taking entry point"
            );
            assertFalse(
                vm.contains(signatures[i], "uint8,bytes32,bytes32"), "the vault grew a (v, r, s) entry point"
            );
            assertFalse(vm.contains(signatures[i], "(bytes,"), "the vault grew a bytes-taking entry point");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _pledge(address who, uint256 amount) internal {
        usyc.mint(who, amount);
        vm.startPrank(who);
        usyc.approve(address(vault), amount);
        vault.pledge(amount);
        vm.stopPrank();
    }

    function _payYield(uint256 amount) internal {
        if (amount == 0) return;
        usyc.mint(funder, amount);
        vm.startPrank(funder);
        usyc.approve(address(vault), amount);
        vault.payYield(amount);
        vm.stopPrank();
    }

    function _release(address who, uint256 amount) internal returns (uint256 taken) {
        uint256 before = usyc.balanceOf(who);
        vm.prank(who);
        taken = vault.release(amount);
        assertEq(usyc.balanceOf(who) - before, taken, "release reported an amount it did not move");
    }

    function _bindAndUnbind(StubPlan stub, string memory label) internal {
        bytes32 id = keccak256(bytes(label));
        vm.prank(binder);
        vault.bindPlan(id, address(stub), pledger, 1e6);
        uint256 lockedBefore = vault.lockedOf(pledger);

        vm.prank(outsider);
        vault.unbindPlan(id);

        assertEq(vault.lockedOf(pledger), lockedBefore - 1e6, "a terminal plan did not release its lock");
    }

    function _isNonDefaultedTerminal(IInstallmentPlan.PlanState state) internal pure returns (bool) {
        return state == IInstallmentPlan.PlanState.Repaid || state == IInstallmentPlan.PlanState.Cancelled
            || state == IInstallmentPlan.PlanState.Refunded
            || state == IInstallmentPlan.PlanState.SettledWithFeeOutstanding;
    }

    function _driveToRepaid(InstallmentPlan target) internal {
        _fundBorrower(PRINCIPAL);
        vm.startPrank(borrower);
        usdc.approve(address(target), PRINCIPAL);
        target.repay(PRINCIPAL);
        vm.stopPrank();
        assertEq(uint8(target.state()), uint8(IInstallmentPlan.PlanState.Repaid), "the plan did not repay");
    }

    /// @dev Charge-off measures from the oldest *unpaid* installment, and a `Missed`
    ///      installment counts as unpaid. Sixty days, cranked by the keeper.
    function _driveToDefaulted(InstallmentPlan target) internal {
        vm.warp(target.graceEndsAt(0) + 1);
        vm.prank(keeper);
        target.markMissed(0);

        vm.warp(target.dueDate(0) + PlanParams.CHARGE_OFF_AFTER + 1);
        vm.prank(keeper);
        target.chargeOff();
    }
}

/// @notice A plan-shaped double whose state is settable.
///
/// @dev The real `InstallmentPlan` is driven for the two states that carry the
///      requirement — `Defaulted` for the seizure and `Repaid` for the release — because
///      a double cannot prove that `settlementRecipient` is the borrower's own signed
///      term. It is used for the exhaustive state matrices, where the alternative is
///      manufacturing `Disputed`, `Hold`, `HALTED`, `Blocked` and `FraudReversed` on a
///      real plan, and several of those are unreachable in v1 by design.
contract StubPlan {
    IInstallmentPlan.PlanState public state;
    address public settlementRecipient;

    constructor(address recipient) {
        settlementRecipient = recipient;
    }

    function setState(IInstallmentPlan.PlanState state_) external {
        state = state_;
    }
}
