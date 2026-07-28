// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title PlanId
/// @notice Canonical derivation of a plan's identity and of the authorization
///         nonces that hang off it.
///
/// @dev This library is the single source of truth for `planId`. `packages/plan-core`
///      reimplements it in TypeScript and a differential test asserts bit-identity
///      across a randomized corpus. Both sides must change together or CI fails.
///
///      Three properties are load-bearing and each one is a decision, not an accident:
///
///      1. `implementation` is in the preimage. The borrower signs authorizations
///         payable to a CREATE2 address; if that address could later point at
///         different logic, the signature commits to an address rather than to a
///         deal. Putting the implementation in the preimage means a new vintage
///         produces a different `planId`, so no outstanding strip can be
///         reinterpreted by an upgrade.
///
///      2. `originationNonce` is in the preimage. Without it, a borrower who buys
///         two identical items — or who retries a checkout that timed out — derives
///         the same `planId`, and therefore the same authorization nonces. EIP-3009
///         nonces are single-use and `cancelAuthorization` burns them permanently,
///         so the second plan would be unsignable forever.
///
///      3. `chainId` and `factory` are in the preimage. The same terms on a
///         different chain, or from a different factory, are a different plan.
library PlanId {
    /// @notice Field ordering is part of the ABI. Changing it after any strip has
    ///         been signed is a migration, not a refactor.
    bytes32 internal constant PLAN_ID_TYPEHASH = keccak256(
        "Plan(uint256 chainId,address factory,address implementation,address borrower,address merchant,address token,uint256 principal,uint256 installmentCount,uint256 firstDueDate,uint256 interval,uint256 originationNonce,bytes32 termsHash)"
    );

    struct PlanTerms {
        uint256 chainId;
        address factory;
        address implementation;
        address borrower;
        address merchant;
        address token;
        /// @dev Denominated in the token's ERC-20 decimals. On Arc, USDC is
        ///      6-decimal over ERC-20 and 18-decimal natively on the same balance;
        ///      EIP-3009 `value` is the 6-decimal figure. See `Usdc6` in plan-core.
        uint256 principal;
        uint256 installmentCount;
        uint256 firstDueDate;
        uint256 interval;
        uint256 originationNonce;
        /// @dev Commitment to the disclosed deal: line items, MDR, jurisdiction
        ///      parameter set, fee schedule. Hashed off-chain, bound on-chain.
        bytes32 termsHash;
    }

    error InstallmentCountZero();
    error IntervalZero();
    error PrincipalZero();
    error InstallmentIndexOutOfRange(uint256 index, uint256 installmentCount);

    /// @notice Derive the plan identity.
    /// @dev `abi.encode`, not `abi.encodePacked` — every field is fixed-width here,
    ///      but encode keeps the preimage unambiguous if a dynamic field is ever
    ///      added, and matches how the TypeScript side builds it.
    function derive(PlanTerms memory terms) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                PLAN_ID_TYPEHASH,
                terms.chainId,
                terms.factory,
                terms.implementation,
                terms.borrower,
                terms.merchant,
                terms.token,
                terms.principal,
                terms.installmentCount,
                terms.firstDueDate,
                terms.interval,
                terms.originationNonce,
                terms.termsHash
            )
        );
    }

    /// @notice The EIP-3009 nonce for installment `index`.
    /// @dev `keccak256(planId ‖ index)` over two fixed-width words. Deriving the
    ///      nonce from the plan is what makes a check non-transferable between
    ///      plans: a signature carrying this nonce can only ever credit the plan
    ///      whose id produced it.
    function checkNonce(bytes32 planId, uint256 index) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(planId, index));
    }

    /// @notice Bounds-checked variant for call sites that hold the terms.
    function checkNonce(PlanTerms memory terms, uint256 index) internal pure returns (bytes32) {
        if (index >= terms.installmentCount) {
            revert InstallmentIndexOutOfRange(index, terms.installmentCount);
        }
        return checkNonce(derive(terms), index);
    }

    /// @notice Every nonce in the strip, in installment order.
    function checkNonces(
        bytes32 planId,
        uint256 installmentCount
    ) internal pure returns (bytes32[] memory nonces) {
        nonces = new bytes32[](installmentCount);
        for (uint256 i = 0; i < installmentCount; ++i) {
            nonces[i] = checkNonce(planId, i);
        }
    }

    /// @notice Reject terms that cannot produce a coherent schedule.
    /// @dev Called at origination. Derivation itself is deliberately total — a
    ///      verifier must be able to recompute any `planId`, including a rejected
    ///      one, without tripping a guard.
    function validate(PlanTerms memory terms) internal pure {
        if (terms.installmentCount == 0) revert InstallmentCountZero();
        if (terms.interval == 0) revert IntervalZero();
        if (terms.principal == 0) revert PrincipalZero();
    }
}
