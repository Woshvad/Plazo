// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {PlanFixture} from "./helpers/PlanFixture.sol";
import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {IInstallmentPlan} from "../src/interfaces/IInstallmentPlan.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";
import {TermsDetail} from "../src/libraries/TermsDetail.sol";
import {MockContractWallet} from "./mocks/MockContractWallet.sol";

/// @title SignerMutationTest
/// @notice The smart-account signing path, and the risk it introduces.
///
/// @dev One-ceremony signing requires a smart account: there is no batch typed-data
///      RPC anywhere, so an EOA borrower signs a four-check strip four times and a
///      twelve-check Flex strip twelve times. The Phase 1 fork spike proved Arc USDC
///      completes an ERC-1271 authorization end to end against real bytecode, so the
///      mechanism exists — which makes the smart account the default borrower wallet
///      rather than an edge case.
///
///      It also introduces the one risk an EOA does not have. A contract account can
///      change what it considers a valid signature at any moment, retroactively
///      invalidating every outstanding check it signed. The roadmap proposed making
///      the unsecured cap depend on whether a wallet vendor exposes a key-rotation
///      webhook. These tests implement the alternative: an onchain observation that
///      anyone can make and anyone is paid to make.
contract SignerMutationTest is PlanFixture {
    MockContractWallet internal wallet;

    function setUp() public {
        _deployStack();
        vm.warp(1_800_000_000);

        // The borrower is now a contract that validates with the same key. Nothing
        // else about origination changes — and that is the property worth having:
        // the collection path does not branch on signer class anywhere.
        wallet = new MockContractWallet(vm.addr(BORROWER_KEY));
        borrower = address(wallet);
        signerClass = TermsDetail.SignerClass.Contract;
    }

    function test_aContractWalletCanSignAndBeCollectedFrom() public {
        _originateDefault();
        _fundBorrower(200e6);

        plan.collect(0);
        assertEq(plan.outstandingPrincipal(), 75e6);
        assertEq(usdc.balanceOf(address(wallet)), 175e6);
    }

    /// @dev The failure mode, made visible. A revoked signer is not a borrower who
    ///      is short of money, and filing it as one would put a credit event on a
    ///      Passport for what is a wallet configuration change — and would provision
    ///      NAV against a loss that has not happened.
    function test_aRevokedSignerBouncesAsSignerInvalidRatherThanInsufficientFunds() public {
        _originateDefault();
        _fundBorrower(200e6);
        plan.collect(0);

        wallet.revokeSigner();
        vm.warp(_dueDate(planId, firstDue, 1));

        (bool cleared, IInstallmentPlan.BounceReason reason) = plan.collect(1);
        assertFalse(cleared);
        assertEq(uint256(reason), uint256(IInstallmentPlan.BounceReason.SignerInvalid));
        assertTrue(reason != IInstallmentPlan.BounceReason.InsufficientFunds);
    }

    /// @dev PLAN-10, and the resolution of D1. The cap policy turns on whether signer
    ///      mutation is observable in real time. This makes it observable without a
    ///      vendor: a stranger cranks `revalidate()`, the plan re-derives each
    ///      outstanding digest from the token's own domain separator, and a strip
    ///      that no longer validates is bounced with a typed reason on the spot.
    function test_revalidateSurfacesMutationBeforeTheNextDueDate() public {
        _originateDefault();
        _fundBorrower(200e6);
        plan.collect(0);

        wallet.revokeSigner();

        vm.expectEmit(true, true, false, true, address(plan));
        emit IInstallmentPlan.CheckBounced(planId, 1, IInstallmentPlan.BounceReason.SignerInvalid);

        vm.prank(stranger);
        plan.revalidate();

        assertEq(plan.revalidatedAt(), vm.getBlockTimestamp());
        assertEq(
            uint256(plan.installmentStatus(1)),
            uint256(IInstallmentPlan.InstallmentStatus.Bounced),
            "revalidation did not record the mutation"
        );
        // Discovered days before the due date rather than at it — which is the whole
        // point, because at the due date the information arrives too late to reprice
        // anything.
        assertLt(vm.getBlockTimestamp(), plan.dueDate(1));
    }

    function test_revalidatingAValidStripChangesNothing() public {
        _originateDefault();
        _fundBorrower(200e6);

        vm.prank(stranger);
        plan.revalidate();

        for (uint256 i = 0; i < COUNT; ++i) {
            assertEq(uint256(plan.installmentStatus(i)), uint256(IInstallmentPlan.InstallmentStatus.Pending));
        }
        assertEq(uint256(plan.state()), uint256(IInstallmentPlan.PlanState.Pending));
    }

    /// @dev Paid, because an unpaid observation is an observation nobody makes.
    ///      Rate-limited to one paid call per freshness window, because a bounty
    ///      anyone can claim on demand is a faucet.
    function test_revalidationIsPaidButNotDrainable() public {
        _originateDefault();

        vm.prank(stranger);
        plan.revalidate();
        assertEq(usdc.balanceOf(stranger), PlanParams.MARK_BOUNTY, "the revalidator was not paid");

        vm.prank(stranger);
        vm.expectRevert();
        plan.revalidate();

        vm.warp(vm.getBlockTimestamp() + PlanParams.REVALIDATION_WINDOW);
        vm.prank(stranger);
        plan.revalidate();
        assertEq(usdc.balanceOf(stranger), 2 * PlanParams.MARK_BOUNTY);
    }

    /// @dev An EOA's validation logic is its address and cannot change, so there is
    ///      nothing to observe and nothing to pay for. Paying anyway would let anyone
    ///      drain every EOA plan's escrow one window at a time for no information.
    function test_revalidatingAnEoaPlanPaysNothing() public {
        borrower = vm.addr(BORROWER_KEY);
        signerClass = TermsDetail.SignerClass.EOA;
        _originateDefault();

        vm.prank(stranger);
        plan.revalidate();

        assertEq(usdc.balanceOf(stranger), 0, "an EOA plan paid for an observation that cannot change");
        assertEq(plan.markEscrow(), PlanParams.markEscrowFor(COUNT));
    }

    /// @dev The signer class is inside `termsHash`, so it is inside `planId`, so it
    ///      is inside every authorization nonce and the payee address. Phase 3's
    ///      UW-10 reads it to set the unsecured cap; it cannot be edited afterwards
    ///      to move a borrower into a more generous band.
    function test_signerClassIsBoundToThePlanIdentity() public {
        _originateDefault();
        assertEq(uint256(plan.signerClass()), uint256(TermsDetail.SignerClass.Contract));

        TermsDetail.Detail memory asEoa = _detail();
        asEoa.signerClass = TermsDetail.SignerClass.EOA;
        assertTrue(
            TermsDetail.hash(asEoa) != TermsDetail.hash(_detail()),
            "the signer class does not reach the commitment"
        );
    }
}
