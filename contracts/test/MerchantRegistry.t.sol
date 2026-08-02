// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {OriginationFixture} from "./helpers/OriginationFixture.sol";

import {CheckoutRouter} from "../src/CheckoutRouter.sol";
import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";

/// @notice MERCH-01 and MERCH-06 — the fraud posture for the whole book.
///
/// @dev Everything here is aimed at one attack. A merchant sells to a confederate on
///      credit, the pool fronts the full amount, the merchant "refunds" to a
///      different address, and the pool holds a receivable against a borrower who
///      will never pay for goods that never moved. It is the highest-yield attack on
///      a BNPL book because the attacker is paid before anyone can observe anything,
///      and a flat entry bond does not price it at all.
contract MerchantRegistryTest is OriginationFixture {
    address internal newMerchant = address(0xFEED5);

    function setUp() public {
        _deployStack();
        _prepareOrigination();
    }

    // ─── The bond ────────────────────────────────────────────────────────────

    /// @notice MERCH-01. The bond is a function of live exposure, not an entry fee.
    function test_theBondRequirementScalesWithOutstandingExposure() public {
        uint256 floor_ = parameters.get(ParameterKeys.MERCHANT_BOND_FLOOR);
        assertEq(merchants.requiredBond(merchant), floor_, "the floor does not bind at zero exposure");

        // Push exposure high enough that the proportional term overtakes the floor.
        uint256 bondBps = parameters.get(ParameterKeys.MERCHANT_BOND_BPS);
        uint256 exposureNeeded = (floor_ * PlanParams.BPS) / bondBps;

        merchants.grantRole(merchants.BOOKKEEPER_ROLE(), address(this));
        merchants.noteOrigination(merchant, exposureNeeded * 2);

        assertEq(
            merchants.requiredBond(merchant),
            (exposureNeeded * 2 * bondBps) / PlanParams.BPS,
            "the requirement did not scale with exposure"
        );
        assertGt(merchants.requiredBond(merchant), floor_, "the floor still bound above it");
    }

    /// @notice The requirement falls as fronted principal comes back.
    /// @dev A merchant winding down recovers their bond as their plans repay, without
    ///      an operator having to decide when. The alternative — a manual release —
    ///      makes the bond an operator's hostage rather than a risk control.
    function test_theRequirementFallsAsExposureIsRecovered() public {
        // Exactly the velocity cap, which at a 10% bond ratio is well clear of the
        // $250 floor — so the proportional term is what is being observed.
        uint256 exposure = merchants.velocityCapFor(merchant);

        merchants.grantRole(merchants.BOOKKEEPER_ROLE(), address(this));
        merchants.noteOrigination(merchant, exposure);
        uint256 peak = merchants.requiredBond(merchant);
        assertGt(peak, parameters.get(ParameterKeys.MERCHANT_BOND_FLOOR), "the floor still bound");

        merchants.noteRecovered(merchant, exposure);
        assertLt(merchants.requiredBond(merchant), peak, "the requirement did not fall");
        assertEq(
            merchants.requiredBond(merchant),
            parameters.get(ParameterKeys.MERCHANT_BOND_FLOOR),
            "the requirement did not return to the floor"
        );
    }

    /// @notice A repaid plan releases the merchant's exposure, and their bond with it.
    ///
    /// @dev Without the router's crank the two ledgers drift apart: the pool learns
    ///      the receivable came back, the registry never does, and a merchant who has
    ///      repaid every plan they ever originated cannot withdraw a cent of their
    ///      bond. The bond would ratchet upward forever, which turns a risk control
    ///      into an expropriation.
    function test_repaymentReleasesTheMerchantsExposureAndBond() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;

        assertEq(merchants.outstandingFrontedFor(merchant), PRINCIPAL, "exposure not taken");
        uint256 peak = merchants.requiredBond(merchant);

        _payOff(p);
        checkout.recognise(id);

        assertEq(merchants.outstandingFrontedFor(merchant), 0, "exposure survived repayment");
        assertLe(merchants.requiredBond(merchant), peak, "the requirement did not fall");

        // And the bond is now withdrawable down to the floor.
        uint256 bond = merchants.bondOf(merchant);
        uint256 required = merchants.requiredBond(merchant);
        vm.prank(merchant);
        merchants.withdrawBond(bond - required);
        assertEq(merchants.bondOf(merchant), required, "the merchant could not recover their bond");
    }

    /// @notice The crank is permissionless and idempotent.
    function test_theCrankIsOpenAndRepeatable() public {
        InstallmentPlan p = _checkoutDefault();
        bytes32 id = planId;
        _payOff(p);

        vm.prank(stranger);
        checkout.recognise(id);

        uint256 exposure = merchants.outstandingFrontedFor(merchant);
        vm.prank(stranger);
        checkout.recognise(id);

        assertEq(merchants.outstandingFrontedFor(merchant), exposure, "a second crank moved exposure");
    }

    /// @notice A merchant with live exposure cannot withdraw beneath the requirement.
    function test_aMerchantCannotWithdrawBelowTheRequirement() public {
        _checkoutDefault();

        uint256 bond = merchants.bondOf(merchant);
        uint256 required = merchants.requiredBond(merchant);
        uint256 excessive = bond - required + 1;

        vm.prank(merchant);
        vm.expectRevert(
            abi.encodeWithSelector(MerchantRegistry.BondBelowRequirement.selector, bond - excessive, required)
        );
        merchants.withdrawBond(excessive);

        vm.prank(merchant);
        merchants.withdrawBond(bond - required);
        assertEq(merchants.bondOf(merchant), required, "the merchant could not reach the requirement");
    }

    /// @notice An origination that would leave the bond short is refused.
    function test_anUnderbondedMerchantCannotOriginate() public {
        _onboardMerchant(newMerchant, 0);
        _screenClear(newMerchant);

        (bool ok, string memory reason) = merchants.canOriginate(newMerchant, PRINCIPAL);
        assertFalse(ok, "an unbonded merchant reported eligible");
        assertEq(reason, "merchant bond below requirement");
    }

    // ─── Vesting withholding (DEC-09) ────────────────────────────────────────

    /// @notice A new merchant's own settlement capitalises their own bond.
    ///
    /// @dev The mechanism that makes the exposure-scaled bond self-funding. Read as a
    ///      rate that improves over time, "MDR vesting" is a pricing gimmick. Read as
    ///      a withholding it is the control the fraud model needs — and it binds the
    ///      merchant most likely to run refund arbitrage, which is the one who just
    ///      onboarded.
    function test_aNewMerchantsSettlementIsPartlyWithheldIntoTheirBond() public {
        uint256 bondBefore = merchants.bondOf(merchant);
        uint256 vestingBps = merchants.vestingBpsFor(merchant);
        assertGt(vestingBps, 0, "a freshly registered merchant is not in the vesting window");

        uint256 net = PRINCIPAL - checkout.mdrFor(PRINCIPAL);
        uint256 expected = (net * vestingBps) / PlanParams.BPS;

        _checkoutDefault();

        assertEq(merchants.bondOf(merchant) - bondBefore, expected, "nothing was withheld into the bond");
        assertEq(merchants.merchantOf(merchant).withheld, expected, "the withholding was not tracked");
        assertEq(usdc.balanceOf(merchantPayout), net - expected, "the merchant was paid the withheld part");
    }

    /// @notice A seasoned merchant is paid in full.
    function test_aSeasonedMerchantHasNothingWithheld() public {
        vm.warp(vm.getBlockTimestamp() + parameters.get(ParameterKeys.MERCHANT_VESTING_WINDOW) + 1);
        _screenClear(borrower);
        _screenClear(merchant);

        assertEq(merchants.vestingBpsFor(merchant), 0, "the merchant is still vesting");
        assertTrue(merchants.isSeasoned(merchant), "the merchant is not seasoned");

        uint256 net = PRINCIPAL - checkout.mdrFor(PRINCIPAL);
        _checkoutDefault();
        assertEq(usdc.balanceOf(merchantPayout), net, "a seasoned merchant had settlement withheld");
    }

    /// @notice Withheld capital is released before deposited capital.
    /// @dev Returning a merchant's own deposit while holding their earnings would be
    ///      the protocol keeping the wrong dollars.
    function test_withheldCapitalIsReturnedFirst() public {
        _checkoutDefault();
        uint256 withheld = merchants.merchantOf(merchant).withheld;
        assertGt(withheld, 0);

        uint256 room = merchants.bondOf(merchant) - merchants.requiredBond(merchant);
        uint256 draw = room < withheld ? room : withheld;

        vm.prank(merchant);
        merchants.withdrawBond(draw);

        assertEq(merchants.merchantOf(merchant).withheld, withheld - draw, "deposits were released first");
    }

    // ─── Velocity (MERCH-06) ─────────────────────────────────────────────────

    /// @notice A new merchant runs into a rolling volume cap.
    function test_aNewMerchantHasAVelocityCap() public {
        uint256 cap = merchants.velocityCapFor(merchant);
        assertLt(cap, type(uint256).max, "a new merchant is uncapped");

        merchants.grantRole(merchants.BOOKKEEPER_ROLE(), address(this));
        merchants.noteOrigination(merchant, cap);

        assertEq(merchants.velocityUsed(merchant), cap, "the bucket did not fill");
        vm.expectRevert(abi.encodeWithSelector(MerchantRegistry.VelocityCapExceeded.selector, cap + 1, cap));
        merchants.noteOrigination(merchant, 1);
    }

    /// @notice The bucket leaks continuously rather than resetting on a boundary.
    ///
    /// @dev A fixed window lets a new merchant run two full caps back to back across
    ///      the boundary — on a daily cap that is a two-day fraud budget spent in ten
    ///      minutes, and the merchant does not even need to know when the boundary is
    ///      to find it.
    function test_theVelocityBucketLeaksRatherThanResetting() public {
        uint256 cap = merchants.velocityCapFor(merchant);
        uint256 window = parameters.get(ParameterKeys.MERCHANT_VELOCITY_WINDOW);

        merchants.grantRole(merchants.BOOKKEEPER_ROLE(), address(this));
        merchants.noteOrigination(merchant, cap);

        vm.warp(vm.getBlockTimestamp() + window / 2);
        assertApproxEqAbs(
            merchants.velocityUsed(merchant), cap / 2, 1, "half a window did not drain half the bucket"
        );

        vm.warp(vm.getBlockTimestamp() + window);
        assertEq(merchants.velocityUsed(merchant), 0, "a full window did not drain the bucket");
    }

    /// @notice A seasoned merchant is uncapped unless governance says otherwise.
    function test_aSeasonedMerchantIsUncappedUnlessOverridden() public {
        vm.warp(vm.getBlockTimestamp() + parameters.get(ParameterKeys.MERCHANT_VESTING_WINDOW) + 1);
        assertEq(merchants.velocityCapFor(merchant), type(uint256).max, "a seasoned merchant is capped");

        merchants.setVelocityCapOverride(merchant, 1000e6);
        assertEq(merchants.velocityCapFor(merchant), 1000e6, "the override did not bind");
    }

    // ─── Standing ────────────────────────────────────────────────────────────

    /// @notice Registration is self-serve; permission to originate is not.
    /// @dev Gating registration would only mean an operator has to be online for a
    ///      merchant to fill in a form. MERCH-05's sandbox is built on this being
    ///      open, and KYB is what actually gates the money.
    function test_registrationIsOpenAndKybIsNot() public {
        uint32 domain = payout.ARC_DOMAIN();
        vm.prank(newMerchant);
        merchants.register(merchantPayout, domain);

        assertTrue(merchants.isRegistered(newMerchant), "self-registration failed");
        assertFalse(merchants.isKybVerified(newMerchant), "registration granted KYB");

        vm.prank(newMerchant);
        vm.expectRevert();
        merchants.attestKyb(newMerchant, true);
    }

    function test_aMerchantCannotRegisterTwice() public {
        uint32 domain = payout.ARC_DOMAIN();
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(MerchantRegistry.AlreadyRegistered.selector, merchant));
        merchants.register(merchantPayout, domain);
    }

    /// @notice Only the bookkeeper writes exposure.
    /// @dev Exposure is what the bond is priced off, so an open writer would let
    ///      anyone reduce a merchant's requirement to the floor.
    function test_onlyTheBookkeeperMovesExposure() public {
        vm.prank(stranger);
        vm.expectRevert();
        merchants.noteRecovered(merchant, 1e6);
    }

    /// @notice UW-09's per-merchant concentration cap binds at the pool.
    ///
    /// @dev A share of the book rather than an absolute, so it scales with the capital
    ///      that has to absorb the loss. A fixed limit becomes either irrelevant or
    ///      binding as the book grows, and nobody notices which until it is one of
    ///      them.
    function test_perMerchantConcentrationIsCappedAsAShareOfTheBook() public {
        bytes32 corridor = checkout.corridorOf(address(usdc));
        _setParameter(ParameterKeys.MERCHANT_CONCENTRATION_BPS, 100);

        (uint256 room,) = creditPool.concentrationHeadroom(merchant, corridor);
        assertEq(room, (creditPool.totalAssets() * 100) / PlanParams.BPS, "headroom is not the share");

        // Fill this merchant's bucket to the cap with a synthetic front.
        creditPool.setOriginator(address(this));
        creditPool.front(keccak256("filler"), address(0xF11), merchant, corridor, room, 0, 0, address(this));

        (uint256 remaining,) = creditPool.concentrationHeadroom(merchant, corridor);
        assertEq(remaining, 0, "the concentration bucket did not fill");

        CheckoutRouter.OriginationInput memory input =
            _originationInput(_terms(PRINCIPAL, COUNT, 9), keccak256("s"), 5000e6);
        vm.expectRevert(abi.encodeWithSelector(CheckoutRouter.MerchantConcentration.selector, PRINCIPAL, 0));
        checkout.originate(input);
    }
}
