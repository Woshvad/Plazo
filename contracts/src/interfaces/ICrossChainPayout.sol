// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title ICrossChainPayout
/// @notice Where a merchant's settlement goes, once it leaves the pool.
///
/// @dev A seam, installed in Phase 3 and filled in Phase 6. Arc is CCTP domain 26
///      with Hooks supported and Fast Transfer not applicable — Arc finalises in
///      roughly one block, so there is nothing to accelerate. Phase 6 supplies the
///      CCTP v2 and Gateway implementations behind this call.
///
///      It exists now rather than in Phase 6 because settlement is written once. A
///      router that pays a merchant with a bare `transfer` and is later taught about
///      destination chains has to re-open the origination path, which by then is
///      audited. The Arc-local implementation is a `transfer` behind an assertion,
///      and the assertion is the point: a payout naming a chain this deployment
///      cannot reach fails loudly at checkout rather than silently paying the wrong
///      address on the wrong network.
interface ICrossChainPayout {
    /// @notice Arc's own chain, as a destination.
    /// @dev Callers name a destination explicitly rather than defaulting, so "pay on
    ///      Arc" is a decision in the record and not an omission.
    function localDomain() external view returns (uint32);

    /// @notice Whether this implementation can settle to `domain`.
    function supportsDomain(uint32 domain) external view returns (bool);

    /// @notice Send `amount` of `token` to `recipient` on `domain`.
    /// @dev The caller has already moved the funds to this contract, or approved
    ///      them; each implementation documents which. The Arc-local one is pull:
    ///      it takes the funds from the caller in the same call.
    function payout(address token, uint32 domain, address recipient, uint256 amount) external;
}
