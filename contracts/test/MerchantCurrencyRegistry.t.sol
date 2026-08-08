// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {MerchantCurrencyRegistry} from "../src/MerchantCurrencyRegistry.sol";

/// @notice MERCH-07's currency half — a preference, an allowlist, and a zero default.
///
/// @dev The whole point of this contract is what it does *not* do, so most of these tests
///      are about the absence of an effect: an unset merchant is untouched, a merchant
///      cannot reach another merchant's row, and a currency nobody permitted cannot be
///      named. The one behaviour that had to be chosen rather than inherited — what a
///      withdrawn allowance does to an election already made — is asserted explicitly
///      below, because a half-revoked allowlist that nobody wrote down is one that will be
///      misread by whoever next has to reason about a settlement.
contract MerchantCurrencyRegistryTest is Test {
    MerchantCurrencyRegistry internal currencies;

    address internal curator = address(0xC0FFEE);
    address internal merchantA = address(0xA11CE);
    address internal merchantB = address(0xB0B);
    address internal eurc = address(0xE0);
    address internal usdc = address(0x05DC);

    function setUp() public {
        currencies = new MerchantCurrencyRegistry(address(this));
        currencies.grantRole(currencies.CURATOR_ROLE(), curator);

        vm.prank(curator);
        currencies.allowCurrency(eurc, true);
    }

    /// @notice Every merchant who existed before this contract did reads zero.
    /// @dev The security property, not a convenience. Zero means "pay in the plan's own
    ///      currency", so a deployment of this registry moves no existing settlement.
    function test_anUnsetMerchantReadsZeroAndIsNotConfigured() public view {
        assertEq(currencies.payoutCurrencyOf(merchantA), address(0), "an unset merchant is not zero");
        assertEq(currencies.electedCurrencyOf(merchantA), address(0), "an unset election is not zero");
        assertFalse(currencies.isConfigured(merchantA), "an unset merchant reads as configured");
    }

    /// @notice The election is self-serve and reaches exactly one row.
    function test_aMerchantElectsTheirOwnAndCannotElectAnothers() public {
        vm.prank(merchantA);
        currencies.setPayoutCurrency(eurc);

        assertEq(currencies.payoutCurrencyOf(merchantA), eurc, "the merchant's own election did not take");
        assertTrue(currencies.isConfigured(merchantA), "an elected merchant is not configured");

        // There is no merchant argument to pass, so the only row `merchantA` can write is
        // their own. The assertion is that the neighbouring row is untouched.
        assertEq(
            currencies.payoutCurrencyOf(merchantB), address(0), "one merchant's election reached another"
        );
        assertFalse(currencies.isConfigured(merchantB), "one merchant's election configured another");
    }

    /// @notice A currency governance has not permitted cannot be named at all.
    /// @dev Without this a merchant could name any ERC-20 — including one with a transfer
    ///      hook, or a proxy they control — and the router would approve a settlement venue
    ///      to move real value into it.
    function test_aCurrencyGovernanceHasNotAllowedIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(MerchantCurrencyRegistry.CurrencyNotAllowed.selector, usdc));
        vm.prank(merchantA);
        currencies.setPayoutCurrency(usdc);

        assertEq(currencies.payoutCurrencyOf(merchantA), address(0), "a refused election was recorded");
    }

    /// @notice Withdrawing an allowance stops the routing and keeps the election.
    ///
    /// @dev **This is the behaviour the implementation chose, asserted rather than
    ///      described.** `payoutCurrencyOf` re-checks the allowlist on every read, so a
    ///      withdrawn currency falls back to zero — the plan's own currency, which the pool
    ///      already holds and which is therefore always payable. The merchant keeps getting
    ///      paid; they simply stop getting paid in the withdrawn currency.
    ///
    ///      The two rejected alternatives are both worse. Reverting would stop the
    ///      merchant's checkout on a governance action they had no part in. Passing the
    ///      stale election through would mean an allowlist that cannot be un-set, which is
    ///      a control that only works before anybody needs it — precisely the situation
    ///      where a currency turns out to be hostile after it was permitted.
    function test_withdrawingAnAllowanceFallsBackToThePlansOwnCurrency() public {
        vm.prank(merchantA);
        currencies.setPayoutCurrency(eurc);
        assertEq(currencies.payoutCurrencyOf(merchantA), eurc, "the election did not take");

        vm.prank(curator);
        currencies.allowCurrency(eurc, false);

        assertEq(
            currencies.payoutCurrencyOf(merchantA),
            address(0),
            "a withdrawn currency is still being routed to"
        );
        assertEq(currencies.electedCurrencyOf(merchantA), eurc, "the merchant's election was silently erased");
        assertTrue(currencies.isConfigured(merchantA), "a withdrawn allowance un-configured the merchant");

        // And a fresh election naming it is refused outright.
        vm.expectRevert(abi.encodeWithSelector(MerchantCurrencyRegistry.CurrencyNotAllowed.selector, eurc));
        vm.prank(merchantB);
        currencies.setPayoutCurrency(eurc);

        // Restoring the allowance restores the merchant's own preference, without their
        // having to act. That is what makes keeping the election the right call.
        vm.prank(curator);
        currencies.allowCurrency(eurc, true);
        assertEq(
            currencies.payoutCurrencyOf(merchantA),
            eurc,
            "the restored allowance did not restore the election"
        );
    }

    /// @notice Clearing an election is never refusable.
    /// @dev A merchant who could not get back to the default is a merchant a withdrawn
    ///      allowance could strand, so `address(0)` is not checked against the allowlist.
    function test_clearingAnElectionIsAlwaysAllowed() public {
        vm.prank(merchantA);
        currencies.setPayoutCurrency(eurc);

        vm.prank(curator);
        currencies.allowCurrency(eurc, false);

        vm.prank(merchantA);
        currencies.setPayoutCurrency(address(0));

        assertEq(currencies.electedCurrencyOf(merchantA), address(0), "the election was not cleared");
        assertFalse(currencies.isConfigured(merchantA), "a cleared merchant still reads as configured");
    }

    /// @notice The allowlist is a risk control and carries the curator's role.
    function test_allowCurrencyRequiresTheCuratorRole() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, merchantA, currencies.CURATOR_ROLE()
            )
        );
        vm.prank(merchantA);
        currencies.allowCurrency(usdc, true);

        assertFalse(currencies.isAllowed(usdc), "an unauthorised caller changed the allowlist");
    }
}
