// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {OriginationFixture} from "./OriginationFixture.sol";

import {InstallmentPlan} from "../../src/InstallmentPlan.sol";
import {PlanFactory} from "../../src/PlanFactory.sol";
import {IdentityFXRouter} from "../../src/IdentityFXRouter.sol";
import {ParameterRegistry} from "../../src/ParameterRegistry.sol";
import {TranchedCreditPool} from "../../src/TranchedCreditPool.sol";
import {Tier0Underwriter} from "../../src/Tier0Underwriter.sol";
import {CheckoutRouter} from "../../src/CheckoutRouter.sol";
import {TieredUnderwriter} from "../../src/underwriting/TieredUnderwriter.sol";
import {IFxVenue} from "../../src/interfaces/IFxVenue.sol";
import {ICreditPool} from "../../src/interfaces/ICreditPool.sol";
import {IUnderwritingPartner} from "../../src/interfaces/IUnderwritingPartner.sol";
import {FxMidAttestation} from "../../src/libraries/FxMidAttestation.sol";
import {LimitAttestation} from "../../src/libraries/LimitAttestation.sol";
import {PlanId} from "../../src/libraries/PlanId.sol";
import {PlanParams} from "../../src/libraries/PlanParams.sol";
import {TermsDetail} from "../../src/libraries/TermsDetail.sol";
import {MockArcEurc} from "../mocks/MockArcEurc.sol";
import {MockArcStablecoin} from "../mocks/MockArcStablecoin.sol";

/// @notice The EURC corridor: a second book, a second credit stack, one changed
///         constructor argument, and a lender who is accredited explicitly.
///
/// @dev Extends the dollar fixture rather than duplicating it, so the USDC half is
///      inherited whole and a corridor test that breaks a dollar assertion breaks it
///      loudly.
///
///      **E-01, in one line of the deployment.** The corridor's FX router is another
///      instance of the *same contract* with `accountingToken` set to EURC. There is no
///      `EurcIdentityFXRouter.sol` and there should never be one: the invariant is
///      literally the same invariant — normalize is the identity or it reverts — and a
///      second file would be a second thing to audit that says the same thing. Every
///      figure inside a EURC plan is therefore EURC and self-consistent, and the
///      currency crossing relocates to the pool boundary where it can be priced.
///
///      **B-2a, in the rest of it.** The EURC corridor is a *whole parallel book*: its
///      own pool, its own `ParameterRegistry`, its own `Tier0Underwriter` and its own
///      `TieredUnderwriter`. `Tier0Underwriter.bookHeadroom()` divides by
///      `totalAssets()` on its single settable pool and `outstandingExposure` is one
///      scalar, so a EURC plan scored against the dollar instance would consume the
///      dollar book's headroom and be measured against dollar bands at 1:1. Each of
///      these is the *same bytecode* with different constructor arguments, exactly as
///      the second FX router is.
///
///      **The EURC parameter set is seeded at parity with the dollar set, and parity is
///      a launch hypothesis rather than a measurement.** The registry's compiled bands
///      are integers; deployed a second time they are simply read as euro. Nobody has
///      measured a European cohort's ticket distribution, delinquency curve or bond
///      requirement, and the honest position is that the numbers start where the dollar
///      numbers are and move through `set`/`narrowBand` on the standing cohort track
///      like every other Appendix A value.
///
///      **Two books means two gates.** `originationOpen()`, the reserve floor, the
///      subordination floor and the Tier-0 book share are all per pool, and every
///      `_emitGate` stream now has two sources. Anything downstream — the indexer, the
///      lender app — must key by pool address rather than assume there is one. That is
///      a note for plan 07-11 and it belongs where the second pool is created.
///
///      **Nothing here grants a convenience.** Every role granted below is one a real
///      deployment grants, and the EURC lender is accredited explicitly rather than
///      inheriting the dollar lender's standing — finding 16 is a book nobody on earth
///      may deposit into, discovered live, and two books mean two eligibility sets.
abstract contract CorridorFixture is OriginationFixture {
    MockArcEurc internal eurc;
    IdentityFXRouter internal eurcFxRouter;
    ParameterRegistry internal eurcParameters;
    TranchedCreditPool internal eurcPool;
    Tier0Underwriter internal eurcTier0;
    TieredUnderwriter internal eurcTiered;
    CorridorVenue internal corridorVenue;

    /// @notice The EURC book's own lender. Accredited here, by name.
    address internal eurcLender = address(0xEE11D);

    uint256 internal constant FX_SIGNER_KEY = 0xF5169E4;
    address internal fxSignerKey;

    /// @notice A second product line. POOL-01: a deployment plus a row.
    bytes32 internal constant PAY_IN_4_EURC = keccak256("plazo.line.payin4.eurc");

    /// @dev Deliberately **not** the dollar book's seeds. Two books with identical
    ///      capitalisation would make `bookHeadroom()` agree by coincidence, and a
    ///      coincidence is exactly what a test asserting the two books are separate
    ///      must not be able to mistake for the property.
    uint256 internal constant EURC_SENIOR_SEED = 40_000e6;
    uint256 internal constant EURC_JUNIOR_SEED = 10_000e6;

    /// @notice EUR→USD, 1e18-scaled. `toToken` per `fromToken`, as the mid defines it.
    uint256 internal constant EUR_USD_E18 = 1.08e18;

    // ─────────────────────────────────────────────────────────────────────────
    // Deployment
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The corridor's token is created here rather than below, because the venue
    ///      needs it and the venue is built inside the dollar fixture's own deployment.
    function _deployFxVenue() internal override returns (address) {
        eurc = new MockArcEurc();
        corridorVenue = new CorridorVenue();
        corridorVenue.setRate(address(eurc), address(usdc), EUR_USD_E18);
        corridorVenue.setRate(address(usdc), address(eurc), (1e18 * 1e18) / EUR_USD_E18);
        return address(corridorVenue);
    }

    function _deployStack() internal virtual override {
        super._deployStack();

        fxSignerKey = vm.addr(FX_SIGNER_KEY);
        fxGuard.grantRole(fxGuard.FX_SIGNER_ROLE(), fxSignerKey);

        eurcFxRouter = new IdentityFXRouter(address(eurc));

        eurcParameters = new ParameterRegistry(address(this));

        eurcPool = new TranchedCreditPool(
            TranchedCreditPool.Wiring({
                admin: address(this),
                token: address(eurc),
                parameters: address(eurcParameters),
                eligibility: address(eligibility),
                productLine: PAY_IN_4_EURC,
                minInstallments: 2,
                maxInstallments: 6,
                minInterval: 7 days,
                maxInterval: 31 days
            })
        );
        poolRegistry.register(PAY_IN_4_EURC, address(eurcPool));

        eurcTier0 = new Tier0Underwriter(address(this), address(eurcParameters), address(killSwitch));
        eurcTiered = new TieredUnderwriter(
            address(this),
            address(eurcTier0),
            address(pledges),
            address(sweeper),
            address(eurcParameters),
            address(partnerStub)
        );

        // Both rows, stated in one place. The dollar row restates what the router's
        // constructor already seeded; writing it out means a reader of this fixture sees
        // two complete books rather than one book and one implication.
        checkout.setCorridor(address(usdc), address(router), address(parameters), address(tiered));
        checkout.setCorridor(
            address(eurc), address(eurcFxRouter), address(eurcParameters), address(eurcTiered)
        );

        currencies.allowCurrency(address(usdc), true);
        currencies.allowCurrency(address(eurc), true);

        // The dollar side's grants, mirrored exactly. A fixture that granted one and
        // forgot the other would hide the gap plan 07-12 would otherwise find live.
        eurcPool.setOriginator(address(checkout));
        eurcTier0.grantRole(eurcTier0.ORIGINATOR_ROLE(), address(eurcTiered));
        eurcTiered.grantRole(eurcTiered.ORIGINATOR_ROLE(), address(checkout));
        pledges.grantRole(pledges.BINDER_ROLE(), address(eurcTiered));
        passport.grantRole(passport.WRITER_ROLE(), address(eurcTier0));
        passport.grantRole(passport.READER_ROLE(), address(eurcTier0));
        eurcTier0.setPool(address(eurcPool));
        eurcTier0.setPassport(address(passport));

        // Finding 16: the deployment accredits nobody, correctly. So the EURC book's own
        // lender is listed by name, and so is the book itself — the router mints its
        // receivable to this pool under the same default-deny transfer hook.
        eligibility.setGlobal(address(eurcPool), true);
        eligibility.setGlobal(eurcLender, true);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Capitalising the second book
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Everything a EURC origination needs, short of the plan itself.
    function _prepareCorridorOrigination() internal {
        _prepareOrigination();
        _seedEurcPool();
    }

    /// @dev The dollar fixture's three-step entry, on the second book. POOL-03 made
    ///      entry asynchronous and a second book does not get to shortcut it.
    function _seedEurcPool() internal {
        _seedEurcTranche(ICreditPool.Tranche.Senior);
        _seedEurcTranche(ICreditPool.Tranche.Junior);

        // Junior first: senior capacity is a function of the subordination beneath it.
        _requestEurcDeposit(ICreditPool.Tranche.Junior, EURC_JUNIOR_SEED);
        _requestEurcDeposit(ICreditPool.Tranche.Senior, EURC_SENIOR_SEED);

        if (vm.getBlockTimestamp() <= eurcPool.epochEndsAt()) {
            vm.warp(eurcPool.epochEndsAt() + 1);
        }
        eurcPool.markEpoch(64);
        eurcPool.closeEpoch();

        vm.prank(eurcLender);
        eurcPool.claimShares(ICreditPool.Tranche.Senior);
        vm.prank(eurcLender);
        eurcPool.claimShares(ICreditPool.Tranche.Junior);

        _fundEurcReserve((eurcPool.totalAssets() * 600) / PlanParams.BPS);
    }

    function _seedEurcTranche(ICreditPool.Tranche tranche) internal {
        eurc.mint(address(this), TRANCHE_SEED);
        eurc.approve(address(eurcPool), TRANCHE_SEED);
        eurcPool.seed(tranche, TRANCHE_SEED);
    }

    function _requestEurcDeposit(ICreditPool.Tranche tranche, uint256 amount) internal {
        eurc.mint(eurcLender, amount);
        vm.startPrank(eurcLender);
        eurc.approve(address(eurcPool), amount);
        eurcPool.requestDeposit(tranche, amount);
        vm.stopPrank();
    }

    function _fundEurcReserve(uint256 amount) internal {
        eurc.mint(address(this), amount);
        eurc.approve(address(eurcPool), amount);
        eurcPool.fundReserve(amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // A EURC plan, through the router
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice MERCH-07's setter, as a merchant would call it.
    /// @dev Pranked on the merchant, because there is no merchant argument to pass.
    function _setMerchantPayoutCurrency(address who, address currency) internal {
        vm.prank(who);
        currencies.setPayoutCurrency(currency);
    }

    function _eurcDetail() internal view returns (TermsDetail.Detail memory) {
        return TermsDetail.Detail({
            jurisdiction: jurisdictions.DEFAULT_JURISDICTION(),
            lineItemsHash: keccak256("one pair of boots, priced in euro"),
            mdrBps: 400,
            lateFeeFlat: PlanParams.LATE_FEE_FLAT,
            signerClass: signerClass,
            settlementRecipient: address(eurcPool),
            fxRouter: address(eurcFxRouter)
        });
    }

    function _eurcTerms(
        uint256 principal,
        uint256 count,
        uint256 nonce
    ) internal view returns (PlanId.PlanTerms memory) {
        return PlanId.PlanTerms({
            chainId: block.chainid,
            factory: address(factory),
            implementation: implementation,
            borrower: borrower,
            merchant: merchant,
            token: address(eurc),
            principal: principal,
            installmentCount: count,
            firstDueDate: vm.getBlockTimestamp(),
            interval: INTERVAL,
            originationNonce: nonce,
            termsHash: TermsDetail.hash(_eurcDetail())
        });
    }

    /// @dev The strip is signed against **EURC's** domain separator, not the dollar
    ///      token's. That is the whole reason a corridor needs its own signer: the two
    ///      separators differ by `name` and `verifyingContract`, so a strip signed
    ///      against one can never validate against the other (07-01, finding 31).
    function _eurcStrip(
        PlanId.PlanTerms memory terms,
        bytes32 id,
        address payee
    ) internal view returns (bytes[] memory strip) {
        strip = new bytes[](terms.installmentCount);
        for (uint256 i = 0; i < terms.installmentCount; ++i) {
            uint256 due = _dueDate(id, terms.firstDueDate, terms.interval, i);
            bytes32 structHash = keccak256(
                abi.encode(
                    eurc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                    terms.borrower,
                    payee,
                    _amountAt(terms.principal, terms.installmentCount, i),
                    due - 1,
                    due + PlanParams.AUTHORIZATION_WINDOW,
                    PlanId.checkNonce(id, i)
                )
            );
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", eurc.DOMAIN_SEPARATOR(), structHash));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerKey, digest);
            strip[i] = abi.encodePacked(r, s, v);
        }
    }

    function _eurcRequest(
        PlanId.PlanTerms memory terms
    ) internal view returns (PlanFactory.OriginationRequest memory) {
        bytes32 id = PlanId.derive(terms);
        address predicted = factory.predictAddress(id);
        return PlanFactory.OriginationRequest({
            terms: terms,
            detail: _eurcDetail(),
            acceptance: _acceptance(terms, id),
            acceptanceSignature: _signAcceptance(_acceptance(terms, id), predicted),
            strip: _eurcStrip(terms, id, predicted)
        });
    }

    /// @notice The mid a EURC origination carries. EUR→USD, per `_prepare`'s rule.
    function _eurcMid(bytes32 sessionId) internal view returns (FxMidAttestation.Mid memory) {
        return _midFor(address(eurc), address(usdc), EUR_USD_E18, sessionId);
    }

    function _midFor(
        address from,
        address to,
        uint256 midE18,
        bytes32 sessionId
    ) internal view returns (FxMidAttestation.Mid memory) {
        return FxMidAttestation.Mid({
            corridor: checkout.corridorOf(from),
            fromToken: from,
            toToken: to,
            midE18: midE18,
            validUntil: vm.getBlockTimestamp() + 2 minutes,
            sessionId: sessionId
        });
    }

    function _signMid(FxMidAttestation.Mid memory mid) internal view returns (bytes memory) {
        bytes32 digest = FxMidAttestation.digest(mid, block.chainid, address(fxGuard));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(FX_SIGNER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _eurcOriginationInput(
        PlanId.PlanTerms memory terms,
        bytes32 sessionId,
        uint256 limit,
        FxMidAttestation.Mid memory mid
    ) internal view returns (CheckoutRouter.OriginationInput memory) {
        bytes32 id = PlanId.derive(terms);
        LimitAttestation.Attestation memory a = LimitAttestation.Attestation({
            sessionId: sessionId,
            planId: id,
            borrower: borrower,
            personId: eurcTier0.pseudonymousId(borrower),
            identityClass: uint8(IUnderwritingPartner.IdentityClass.Pseudonymous),
            limit: limit,
            validUntil: vm.getBlockTimestamp() + 5 minutes
        });
        return CheckoutRouter.OriginationInput({
            request: _eurcRequest(terms),
            attestation: a,
            attestationSignature: _signAttestation(a, UNDERWRITER_KEY),
            fxMid: mid,
            fxMidSignature: _signMid(mid)
        });
    }

    /// @notice Originate a EURC plan through the router, as a corridor checkout would.
    function _originateEurcPlan(
        uint256 principal,
        uint256 nonce,
        bytes32 sessionId,
        uint256 limit
    ) internal returns (InstallmentPlan) {
        PlanId.PlanTerms memory terms = _eurcTerms(principal, COUNT, nonce);
        planId = PlanId.derive(terms);
        firstDue = terms.firstDueDate;

        (, address deployed) =
            checkout.originate(_eurcOriginationInput(terms, sessionId, limit, _eurcMid(sessionId)));

        plan = InstallmentPlan(deployed);
        return plan;
    }
}

/// @notice A venue that fills at a rate the fixture sets, in either direction.
///
/// @dev **A double, and a necessary one.** No AMM with USDC/EURC liquidity exists on Arc
///      testnet — plan 07-01 probed seven candidates and none holds bytecode (finding 34)
///      — so a currency crossing is not observable on chain at all and every corridor
///      assertion has to run against something local. `FxDeviationGuard` is already
///      proven against a double that fills *badly* (07-03); this one fills exactly at the
///      rate it was given, so a corridor test's arithmetic is about the router rather
///      than about the guard's tolerance.
///
///      It **mints** rather than holding inventory. Pre-funding two books in two
///      currencies would make every corridor test carry a venue balance sheet for a
///      mechanism whose correctness is about the guard's floor and the router's split,
///      not about who was long what. The rate is settable per ordered pair precisely so
///      the reciprocal direction is a separate statement — a venue that derived one from
///      the other would hide the exact error `MidPairMismatch` exists to catch.
contract CorridorVenue is IFxVenue {
    mapping(address from => mapping(address to => uint256)) public rateE18;

    function setRate(address from, address to, uint256 rate) external {
        rateE18[from][to] = rate;
    }

    function supportsPair(address fromToken, address toToken) external view returns (bool) {
        return rateE18[fromToken][toToken] != 0;
    }

    function quote(address fromToken, address toToken, uint256 amountIn) public view returns (uint256) {
        return (amountIn * rateE18[fromToken][toToken]) / 1e18;
    }

    function settle(
        address fromToken,
        address toToken,
        uint256 amountIn,
        uint256,
        address recipient
    ) external returns (uint256 amountOut) {
        MockArcStablecoin(fromToken).transferFrom(msg.sender, address(this), amountIn);
        amountOut = quote(fromToken, toToken, amountIn);
        MockArcStablecoin(toToken).mint(recipient, amountOut);
    }
}
