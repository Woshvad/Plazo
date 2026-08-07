// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IUnderwritingPartner} from "../interfaces/IUnderwritingPartner.sol";
import {IUnderwritingPartnerV2} from "../interfaces/IUnderwritingPartnerV2.sol";
import {TermsDetail} from "../libraries/TermsDetail.sol";

/// @title PartnerUnderwriterStub
/// @notice UW-07's Tier-3 seam with nobody behind it: it refuses, and refuses softly on
///         the reads and hard on the writes.
///
/// @dev **No licensed partner is engaged.** That is a standing third-party access item
///      recorded in STATE.md alongside Circle Compliance Engine, StableFX and Circle
///      Mint, not a piece of unwritten code. So what ships is the seam, and the day a
///      partner is engaged this contract is replaced by an adapter that speaks their API
///      **off-chain** and writes only a limit and a tier on-chain — never the features
///      that produced either (E-10, UW-07).
///
///      **Zero rather than a revert on `capFor`, and this is the opposite of
///      `StableFxVenueStub` on purpose.** The FX stub reverts because a missing rate
///      would otherwise become a *wrong price* on a real loan that a borrower repays in
///      four installments. A missing partner produces no wrong number at all: the
///      composite takes the maximum across tiers, so zero from here is absorbed by
///      falling back to Tier 0, Tier 1 and Tier 2. A revert would make an unengaged
///      partner break **every** origination in the book, which is a far worse failure
///      than the one it would be protecting against. The two stubs are not inconsistent;
///      they are each refusing in the direction that cannot fabricate a number.
///
///      **The writes revert, and that asymmetry is the point.** A stub that silently
///      accepted `notePlan` would look exactly like a partner that had recorded
///      something — and a partner's book of record is the one thing a stub must never
///      appear to keep. The composite contains these reverts so an unengaged partner
///      still cannot break an origination; the containment lives there rather than here,
///      because here the honest answer is that nothing was written.
contract PartnerUnderwriterStub is IUnderwritingPartnerV2 {
    /// @notice No licensed partner stands behind this seam yet.
    error PartnerNotEngaged();

    /// @inheritdoc IUnderwritingPartner
    /// @dev Zero is a decision, not an error. See the contract note.
    function capFor(bytes32, IdentityClass, TermsDetail.SignerClass) external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IUnderwritingPartnerV2
    /// @dev The widened form refuses identically. A stub that answered the five-argument
    ///      overload differently from the three-argument one would be a stub with an
    ///      opinion.
    function capFor(
        bytes32,
        IdentityClass,
        TermsDetail.SignerClass,
        address,
        bytes32
    ) external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IUnderwritingPartnerV2
    function tierOf(bytes32) external pure returns (uint8) {
        return 0;
    }

    /// @inheritdoc IUnderwritingPartnerV2
    function isSeasoned(bytes32) external pure returns (bool) {
        return false;
    }

    /// @inheritdoc IUnderwritingPartner
    function outstandingExposure() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc IUnderwritingPartner
    function notePlan(bytes32, IdentityClass, bytes32, uint256) external pure {
        revert PartnerNotEngaged();
    }

    /// @inheritdoc IUnderwritingPartner
    function notePlanOutcome(bytes32) external pure {
        revert PartnerNotEngaged();
    }

    /// @inheritdoc IUnderwritingPartnerV2
    function bindPlan(bytes32, address, address) external pure {
        revert PartnerNotEngaged();
    }
}
