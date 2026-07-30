// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title PlanAcceptance
/// @notice The companion payload a borrower signs so their wallet can render the
///         deal field by field.
///
/// @dev An EIP-3009 authorization renders in a wallet as "transfer 18.75 USDC to
///      0x1a2b… after 2026-08-13". Four of those tell a borrower nothing about the
///      plan they are entering: not the total, not the schedule, not who the
///      merchant is, not what happens if they are late. A wallet cannot infer any
///      of it, because none of it is in the authorization.
///
///      So the strip travels with a typed acceptance. It is structured data with
///      named fields, which is what a wallet's typed-data screen exists to display,
///      and it is verified onchain against `planId` at origination — so the deal
///      the borrower was shown and the deal the contract enforces are the same
///      bytes, checked rather than asserted.
///
///      `firstDueDate` is the **jittered** date, not the nominal one. A borrower
///      whose wallet showed them the 13th and whose check is payable on the 12th
///      has been shown a different deal from the one they signed.
library PlanAcceptance {
    struct Acceptance {
        bytes32 planId;
        address borrower;
        address merchant;
        address token;
        uint256 principal;
        uint256 installmentCount;
        /// @notice Face value of installment 0.
        /// @dev Carries the division remainder. A `principal` that does not divide
        ///      evenly has to put the odd cent somewhere, and putting it first means
        ///      it settles at checkout rather than surfacing as a surprise on the
        ///      final check — and every installment the borrower has left to pay is
        ///      the uniform figure the merchant page advertised.
        uint256 firstInstallment;
        /// @notice Face value of every installment after the first.
        uint256 laterInstallment;
        /// @notice When the first installment is due. The down payment, so no jitter.
        uint256 firstDueDate;
        /// @notice When the last installment is due, jitter included.
        /// @dev The two dates a borrower actually asks about are the first and the
        ///      last. Together with `interval` and `installmentCount` they pin the
        ///      whole schedule, because the jitter every intermediate date carries
        ///      is derived from `planId` — which is in this struct — and so is
        ///      recomputable by anyone holding the acceptance. A wallet screen that
        ///      showed a nominal date the contract would not honour would be worse
        ///      than showing none.
        uint256 finalDueDate;
        uint256 interval;
        bytes32 termsHash;
        /// @notice After this, the acceptance is stale and cannot originate a plan.
        /// @dev A signed acceptance is an offer. An offer that never expires is a
        ///      standing authorization to originate credit on terms the borrower
        ///      agreed to at a price that has moved.
        uint256 validUntil;
    }

    bytes32 internal constant ACCEPTANCE_TYPEHASH = keccak256(
        "PlanAcceptance(bytes32 planId,address borrower,address merchant,address token,uint256 principal,uint256 installmentCount,uint256 firstInstallment,uint256 laterInstallment,uint256 firstDueDate,uint256 finalDueDate,uint256 interval,bytes32 termsHash,uint256 validUntil)"
    );

    /// @notice The Plazo EIP-712 domain name.
    bytes32 internal constant DOMAIN_NAME = keccak256("Plazo");
    bytes32 internal constant DOMAIN_VERSION = keccak256("1");
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function hashStruct(Acceptance memory acceptance) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ACCEPTANCE_TYPEHASH,
                acceptance.planId,
                acceptance.borrower,
                acceptance.merchant,
                acceptance.token,
                acceptance.principal,
                acceptance.installmentCount,
                acceptance.firstInstallment,
                acceptance.laterInstallment,
                acceptance.firstDueDate,
                acceptance.finalDueDate,
                acceptance.interval,
                acceptance.termsHash,
                acceptance.validUntil
            )
        );
    }

    /// @notice The domain separator for a plan at `plan` on `chainId`.
    /// @dev `verifyingContract` is the plan's own CREATE2 address, which is
    ///      derivable from `planId` by anyone before the clone holds code. Binding
    ///      the acceptance to the clone means an acceptance signed for one plan
    ///      cannot originate another, even if every other field were replayed.
    ///      Derived, never stored: a clone's domain separator would otherwise be
    ///      baked at deployment and silently wrong the day the chain id changes.
    function domainSeparator(uint256 chainId, address plan) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME, DOMAIN_VERSION, chainId, plan));
    }

    function digest(
        Acceptance memory acceptance,
        uint256 chainId,
        address plan
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(chainId, plan), hashStruct(acceptance)));
    }
}
