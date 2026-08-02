// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title LimitAttestation
/// @notice The underwriter's signed credit decision, as it reaches the chain.
///
/// @dev CHKT-05. Underwriting runs off-chain — it has to, because the inputs are a
///      borrower's history and a partner's scorecard and neither belongs in a public
///      log. What reaches the chain is a number and a signature over it.
///
///      That makes the signing key valuable, so the design question is not "how do
///      we stop it being stolen" but "what can someone do with it once they have".
///      Three answers, all structural:
///
///      **It can only lower.** The router takes the minimum of this figure, a hard
///      on-chain ceiling, the tier cap, the kill-switch throttle and the book-share
///      headroom. A stolen key cannot mint credit; it can only decline to extend
///      credit the chain would already have allowed.
///
///      **It is session-bound and short.** The digest commits to a `sessionId` and a
///      `validUntil` measured in minutes. An attestation is not a bearer credential
///      that outlives the checkout it was issued for, and it cannot be replayed into
///      a different session.
///
///      **It commits to the plan.** `planId` is in the struct, so an attestation
///      issued for a $200 purchase at one merchant cannot originate a different plan
///      — the plan id already binds borrower, merchant, principal, schedule and
///      terms hash.
///
///      What is *emitted* is a band, never the figure. See `CheckoutRouter.bandOf`.
library LimitAttestation {
    struct Attestation {
        /// @notice The checkout session this decision belongs to.
        /// @dev CHKT-02's resumable state machine is keyed on this, so a borrower who
        ///      abandons after two authorizations and returns resumes under the same
        ///      decision rather than being re-underwritten at a price that moved.
        bytes32 sessionId;
        /// @notice The exact plan this decision authorises.
        bytes32 planId;
        address borrower;
        /// @notice The aggregation key. A commitment, never an identifier (DEC-10).
        bytes32 personId;
        /// @notice 0 pseudonymous, 1 identity-linked.
        uint8 identityClass;
        /// @notice The approved limit, 6-decimal.
        uint256 limit;
        uint256 validUntil;
    }

    bytes32 internal constant ATTESTATION_TYPEHASH = keccak256(
        "LimitAttestation(bytes32 sessionId,bytes32 planId,address borrower,bytes32 personId,uint8 identityClass,uint256 limit,uint256 validUntil)"
    );

    bytes32 internal constant DOMAIN_NAME = keccak256("Plazo");
    bytes32 internal constant DOMAIN_VERSION = keccak256("1");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function hashStruct(Attestation memory attestation) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                attestation.sessionId,
                attestation.planId,
                attestation.borrower,
                attestation.personId,
                attestation.identityClass,
                attestation.limit,
                attestation.validUntil
            )
        );
    }

    /// @notice The domain separator for attestations verified by `router`.
    /// @dev `verifyingContract` is the router, not the plan: an attestation is a
    ///      statement to the origination path, and the plan it authorises may never
    ///      exist. Derived rather than stored, for the same reason everything else in
    ///      this protocol derives its separator — it embeds `chainId`, and a baked-in
    ///      value is silently wrong the day the config flips to another network.
    function domainSeparator(uint256 chainId, address router) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME, DOMAIN_VERSION, chainId, router));
    }

    function digest(
        Attestation memory attestation,
        uint256 chainId,
        address router
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(chainId, router), hashStruct(attestation))
        );
    }

    /// @notice Which band a limit falls in.
    ///
    /// @dev The disclosure format, and the only thing about a credit decision that
    ///      reaches a public log. Coarse and deliberately uneven: the buckets are wide
    ///      where Tier 0 actually operates, so an operator can spot an anomalous
    ///      distribution from a compromised signing key and an LP can see the book's
    ///      shape, while nobody can reconstruct a borrower's exact credit line.
    ///      Anyone who could narrow a limit from these could already have guessed it
    ///      from the tier.
    ///
    ///      Lives here rather than on the router so a client, a corpus generator and
    ///      the contract all evaluate one implementation. Two readings of the same
    ///      bucket list is exactly the kind of thing that stays wrong for a year.
    function bandOf(uint256 limit) internal pure returns (uint8) {
        uint256 usdc = 1e6;
        if (limit < 100 * usdc) return 0;
        if (limit < 250 * usdc) return 1;
        if (limit < 500 * usdc) return 2;
        if (limit < 1000 * usdc) return 3;
        if (limit < 2500 * usdc) return 4;
        if (limit < 5000 * usdc) return 5;
        return 6;
    }
}
