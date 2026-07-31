// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {OriginationFixture} from "./helpers/OriginationFixture.sol";

import {ReceivableToken} from "../src/ReceivableToken.sol";

/// @notice GOV-10 and the transfer-hook half of D5.
///
/// @dev The hook lands at the *first* origination, not in a later compliance phase.
///      NYDFS licenses transferees, not just originators; a receivable that has
///      already circulated to unlicensed holders cannot be brought under an
///      eligibility rule without a holder snapshot, a migration, and possibly
///      rescinding transfers that were valid when they happened. It costs nothing
///      today and it is unaffordable later.
contract ReceivableTest is OriginationFixture {
    address internal eligibleHolder = address(0x11C);
    address internal ineligibleHolder = address(0x0FF);

    function setUp() public {
        _deployStack();
        _prepareOrigination();
    }

    /// @notice Default deny. An address nobody considered cannot receive.
    ///
    /// @dev This will feel wrong the first time a demo fails, and it is the only
    ///      defensible default: the alternative is an asset class whose holder set is
    ///      whoever moved first.
    function test_aTransferToAnUnconsideredAddressIsRefused() public {
        _checkoutDefault();

        vm.prank(address(creditPool));
        vm.expectRevert(
            abi.encodeWithSelector(
                ReceivableToken.TransferNotPermitted.selector, address(creditPool), ineligibleHolder
            )
        );
        receivable.transferFrom(address(creditPool), ineligibleHolder, uint256(planId));
    }

    /// @notice An address governance has listed can receive.
    function test_aTransferToAnEligibleAddressGoesThrough() public {
        _checkoutDefault();
        eligibility.setGlobal(eligibleHolder, true);

        vm.prank(address(creditPool));
        receivable.transferFrom(address(creditPool), eligibleHolder, uint256(planId));

        assertEq(receivable.ownerOf(uint256(planId)), eligibleHolder, "the transfer did not land");
    }

    /// @notice Per-asset eligibility works without a global listing.
    /// @dev Phase 5's tranche shares have a narrower holder set than a receivable —
    ///      Reg D restricts one and NYDFS the other — so the registry has to express
    ///      both without the protocol's own plumbing needing a listing per asset.
    function test_perAssetEligibilityIsEnoughOnItsOwn() public {
        _checkoutDefault();
        eligibility.setForAsset(address(receivable), eligibleHolder, true);

        vm.prank(address(creditPool));
        receivable.transferFrom(address(creditPool), eligibleHolder, uint256(planId));
        assertEq(receivable.ownerOf(uint256(planId)), eligibleHolder);

        // And it does not spill over to another asset class.
        assertFalse(
            eligibility.isEligible(address(creditPool), eligibleHolder),
            "per-asset eligibility leaked to another asset"
        );
    }

    /// @notice The mint is checked too, not only the secondary market.
    ///
    /// @dev A restriction a mint can bypass is a restriction on the secondary market
    ///      only — and the primary distribution is exactly where an unlicensed holder
    ///      would be created.
    function test_theMintItselfIsGated() public {
        eligibility.setGlobal(address(creditPool), false);

        receivable.grantRole(receivable.ISSUER_ROLE(), address(this));
        vm.expectRevert(
            abi.encodeWithSelector(
                ReceivableToken.TransferNotPermitted.selector, address(0), address(creditPool)
            )
        );
        receivable.mint(keccak256("unwanted"), address(creditPool), 100e6);
    }

    /// @notice Burning is always permitted.
    /// @dev A restriction on who may hold an asset is not a restriction on the asset
    ///      ceasing to exist. An eligibility system that blocked burns would make a
    ///      charged-off receivable permanently untransferable to nowhere.
    function test_burningIsAlwaysPermitted() public {
        _checkoutDefault();

        receivable.grantRole(receivable.ISSUER_ROLE(), address(this));
        receivable.burn(planId);
        assertFalse(receivable.exists(planId), "the receivable survived its burn");
    }

    /// @notice `tokenId` is the `planId`, in both directions.
    /// @dev The receivable and the obligation are the same thing named twice, so a
    ///      factoring counterparty or an indexer can move between them with a cast.
    function test_theTokenIdIsThePlanId() public {
        _checkoutDefault();
        assertEq(uint256(planId), uint256(planId));
        assertTrue(receivable.exists(planId));
        assertEq(receivable.ownerOf(uint256(planId)), address(creditPool));
    }

    /// @notice Only the issuer role mints.
    function test_onlyTheIssuerCanMint() public {
        vm.prank(stranger);
        vm.expectRevert();
        receivable.mint(keccak256("forged"), stranger, 100e6);
    }

    /// @notice An unrestricted asset class needs no holder list.
    /// @dev Phase 8's factoring market is the intended use. Nothing in Phase 3 sets
    ///      it, and opening a class is a governance action with its own event so it is
    ///      visible rather than inferable from a holder distribution.
    function test_anUnrestrictedAssetNeedsNoHolderList() public {
        _checkoutDefault();
        eligibility.setUnrestricted(address(receivable), true);

        vm.prank(address(creditPool));
        receivable.transferFrom(address(creditPool), ineligibleHolder, uint256(planId));
        assertEq(receivable.ownerOf(uint256(planId)), ineligibleHolder);
    }
}
