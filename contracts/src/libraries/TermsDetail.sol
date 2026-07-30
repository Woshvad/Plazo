// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title TermsDetail
/// @notice The disclosed deal behind `planId`'s `termsHash`.
///
/// @dev The `planId` preimage is frozen — Phase 1 shipped a differential corpus
///      against it and any change is a migration, not a refactor. It carries a
///      `termsHash` and nothing else about the commercial terms. So everything a
///      plan needs to know that is not already a preimage field rides *inside* that
///      hash: the plan is initialised with the disclosed detail, hashes it, and
///      requires the result to equal the `termsHash` already committed.
///
///      That indirection is what makes these fields tamper-evident. Changing the
///      jurisdiction, the settlement recipient or the FX router changes
///      `termsHash`, which changes `planId`, which changes every authorization
///      nonce *and* the CREATE2 payee address. A strip signed against one set of
///      terms cannot be redirected to another: the signatures simply stop being
///      payable to anywhere that will ever hold code.
///
///      `fxRouter` in particular is here rather than in operator configuration.
///      The router normalizes an amount before it reaches the waterfall, so a
///      router chosen after signing could change what the borrower's payment is
///      worth. Anything that can move value has to be inside the commitment.
library TermsDetail {
    /// @notice Whose signature validates the strip.
    /// @dev An EOA's validation logic is its address and cannot change, so an
    ///      outstanding strip stays valid by construction. A contract account can
    ///      change its validation logic at any time, which is why a contract signer
    ///      carries the reduced unsecured cap unless a recent `revalidate()` says
    ///      otherwise. Consumed by Phase 3's UW-10.
    enum SignerClass {
        EOA,
        Contract
    }

    struct Detail {
        /// @notice Selects the jurisdiction parameter set — late-fee cap, APR cap,
        ///         statement cadence, withdrawal window.
        bytes32 jurisdiction;
        /// @notice Commitment to the disclosed basket: line items, prices, merchant
        ///         order reference. Hashed off-chain; never published onchain.
        bytes32 lineItemsHash;
        /// @notice Merchant discount rate, basis points.
        uint256 mdrBps;
        /// @notice The late fee disclosed to the borrower, before the jurisdiction
        ///         cap is applied. Disclosed and committed, so the fee a borrower
        ///         was shown is the fee the contract can charge.
        uint256 lateFeeFlat;
        SignerClass signerClass;
        /// @notice Where the pool's leg of every settlement goes.
        address settlementRecipient;
        /// @notice The currency-normalization router. Identity in v1.
        address fxRouter;
    }

    /// @notice Field ordering is part of the commitment. Changing it invalidates
    ///         every outstanding strip, which is the point.
    bytes32 internal constant TERMS_DETAIL_TYPEHASH = keccak256(
        "TermsDetail(bytes32 jurisdiction,bytes32 lineItemsHash,uint256 mdrBps,uint256 lateFeeFlat,uint8 signerClass,address settlementRecipient,address fxRouter)"
    );

    function hash(Detail memory detail) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TERMS_DETAIL_TYPEHASH,
                detail.jurisdiction,
                detail.lineItemsHash,
                detail.mdrBps,
                detail.lateFeeFlat,
                uint8(detail.signerClass),
                detail.settlementRecipient,
                detail.fxRouter
            )
        );
    }
}
