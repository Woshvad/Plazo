// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {ITransferEligibility} from "./interfaces/ITransferEligibility.sol";

/// @title ReceivableToken
/// @notice One transfer-restricted ERC-721 per originated plan.
///
/// @dev GOV-10, and it is minted at the *first* origination rather than in a later
///      compliance phase. NYDFS licenses transferees, not just originators; a
///      receivable that has already circulated to unlicensed holders cannot be
///      brought under an eligibility rule without a snapshot, a migration, and
///      possibly rescinding transfers that were valid when they happened. The hook
///      costs nothing today and is unaffordable later.
///
///      **`tokenId` is the `planId`.** No separate counter, no mapping to maintain,
///      and an indexer or a factoring counterparty can move between the receivable
///      and the plan in either direction with a cast. The receivable and the
///      obligation are the same thing named twice.
///
///      **Default deny on transfer.** `_update` consults the eligibility registry
///      for every movement including the mint, so a deployment that has not decided
///      who may hold receivables can mint none. That is the correct failure
///      direction: the alternative is an asset class whose holder set is whoever
///      moved first.
///
///      **No metadata URI.** A receivable's terms live in `termsHash` and its state
///      lives in the plan; a JSON document on a server would be a second, weaker
///      description of the same deal and the one people would read. Phase 8's
///      factoring market reads the plan.
contract ReceivableToken is ERC721, AccessControl {
    /// @notice May mint and burn receivables.
    /// @dev The router mints at origination. Phase 5's pool burns on charge-off and
    ///      on repayment; until then nothing burns, and the role exists so that when
    ///      it does the grant is a deliberate act rather than an upgrade.
    bytes32 public constant ISSUER_ROLE = keccak256("PLAZO.RECEIVABLE_ISSUER");

    ITransferEligibility public eligibility;

    event EligibilityRegistryChanged(address indexed previous, address indexed current);
    event ReceivableMinted(bytes32 indexed planId, address indexed to, uint256 principal);
    event ReceivableBurned(bytes32 indexed planId);

    error TransferNotPermitted(address from, address to);
    error EligibilityZero();

    constructor(address admin, address eligibility_) ERC721("Plazo Receivable", "PLZR") {
        if (eligibility_ == address(0)) revert EligibilityZero();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        eligibility = ITransferEligibility(eligibility_);
    }

    /// @notice Mint the receivable for a plan.
    ///
    /// @dev `principal` is carried in the event only. The plan is the source of truth
    ///      for what is outstanding, and a figure stored here would be a second number
    ///      that goes stale the first time an installment clears.
    ///
    ///      `_mint`, not `_safeMint`. The safe variant hands control to the recipient
    ///      mid-mint, and this mint happens inside the origination transaction — after
    ///      the pool has paid the merchant and before the plan is bound. Handing a
    ///      callback to anyone at that moment is a reentrancy surface bought for
    ///      nothing, because the check `_safeMint` performs is weaker than the one
    ///      already performed: `_update` consults the eligibility registry, and
    ///      "governance decided this address may hold receivables" is a stronger
    ///      statement than "this address implements an interface".
    function mint(bytes32 planId, address to, uint256 principal) external onlyRole(ISSUER_ROLE) {
        _mint(to, uint256(planId));
        emit ReceivableMinted(planId, to, principal);
    }

    function burn(bytes32 planId) external onlyRole(ISSUER_ROLE) {
        _burn(uint256(planId));
        emit ReceivableBurned(planId);
    }

    function exists(bytes32 planId) external view returns (bool) {
        return _ownerOf(uint256(planId)) != address(0);
    }

    /// @notice Point at a different eligibility registry.
    /// @dev Admin-only, and the only mutable thing on this contract. The registry is
    ///      a compliance policy and policies change; the token is an asset and assets
    ///      should not. Replacing the registry cannot retroactively legitimise a
    ///      transfer that already happened, which is the property that matters.
    function setEligibility(address eligibility_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (eligibility_ == address(0)) revert EligibilityZero();
        address previous = address(eligibility);
        eligibility = ITransferEligibility(eligibility_);
        emit EligibilityRegistryChanged(previous, eligibility_);
    }

    /// @dev Every movement passes through here — mint, transfer and burn — which is
    ///      why the check lives here and not in an override of `transferFrom`. A
    ///      restriction that a mint can bypass is a restriction on the secondary
    ///      market only, and the primary distribution is exactly where an
    ///      unlicensed holder would be created.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (!eligibility.isTransferPermitted(address(this), from, to)) {
            revert TransferNotPermitted(from, to);
        }
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return ERC721.supportsInterface(interfaceId) || AccessControl.supportsInterface(interfaceId);
    }
}
