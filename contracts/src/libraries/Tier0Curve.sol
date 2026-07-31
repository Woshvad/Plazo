// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title Tier0Curve
/// @notice The Tier-0 limit, as a pure function of a borrower's record.
///
/// @dev Extracted from `Tier0Underwriter` so it is reproducible by anyone holding
///      the published parameters, and so it can be checked against the TypeScript
///      implementation by a differential corpus rather than by two readings of the
///      same paragraph.
///
///      That reproducibility is UW-08 in miniature: a borrower is entitled to see
///      exactly which events produced their limit, and an answer they cannot
///      recompute is not an answer. The events are countable — clean completions —
///      and the arithmetic is four multiplications and three comparisons.
///
///      Iterative rather than a closed form on purpose. `initialLimit × growth^n` in
///      fixed point is one library call and nobody can check it by hand; a loop of
///      integer multiply-and-divide is exactly what the borrower's client does, and
///      the rounding at each step is part of the answer rather than an artefact of
///      how it was computed.
library Tier0Curve {
    uint256 internal constant BPS = 10_000;

    /// @dev Sixty-four clean completions at ×1.25 is a factor of ten million. The
    ///      identity cap binds long before; the bound exists so an unbounded loop
    ///      cannot exist, not because it could be reached.
    uint256 internal constant MAX_GROWTH_STEPS = 64;

    /// @notice The registry rows this curve reads.
    struct Params {
        uint256 initialLimit;
        uint256 growthBps;
        uint256 pseudonymousCap;
        uint256 identifiedCap;
        uint256 contractSignerCapBps;
    }

    /// @param cleanCompletions Plans that finished with no missed installment.
    /// @param identified Whether an operator attested this person's wallets together.
    /// @param mutableSigner Whether the borrower's signature validation can change.
    function limitFor(
        uint256 cleanCompletions,
        bool identified,
        bool mutableSigner,
        Params memory p
    ) internal pure returns (uint256 limit) {
        limit = grownLimit(cleanCompletions, p);

        uint256 identityCap = identified ? p.identifiedCap : p.pseudonymousCap;
        if (limit > identityCap) limit = identityCap;

        // UW-10. An EOA's validation logic is its address and cannot change, so its
        // strip stays valid by construction. A contract account can change its
        // validation logic whenever it likes, so a strip it signed is only as good as
        // the last time someone checked — and the reduction is the price of the
        // interval between checks.
        if (mutableSigner) {
            limit = (limit * p.contractSignerCapBps) / BPS;
        }
    }

    /// @notice The growth curve alone, before any cap.
    function grownLimit(uint256 cleanCompletions, Params memory p) internal pure returns (uint256 limit) {
        limit = p.initialLimit;

        uint256 steps = cleanCompletions > MAX_GROWTH_STEPS ? MAX_GROWTH_STEPS : cleanCompletions;
        for (uint256 i = 0; i < steps; ++i) {
            limit = (limit * p.growthBps) / BPS;
            if (limit >= p.identifiedCap) return p.identifiedCap;
        }
    }
}
