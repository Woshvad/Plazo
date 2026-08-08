// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {CorridorFixture} from "./helpers/CorridorFixture.sol";

import {CheckoutRouter} from "../src/CheckoutRouter.sol";
import {MerchantCurrencyRegistry} from "../src/MerchantCurrencyRegistry.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";

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

/// @notice The second book exists, opens, and is not the first one.
///
/// @dev A smoke suite rather than the corridor's behavioural tests, which plan 07-10
///      carries. What it holds is that `CorridorFixture` builds something real: a EURC
///      pool whose accounting currency is EURC, whose gate is open because *its own*
///      lender was accredited and *its own* reserve was funded, and whose Tier-0
///      headroom is a different number from the dollar book's. That last assertion is
///      the one that would catch B-2a not having landed — two instances agreeing would
///      mean one is reading the other's pool.
contract CorridorFixtureSmokeTest is CorridorFixture {
    function setUp() public {
        _deployStack();
        _prepareCorridorOrigination();
    }

    function test_theEurcBookOpensForOrigination() public view {
        assertEq(address(eurcPool.token()), address(eurc), "the second book is not denominated in EURC");
        assertTrue(eurcPool.originationOpen(), "the EURC book will not front anything");
        assertEq(
            eurcFxRouter.accountingToken(),
            address(eurc),
            "the corridor's identity router normalizes the wrong currency"
        );
        assertEq(
            checkout.fxRouterOf(address(eurc)),
            address(eurcFxRouter),
            "the corridor does not resolve to its own router"
        );
    }

    /// @notice A EURC plan originates end to end, and the money lands in two currencies.
    ///
    /// @dev The fixture's origination helper, exercised rather than shipped untested —
    ///      an unrun helper is a helper plan 07-10 would discover does not work. What it
    ///      demonstrates is the whole B-2b split in one transaction: the merchant's
    ///      settlement stays in the plan's own currency and reaches the escrow as EURC,
    ///      while the withholding is converted through the guard and reaches the
    ///      single-currency bond ledger as dollars. The merchant is not paid less for it;
    ///      the withheld reserve simply changes denomination.
    function test_aEurcPlanOriginatesAndTheTwoLegsLandSeparately() public {
        // Read from the corridor's own registry, which is the point: `MIN_TICKET` is a
        // money row and a EURC plan is measured against the EURC set.
        // 90 rather than 100: the Tier-0 cap for a pseudonymous first-timer is exactly
        // 100e6, and 100 loaded by the 5% corridor haircut is 105. That is the haircut
        // binding, and `test_theCorridorHaircutLoadsTheHeadroom` below is where it is
        // asserted rather than worked around.
        uint256 principal = 90e6;
        uint256 mdr = (principal * 400) / PlanParams.BPS;
        uint256 net = principal - mdr;
        uint256 withheldEurc = (net * merchants.vestingBpsFor(merchant)) / PlanParams.BPS;
        assertTrue(withheldEurc > 0, "the fixture's merchant is seasoned, so nothing is withheld");

        uint256 bondBefore = merchants.bondOf(merchant);

        _originateEurcPlan(principal, 7, keccak256("corridor-smoke"), 5000e6);

        // The merchant's leg never left EURC, and it is exactly the invoice less MDR
        // less the withholding. The haircut loaded the credit headroom and took nothing.
        assertEq(
            eurc.balanceOf(address(settlementEscrow)),
            net - withheldEurc,
            "the merchant's settlement was not held in the plan's own currency, in full"
        );

        // The withholding crossed once, at the attested mid, into the ledger's currency.
        assertEq(
            merchants.bondOf(merchant) - bondBefore,
            (withheldEurc * EUR_USD_E18) / 1e18,
            "the withheld reserve did not reach the bond ledger in its own currency"
        );

        // And the exposure the bond is priced off is the converted figure, not the raw
        // one — the two call sites of `_bondEquivalent`, seen from the ledger's side.
        assertEq(
            merchants.outstandingFrontedFor(merchant),
            (principal * EUR_USD_E18) / 1e18,
            "a EURC principal entered the single-currency exposure ledger unconverted"
        );

        // The dollar book funded none of it.
        assertEq(creditPool.merchantExposure(merchant), 0, "the dollar book fronted a EURC plan");
        assertEq(eurcPool.merchantExposure(merchant), principal, "the EURC book did not front its own plan");
    }

    /// @notice FX-04. The corridor haircut is what refuses a plan the dollar book takes.
    ///
    /// @dev A pseudonymous first-timer's Tier-0 cap is exactly 100e6 on both books,
    ///      because the two parameter sets are seeded at parity. The identical 100-unit
    ///      plan therefore originates in dollars and is refused in euro — at **105e6
    ///      against 100e6**, which is the raw principal loaded by the 5% haircut and
    ///      nothing else. The currency risk the book carries from origination to the last
    ///      due date is priced there, in credit, where an LP can see it.
    function test_theCorridorHaircutLoadsTheHeadroom() public {
        CheckoutRouter.OriginationInput memory input = _eurcOriginationInput(
            _eurcTerms(PRINCIPAL, COUNT, 9),
            keccak256("corridor-haircut"),
            5000e6,
            _eurcMid(keccak256("corridor-haircut"))
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                CheckoutRouter.LimitExceeded.selector,
                PRINCIPAL + (PRINCIPAL * 500) / PlanParams.BPS,
                PRINCIPAL
            )
        );
        checkout.originate(input);

        // The control: the same size, the same borrower, the same merchant, on the book
        // whose currency is the router's base. Nothing is loaded and it goes through.
        _checkoutDefault();
    }

    /// @notice The two books are two balance sheets, measured rather than asserted.
    /// @dev They are capitalised differently on purpose. If these agreed, one
    ///      `Tier0Underwriter` would be dividing by the other's `totalAssets()`.
    function test_theTwoBooksHaveSeparateHeadroom() public view {
        assertTrue(
            eurcPool.totalAssets() != creditPool.totalAssets(),
            "the two books are capitalised identically, so the next assertion proves nothing"
        );
        assertTrue(
            eurcTier0.bookHeadroom() != tier0.bookHeadroom(),
            "the EURC underwriter is reading the dollar book's assets"
        );
    }
}
