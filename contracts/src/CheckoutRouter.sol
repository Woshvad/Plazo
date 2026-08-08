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
import {MerchantCurrencyRegistry} from "./MerchantCurrencyRegistry.sol";
import {ReceivableToken} from "./ReceivableToken.sol";
import {FirstPaymentDefaultSwitch} from "./FirstPaymentDefaultSwitch.sol";
import {OriginationPause} from "./OriginationPause.sol";
import {ParameterRegistry} from "./ParameterRegistry.sol";
import {SettlementEscrow} from "./SettlementEscrow.sol";
import {FxDeviationGuard} from "./fx/FxDeviationGuard.sol";
import {IComplianceOracle} from "./interfaces/IComplianceOracle.sol";
import {ICrossChainPayout} from "./interfaces/ICrossChainPayout.sol";
import {IFxVenue} from "./interfaces/IFxVenue.sol";
import {IUnderwritingPartner} from "./interfaces/IUnderwritingPartner.sol";
import {IUnderwritingPartnerV2} from "./interfaces/IUnderwritingPartnerV2.sol";
import {FxMidAttestation} from "./libraries/FxMidAttestation.sol";
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
///      **MERCH-04 carves physical goods out of that, and does not contradict it.**
///      A merchant in the `Escrowed` category has their settlement moved out of the
///      pool and into `SettlementEscrow` in this same transaction, and released to
///      them once they attest shipment. The claim CHKT-04 makes — full amount less
///      MDR, decided with sub-second finality, no reconciliation — is unchanged for
///      the digital and low-risk categories it was written about. See
///      `_settleMerchant`.
///
///      **The plan still verifies everything itself.** This router being the only
///      authorized originator is a denial-of-service control, not a trust
///      relationship: `InstallmentPlan.initialize` recomputes `planId`, recomputes
///      `termsHash`, and verifies the borrower's acceptance against its own address.
///      A plan that trusted its caller would be a plan whose disclosed terms are an
///      operator's assertion.
///
///      ── Phase 7: the corridor is a whole parallel book ────────────────────────
///
///      **Every money-denominated figure a plan is measured against comes from the
///      corridor's own contracts, and none of them is converted.** `_sizeCheck`
///      compares a principal against `MIN_TICKET`, `MAX_TICKET`,
///      `LIMIT_HARD_CEILING`, the attested cap, the underwriter's `capFor`, the
///      pool's concentration headroom and the merchant's standing. Before Phase 7
///      every one of those was dollar-denominated and there was one of each. A EURC
///      principal measured against them at 1:1 is a money bug that no amount of
///      correctness inside `InstallmentPlan` can reach, because it happens at the
///      origination gate and not in the plan.
///
///      So the corridor carries **its own `ParameterRegistry`, its own underwriter
///      and its own FX router**, resolved together as one `CorridorConfig` that
///      `setCorridor` refuses to half-fill. `Tier0Underwriter.bookHeadroom()` divides
///      by `totalAssets()` on its single settable pool and `outstandingExposure` is
///      one scalar — so a EURC plan scored against the dollar instance would consume
///      the dollar book's headroom as well as being measured against dollar bands.
///      Two currencies are two balance sheets (DEC-21), and that means two of every
///      contract that holds one. After this change **no comparison in `_sizeCheck`
///      crosses currencies at all**, which is a stronger property than any conversion
///      would have bought.
///
///      **The rejected alternative, and what it would have cost.** Converting the
///      principal to dollars before the credit comparison would put an FX rate on the
///      critical path of every credit decision — a rate that, being consulted to
///      decide what something is worth, would be the price oracle C1 removes and
///      `tools/check-no-oracle.mjs` fails the build over. Two registries and two
///      underwriters cost a deployment each; a rate on the credit path costs the
///      all-dollar balance sheet.
///
///      **The rule that decides which registry a row is read from, stated once:
///      a row denominated in *money* is read from `cc.parameters`; a row denominated
///      in *time* is read from `parameters`.** `MIN_TICKET`, `MAX_TICKET`,
///      `LIMIT_HARD_CEILING` and `FX_CORRIDOR_HAIRCUT_BPS` are money.
///      `ATTESTATION_MAX_TTL` and `FX_MID_MAX_TTL` are time, and so is
///      `SCREEN_FRESHNESS`, which is not a registry row at all. The two registries are
///      the same bytecode with the same seeds, so the time rows agree by construction
///      today; the money rows do not, and must never be asked to.
///
///      **The one cross-currency figure in the whole path is named `_bondEquivalent`
///      and it has exactly two call sites.** `MerchantRegistry` custodies bonds in one
///      currency and must not be superseded — 06-13 stranded 46 USDC by superseding it
///      once. The bond is a **fraud control, not a credit control**, which is why a
///      bounded and stated conversion error is acceptable there and a silent 1:1 is
///      not acceptable anywhere. It fails closed. See `_bondEquivalent`.
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
        /// @notice The quoting service's signed mid, when this origination needs one.
        /// @dev **Optional, and unread when no currency crosses.** A dollar plan paid
        ///      to a merchant who elected nothing reads neither of these two fields.
        ///      They are required — and validated — exactly when the plan's currency
        ///      is not the base currency, or the merchant's elected payout currency is
        ///      not the plan's. There is **one** mid per origination on purpose: the
        ///      bond conversion, the merchant leg and the withholding all read it, so a
        ///      single origination can never carry two rates.
        FxMidAttestation.Mid fxMid;
        bytes fxMidSignature;
    }

    /// @notice One corridor's router, bands and underwriter, resolved together.
    ///
    /// @dev **One mapping to a three-field struct rather than three mappings.** Three
    ///      parallel mappings would cost three storage reads on every origination and,
    ///      worse, would admit a corridor configured with a router and no parameter
    ///      set — which would silently fall back to reading another currency's bands.
    ///      That is precisely the money bug this struct exists to make unrepresentable,
    ///      and `CorridorIncomplete` is what refuses it.
    struct CorridorConfig {
        /// @notice The `IFXRouter` this corridor's plans must name in their signed terms.
        address fxRouter;
        /// @notice Where every **money**-denominated band for this corridor is read.
        ParameterRegistry parameters;
        /// @notice This corridor's own credit book. Its pool, its exposure, its bands.
        IUnderwritingPartnerV2 underwriter;
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
        /// @notice The corridor resolved once, in `_prepare`.
        /// @dev Carried rather than re-read so `_sizeCheck`, `_settleMerchant` and
        ///      `_register` cannot disagree about which book they are transacting
        ///      against — there is no window between them for `setCorridor` to land.
        CorridorConfig cc;
        /// @notice The attested mid this origination converts at, if it converts.
        /// @dev One rate per origination. `_bondEquivalent`, the merchant leg and the
        ///      withholding all read *this* field rather than taking a rate of their
        ///      own, which is the mechanism behind that claim rather than a comment
        ///      asserting it.
        FxMidAttestation.Mid fxMid;
        bytes fxMidSignature;
    }

    PlanFactory public immutable factory;
    PoolRegistry public immutable pools;
    PlazoPassport public immutable passport;
    MerchantRegistry public immutable merchants;
    /// @notice MERCH-07's currency half. A merchant's own payout preference.
    MerchantCurrencyRegistry public immutable currencies;
    ReceivableToken public immutable receivable;
    FirstPaymentDefaultSwitch public immutable killSwitch;
    OriginationPause public immutable pauses;
    /// @notice The base corridor's registry, and the source of every **time** row.
    ParameterRegistry public immutable parameters;
    IComplianceOracle public immutable compliance;
    ICrossChainPayout public immutable payout;
    /// @notice Where a physical-goods merchant's settlement is held (MERCH-04).
    SettlementEscrow public immutable settlementEscrow;
    /// @notice The only way a currency crosses in this contract (FX-05).
    /// @dev Every conversion below goes through `settleGuarded` and there is no second
    ///      path: this contract never calls a venue itself, so a fill outside the
    ///      signed mid's band is refused before the transaction can complete.
    FxDeviationGuard public immutable fxGuard;
    /// @notice The venue the guard settles through.
    /// @dev **Governance's, not the caller's, and immutable for the same reason every
    ///      other wiring field here is.** A caller-supplied venue would let whoever
    ///      submits the origination choose who fills the merchant's settlement, and the
    ///      most a hostile venue could then take is the whole `FX_MAX_DEVIATION_BPS`
    ///      band — real value, out of a merchant's payment. It ships as
    ///      `AmmVenue(router = 0)`, which refuses every fill, because plan 07-01 probed
    ///      seven AMM candidates on Arc testnet and none of them holds bytecode
    ///      (finding 34). A venue appearing is a redeployment plus a rewire, which
    ///      DEC-15 made cheap on purpose.
    address public immutable fxVenue;

    /// @notice The currency this router's base corridor — and the bond ledger — is in.
    ///
    /// @dev **Declared rather than derived, because four branches read it**: the
    ///      corridor haircut's condition, `_bondEquivalent`'s identity branch,
    ///      `_bondEquivalent`'s fail-closed branch, and the currency the withholding is
    ///      converted into before it reaches `MerchantRegistry`. Deriving it from the
    ///      corridor's own `IdentityFXRouter.accountingToken()` would have been dead by
    ///      definition — an identity router refuses any token that is not its accounting
    ///      currency, so reaching the comparison at all means it already holds. The
    ///      constructor pins it to the corridor seeded beneath it, so "the base
    ///      corridor" and "the base token" cannot drift apart.
    address public immutable baseToken;

    /// @notice Which router, bands and underwriter each corridor uses.
    mapping(address token => CorridorConfig) private _corridors;

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
    event CorridorSet(
        address indexed token, address fxRouter, address parameters, address underwriter, address indexed by
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
    /// @notice No corridor has been configured for this token.
    /// @dev Refusal, never fallback. A corridor falling back to the base router is the
    ///      "silently treats one EURC as one USDC" failure `IdentityFXRouter`'s own
    ///      header names as worse than having no router at all.
    error CorridorNotConfigured(address token);
    /// @notice A corridor was configured with one of its three parts missing.
    error CorridorIncomplete(address token);
    /// @notice A currency has to cross and no deviation guard is wired.
    error FxGuardUnset();
    /// @notice A currency has to cross and there is no usable mid to cross it at.
    /// @dev Absent, expired, over-TTL, unsigned, signed by a key without the role, or
    ///      quoted for the wrong pair — all of them this, and all of them fail closed.
    error FxMidRequired(address token);

    struct Wiring {
        address factory;
        address pools;
        address passport;
        address merchants;
        address currencies;
        address receivable;
        address underwriter;
        address killSwitch;
        address pauses;
        address parameters;
        address compliance;
        address payout;
        address settlementEscrow;
        address fxGuard;
        address fxVenue;
        address fxRouter;
        address baseToken;
    }

    constructor(address admin, Wiring memory wiring) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        factory = PlanFactory(wiring.factory);
        pools = PoolRegistry(wiring.pools);
        passport = PlazoPassport(wiring.passport);
        merchants = MerchantRegistry(wiring.merchants);
        currencies = MerchantCurrencyRegistry(wiring.currencies);
        receivable = ReceivableToken(wiring.receivable);
        killSwitch = FirstPaymentDefaultSwitch(wiring.killSwitch);
        pauses = OriginationPause(wiring.pauses);
        parameters = ParameterRegistry(wiring.parameters);
        compliance = IComplianceOracle(wiring.compliance);
        payout = ICrossChainPayout(wiring.payout);
        settlementEscrow = SettlementEscrow(wiring.settlementEscrow);
        fxGuard = FxDeviationGuard(wiring.fxGuard);
        fxVenue = wiring.fxVenue;
        baseToken = wiring.baseToken;

        // The base corridor is seeded through the same helper `setCorridor` uses, so
        // completeness is checked by one implementation rather than two — a deployment
        // with a router and no parameter set is refused here exactly as it would be
        // afterwards, and a deployment that never calls `setCorridor` behaves precisely
        // as this contract did before Phase 7.
        _setCorridor(wiring.baseToken, wiring.fxRouter, wiring.parameters, wiring.underwriter);

        // `baseToken` and "the base corridor" are one fact stated twice, and this is
        // where they are pinned together. Four branches below decide what to convert by
        // comparing against `baseToken`; a deployment whose base token named a corridor
        // it had not seeded would put all four on a corridor that reverts
        // `CorridorNotConfigured` at the first origination.
        if (_corridors[baseToken].fxRouter != wiring.fxRouter) revert CorridorIncomplete(baseToken);

        // And `baseToken` is the currency the bond ledger actually keeps, checked rather
        // than assumed. `_crossCurrencies` converts the withholding **into** `baseToken`
        // before `postWithheld` on the strength of this equality; if the two ever came
        // apart, the registry would be handed a currency it has no way to know it holds
        // and `requiredBond` would compare two of them at 1:1 — the exact defect the
        // conversion exists to prevent, reintroduced by a wiring mistake.
        if (address(merchants.token()) != baseToken) revert CorridorIncomplete(baseToken);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Corridors
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Configure the router, bands and underwriter one currency originates on.
    ///
    /// @dev All three or none. A corridor holding a router but pointing at another
    ///      currency's `ParameterRegistry` would measure its principals against another
    ///      currency's ticket bounds and ceiling at 1:1, and a corridor pointing at
    ///      another currency's underwriter would consume that book's Tier-0 headroom —
    ///      both of them silently, both of them producing plausible numbers. The
    ///      all-or-nothing shape is what makes those unrepresentable rather than
    ///      merely discouraged.
    function setCorridor(
        address token,
        address fxRouter_,
        address parameters_,
        address underwriter_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setCorridor(token, fxRouter_, parameters_, underwriter_);
    }

    function _setCorridor(
        address token,
        address fxRouter_,
        address parameters_,
        address underwriter_
    ) private {
        if (
            token == address(0) || fxRouter_ == address(0) || parameters_ == address(0)
                || underwriter_ == address(0)
        ) {
            revert CorridorIncomplete(token);
        }

        _corridors[token] = CorridorConfig({
            fxRouter: fxRouter_,
            parameters: ParameterRegistry(parameters_),
            underwriter: IUnderwritingPartnerV2(underwriter_)
        });

        emit CorridorSet(token, fxRouter_, parameters_, underwriter_, msg.sender);
    }

    function corridorConfigOf(address token) public view returns (CorridorConfig memory) {
        return _corridors[token];
    }

    /// @notice The FX router a plan denominated in `token` must name in its terms.
    /// @dev A thin reader over the struct, kept under the name every existing caller
    ///      and test already uses.
    function fxRouterOf(address token) public view returns (address) {
        return _corridors[token].fxRouter;
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
        ctx.pool
            .front(
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

        // The corridor is resolved **once**, here, and carried on the context. Every
        // later reader takes it from `ctx` rather than re-reading the mapping, so there
        // is no window inside one origination in which two of them could see different
        // books.
        ctx.cc = _corridors[terms.token];
        if (ctx.cc.fxRouter == address(0)) revert CorridorNotConfigured(terms.token);

        // The signed terms still choose the router and this contract still verifies it —
        // now against the corridor the plan's own currency resolves to, rather than
        // against one global address.
        if (detail.fxRouter != ctx.cc.fxRouter) {
            revert FxRouterMismatch(ctx.cc.fxRouter, detail.fxRouter);
        }

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

        ctx.fxMid = input.fxMid;
        ctx.fxMidSignature = input.fxMidSignature;

        // **The mid's direction is fixed here, by enforcement rather than by comment.**
        //
        // `FxMidAttestation.Mid.midE18` is defined as `toToken` per `fromToken`. So
        // requiring `fromToken == ctx.token` and `toToken == baseToken` makes `midE18`
        // *base currency per corridor currency* — for a EURC plan on a dollar-base
        // router that is EUR→USD, and `principal * midE18 / 1e18` is therefore the
        // dollar equivalent that `MerchantRegistry`'s single-currency bond ledger needs.
        //
        // Leaving this to convention was not an option. An off-chain signer sending the
        // reciprocal understates a required bond by the whole EUR/USD spread, produces a
        // perfectly plausible number, and passes every test that does not check the
        // arithmetic — which is the shape of defect that survives a review.
        if (ctx.token != baseToken) {
            if (ctx.fxMid.fromToken != ctx.token || ctx.fxMid.toToken != baseToken) {
                revert FxMidRequired(ctx.token);
            }
        }
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
    function _authorize(
        OriginationInput calldata input,
        Context memory ctx
    ) private returns (uint256 attested) {
        LimitAttestation.Attestation calldata a = input.attestation;

        // **W-3, and the check that carries it is the line immediately below.**
        // `ctx.planId` is `factory.derivePlanId(terms)` — recomputed in `_prepare` from
        // the signed terms, never taken from the caller — so an attestation is bound to
        // a plan id this contract derived itself. That is the whole mechanism by which
        // the *currency* of `a.limit` is pinned: `LimitAttestation` carries no currency
        // field, and the only thing tying the signer's figure to `terms.token` is that
        // the plan id they signed against commits to it.
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
    ///
    ///      **Every comparison below is in the plan's own currency.** The ticket
    ///      bounds, the ceiling and the haircut come from `ctx.cc.parameters` — the
    ///      corridor's registry. `capFor` comes from the corridor's own underwriter,
    ///      which reads the corridor's registry and divides by the corridor's pool, so
    ///      nothing about that figure can be scaled to another currency. The two
    ///      concentration figures come from `ctx.pool`, which on a EURC origination
    ///      **is** the EURC pool. And the attested limit is denominated in
    ///      `terms.token` because the attestation is bound to `planId` and `planId`
    ///      commits to `terms.token` — a sentence that needs writing down precisely
    ///      because `LimitAttestation` carries no currency field of its own, so the
    ///      binding is real but indirect. See `_authorize`.
    ///
    ///      The single exception is `merchants.canOriginate`, whose ledger is
    ///      single-currency by construction and which therefore takes
    ///      `_bondEquivalent(ctx)` rather than the raw principal.
    function _sizeCheck(
        TermsDetail.SignerClass signerClass,
        Context memory ctx,
        uint256 attested
    ) private view {
        // Money rows, from the corridor's own registry (B-2a).
        uint256 minTicket = ctx.cc.parameters.get(ParameterKeys.MIN_TICKET);
        uint256 maxTicket = ctx.cc.parameters.get(ParameterKeys.MAX_TICKET);
        if (ctx.principal < minTicket || ctx.principal > maxTicket) {
            revert TicketOutOfRange(ctx.principal, minTicket, maxTicket);
        }

        uint256 limit = attested;

        uint256 ceiling = ctx.cc.parameters.get(ParameterKeys.LIMIT_HARD_CEILING);
        if (limit > ceiling) limit = ceiling;

        // Tier 0 already folds in the identity cap, the contract-signer reduction,
        // the kill-switch throttle, the book-share headroom and the one-active-plan
        // rule. Zero from here means "not now", and the router turns that into a
        // failed origination the service reads as CHKT-08's fallback trigger.
        //
        // **Five arguments, and the last two are why Tiers 1 and 2 exist at all.**
        // `PledgeVault.limitFor` is keyed by wallet and `PayrollSweeper.isOptedIn` by
        // `(planId, wallet)`; neither is derivable from a person id, so the published
        // three-argument form silently yields the Tier-0 figure alone and UW-06's
        // instant Tier-2 limit is unreachable through the only function that grants one.
        uint256 tierCap =
            ctx.cc.underwriter.capFor(ctx.personId, ctx.identity, signerClass, ctx.borrower, ctx.planId);
        if (limit > tierCap) limit = tierCap;

        // **FX-04's haircut loads the credit headroom and never the payment.** A plan
        // denominated in something other than this router's base accounting currency
        // consumes more room than its face value, because the book carries the currency
        // risk from origination to the last due date and StableFX has no forward tenor
        // to lay it off with (E-02). The risk is therefore priced in credit terms,
        // explicitly, where an LP can see it.
        //
        // The rejected alternative and its cost: reducing what the merchant is fronted
        // by the haircut would make the borrower's signed principal and the merchant's
        // receipt disagree, which is exactly the "a plan whose disclosed terms are an
        // operator's assertion" failure this contract's own header warns against.
        // `terms.principal` is signed; the merchant is paid the invoice.
        uint256 loaded = ctx.principal;
        if (ctx.token != baseToken) {
            loaded = ctx.principal
                + (ctx.principal * ctx.cc.parameters.get(ParameterKeys.FX_CORRIDOR_HAIRCUT_BPS))
                / PlanParams.BPS;
        }

        if (loaded > limit) revert LimitExceeded(loaded, limit);

        // **All three of these are corridor-currency figures, so all three take the
        // corridor-currency `loaded`.** `merchantRoom` in particular does *not* come
        // from `MerchantRegistry`: `TranchedCreditPool.concentrationHeadroom` computes
        // it as `totalAssets() * MERCHANT_CONCENTRATION_BPS / BPS` minus that merchant's
        // exposure **on this pool**, and on a EURC origination `ctx.pool` is the EURC
        // pool — so the figure is EURC. Comparing `_bondEquivalent`'s base-currency
        // output against it would introduce a scale mismatch onto a control that is
        // correct today, three lines from `corridorRoom`, which is rightly left alone.
        (uint256 merchantRoom, uint256 corridorRoom) =
            ctx.pool.concentrationHeadroom(ctx.merchant, ctx.corridor);
        if (loaded > merchantRoom) revert MerchantConcentration(loaded, merchantRoom);
        if (loaded > corridorRoom) revert CorridorConcentration(loaded, corridorRoom);

        // The one cross-currency figure in the path, and the only comparison here that
        // is not in the plan's own currency — because the ledger behind it has exactly
        // one currency and must not gain a second. See `_bondEquivalent`.
        (bool ok, string memory reason) = merchants.canOriginate(ctx.merchant, _bondEquivalent(ctx));
        if (!ok) revert MerchantIneligible(reason);
    }

    /// @notice This plan's principal, in the currency the merchant bond ledger keeps.
    ///
    /// @dev **The one named cross-currency conversion in the origination path, and it
    ///      reaches exactly two call sites — `canOriginate` and `noteOrigination`, the
    ///      only two readers of `MerchantRegistry`'s single-currency bond ledger.**
    ///      Nowhere else, and specifically not on `merchantRoom`, which the pool
    ///      computes from its own `totalAssets()` and which is therefore already in the
    ///      corridor's currency.
    ///
    ///      **Why a conversion is acceptable here and a silent 1:1 is not acceptable
    ///      anywhere.** The bond is a **fraud control, not a credit control**: it prices
    ///      how much a merchant could walk away with, and it is sized in a currency the
    ///      registry custodies. That registry must not be superseded — 06-13 stranded
    ///      46 USDC by superseding it once, and the merchant's own withdrawal on the old
    ///      address is still the only route to it — and it cannot hold two currencies
    ///      without `requiredBond` comparing them at 1:1, which is this plan's own bug
    ///      relocated rather than fixed. So the exposure is converted **into** the
    ///      ledger's currency at the attested mid, and the error that leaves is bounded
    ///      and stated rather than unbounded and silent.
    ///
    ///      **The bound.** One unit of integer truncation, plus whatever the mid itself
    ///      is wrong by. The mid is bounded in width by `FX_MAX_DEVIATION_BPS` at the
    ///      guard and in age by `FX_MID_MAX_TTL` here, so the most this can understate a
    ///      required bond by is that band — a fraud-control tolerance, on a figure that
    ///      is itself a multiple of exposure, rather than a credit-control one.
    ///
    ///      **It fails closed, and that is the point of the function existing at all.**
    ///      On a non-base-currency origination an absent, expired, over-TTL, unsigned or
    ///      wrongly-signed mid reverts `FxMidRequired`. A cross-currency plan cannot
    ///      originate without a fresh mid, because the alternative is a bond check
    ///      performed against a number nobody attested — which is a fraud control that
    ///      silently is not one.
    function _bondEquivalent(Context memory ctx) private view returns (uint256) {
        if (ctx.token == baseToken) return ctx.principal;

        FxMidAttestation.Mid memory mid = ctx.fxMid;

        // Absent. `_prepare` has already fixed the direction; a zero rate is the
        // remaining way for an unset struct to reach here.
        if (mid.midE18 == 0) revert FxMidRequired(ctx.token);

        // Expired, and no older than a mid is allowed to be. `FX_MID_MAX_TTL` is a
        // **time** row and therefore comes from the base registry, per the header's rule.
        if (block.timestamp > mid.validUntil) revert FxMidRequired(ctx.token);
        if (mid.validUntil - block.timestamp > parameters.get(ParameterKeys.FX_MID_MAX_TTL)) {
            revert FxMidRequired(ctx.token);
        }

        // Signed, and signed by a key that holds the guard's role. `tryRecover` rather
        // than `recover` so a malformed signature is `FxMidRequired` too: one error for
        // "there is no usable mid", however it came to be unusable, is what makes the
        // fail-closed claim checkable from outside.
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(
            FxMidAttestation.digest(mid, block.chainid, address(fxGuard)), ctx.fxMidSignature
        );
        if (err != ECDSA.RecoverError.NoError) revert FxMidRequired(ctx.token);
        if (!fxGuard.hasRole(fxGuard.FX_SIGNER_ROLE(), signer)) revert FxMidRequired(ctx.token);

        return (ctx.principal * mid.midE18) / 1e18;
    }

    function _settleMerchant(Context memory ctx) private {
        (address recipient, uint32 domain) = merchants.payoutRouteOf(ctx.merchant);
        if (!payout.supportsDomain(domain)) revert UnsupportedPayoutDomain(domain);

        // MERCH-07's currency half, read from the merchant's own side-car. Zero means
        // "pay in the plan's own currency", which is what every merchant who registered
        // before that contract existed reads — so this line changes nothing for anybody
        // who has not affirmatively asked it to.
        //
        // **The borrower's currency and the merchant's are independent because they are
        // different call sites.** Nothing about the merchant's preference is inside
        // `TermsDetail`, inside `termsHash` or inside `planId`, and nothing about it
        // reaches `InstallmentPlan` — which does not know it, must not learn it, and
        // would need a new vintage to be told.
        address want = currencies.payoutCurrencyOf(ctx.merchant);
        if (want == address(0)) want = ctx.token;

        uint256 withheld = ctx.withholding;
        uint256 payable_ = ctx.net - ctx.withholding;
        (withheld, payable_) = _crossCurrencies(ctx, want, withheld, payable_);

        // DEC-09. A slice of the merchant's own settlement capitalises their own bond
        // while they are new, so the exposure-scaled requirement is satisfiable by
        // the business they are doing rather than only by capital locked up in
        // advance.
        if (withheld > 0) {
            IERC20(baseToken).forceApprove(address(merchants), withheld);
            merchants.postWithheld(ctx.merchant, ctx.planId, withheld);
        }

        merchants.noteOrigination(ctx.merchant, _bondEquivalent(ctx));

        IERC20 asset = IERC20(want);

        // MERCH-04, and **this is not a CHKT-04 regression (D-09)**. CHKT-04 is closed
        // and reads "the merchant is credited in full minus MDR with sub-second
        // finality"; MERCH-04 explicitly carves physical goods out of it. The money
        // leaves the pool in this transaction either way and the merchant's claim on it
        // is fixed in this transaction either way — what differs is whose custody it
        // sits in until shipment is attested. The `Instant` branch below is byte-for-
        // byte the Phase 3 path.
        //
        // The category is read **once, here, at origination**, and that is what closes
        // D-06's mutability objection: the routing decision is immediate and
        // irreversible, so a later `setCategory` cannot reach back and un-escrow a plan
        // that has already settled. `SettlementEscrow.hold` stamps what it read onto the
        // row — including the **converted** token, so the escrow stays self-describing
        // when the merchant is paid in a currency the plan was not written in.
        if (merchants.categoryOf(ctx.merchant) == MerchantRegistry.SettlementCategory.Instant) {
            asset.forceApprove(address(payout), payable_);
            payout.payout(want, domain, recipient, payable_);
        } else {
            asset.forceApprove(address(settlementEscrow), payable_);
            settlementEscrow.hold(ctx.planId, ctx.merchant, want, domain, recipient, payable_);
        }
    }

    /// @notice Move the withholding and the payment into the currencies they must end
    ///         in, in at most one guarded settlement.
    ///
    /// @dev Two legs with two destinations, and they are not the same destination.
    ///
    ///      **The withholding must end in `baseToken`.** `MerchantRegistry` custodies
    ///      bonds and withholding in one currency and has no way to know it has been
    ///      handed a second; posting EURC into it would leave `requiredBond` comparing
    ///      two currencies at 1:1, which is B-2's bug relocated rather than fixed.
    ///      **This changes nothing the merchant receives** — the withholding is withheld
    ///      either way. It changes only the currency the withheld reserve is denominated
    ///      in, and `withdrawBond` still returns it to them.
    ///
    ///      **The payment must end in `want`**, which is the merchant's own election or
    ///      the plan's currency when they have made none.
    ///
    ///      **At most one `settleGuarded` call, because a mid is spent once.**
    ///      `FxDeviationGuard` consumes `mid.sessionId` before the venue is called and
    ///      refuses the second use — so two conversions at one mid is not a thing that
    ///      can be written, and two mids would mean one origination carrying two rates,
    ///      which is exactly what carrying the mid on `Context` exists to prevent. When
    ///      both legs cross in the same direction they cross together and the proceeds
    ///      are split at the ratio the withholding was computed at. When they would need
    ///      different destinations — a corridor plan whose merchant elected some third
    ///      currency — this refuses rather than converting one of them wrongly.
    ///
    ///      **One entry point, and there is no second.** Every currency crossing in this
    ///      contract is this call. Nothing here calls a venue directly, so a fill outside
    ///      the signed mid's band cannot reach a merchant through any path.
    function _crossCurrencies(
        Context memory ctx,
        address want,
        uint256 withheld,
        uint256 payable_
    ) private returns (uint256, uint256) {
        bool crossWithheld = withheld > 0 && ctx.token != baseToken;
        bool crossPayable = payable_ > 0 && ctx.token != want;

        if (!crossWithheld && !crossPayable) return (withheld, payable_);

        // Three currencies in one origination. One mid cannot express it and a second
        // mid is not on offer, so this is a refusal rather than an approximation.
        if (crossWithheld && crossPayable && want != baseToken) revert FxMidRequired(want);

        address target = crossWithheld ? baseToken : want;

        if (address(fxGuard) == address(0)) revert FxGuardUnset();
        if (ctx.fxMid.fromToken != ctx.token || ctx.fxMid.toToken != target) {
            revert FxMidRequired(target);
        }

        uint256 amountIn = (crossWithheld ? withheld : 0) + (crossPayable ? payable_ : 0);

        IERC20(ctx.token).forceApprove(address(fxGuard), amountIn);
        uint256 out =
            fxGuard.settleGuarded(IFxVenue(fxVenue), ctx.fxMid, ctx.fxMidSignature, amountIn, address(this));
        // No standing claim on this contract's balance survives the crossing.
        IERC20(ctx.token).forceApprove(address(fxGuard), 0);

        if (crossWithheld && crossPayable) {
            uint256 outWithheld = (out * withheld) / amountIn;
            return (outWithheld, out - outWithheld);
        }
        if (crossWithheld) return (out, payable_);
        return (withheld, out);
    }

    function _register(Context memory ctx, bytes32 sessionId) private {
        sessionPlan[sessionId] = ctx.planId;

        poolOf[ctx.planId] = address(ctx.pool);
        receivable.mint(ctx.planId, address(ctx.pool), ctx.principal);

        // The corridor's own book records the origination, so a EURC plan consumes EURC
        // Tier-0 headroom and a dollar plan consumes the dollar book's. `principal` is
        // handed over unconverted on purpose: the underwriter that receives it is the one
        // whose bands, pool and exposure scalar are all in this plan's own currency.
        IUnderwritingPartnerV2 uw = ctx.cc.underwriter;
        bool seasoned = uw.isSeasoned(ctx.personId);
        uw.notePlan(ctx.personId, ctx.identity, ctx.planId, ctx.principal);
        uw.bindPlan(ctx.planId, ctx.plan, ctx.borrower);
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
    ///
    ///      **Every figure here is in `token`'s own currency, exactly as in
    ///      `_sizeCheck`,** and the corridor's registry and underwriter are what make
    ///      that true. An unconfigured corridor answers zero rather than reverting,
    ///      because this is a quote.
    ///
    ///      **Two known under-reports, both in the safe direction, both recorded rather
    ///      than smoothed over.** The corridor haircut is applied here as a *deflation*
    ///      of the answer — the largest `P` with `P·(1+h) ≤ limit` — because `_sizeCheck`
    ///      loads the principal rather than discounting the limit, and a quote that
    ///      returned the un-deflated figure would be contradicted by the chain at the
    ///      moment of signing, which CHKT-01 says is worth nothing. And `capFor` is
    ///      called in its **three-argument** form because this signature carries neither
    ///      a borrower wallet nor a prospective plan id, so a Tier-1 or Tier-2 borrower
    ///      is quoted their Tier-0 figure alone. Widening it reaches four TypeScript
    ///      packages that compile this selector into a literal ABI string; it is a
    ///      deliberate follow-on rather than something to smuggle in here.
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

        CorridorConfig memory cc = _corridors[token];
        if (cc.fxRouter == address(0)) return 0;

        uint256 limit = cc.underwriter.capFor(personId, identity, signerClass);

        uint256 ceiling = cc.parameters.get(ParameterKeys.LIMIT_HARD_CEILING);
        if (limit > ceiling) limit = ceiling;

        uint256 maxTicket = cc.parameters.get(ParameterKeys.MAX_TICKET);
        if (limit > maxTicket) limit = maxTicket;

        (uint256 merchantRoom, uint256 corridorRoom) = pool.concentrationHeadroom(merchant, corridorOf(token));
        if (limit > merchantRoom) limit = merchantRoom;
        if (limit > corridorRoom) limit = corridorRoom;

        uint256 velocityRoom = merchants.velocityCapFor(merchant);
        uint256 used = merchants.velocityUsed(merchant);
        velocityRoom = velocityRoom > used ? velocityRoom - used : 0;
        if (limit > velocityRoom) limit = velocityRoom;

        // The same loading as `_sizeCheck`, read from the other end: there it asks
        // whether `P·(1+h)` fits inside the room, so here the answer is the largest `P`
        // for which it does. The quote and the enforcement have to agree at the corridor
        // boundary or the corridor has a checkout that offers what the chain refuses.
        if (token != baseToken) {
            uint256 haircut = cc.parameters.get(ParameterKeys.FX_CORRIDOR_HAIRCUT_BPS);
            limit = (limit * PlanParams.BPS) / (PlanParams.BPS + haircut);
        }

        if (!pool.originationOpen() || !pauses.isOpen(corridorOf(token))) return 0;
        if (limit < cc.parameters.get(ParameterKeys.MIN_TICKET)) return 0;
        return limit;
    }

    /// @notice Whether a merchant could originate `principal` right now, with a
    ///         reason when they could not.
    /// @dev The quote surface's diagnostic. A checkout that can only report "no" has
    ///      to guess at the fix; one that can report "merchant velocity cap" tells the
    ///      merchant to try again in an hour and tells the borrower nothing about
    ///      themselves that is untrue.
    function merchantStanding(
        address merchant,
        uint256 principal
    ) external view returns (bool ok, string memory reason) {
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
