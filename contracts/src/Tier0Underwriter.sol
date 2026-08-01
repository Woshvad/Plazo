// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IUnderwritingPartner} from "./interfaces/IUnderwritingPartner.sol";
import {IInstallmentPlan} from "./interfaces/IInstallmentPlan.sol";
import {ICreditPool} from "./interfaces/ICreditPool.sol";
import {TermsDetail} from "./libraries/TermsDetail.sol";
import {Tier0Curve} from "./libraries/Tier0Curve.sol";
import {ParameterRegistry} from "./ParameterRegistry.sol";
import {ParameterKeys} from "./libraries/ParameterKeys.sol";
import {PlanParams} from "./libraries/PlanParams.sol";
import {FirstPaymentDefaultSwitch} from "./FirstPaymentDefaultSwitch.sol";
import {PlazoPassport} from "./PlazoPassport.sol";

/// @title Tier0Underwriter
/// @notice Credit for a borrower with no history, sized to what the book can lose.
///
/// @dev UW-01, UW-02, UW-10 — and DEC-02, which is what makes them matter. Tier 0
///      draws pool capital from day one rather than running as a shadow book, against
///      a research recommendation, with the risk accepted knowingly. So every cap
///      here is load-bearing, and none of them is a placeholder.
///
///      **Per person, never per wallet (DEC-10).** Onchain there is no person, so
///      aggregation is on a `personId`. A pseudonymous borrower's is derived from
///      their wallet — one wallet is one person, and sybil resistance comes from the
///      cap being small rather than from pretending the identifier means something.
///      An identity-linked borrower's is attested and is a *commitment*, never an
///      identifier: two wallets attested to the same `personId` share one limit and
///      one active-plan slot, and nothing on the chain says who they are.
///
///      **The pseudonymous cap is what an attacker gets per wallet they will bother
///      to create.** It is set to what the book can afford to lose that many times,
///      not to what a well-behaved pseudonymous borrower deserves. Raising it is the
///      most tempting recalibration this protocol offers and the most dangerous.
///
///      **One active plan.** Stacking is how BNPL borrowers get into trouble and how
///      BNPL books do. The limit means nothing if the same person can hold four of
///      them at once, and the protocol can only see its own book — so it enforces
///      what it can see, completely, rather than what it wishes it could see,
///      partially.
///
///      **Growth is derived, not granted.** ×1.25 per cleanly completed plan, read
///      off the plan contracts themselves. Nobody can hand a borrower a limit
///      increase, including this contract's admin, because there is no function that
///      would do it.
contract Tier0Underwriter is IUnderwritingPartner, AccessControl {
    /// @notice May record originations.
    /// @dev Held by `CheckoutRouter` alone. This role decides the active-plan slot
    ///      and the exposure figure, which are the two things the caps are computed
    ///      against.
    bytes32 public constant ORIGINATOR_ROLE = keccak256("PLAZO.ORIGINATOR");


    struct Person {
        uint256 cleanCompletions;
        uint256 activePlans;
        uint256 outstanding;
        IdentityClass identity;
    }

    struct PlanRecord {
        bytes32 personId;
        address plan;
        /// @notice The wallet the Passport record is keyed by.
        /// @dev A `personId` can span wallets; a Passport record cannot, because it is
        ///      what a wallet presents. Stored so the permissionless settlement path
        ///      can write the mark without the caller supplying an address.
        address borrower;
        uint256 principal;
        bool open;
        /// @notice Whether a delinquency mark has already been written for this plan.
        bool marked;
    }

    ParameterRegistry public immutable parameters;
    FirstPaymentDefaultSwitch public immutable killSwitch;

    /// @notice The book Tier-0 paper is measured against (UW-02).
    /// @dev Settable because deployment is circular — the pool needs the router, the
    ///      router needs this, and this needs the pool. Admin-only, and a change is
    ///      an event: pointing the book-share cap at a different book is exactly the
    ///      kind of thing that should be visible.
    ICreditPool public pool;

    /// @notice Where a plan's outcome is written as credit standing.
    /// @dev Settable for the same circularity reason as `pool`, and optional: a
    ///      deployment without a Passport still underwrites, it just does not record.
    ///      Every call into it originates from a path that has already read a plan's own
    ///      state, which is what makes PASS-01's "written only by protocol contracts"
    ///      mean something stronger than "written by a privileged key".
    PlazoPassport public passport;

    mapping(bytes32 personId => Person) private _people;
    mapping(bytes32 planId => PlanRecord) private _plans;

    uint256 private _outstandingExposure;

    event PoolChanged(address indexed previous, address indexed current);
    event PassportChanged(address indexed previous, address indexed current);

    /// @dev Neither of these carries `personId`, and that is deliberate.
    ///
    ///      A pseudonymous person id is `keccak256("PLAZO.PSEUDONYMOUS", wallet)` —
    ///      anyone can compute it from a wallet address, so an indexed `personId` is
    ///      an indexed wallet wearing a hash. Emitting it would let anyone index the
    ///      log stream into a wallet-keyed record of every plan a borrower has taken
    ///      and how each one ended: a permanent, public, uncorrectable credit file,
    ///      which is precisely the exposure PASS-09 keys plan events by `planId` to
    ///      avoid.
    ///
    ///      A borrower's standing is still readable by anyone who already knows which
    ///      wallet to ask about — `personOf(pseudonymousId(wallet))` is a public view
    ///      and has to be, because that is how an underwriter looks it up. What the
    ///      event stream withholds is the bulk enumeration: building the diary
    ///      requires guessing wallets rather than reading a log.
    event PlanNoted(bytes32 indexed planId, uint256 principal);
    event PlanSettled(bytes32 indexed planId, bool clean);

    error PlanAlreadyNoted(bytes32 planId);
    error PlanNotNoted(bytes32 planId);
    error PlanAlreadySettled(bytes32 planId);
    error PlanNotTerminal(bytes32 planId, IInstallmentPlan.PlanState state);
    error PoolUnset();
    error PlanNotDelinquent(bytes32 planId, IInstallmentPlan.PlanState state);

    constructor(address admin, address parameters_, address killSwitch_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        parameters = ParameterRegistry(parameters_);
        killSwitch = FirstPaymentDefaultSwitch(killSwitch_);
    }

    function setPool(address pool_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address previous = address(pool);
        pool = ICreditPool(pool_);
        emit PoolChanged(previous, pool_);
    }

    function setPassport(address passport_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address previous = address(passport);
        passport = PlazoPassport(passport_);
        emit PassportChanged(previous, passport_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The limit
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IUnderwritingPartner
    function capFor(bytes32 personId, IdentityClass identity, TermsDetail.SignerClass signerClass)
        public
        view
        returns (uint256)
    {
        Person storage p = _people[personId];

        // One active plan until the first completes. Zero is a decision, not an
        // error: the router turns it into CHKT-08's fallback rather than a decline.
        if (p.activePlans > 0) return 0;

        uint256 limit = Tier0Curve.limitFor(
            p.cleanCompletions,
            identity == IdentityClass.Identified,
            signerClass == TermsDetail.SignerClass.Contract,
            curveParams()
        );

        limit = killSwitch.throttle(limit);

        uint256 headroom = bookHeadroom();
        if (limit > headroom) limit = headroom;

        return limit;
    }

    /// @notice How much more Tier-0 paper the book can carry (UW-02).
    /// @dev Enforced onchain rather than in the underwriting service because it is
    ///      the constraint DEC-02 traded the shadow book for. A cap that lives in an
    ///      operator's configuration is a cap that is off during the incident.
    function bookHeadroom() public view returns (uint256) {
        if (address(pool) == address(0)) return 0;

        uint256 assets = pool.totalAssets();
        if (assets == 0) return 0;

        uint256 ceiling = (assets * parameters.get(ParameterKeys.TIER0_BOOK_SHARE_BPS)) / PlanParams.BPS;
        if (_outstandingExposure >= ceiling) return 0;
        return ceiling - _outstandingExposure;
    }

    /// @notice The curve's inputs, read from the registry.
    /// @dev Public so a borrower's client can fetch the five numbers and reproduce
    ///      their own limit exactly. UW-08's "see exactly which events produced your
    ///      limit" is not satisfiable against a curve nobody outside this contract can
    ///      evaluate.
    function curveParams() public view returns (Tier0Curve.Params memory) {
        return Tier0Curve.Params({
            initialLimit: parameters.get(ParameterKeys.TIER0_INITIAL_LIMIT),
            growthBps: parameters.get(ParameterKeys.TIER0_GROWTH_BPS),
            pseudonymousCap: parameters.get(ParameterKeys.TIER0_PSEUDONYMOUS_CAP),
            identifiedCap: parameters.get(ParameterKeys.TIER0_IDENTIFIED_CAP),
            contractSignerCapBps: parameters.get(ParameterKeys.CONTRACT_SIGNER_CAP_BPS)
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Recording
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IUnderwritingPartner
    function notePlan(bytes32 personId, IdentityClass identity, bytes32 planId, uint256 principal)
        external
        onlyRole(ORIGINATOR_ROLE)
    {
        PlanRecord storage record = _plans[planId];
        if (record.personId != bytes32(0)) revert PlanAlreadyNoted(planId);

        record.personId = personId;
        record.principal = principal;
        record.open = true;

        Person storage p = _people[personId];
        p.activePlans += 1;
        p.outstanding += principal;
        p.identity = identity;

        _outstandingExposure += principal;

        emit PlanNoted(planId, principal);
    }

    /// @notice Bind a plan record to its deployed contract.
    /// @dev Separate from `notePlan` only because the router knows the address and
    ///      the id at different points in the same transaction; both are
    ///      originator-gated and both must happen before the plan can be settled.
    function bindPlan(bytes32 planId, address plan, address borrower) external onlyRole(ORIGINATOR_ROLE) {
        PlanRecord storage record = _plans[planId];
        if (record.personId == bytes32(0)) revert PlanNotNoted(planId);
        record.plan = plan;
        record.borrower = borrower;
    }

    /// @notice Write a delinquency to the borrower's Passport. Permissionless.
    ///
    /// @dev Self-verifying like `notePlanOutcome`: it reads the plan's own state and
    ///      refuses unless the plan really is delinquent, so the mark cannot be
    ///      manufactured by a caller and cannot be suppressed by an operator declining
    ///      to run something. Idempotent per plan, because a plan that bounces, cures
    ///      and bounces again is one borrower having a bad quarter, not two.
    function noteDelinquency(bytes32 planId) external {
        PlanRecord storage record = _plans[planId];
        if (record.personId == bytes32(0) || record.plan == address(0)) revert PlanNotNoted(planId);
        if (record.marked) return;

        IInstallmentPlan.PlanState planState = IInstallmentPlan(record.plan).state();
        if (planState != IInstallmentPlan.PlanState.Delinquent) {
            revert PlanNotDelinquent(planId, planState);
        }

        record.marked = true;
        if (address(passport) != address(0) && record.borrower != address(0)) {
            passport.noteNegative(record.borrower);
        }
    }

    /// @inheritdoc IUnderwritingPartner
    ///
    /// @dev Permissionless and self-verifying. The outcome is read off the plan —
    ///      state and every installment status — rather than accepted from the
    ///      caller, because a caller-supplied "this went fine" is a limit increase
    ///      anybody can mint.
    ///
    ///      Three outcomes, three different meanings:
    ///
    ///      - **Repaid with no missed installment** — clean. The slot is released and
    ///        the limit grows. A plan that was late and cured is *not* clean: it was
    ///        collected, and the borrower's Passport records that it took a mark.
    ///      - **Defaulted** — the slot is released and the limit does not grow. The
    ///        loss is the pool's business, not this contract's.
    ///      - **Refunded or cancelled** — the slot is released and nothing else
    ///        happens. A merchant reversing a sale is not evidence about the
    ///        borrower, in either direction, and treating it as a clean completion
    ///        would make limit growth purchasable from any merchant willing to refund.
    function notePlanOutcome(bytes32 planId) external {
        PlanRecord storage record = _plans[planId];
        if (record.personId == bytes32(0) || record.plan == address(0)) revert PlanNotNoted(planId);
        if (!record.open) revert PlanAlreadySettled(planId);

        IInstallmentPlan plan = IInstallmentPlan(record.plan);
        IInstallmentPlan.PlanState planState = plan.state();

        bool repaid = planState == IInstallmentPlan.PlanState.Repaid;
        bool reversed = planState == IInstallmentPlan.PlanState.Refunded
            || planState == IInstallmentPlan.PlanState.Cancelled;
        bool defaulted = planState == IInstallmentPlan.PlanState.Defaulted;

        if (!repaid && !reversed && !defaulted) revert PlanNotTerminal(planId, planState);

        bool clean = repaid && _neverMissed(plan);

        record.open = false;

        Person storage p = _people[record.personId];
        p.activePlans -= 1;
        p.outstanding -= record.principal > p.outstanding ? p.outstanding : record.principal;
        _outstandingExposure -=
            record.principal > _outstandingExposure ? _outstandingExposure : record.principal;

        if (clean) p.cleanCompletions += 1;

        // A defaulted plan is a mark; a refunded or cancelled one is not evidence about
        // the borrower in either direction, and a plan already marked delinquent has
        // had its mark written. `clean` alone would conflate all three.
        if (address(passport) != address(0) && record.borrower != address(0)) {
            if (repaid) passport.noteOutcome(record.borrower, clean);
            else if (defaulted && !record.marked) passport.noteOutcome(record.borrower, false);
        }

        emit PlanSettled(planId, clean);
    }

    function _neverMissed(IInstallmentPlan plan) private view returns (bool) {
        uint256 count = plan.installmentCount();
        for (uint256 i = 0; i < count; ++i) {
            IInstallmentPlan.InstallmentStatus status = plan.installmentStatus(i);
            if (
                status == IInstallmentPlan.InstallmentStatus.Missed
                    || status == IInstallmentPlan.InstallmentStatus.Expired
            ) {
                return false;
            }
        }
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IUnderwritingPartner
    function outstandingExposure() external view returns (uint256) {
        return _outstandingExposure;
    }

    function personOf(bytes32 personId) external view returns (Person memory) {
        return _people[personId];
    }

    function planRecordOf(bytes32 planId) external view returns (PlanRecord memory) {
        return _plans[planId];
    }

    /// @notice Whether this person counts as seasoned for the kill switch.
    /// @dev Read at origination and frozen into the switch's registration, because
    ///      seasoning at the time of the decision is what was priced.
    function isSeasoned(bytes32 personId) external view returns (bool) {
        return _people[personId].cleanCompletions >= parameters.get(ParameterKeys.FPD_SEASONING_PLANS);
    }

    /// @notice The pseudonymous `personId` for a wallet.
    /// @dev Domain-separated so a pseudonymous key can never collide with an attested
    ///      identity commitment — which would let a borrower who cannot be identified
    ///      inherit the standing of one who can.
    function pseudonymousId(address wallet) public pure returns (bytes32) {
        return keccak256(abi.encode("PLAZO.PSEUDONYMOUS", wallet));
    }
}
