// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IUnderwritingPartner} from "./IUnderwritingPartner.sol";
import {TermsDetail} from "../libraries/TermsDetail.sol";

/// @title IUnderwritingPartnerV2
/// @notice The underwriting seam as the router has always actually used it, plus the
///         two arguments without which Tiers 1 and 2 are unreachable.
///
/// @dev **Why this file exists at all.** `CheckoutRouter` declares its underwriter as
///      the *concrete* `Tier0Underwriter` and `_register` calls
///      `underwriter.isSeasoned(personId)` and `underwriter.bindPlan(planId, plan, borrower)`.
///      **Neither of those is declared on `IUnderwritingPartner`.** So a composite that
///      implemented only the published interface would not compile into the router, and
///      "Tier 3 plugs into the existing seam" was never true of the seam as published.
///      The honest fix is to widen it **in a new file**: the deployed
///      `IUnderwritingPartner.sol` is not edited, because Phase 8's licensed lender and
///      every external reader are entitled to the interface as published.
///
///      **The widened `capFor` is an overload, and the reason is a capability rather
///      than a preference.** `IUnderwritingPartner.capFor(bytes32, IdentityClass, SignerClass)`
///      carries **neither a wallet nor a plan id**. `PledgeVault.limitFor` is keyed by
///      `address` and `PayrollSweeper.isOptedIn` by `(planId, address)`, so neither is
///      readable from those three arguments — and there is no way to derive one:
///      `Tier0Underwriter` aggregates on a `personId`, exposes no view that maps one back
///      to an address, and `pseudonymousId(address)` is one-way. Left as published,
///      UW-06's "instant Tier-2 limit" and UW-05's payroll uplift are unreachable through
///      the only function that grants a limit.
///
///      Two facts make the widening free. This is a **new file**, so no deployed bytecode
///      and no published signature changes. And `CheckoutRouter._prepare` **already holds
///      both arguments** — `ctx.borrower` from `terms.borrower`, `ctx.planId` from
///      `factory.derivePlanId` — before `_sizeCheck` runs, so the call site gains two
///      words and nothing else.
///
///      **What the two extra arguments are, and the boundary they may not cross.**
///      `borrower` is a **wallet**, used to read per-wallet collateral. `planId` is the
///      **prospective** plan id, used to read a per-plan opt-in. Neither is PII, and
///      neither may become a key into anything this interface returns: a pledge is
///      per-wallet capital and a limit is per-person credit, and conflating them silently
///      is how one person's collateral ends up backing another person's plan.
///
///      **`tierOf` returns a coarse tier and nothing richer.** PASS-02's rule applied to
///      underwriting: a number a counterparty can act on, never a record they can
///      reconstruct. It is a `uint8` and deliberately not `PlazoPassport.Tier` — that enum
///      names credit *standing* (Unknown/Impaired/Building/Established/Trusted), which is a
///      different question from which tier issued a limit, and one vocabulary answering two
///      questions is how a reader ends up believing an `Established` borrower is Tier 3.
///
///      **No member of this interface may ever carry a PII field.** E-10, UW-07. Only the
///      resulting limit and tier cross this boundary; the inputs that produced them do not.
///      A future member taking a name, a postal address, a document reference, a date of
///      birth or an income figure is a **violation of the requirement rather than an
///      extension of the interface**, and the fact that it would be convenient is exactly
///      why the prohibition is written here instead of being left to judgement.
interface IUnderwritingPartnerV2 is IUnderwritingPartner {
    /// @notice Whether this person counts as seasoned for the first-payment-default switch.
    /// @dev Already implemented by `Tier0Underwriter` and already called by
    ///      `CheckoutRouter._register`; declared here because it was never on the
    ///      published interface and the router holds the concrete type as a result.
    function isSeasoned(bytes32 personId) external view returns (bool);

    /// @notice Bind a noted plan to its deployed address and the wallet that took it.
    /// @dev Originator-gated in every implementation. Separate from `notePlan` only
    ///      because the router knows the id and the address at different points in the
    ///      same transaction.
    function bindPlan(bytes32 planId, address plan, address borrower) external;

    /// @notice The highest tier this person currently qualifies for. Coarse, by design.
    function tierOf(bytes32 personId) external view returns (uint8);

    /// @notice The largest plan this partner will stand behind, with the two reads the
    ///         published signature cannot reach.
    /// @param personId The aggregation key. Per person, never per wallet — UW-01.
    /// @param identity Whether the person is identity-linked.
    /// @param signerClass Whether the borrower's signature validation can change.
    /// @param borrower The wallet whose pledged collateral is read. Not PII, and not an
    ///        aggregation key: it may only ever be used to read per-wallet capital.
    /// @param planId The **prospective** plan id, used to read a per-plan payroll opt-in.
    /// @dev An **overload**. The three-argument form is inherited unchanged and an
    ///      implementation that answers it with zeros for these two arguments is answering
    ///      honestly — it will simply return the Tier-0 figure alone, because with no
    ///      wallet there is no pledge to read and with no plan id there is no opt-in to
    ///      read. A caller who reaches for the short form does not get an error; they get
    ///      a smaller number, which is why this paragraph exists.
    function capFor(
        bytes32 personId,
        IdentityClass identity,
        TermsDetail.SignerClass signerClass,
        address borrower,
        bytes32 planId
    ) external view returns (uint256);
}
