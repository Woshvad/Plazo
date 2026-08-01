// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {PlanFactory} from "./PlanFactory.sol";
import {TranchedCreditPool} from "./TranchedCreditPool.sol";
import {PoolRegistry} from "./PoolRegistry.sol";
import {PlazoPassport} from "./PlazoPassport.sol";
import {MerchantRegistry} from "./MerchantRegistry.sol";
import {ReceivableToken} from "./ReceivableToken.sol";
import {Tier0Underwriter} from "./Tier0Underwriter.sol";
import {FirstPaymentDefaultSwitch} from "./FirstPaymentDefaultSwitch.sol";
import {OriginationPause} from "./OriginationPause.sol";
import {ParameterRegistry} from "./ParameterRegistry.sol";
import {IComplianceOracle} from "./interfaces/IComplianceOracle.sol";
import {ICrossChainPayout} from "./interfaces/ICrossChainPayout.sol";
import {IUnderwritingPartner} from "./interfaces/IUnderwritingPartner.sol";
import {LimitAttestation} from "./libraries/LimitAttestation.sol";
import {ParameterKeys} from "./libraries/ParameterKeys.sol";
import {PlanParams} from "./libraries/PlanParams.sol";
import {PlanId} from "./libraries/PlanId.sol";
import {TermsDetail} from "./libraries/TermsDetail.sol";

/// @title CheckoutRouter
/// @notice The one door credit comes through.
///
/// @dev Everything Phase 3 builds meets here, and the ordering inside `originate` is
///      the phase's actual product. Written as prose, one transaction does this:
///
///      the corridor is open, both parties are screened and screened *recently*, the
///      underwriter's signed decision is fresh and bounded by every on-chain cap, the
///      merchant is KYB'd and inside their velocity, the book has room for this
///      merchant and this corridor, the pool pays the merchant in full less MDR and
///      funds the plan's own delinquency escrow out of that MDR, the plan deploys to
///      the address the borrower already signed against, the receivable is minted to
///      the pool under a default-deny transfer hook, and the borrower's active-plan
///      slot closes behind them.
///
///      **The merchant is paid in the same transaction (CHKT-04).** Not the same
///      block — the same transaction. Arc finalises in about half a second with no
///      reorgs, so "settled" means settled; there is no pending state for a merchant
///      to reconcile and no window in which the goods have gone and the money has
///      not.
///
///      **The plan still verifies everything itself.** This router being the only
///      authorized originator is a denial-of-service control, not a trust
///      relationship: `InstallmentPlan.initialize` recomputes `planId`, recomputes
///      `termsHash`, and verifies the borrower's acceptance against its own address.
///      A plan that trusted its caller would be a plan whose disclosed terms are an
///      operator's assertion.
contract CheckoutRouter is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using LimitAttestation for LimitAttestation.Attestation;

    /// @notice May sign limit attestations.
    /// @dev A role rather than a single address so a key can be rotated without a
    ///      redeployment, and so the attesting key is *named in the emission* — a key
    ///      issuing an out-of-distribution band is visible without any borrower being.
    bytes32 public constant UNDERWRITER_ROLE = keccak256("PLAZO.UNDERWRITER");

    /// @notice How long a compliance screen is trusted for.
    /// @dev A screen from six months ago is not a screen. Fixed rather than a
    ///      registry row because it is a property of what screening *means*, not a
    ///      risk appetite to be recalibrated — and because the feed that writes those
    ///      screens is the same operator who would be tempted to lengthen it.
    uint256 public constant SCREEN_FRESHNESS = 7 days;

    struct OriginationInput {
        PlanFactory.OriginationRequest request;
        LimitAttestation.Attestation attestation;
        bytes attestationSignature;
    }

    /// @dev Everything derived once and passed down, because the alternative is
    ///      thirteen locals in one function and Solidity's stack does not have
    ///      thirteen slots to spare.
    struct Context {
        bytes32 planId;
        TranchedCreditPool pool;
        address plan;
        address borrower;
        address merchant;
        address token;
        bytes32 corridor;
        uint256 principal;
        uint256 mdr;
        uint256 escrow;
        uint256 net;
        uint256 withholding;
        bytes32 personId;
        IUnderwritingPartner.IdentityClass identity;
    }

    PlanFactory public immutable factory;
    PoolRegistry public immutable pools;
    PlazoPassport public immutable passport;
    MerchantRegistry public immutable merchants;
    ReceivableToken public immutable receivable;
    Tier0Underwriter public immutable underwriter;
    FirstPaymentDefaultSwitch public immutable killSwitch;
    OriginationPause public immutable pauses;
    ParameterRegistry public immutable parameters;
    IComplianceOracle public immutable compliance;
    ICrossChainPayout public immutable payout;
    address public immutable fxRouter;

    /// @notice Sessions already originated. CHKT-02's replay boundary.
    mapping(bytes32 sessionId => bytes32 planId) public sessionPlan;

    /// @notice Which book funded each plan.
    /// @dev POOL-01 means there is no longer *the* pool. A plan settles to the book
    ///      named in its own signed terms, forever, and the crank has to find that book
    ///      rather than assume one — which is also why the pool is not an immutable on
    ///      this contract any more.
    mapping(bytes32 planId => address) public poolOf;

    event LimitAttested(bytes32 indexed sessionId, uint8 band, address indexed attestor);
    event OriginationCompleted(
        bytes32 indexed planId, address indexed merchant, uint256 principal, uint256 mdr, uint256 withheld
    );

    error AttestationExpired(uint256 validUntil);
    error AttestationTooLong(uint256 ttl, uint256 maxTtl);
    error AttestationPlanMismatch(bytes32 expected, bytes32 provided);
    error AttestationBorrowerMismatch(address expected, address provided);
    error AttestationSignerUnauthorized(address signer);
    error SessionAlreadyOriginated(bytes32 sessionId, bytes32 planId);
    error BorrowerNotScreened(address borrower);
    error MerchantNotScreened(address merchant);
    error ScreenStale(address account, uint256 screenedAt);
    error MerchantIneligible(string reason);
    error LimitExceeded(uint256 principal, uint256 limit);
    error TicketOutOfRange(uint256 principal, uint256 min, uint256 max);
    error MerchantConcentration(uint256 principal, uint256 headroom);
    error CorridorConcentration(uint256 principal, uint256 headroom);
    error SettlementRecipientNotAPool(address provided);
    error ScheduleNotFunded(address pool, uint256 installmentCount, uint256 interval);
    error FxRouterMismatch(address expected, address provided);
    error UnsupportedPayoutDomain(uint32 domain);
    error PlanNotOriginatedHere(bytes32 planId);

    struct Wiring {
        address factory;
        address pools;
        address passport;
        address merchants;
        address receivable;
        address underwriter;
        address killSwitch;
        address pauses;
        address parameters;
        address compliance;
        address payout;
        address fxRouter;
    }

    constructor(address admin, Wiring memory wiring) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        factory = PlanFactory(wiring.factory);
        pools = PoolRegistry(wiring.pools);
        passport = PlazoPassport(wiring.passport);
        merchants = MerchantRegistry(wiring.merchants);
        receivable = ReceivableToken(wiring.receivable);
        underwriter = Tier0Underwriter(wiring.underwriter);
        killSwitch = FirstPaymentDefaultSwitch(wiring.killSwitch);
        pauses = OriginationPause(wiring.pauses);
        parameters = ParameterRegistry(wiring.parameters);
        compliance = IComplianceOracle(wiring.compliance);
        payout = ICrossChainPayout(wiring.payout);
        fxRouter = wiring.fxRouter;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Origination
    // ─────────────────────────────────────────────────────────────────────────

    function originate(OriginationInput calldata input)
        external
        nonReentrant
        returns (bytes32 planId, address plan)
    {
        Context memory ctx = _prepare(input);

        pauses.requireOpen(ctx.corridor);
        _screen(ctx);
        uint256 attested = _authorize(input, ctx);
        _sizeCheck(input.request.detail.signerClass, ctx, attested);

        // Money moves before the plan exists, and it has to. The escrow is sent to
        // the plan's counterfactual address so that `initialize` can verify it holds
        // its own delinquency budget rather than trusting the factory to have sent
        // one — which is the difference between a plan that can pay for its own mark
        // and a plan that discovers it cannot at the moment the mark is needed.
        ctx.pool.front(
            ctx.planId,
            ctx.plan,
            ctx.merchant,
            ctx.corridor,
            ctx.principal,
            ctx.mdr,
            ctx.escrow,
            address(this)
        );

        (planId, plan) = factory.originate(input.request);

        _settleMerchant(ctx);
        _register(ctx, input.attestation.sessionId);

        emit OriginationCompleted(ctx.planId, ctx.merchant, ctx.principal, ctx.mdr, ctx.withholding);
    }

    function _prepare(OriginationInput calldata input) private view returns (Context memory ctx) {
        PlanId.PlanTerms calldata terms = input.request.terms;
        TermsDetail.Detail calldata detail = input.request.detail;

        // The plan settles to the book that funded it. Without this check a merchant
        // could name themselves as the settlement recipient and be paid twice: once
        // by the pool at checkout and again by every installment the borrower makes.
        //
        // The borrower's signed terms choose *which* book, and the registry decides
        // whether that is a book at all. Letting the terms name it is what makes a plan
        // portable across product lines without a signed product-line field: the pool
        // is already inside `termsHash`, so a strip cannot be redirected to a different
        // one.
        if (!pools.isPool(detail.settlementRecipient)) {
            revert SettlementRecipientNotAPool(detail.settlementRecipient);
        }
        ctx.pool = TranchedCreditPool(detail.settlementRecipient);

        // POOL-01, DEC-26. No tenor commingling, enforced by asking the book whether it
        // funds paper of this shape rather than by trusting a label on the request.
        if (!ctx.pool.acceptsSchedule(terms.installmentCount, terms.interval)) {
            revert ScheduleNotFunded(address(ctx.pool), terms.installmentCount, terms.interval);
        }

        if (detail.fxRouter != fxRouter) revert FxRouterMismatch(fxRouter, detail.fxRouter);

        ctx.planId = factory.derivePlanId(terms);
        ctx.plan = factory.predictAddress(ctx.planId);
        ctx.borrower = terms.borrower;
        ctx.merchant = terms.merchant;
        ctx.token = terms.token;
        ctx.corridor = corridorOf(terms.token);
        ctx.principal = terms.principal;

        ctx.mdr = (terms.principal * parameters.get(ParameterKeys.MDR_BPS)) / PlanParams.BPS;
        ctx.escrow = PlanParams.markEscrowFor(terms.installmentCount);
        ctx.net = terms.principal - ctx.mdr;
        ctx.withholding = (ctx.net * merchants.vestingBpsFor(terms.merchant)) / PlanParams.BPS;

        ctx.personId = input.attestation.personId;
        ctx.identity = IUnderwritingPartner.IdentityClass(input.attestation.identityClass);
    }

    /// @dev CHKT-03: screened before the plan exists. A plan originated for a
    ///      sanctioned party and then blocked is a plan the protocol created and
    ///      cannot collect; a plan never originated is nothing at all.
    ///
    ///      Freshness is checked as well as status, because OPS-05's whole point is
    ///      that a party's standing changes between screens. A `Clear` from six
    ///      months ago is a record of a question nobody has asked recently.
    function _screen(Context memory ctx) private view {
        if (!compliance.isClear(ctx.borrower)) revert BorrowerNotScreened(ctx.borrower);
        if (!compliance.isClear(ctx.merchant)) revert MerchantNotScreened(ctx.merchant);

        uint256 borrowerAt = compliance.screenedAt(ctx.borrower);
        if (block.timestamp > borrowerAt + SCREEN_FRESHNESS) revert ScreenStale(ctx.borrower, borrowerAt);

        uint256 merchantAt = compliance.screenedAt(ctx.merchant);
        if (block.timestamp > merchantAt + SCREEN_FRESHNESS) revert ScreenStale(ctx.merchant, merchantAt);
    }

    /// @dev CHKT-05. The attestation is checked for freshness, bound to this session
    ///      and this plan, and its signer must hold the role. What it cannot do is
    ///      raise anything: the size check that follows takes the minimum of it and
    ///      every on-chain cap.
    function _authorize(OriginationInput calldata input, Context memory ctx)
        private
        returns (uint256 attested)
    {
        LimitAttestation.Attestation calldata a = input.attestation;

        if (a.planId != ctx.planId) revert AttestationPlanMismatch(ctx.planId, a.planId);
        if (a.borrower != ctx.borrower) revert AttestationBorrowerMismatch(ctx.borrower, a.borrower);
        if (block.timestamp > a.validUntil) revert AttestationExpired(a.validUntil);

        uint256 maxTtl = parameters.get(ParameterKeys.ATTESTATION_MAX_TTL);
        uint256 ttl = a.validUntil - block.timestamp;
        if (ttl > maxTtl) revert AttestationTooLong(ttl, maxTtl);

        bytes32 existing = sessionPlan[a.sessionId];
        if (existing != bytes32(0)) revert SessionAlreadyOriginated(a.sessionId, existing);

        bytes32 digest = LimitAttestation.digest(a, block.chainid, address(this));
        address signer = ECDSA.recover(digest, input.attestationSignature);
        if (!hasRole(UNDERWRITER_ROLE, signer)) revert AttestationSignerUnauthorized(signer);

        // The band, never the figure. Enough for an operator to see an anomalous
        // distribution and for an LP to see the book's shape; not enough to
        // reconstruct a borrower's exact credit line from a public log.
        emit LimitAttested(a.sessionId, bandOf(a.limit), signer);
        return a.limit;
    }

    /// @dev The bounding, in one place. The attestation is one input among five and
    ///      it is only ever the *smallest* that binds — so a compromised underwriting
    ///      key cannot extend credit the chain would not already have extended. It
    ///      can only refuse to.
    function _sizeCheck(TermsDetail.SignerClass signerClass, Context memory ctx, uint256 attested)
        private
        view
    {
        uint256 minTicket = parameters.get(ParameterKeys.MIN_TICKET);
        uint256 maxTicket = parameters.get(ParameterKeys.MAX_TICKET);
        if (ctx.principal < minTicket || ctx.principal > maxTicket) {
            revert TicketOutOfRange(ctx.principal, minTicket, maxTicket);
        }

        uint256 limit = attested;

        uint256 ceiling = parameters.get(ParameterKeys.LIMIT_HARD_CEILING);
        if (limit > ceiling) limit = ceiling;

        // Tier 0 already folds in the identity cap, the contract-signer reduction,
        // the kill-switch throttle, the book-share headroom and the one-active-plan
        // rule. Zero from here means "not now", and the router turns that into a
        // failed origination the service reads as CHKT-08's fallback trigger.
        uint256 tierCap = underwriter.capFor(ctx.personId, ctx.identity, signerClass);
        if (limit > tierCap) limit = tierCap;

        if (ctx.principal > limit) revert LimitExceeded(ctx.principal, limit);

        (uint256 merchantRoom, uint256 corridorRoom) =
            ctx.pool.concentrationHeadroom(ctx.merchant, ctx.corridor);
        if (ctx.principal > merchantRoom) revert MerchantConcentration(ctx.principal, merchantRoom);
        if (ctx.principal > corridorRoom) revert CorridorConcentration(ctx.principal, corridorRoom);

        (bool ok, string memory reason) = merchants.canOriginate(ctx.merchant, ctx.principal);
        if (!ok) revert MerchantIneligible(reason);
    }

    function _settleMerchant(Context memory ctx) private {
        (address recipient, uint32 domain) = merchants.payoutRouteOf(ctx.merchant);
        if (!payout.supportsDomain(domain)) revert UnsupportedPayoutDomain(domain);

        IERC20 asset = IERC20(ctx.token);

        // DEC-09. A slice of the merchant's own settlement capitalises their own bond
        // while they are new, so the exposure-scaled requirement is satisfiable by
        // the business they are doing rather than only by capital locked up in
        // advance.
        if (ctx.withholding > 0) {
            asset.forceApprove(address(merchants), ctx.withholding);
            merchants.postWithheld(ctx.merchant, ctx.planId, ctx.withholding);
        }

        merchants.noteOrigination(ctx.merchant, ctx.principal);

        uint256 payable_ = ctx.net - ctx.withholding;
        asset.forceApprove(address(payout), payable_);
        payout.payout(ctx.token, domain, recipient, payable_);
    }

    function _register(Context memory ctx, bytes32 sessionId) private {
        sessionPlan[sessionId] = ctx.planId;

        poolOf[ctx.planId] = address(ctx.pool);
        receivable.mint(ctx.planId, address(ctx.pool), ctx.principal);

        bool seasoned = underwriter.isSeasoned(ctx.personId);
        underwriter.notePlan(ctx.personId, ctx.identity, ctx.planId, ctx.principal);
        underwriter.bindPlan(ctx.planId, ctx.plan, ctx.borrower);
        killSwitch.noteOrigination(ctx.planId, ctx.plan, seasoned);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The crank
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Book a plan's progress against the pool *and* the merchant's exposure.
    ///
    /// @dev Permissionless and idempotent, like the pool's own crank.
    ///
    ///      Both ledgers exist and they measure different things: the pool's book is
    ///      the accounting identity, and the merchant registry's `outstandingFronted`
    ///      is the risk gauge the bond is priced off. Only the pool can learn from the
    ///      plan, and only the router holds the registry's bookkeeper role — so
    ///      without this, a merchant's exposure would rise at every origination and
    ///      never fall, their bond requirement would ratchet upward forever, and a
    ///      merchant who had repaid every plan they ever originated could not withdraw
    ///      a cent of it.
    ///
    ///      Reading the carrying value either side of the pool's crank is what makes
    ///      this exact rather than an estimate: whatever the receivable fell by is
    ///      what the merchant is no longer on the hook for, whether it came back as a
    ///      repayment or was written off.
    function recognise(bytes32 planId) external {
        TranchedCreditPool pool = TranchedCreditPool(poolOf[planId]);
        if (address(pool) == address(0)) revert PlanNotOriginatedHere(planId);

        TranchedCreditPool.PlanBook memory before = pool.bookOf(planId);
        pool.recognise(planId);
        TranchedCreditPool.PlanBook memory settled = pool.bookOf(planId);

        uint256 recovered = before.carrying > settled.carrying ? before.carrying - settled.carrying : 0;
        if (recovered > 0) merchants.noteRecovered(before.merchant, recovered);
    }

    function recogniseBatch(bytes32[] calldata planIds) external {
        for (uint256 i = 0; i < planIds.length; ++i) {
            this.recognise(planIds[i]);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Quotes (CHKT-01, CHKT-08)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The largest principal that would actually originate right now.
    ///
    /// @dev CHKT-01's quote is worth nothing if the chain can contradict it at the
    ///      moment of signing, and CHKT-08's fallback offer is worth nothing if it is
    ///      a guess. Both read this: the service sizes a smaller-installment offer
    ///      against the same number the router will enforce, so "we can do $180 of
    ///      this $240 order" is a statement about the chain rather than about the
    ///      service's model of it.
    ///
    ///      Deliberately not a `require`. A borrower $12 over their limit at the
    ///      moment of purchase should be offered something, and a flat decline is the
    ///      worst available answer.
    function maxPrincipalFor(
        bytes32 personId,
        IUnderwritingPartner.IdentityClass identity,
        TermsDetail.SignerClass signerClass,
        address merchant,
        address token,
        address pool_
    ) external view returns (uint256) {
        TranchedCreditPool pool = TranchedCreditPool(pool_);
        if (!pools.isPool(pool_)) return 0;

        uint256 limit = underwriter.capFor(personId, identity, signerClass);

        uint256 ceiling = parameters.get(ParameterKeys.LIMIT_HARD_CEILING);
        if (limit > ceiling) limit = ceiling;

        uint256 maxTicket = parameters.get(ParameterKeys.MAX_TICKET);
        if (limit > maxTicket) limit = maxTicket;

        (uint256 merchantRoom, uint256 corridorRoom) =
            pool.concentrationHeadroom(merchant, corridorOf(token));
        if (limit > merchantRoom) limit = merchantRoom;
        if (limit > corridorRoom) limit = corridorRoom;

        uint256 velocityRoom = merchants.velocityCapFor(merchant);
        uint256 used = merchants.velocityUsed(merchant);
        velocityRoom = velocityRoom > used ? velocityRoom - used : 0;
        if (limit > velocityRoom) limit = velocityRoom;

        if (!pool.originationOpen() || !pauses.isOpen(corridorOf(token))) return 0;
        if (limit < parameters.get(ParameterKeys.MIN_TICKET)) return 0;
        return limit;
    }

    /// @notice Whether a merchant could originate `principal` right now, with a
    ///         reason when they could not.
    /// @dev The quote surface's diagnostic. A checkout that can only report "no" has
    ///      to guess at the fix; one that can report "merchant velocity cap" tells the
    ///      merchant to try again in an hour and tells the borrower nothing about
    ///      themselves that is untrue.
    function merchantStanding(address merchant, uint256 principal)
        external
        view
        returns (bool ok, string memory reason)
    {
        return merchants.canOriginate(merchant, principal);
    }

    /// @notice The MDR on a given principal.
    function mdrFor(uint256 principal) external view returns (uint256) {
        return (principal * parameters.get(ParameterKeys.MDR_BPS)) / PlanParams.BPS;
    }

    /// @notice The concentration bucket a token belongs to.
    /// @dev One currency, one bucket, in v1. Phase 7's corridors are currency
    ///      *pairs*, and the derivation changes there rather than the caps — which is
    ///      why this is a function and not a constant.
    function corridorOf(address token) public pure returns (bytes32) {
        return keccak256(abi.encode("PLAZO.CORRIDOR", token));
    }

    /// @notice A borrower's coarse Passport tier.
    ///
    /// @dev PASS-02's "only a coarse tier exposed through the router", and this is that
    ///      exposure. The router holds `READER_ROLE`; a merchant, a PSP or a partner
    ///      lender asks here and gets one of five words. Anything richer requires the
    ///      borrower's signed consent presented directly to the Passport, which is
    ///      where PASS-04 is enforced and where PASS-07's revocation bites.
    ///
    ///      Nothing about the underwriting decision reads this. The tier is a summary
    ///      for counterparties; `Tier0Underwriter` computes the limit from the plans
    ///      themselves, so a Passport that was wrong could not raise anybody's credit.
    function passportTierOf(address borrower) external view returns (PlazoPassport.Tier) {
        return passport.tierOf(borrower);
    }

    /// @notice Which band a limit falls in. CHKT-05's "emits only a band".
    /// @dev The bucket list lives in `LimitAttestation` so the contract, the corpus
    ///      generator and a merchant's client evaluate one implementation.
    function bandOf(uint256 limit) public pure returns (uint8) {
        return LimitAttestation.bandOf(limit);
    }
}
