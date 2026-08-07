// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IFxVenue} from "../interfaces/IFxVenue.sol";

/// @title StableFxVenueStub
/// @notice The default FX venue: it refuses, and it says exactly why.
///
/// @dev StableFX is the venue Plazo actually intends to cross currency through, and
///      it is the one venue on Arc with a real USDC↔EURC book. It is also KYB/AML
///      gated: settlement needs an API key issued after Circle onboarding, which this
///      project does not hold. So this contract is what ships, and what it does is
///      revert.
///
///      **A venue that degrades to a plausible rate is far worse than one that
///      refuses.** A fabricated FX rate is not a stale number on a dashboard — it is a
///      wrong price on a real loan that a borrower will repay in four installments and
///      that a pool will carry to each due date. Every path here that could return a
///      number reverts instead, and a grep gate asserts that neither `1e18` nor
///      `amountIn` is ever handed back as though it were a fill.
///
///      **`supportsPair` answers `false` rather than reverting**, and the distinction
///      is what makes the seam usable. A caller enumerating venues to pick one has to
///      be able to *ask* without the ask itself failing; refusing the question as well
///      as the answer would mean every caller needed a try/catch to discover that a
///      venue is unavailable, and a try/catch around a venue is one `catch` away from
///      swallowing a real failure.
///
///      **The revert reason names the missing credential, not a fault.** An operator
///      reading a failed origination needs to be able to tell in one line that this is
///      an access item on the third-party track and not a bug in the corridor. That is
///      why the string is specific about *what* is missing and *why* it is missing.
///
///      **No address appears in this file, and that is E-04.** The `verifyingContract`
///      a StableFX Permit2 signature is bound to arrives in the API response's
///      `typedData.domain` and is read from there at runtime. Two live escrow proxies
///      exist with genuinely different implementations and neither answers `PERMIT2()`
///      (plan 07-01, finding 33) — so there is no correct address to compile, and
///      compiling either would be the same class of error as baking in a domain
///      separator. Plan 07-08 reads it from the response.
contract StableFxVenueStub is IFxVenue {
    /// @notice This venue exists but cannot be reached with the credentials in hand.
    error NotAccessible(string reason);

    string internal constant REASON =
        "StableFX settlement requires a KYB/AML-gated API key Plazo does not hold";

    /// @inheritdoc IFxVenue
    /// @dev Answers. See the contract note.
    function supportsPair(address, address) external pure returns (bool) {
        return false;
    }

    /// @inheritdoc IFxVenue
    function quote(address, address, uint256) external pure returns (uint256) {
        revert NotAccessible(REASON);
    }

    /// @inheritdoc IFxVenue
    function settle(address, address, uint256, uint256, address) external pure returns (uint256) {
        revert NotAccessible(REASON);
    }
}
