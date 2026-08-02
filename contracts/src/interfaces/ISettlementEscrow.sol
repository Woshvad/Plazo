// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title ISettlementEscrow
/// @notice Whether a plan's settlement came back because nothing ever shipped.
///
/// @dev A seam, declared in wave 1 and filled from both sides later: `RefundEscrow`
///      reads it in wave 3, `SettlementEscrow` implements it in wave 4. It exists
///      before either because neither should have to guess the other's shape, and
///      because a dispute ground invented at implementation time is a dispute ground
///      nobody reviewed.
///
///      **This is a flag, not accounting.** Nothing behind this interface may write
///      the pool's book. The pool learns what it is owed from the plan and from
///      nowhere else (DEC-08), and a second write path for the same money is the
///      exact defect Phase 3 shipped and DEC-21 was written to prevent — D-04 says
///      so in as many words. `SettlementEscrow.refundToPool` returns the settlement
///      to the reserve and leaves the plan's receivable alone by design; an
///      implementer who "completes" that by also crediting the plan has rebuilt the
///      second ledger. If the borrower's obligation needs to move, it moves through
///      `creditRefund` on the plan, which is the only door.
///
///      **What the flag is for.** A merchant who never attests shipment has taken no
///      money and delivered nothing, but the borrower is still holding a live
///      receivable for goods that do not exist. Without this, their only route is an
///      operator opening a ticket. With it, the failure to attest is already on
///      chain, already objective, and already keyed to the plan — so a dispute can be
///      opened against a fact rather than against a claim, and the path stays
///      GOV-08-clean because no operator role appears anywhere in it.
///
///      **Every member is a view, and that is the anti-forgery half.** There is no
///      setter here and there must never be one: an interface that lets a caller
///      assert eligibility is an interface that lets a caller manufacture a slash
///      against a merchant's bond. Nothing takes an address, so a stranger opening a
///      non-attestation dispute cannot name a different merchant, and nothing takes
///      an amount, so they cannot inflate one. Both are read from the escrow's own
///      row. Eligibility is a consequence of what the escrow recorded, never an
///      argument the caller supplies.
interface ISettlementEscrow {
    /// @notice The facts a non-attestation dispute is opened against.
    ///
    /// @dev A struct rather than a returned tuple for two reasons. It matches how
    ///      every other row in this tree is read — `ParameterRegistry.parameter` and
    ///      `MerchantRegistry.merchantOf` both hand back a named struct — and it
    ///      carries the field names through the ABI into the generated TypeScript,
    ///      so a consumer that reads `amount` where it meant `returnedAt` is a build
    ///      error rather than a positional mistake that type-checks.
    struct ReturnedSettlement {
        /// @dev Who took the order and then did not attest shipping it.
        address merchant;
        /// @dev What went back to the pool's reserve. Never the plan's outstanding
        ///      principal, which this contract does not know and must not guess.
        uint256 amount;
        /// @dev When it went back. A dispute timelock is measured from here.
        uint256 returnedAt;
    }

    /// @notice A settlement went back to the pool because shipment was never attested.
    /// @dev Keyed by `planId` rather than by borrower, like every other plan-plane
    ///      event: a wallet-keyed log stream indexes into a purchase diary no erasure
    ///      request can reach. The merchant is indexed because the merchant plane is
    ///      the side this event is about, and a merchant address is already public in
    ///      `MerchantRegistry`.
    event SettlementReturnedForNonAttestation(
        bytes32 indexed planId, address indexed merchant, uint256 amount
    );

    /// @notice Whether `planId` has an objective, operator-free ground for a dispute.
    ///
    /// @dev True once this plan's settlement has been returned to the pool for
    ///      **non-attestation**, and only then. It is not a general "something went
    ///      wrong" flag and must not become one: what it asserts is the single
    ///      narrow fact that the merchant provably failed to attest shipment before
    ///      an on-chain deadline that the merchant could read in advance.
    ///
    ///      A settlement released normally, a settlement still inside its attestation
    ///      window, and a plan that never escrowed at all are all false. So is a plan
    ///      whose settlement returned for any other reason — widening this to cover
    ///      those would hand a slash to circumstances nobody adjudicated.
    function disputeEligible(bytes32 planId) external view returns (bool);

    /// @notice The row a non-attestation dispute is opened against.
    ///
    /// @dev Read from the escrow's own storage, never supplied by the caller. That is
    ///      the whole anti-forgery argument in one signature: the only thing a caller
    ///      names is a `planId`, so they cannot substitute a merchant they would
    ///      rather slash or an amount they would rather claim.
    ///
    ///      Zero across all three fields when `disputeEligible` is false. Callers
    ///      check the flag; a zero `amount` is not a sentinel to branch on, because a
    ///      returned settlement of zero is not a thing that can happen and treating
    ///      it as one would put a second meaning on a field that has one.
    function returnedSettlementOf(bytes32 planId) external view returns (ReturnedSettlement memory);
}
