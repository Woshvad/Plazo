// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {TermsDetail} from "../libraries/TermsDetail.sol";

/// @title IUnderwritingPartner
/// @notice Everything the router needs from whoever decides a borrower's limit.
///
/// @dev The seam Phases 7 and 8 fill: Tier 3 arrives as a partner scorecard, Flex
///      as a licensed lender. Both must be able to sit behind this call without the
///      origination path changing, because by then it is audited.
///
///      **Only the limit and the tier reach the chain.** UW-07 is explicit that a
///      licensed partner's decision crosses this boundary as a number, never as the
///      inputs that produced it. That is a privacy requirement and a regulatory one:
///      a partner's underwriting features are their property, and a borrower's are
///      not the chain's business.
///
///      The router calls `capFor` before an origination and `notePlan` /
///      `notePlanOutcome` around it. An implementation that needs no state ignores
///      the last two; Tier 0 does not, because a limit that grows with clean
///      behaviour has to be told what happened.
interface IUnderwritingPartner {
    /// @notice How a borrower's identity reaches underwriting.
    /// @dev `Pseudonymous` is one wallet, one person. `Identified` means an operator
    ///      attested that two wallets are the same person; the `personId` is a
    ///      commitment, never an identifier.
    enum IdentityClass {
        Pseudonymous,
        Identified
    }

    /// @notice The largest plan this partner will stand behind for `personId` now.
    /// @param personId The aggregation key. Per person, never per wallet — UW-01.
    /// @param identity Whether the person is identity-linked.
    /// @param signerClass Whether the borrower's signature validation can change.
    /// @dev Returns zero when the person may not originate at all: over their cap,
    ///      already holding an active plan, or throttled. Zero is a decision, not an
    ///      error — the router turns it into CHKT-08's fallback offer rather than a
    ///      revert, because a flat decline at the moment of purchase is the worst
    ///      possible answer to "you are $12 over".
    function capFor(bytes32 personId, IdentityClass identity, TermsDetail.SignerClass signerClass)
        external
        view
        returns (uint256);

    /// @notice Record that a plan was originated against this person.
    /// @dev Router-only. The active-plan slot and the exposure both move here.
    function notePlan(bytes32 personId, IdentityClass identity, bytes32 planId, uint256 principal)
        external;

    /// @notice Settle a finished plan's effect on the person's standing.
    ///
    /// @dev Takes no outcome argument on purpose. The outcome is an onchain fact
    ///      about a contract anyone can read, so an implementation derives it rather
    ///      than accepting it — a caller-supplied "this one went fine" is a limit
    ///      increase anybody can mint. Permissionless for the same reason limit
    ///      growth cannot depend on an operator being alive.
    function notePlanOutcome(bytes32 planId) external;

    /// @notice Total principal this partner currently stands behind.
    function outstandingExposure() external view returns (uint256);
}
