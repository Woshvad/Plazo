// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title FxMidAttestation
/// @notice The quoting service's signed mid, as it reaches the chain.
///
/// @dev FX-05, and deliberately the same object as `LimitAttestation` wearing
///      different clothes. An auditor who has read that file should have nothing new
///      to reason about here: same `\x19\x01` digest construction, same domain
///      derived rather than stored, same TTL bounded by a registry row read at call
///      time, same recovery against a role. The three structural properties carry
///      over with one word changed.
///
///      **It can only refuse.** `FxDeviationGuard` reads `midE18` to answer one
///      question — *is the fill the venue actually returned worse than what we were
///      told* — and never *what is this worth*. A signed mid can widen the floor a
///      fill must beat; it cannot raise a limit, value a position, price a payout or
///      compute a NAV. A stolen signing key therefore buys the ability to decline a
///      trade the chain would have allowed, which is the same bargain CHKT-05 struck.
///
///      That distinction is C1's whole line, and it is the reason this library is not
///      the price oracle CLAUDE.md forbids. The direction of failure is what
///      separates them: an oracle that goes wrong prints a number, an attestation
///      that goes wrong prints nothing and the fill simply does not happen.
///      `tools/check-no-oracle.mjs` is the standing guard that keeps the distinction
///      real, and it names this library by name.
///
///      **It is short and session-bound.** `validUntil` is bounded by
///      `ParameterKeys.FX_MID_MAX_TTL`, which is seeded strictly tighter than
///      `ATTESTATION_MAX_TTL` — a credit limit is stable for a quarter of an hour and
///      an FX mid is not. `sessionId` is consumed once, so a mid quoted before a real
///      market move cannot be replayed after it. Two quotes for the same pair in the
///      same minute differ only by their session, which is exactly what makes the
///      replay check able to tell them apart.
///
///      **It commits to the pair.** `fromToken` and `toToken` are inside the digest,
///      so a mid signed for USDC→EURC cannot floor a EURC→USDC fill — where the
///      correct floor is the reciprocal and applying the mid unchanged would accept a
///      fill wrong by the square of the rate. `corridor` is the concentration bucket
///      the pair belongs to, derived by `CheckoutRouter.corridorOf`, and it travels in
///      the digest so a mid cannot be moved between corridors either.
///
///      Field order is part of the commitment. The canonical type string below is
///      written in the struct's declaration order and the two must be read together;
///      transposing two fields of the same ABI width changes nothing the compiler can
///      see and everything the signature means.
library FxMidAttestation {
    struct Mid {
        /// @notice The concentration bucket this pair belongs to.
        /// @dev `CheckoutRouter.corridorOf(token)`. Carried in the digest so a mid
        ///      cannot be presented against a corridor it was not quoted for.
        bytes32 corridor;
        /// @notice What is being sold.
        address fromToken;
        /// @notice What is being bought.
        address toToken;
        /// @notice `toToken` per `fromToken`, scaled by 1e18.
        /// @dev 1e18-scaled rather than 6-decimal because a rate is a ratio and not a
        ///      balance. Both Arc tokens this corridor trades are 6-decimal (finding
        ///      31), so the amount arithmetic stays in their native units and only the
        ///      ratio carries the extra precision.
        uint256 midE18;
        uint256 validUntil;
        /// @notice The quote this mid belongs to. Consumed once by the guard.
        bytes32 sessionId;
    }

    bytes32 internal constant MID_TYPEHASH = keccak256(
        "FxMidAttestation(bytes32 corridor,address fromToken,address toToken,uint256 midE18,uint256 validUntil,bytes32 sessionId)"
    );

    bytes32 internal constant DOMAIN_NAME = keccak256("Plazo");
    bytes32 internal constant DOMAIN_VERSION = keccak256("1");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function hashStruct(Mid memory mid) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MID_TYPEHASH,
                mid.corridor,
                mid.fromToken,
                mid.toToken,
                mid.midE18,
                mid.validUntil,
                mid.sessionId
            )
        );
    }

    /// @notice The domain separator for mids verified by `guard`.
    ///
    /// @dev One domain family, two attestations, told apart by `verifyingContract`
    ///      alone: `LimitAttestation`'s is the router, this one's is the guard. Sharing
    ///      `name` and `version` is what makes that separation the *only* difference,
    ///      and therefore what makes it easy to check.
    ///
    ///      Derived rather than stored, for the same reason everything else in this
    ///      protocol derives its separator — it embeds `chainId`, and a baked-in value
    ///      is silently wrong the day the config flips to another network (C8).
    function domainSeparator(uint256 chainId, address guard) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME, DOMAIN_VERSION, chainId, guard));
    }

    function digest(Mid memory mid, uint256 chainId, address guard) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(chainId, guard), hashStruct(mid)));
    }
}
