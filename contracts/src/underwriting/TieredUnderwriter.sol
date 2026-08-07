// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IUnderwritingPartner} from "../interfaces/IUnderwritingPartner.sol";
import {IUnderwritingPartnerV2} from "../interfaces/IUnderwritingPartnerV2.sol";
import {Tier0Underwriter} from "../Tier0Underwriter.sol";
import {PledgeVault} from "./PledgeVault.sol";
import {PayrollSweeper} from "./PayrollSweeper.sol";
import {ParameterRegistry} from "../ParameterRegistry.sol";
import {ParameterKeys} from "../libraries/ParameterKeys.sol";
import {PlanParams} from "../libraries/PlanParams.sol";
import {TermsDetail} from "../libraries/TermsDetail.sol";

/// @title TieredUnderwriter
/// @notice Four independent tier signals composed into one number the router can bound.
///
/// @dev UW-04, UW-05, UW-06, UW-07. The proposal is the **maximum** across the tiers a
///      person qualifies for, because a pledge and an income history are independent
///      reasons to extend credit and taking the minimum would make each new tier a way of
///      *lowering* somebody's limit.
///
///      **Tier 0 is a veto, not a candidate, and getting that backwards would be the
///      phase's worst defect.** `Tier0Underwriter.capFor` already folds in the identity
///      cap, the contract-signer reduction (UW-10), the kill-switch throttle (UW-03), the
///      book-share headroom (UW-02) and the one-active-plan rule (UW-01) — and it returns
///      **zero** when any of them binds. A naive `max()` would let a Tier-2 pledge
///      originate a second concurrent plan for a person who already holds one, or
///      originate while the first-payment-default switch has stopped the book. So the
///      first thing this contract does with Tier 0's answer is refuse to step over it,
///      and the second is re-bind the book-share headroom at the top.
///
///      **Everything here is a proposal; the chain refuses independently.**
///      `CheckoutRouter._sizeCheck` takes
///      `min(attested, LIMIT_HARD_CEILING, tierCap, merchantRoom, corridorRoom)`. That is
///      what makes a compromised partner or a wrong scorer survivable rather than fatal,
///      and it is why `TIER3_PARTNER_CAP` bounding a partner figure is the *third* of four
///      independent bounds rather than the only one.
///
///      **The wallet arrives as an argument and is not derived.** `PledgeVault` is keyed
///      by `address`, `PayrollSweeper.isOptedIn` by `(planId, address)`, and
///      `Tier0Underwriter` aggregates on a `personId` and offers no view mapping one back
///      to an address — `pseudonymousId(address)` is one-way. The plan-record route is
///      dead too, and behind this contract's own veto: `Tier0Underwriter.capFor` returns
///      zero once the person holds an active plan, so by the time a plan record exists to
///      read a wallet out of, the composite has already refused. The router therefore
///      supplies `terms.borrower` explicitly, through `IUnderwritingPartnerV2`'s
///      five-argument `capFor`.
///
///      **The consequence of that, stated because it is the thing a reader gets wrong.**
///      A pledge is per-wallet capital and a limit is per-person credit. `notePlan` and
///      `bindPlan` must therefore lock the pledge of *the wallet the offer was computed
///      against* and no other. Silently conflating the two is how one person's collateral
///      ends up backing another person's plan.
///
///      **Two instances, one per book (B-2a).** This contract is deployed **twice**: once
///      over the USDC `Tier0Underwriter` and the USDC `ParameterRegistry`, once over the
///      EURC ones that plan 07-12 deploys. Nothing in this source distinguishes them —
///      they differ only by constructor arguments, exactly as the two `IdentityFXRouter`
///      instances do. The reason is arithmetic, not tidiness:
///      `Tier0Underwriter.bookHeadroom()` divides by `pool.totalAssets()` on its single
///      settable pool and `outstandingExposure` is **one scalar**, so a EURC plan scored
///      against the USDC instance would consume the dollar book's Tier-0 headroom and be
///      measured against dollar bands at 1:1. Two currencies are two balance sheets
///      (DEC-21), and that means two of every contract that holds one.
///
///      **`parameters` must be a registry that actually carries the Tier-1/2/3 rows.**
///      `ParameterRegistry._define` is private and constructor-only and `get()` reverts on
///      an undefined key, so those six rows exist on **neither** already-deployed registry
///      (DEC-72, finding 29). Plan 07-12 wires this contract to the third instance;
///      pointing it at either deployed one turns every origination into a revert.
contract TieredUnderwriter is IUnderwritingPartnerV2, AccessControl {
    /// @notice May swap the Tier-3 proposal source.
    /// @dev The one new role this file adds to the Phase 9 governance graph (GOV-02).
    ///      What it can do is bounded on four sides it does not control: Tier 0's veto,
    ///      `TIER3_PARTNER_CAP`, the book-share headroom, and `_sizeCheck`'s minimum.
    bytes32 public constant PARTNER_ADMIN_ROLE = keccak256("PLAZO.PARTNER_ADMIN");

    /// @notice May record originations. Held by `CheckoutRouter`.
    /// @dev **The same constant string `Tier0Underwriter` already uses**, so a role audit
    ///      of the deployment sees one name rather than two that happen to mean the same
    ///      thing. The two roles are still separate grants on separate contracts.
    bytes32 public constant ORIGINATOR_ROLE = keccak256("PLAZO.ORIGINATOR");

    /// @notice Tier 0 — the floor, and the veto.
    Tier0Underwriter public immutable tier0;

    /// @notice Tier 2 — pledged dollar collateral (UW-06).
    PledgeVault public immutable pledges;

    /// @notice Tier 1's on-chain half — the payroll opt-in (UW-05).
    PayrollSweeper public immutable sweeper;

    /// @notice Every band this contract reads. Read at call time, never compiled.
    ParameterRegistry public immutable parameters;

    /// @notice Tier 3 — a licensed partner's proposal (UW-07).
    /// @dev Mutable behind `PARTNER_ADMIN_ROLE` because the partner is not in hand and
    ///      the day one is, the adapter replacing `PartnerUnderwriterStub` must be
    ///      installable without redeploying the composite and re-granting every role
    ///      beneath it.
    IUnderwritingPartnerV2 public partner;

    /// @notice What was recorded when a plan originated through this composite.
    struct Origination {
        bytes32 personId;
        uint256 principal;
        /// @notice The tier that could have supported this plan, recorded at binding.
        uint8 tier;
        /// @notice Whether a pledge was locked behind it.
        bool pledgeBound;
    }

    mapping(bytes32 planId => Origination) private _originations;

    /// @dev Carries the plan id, the tier and the principal, and deliberately nothing
    ///      else. No person id — a pseudonymous one is computable from a wallet, so an
    ///      indexed person id is an indexed wallet wearing a hash, and the log stream
    ///      would become a permanent public credit file (`Tier0Underwriter`'s events
    ///      withhold it for the same reason). No borrower either: the tier is what a
    ///      counterparty may act on, and which wallet's collateral supported it is not
    ///      theirs to read off a log.
    event TieredOrigination(bytes32 indexed planId, uint8 tier, uint256 principal);

    event PartnerSet(address indexed previous, address indexed partner, address indexed by);

    /// @notice The Tier-3 seam may not be pointed at nothing.
    error PartnerZero();

    /// @notice `bindPlan` was called for a plan this composite never noted.
    error TierUnknown(bytes32 planId);

    constructor(
        address admin,
        address tier0_,
        address pledges_,
        address sweeper_,
        address parameters_,
        address partner_
    ) {
        if (partner_ == address(0)) revert PartnerZero();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        tier0 = Tier0Underwriter(tier0_);
        pledges = PledgeVault(pledges_);
        sweeper = PayrollSweeper(sweeper_);
        parameters = ParameterRegistry(parameters_);
        partner = IUnderwritingPartnerV2(partner_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The limit
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IUnderwritingPartnerV2
    ///
    /// @dev The composite. Read the ordering below as the contract's whole argument: the
    ///      refusal comes first, the maximum second, and the book's own capacity last.
    function capFor(
        bytes32 personId,
        IdentityClass identity,
        TermsDetail.SignerClass signerClass,
        address borrower,
        bytes32 planId
    ) public view returns (uint256) {
        // 1. Tier 0, unchanged and authoritative. `Tier0Curve` is not reimplemented here
        //    and must never be: Tier 0 stays the floor and stays the thing that grows.
        uint256 base = tier0.capFor(personId, identity, signerClass);

        // 2. **The veto.** Three tokens, and the most important ones in this file.
        //
        //    A zero from Tier 0 already means one of five controls is binding: the
        //    identity cap, the contract-signer reduction (UW-10), the first-payment-default
        //    throttle (UW-03), the book-share headroom (UW-02) or the one-active-plan rule
        //    (UW-01). A `max()` that stepped over this line would let a pledge originate a
        //    second concurrent plan for a person who already holds one, or originate while
        //    the kill switch has stopped the book, or push Tier-0 paper past its share of
        //    the pool. Every one of those is a credit control that somebody will
        //    eventually be tempted to route around with collateral or with a partner's
        //    say-so, and this is the line where that is refused.
        if (base == 0) return 0;

        uint256 offer = base;

        // 3. **Tier 1 — the payroll uplift, and only that.** The income-derived limit does
        //    not live on chain: it arrives through the `LimitAttestation` the router
        //    already bounds (CHKT-05), so this contract computes nothing from inflows and
        //    reads no income figure. What it holds is the on-chain half — consent to
        //    salary-source deduction, which is a fact rather than a score.
        //
        //    **Both arguments arrive on `capFor` (B-1) and neither is derivable.**
        //    `isOptedIn` is keyed by `(planId, address)`.
        //
        //    **E-09: this is a limit lever, not a rate.** Pay-in-4 is 0%-on-time and has
        //    no rate to discount, so "materially better pricing" for a payroll-deducted
        //    borrower can only be expressed as capacity. The interest-rate reading becomes
        //    available in Phase 8, when Flex ships something there is to move.
        if (borrower != address(0) && planId != bytes32(0) && sweeper.isOptedIn(planId, borrower)) {
            offer += (offer * parameters.get(ParameterKeys.TIER1_PAYROLL_BONUS_BPS)) / PlanParams.BPS;
        }

        // 4. **Tier 2 — pledged collateral.** The wallet is the argument, not a derivation.
        //    `PledgeVault.limitFor` is already par minus `TIER2_PLEDGE_HAIRCUT_BPS`, so no
        //    valuation happens here and none may: a mark would be a price feed, which C1
        //    forbids as a build failure rather than as a rule.
        uint256 pledged = borrower == address(0) ? 0 : pledges.limitFor(borrower);
        if (pledged > offer) offer = pledged;

        // 5. **Tier 3 — bounded before it can influence anything.** The registry ceiling is
        //    applied to the partner's figure *before* the maximum and not after, so a
        //    partner returning `type(uint256).max` cannot dominate the expression at any
        //    intermediate step. A partner is a source of a proposal, never of authority.
        uint256 partnerCap = partner.capFor(personId, identity, signerClass, borrower, planId);
        uint256 hardCap = parameters.get(ParameterKeys.TIER3_PARTNER_CAP);
        if (partnerCap > hardCap) partnerCap = hardCap;
        if (partnerCap > offer) offer = partnerCap;

        // 6. **UW-02 re-binds at the top.** A Tier-2 or Tier-3 origination still consumes
        //    the same book, so the share cap has to apply to the composed figure and not
        //    only to the Tier-0 one it was computed inside.
        uint256 headroom = tier0.bookHeadroom();
        if (offer > headroom) offer = headroom;

        return offer;
    }

    /// @inheritdoc IUnderwritingPartner
    ///
    /// @dev The published three-argument form, **delegating with zeros**. That is not a
    ///      shortcut: with no wallet there is no pledge to read and with no plan id there
    ///      is no opt-in to read, so this by construction yields **the Tier-0 figure
    ///      alone**. Said here rather than left to be inferred, because a caller who
    ///      reaches for the short form silently loses Tiers 1 and 2 and sees no error —
    ///      only a smaller number. The router calls the five-argument form; this exists so
    ///      `IUnderwritingPartner` remains honestly implemented for every external reader.
    function capFor(
        bytes32 personId,
        IdentityClass identity,
        TermsDetail.SignerClass signerClass
    ) external view returns (uint256) {
        return capFor(personId, identity, signerClass, address(0), bytes32(0));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The tier
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The highest tier this person qualifies for, given the wallet and the
    ///         prospective plan.
    /// @dev A coarse number and nothing richer — PASS-02's rule applied to underwriting.
    ///      It reports which tier *could* support an offer, not which one did; the tier a
    ///      plan actually originated under is `tierOfPlan`.
    function tierOf(bytes32 personId, address borrower, bytes32 planId) public view returns (uint8) {
        if (
            partner.capFor(
                    personId, IdentityClass.Pseudonymous, TermsDetail.SignerClass.EOA, borrower, planId
                ) > 0
        ) {
            return 3;
        }
        if (borrower != address(0) && pledges.pledgedValueOf(borrower) > 0) return 2;
        if (borrower != address(0) && planId != bytes32(0) && sweeper.isOptedIn(planId, borrower)) return 1;
        return 0;
    }

    /// @inheritdoc IUnderwritingPartnerV2
    ///
    /// @dev The interface member, delegating with zeros for the same reason the
    ///      three-argument `capFor` does — and with the same consequence. From a person id
    ///      alone only Tier 3 and Tier 0 are distinguishable, because Tiers 1 and 2 are
    ///      per-wallet facts. Use the three-argument form where the wallet is known.
    function tierOf(bytes32 personId) external view returns (uint8) {
        return tierOf(personId, address(0), bytes32(0));
    }

    /// @notice The tier recorded for a plan when it was bound.
    function tierOfPlan(bytes32 planId) external view returns (uint8) {
        return _originations[planId].tier;
    }

    function originationOf(bytes32 planId) external view returns (Origination memory) {
        return _originations[planId];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Recording
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IUnderwritingPartner
    ///
    /// @dev Forwards to Tier 0 **first**, so the active-plan slot and the exposure move
    ///      exactly as they do today and a composite origination is indistinguishable from
    ///      a Tier-0 one in Tier 0's own books.
    ///
    ///      The partner is told best-effort. `PartnerUnderwriterStub.notePlan` reverts by
    ///      design, and an unengaged partner must not turn every origination into a failed
    ///      one — so the revert is contained here rather than avoided there.
    function notePlan(
        bytes32 personId,
        IdentityClass identity,
        bytes32 planId,
        uint256 principal
    ) external onlyRole(ORIGINATOR_ROLE) {
        tier0.notePlan(personId, identity, planId, principal);
        _originations[planId] =
            Origination({personId: personId, principal: principal, tier: 0, pledgeBound: false});

        try partner.notePlan(personId, identity, planId, principal) {} catch {}
    }

    /// @inheritdoc IUnderwritingPartnerV2
    ///
    /// @dev **This is where a Tier-2 offer locks the collateral behind it**, and it is
    ///      here rather than in `notePlan` for a mechanical reason: `PledgeVault.bindPlan`
    ///      needs the plan address and the pledger's wallet, and `notePlan`'s signature —
    ///      which is the published one — carries neither. The router calls both in the
    ///      same transaction and both are gated on the same role, so the pair is atomic
    ///      from every observer's point of view. Without this the pledge that bought the
    ///      limit could be withdrawn before the first due date, which is plan 07-04's
    ///      `freeOf` control seen from the other side.
    ///
    ///      **Conservative in the only safe direction.** The offer was a maximum across
    ///      tiers and this contract cannot know after the fact which one bound, so it locks
    ///      `min(principal, freeOf(borrower))` — never more than the plan's own principal,
    ///      and never more than the wallet has free. A borrower whose Tier-0 cap alone
    ///      would have covered the ticket therefore also has their pledge locked; that is
    ///      collateral securing a plan the pledger themselves took, which is the direction
    ///      an error here has to fall.
    function bindPlan(bytes32 planId, address plan, address borrower) external onlyRole(ORIGINATOR_ROLE) {
        Origination storage record = _originations[planId];
        if (record.personId == bytes32(0) && record.principal == 0) revert TierUnknown(planId);

        tier0.bindPlan(planId, plan, borrower);

        record.tier = tierOf(record.personId, borrower, planId);

        uint256 free = pledges.freeOf(borrower);
        if (free > 0) {
            uint256 lock = record.principal > free ? free : record.principal;
            if (lock > 0) {
                pledges.bindPlan(planId, plan, borrower, lock);
                record.pledgeBound = true;
            }
        }

        emit TieredOrigination(planId, record.tier, record.principal);
    }

    /// @inheritdoc IUnderwritingPartner
    ///
    /// @dev **Permissionless, and it carries no modifier on purpose.** That is
    ///      `IUnderwritingPartner`'s published contract and its stated reason: limit growth
    ///      cannot depend on an operator being alive, and the outcome is derived from the
    ///      chain rather than accepted from the caller.
    ///
    ///      Tier 0 settles first and reverts if the plan has not terminated, so this
    ///      function is as strict as it ever was. The pledge unbind is attempted after and
    ///      its revert swallowed: `PledgeVault.unbindPlan` refuses a defaulted plan
    ///      deliberately — that collateral is for `seize` — and a still-locked pledge must
    ///      not block Tier 0's bookkeeping from releasing the active-plan slot.
    function notePlanOutcome(bytes32 planId) external {
        tier0.notePlanOutcome(planId);

        if (_originations[planId].pledgeBound) {
            try pledges.unbindPlan(planId) {
                _originations[planId].pledgeBound = false;
            } catch {}
        }

        try partner.notePlanOutcome(planId) {} catch {}
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views and administration
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IUnderwritingPartnerV2
    function isSeasoned(bytes32 personId) external view returns (bool) {
        return tier0.isSeasoned(personId);
    }

    /// @inheritdoc IUnderwritingPartner
    /// @dev Both books this composite stands in front of, summed. A partner that cannot
    ///      answer contributes nothing rather than making the read revert.
    function outstandingExposure() external view returns (uint256) {
        uint256 total = tier0.outstandingExposure();
        try partner.outstandingExposure() returns (uint256 theirs) {
            total += theirs;
        } catch {}
        return total;
    }

    /// @notice Point the Tier-3 seam at a different proposal source.
    function setPartner(address partner_) external onlyRole(PARTNER_ADMIN_ROLE) {
        if (partner_ == address(0)) revert PartnerZero();
        address previous = address(partner);
        partner = IUnderwritingPartnerV2(partner_);
        emit PartnerSet(previous, partner_, msg.sender);
    }
}
