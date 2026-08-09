// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {ParameterRegistry} from "../src/ParameterRegistry.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {IdentityFXRouter} from "../src/IdentityFXRouter.sol";
import {ReceivableToken} from "../src/ReceivableToken.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {MerchantCurrencyRegistry} from "../src/MerchantCurrencyRegistry.sol";
import {PoolRegistry} from "../src/PoolRegistry.sol";
import {TranchedCreditPool} from "../src/TranchedCreditPool.sol";
import {PlazoPassport} from "../src/PlazoPassport.sol";
import {FirstPaymentDefaultSwitch} from "../src/FirstPaymentDefaultSwitch.sol";
import {Tier0Underwriter} from "../src/Tier0Underwriter.sol";
import {PlanFactory} from "../src/PlanFactory.sol";
import {PayoutRouter} from "../src/PayoutRouter.sol";
import {RefundEscrow} from "../src/RefundEscrow.sol";
import {SettlementEscrow} from "../src/SettlementEscrow.sol";
import {CheckoutRouter} from "../src/CheckoutRouter.sol";
import {FxDeviationGuard} from "../src/fx/FxDeviationGuard.sol";
import {AmmVenue} from "../src/fx/AmmVenue.sol";
import {StableFxVenueStub} from "../src/fx/StableFxVenueStub.sol";
import {PledgeVault} from "../src/underwriting/PledgeVault.sol";
import {PayrollSweeper} from "../src/underwriting/PayrollSweeper.sol";
import {PartnerUnderwriterStub} from "../src/underwriting/PartnerUnderwriterStub.sol";
import {TieredUnderwriter} from "../src/underwriting/TieredUnderwriter.sol";

/// @title DeployCorridor
/// @notice Phase 7's broadcast: the EURC corridor, the tier ladder, and the rewire that
///         puts both books behind one router.
///
/// @dev **This script moves no tokens, and cannot.** Arc USDC's movement runs through a
///      native precompile whose on-chain code Foundry cannot execute, and `forge script`
///      executes its body locally to collect the transactions it will broadcast — so any
///      script touching USDC reverts before it can broadcast, whatever `--skip-simulation`
///      says (finding 10). Contract creation and role grants move nothing, so they work
///      here. Capitalising the EURC book, accrediting its lender, bonding a merchant and
///      originating a plan all move value and therefore run from `packages/arc-verify`
///      through viem. There is no `transfer`, no `deposit` and no `seed` below, and a grep
///      gate in `07-12-PLAN.md` asserts it.
///
///      The deployment record is written by `tools/record-deployment.mjs` from the
///      broadcast receipts, never inline — a script that writes its own record writes it
///      during the *local* execution, so a run that fails at the send step still produces
///      a file naming addresses that hold no code (finding 12).
///
/// @dev **B-2a: the corridor is a whole parallel book, not a second token on one book.**
///      `Tier0Underwriter.bookHeadroom()` divides by `totalAssets()` on its single
///      settable pool and `outstandingExposure` is one scalar, so a EURC plan scored
///      against the dollar instance would consume the dollar book's headroom *and* be
///      measured against dollar bands at 1:1. Two currencies are two balance sheets
///      (DEC-21), and that means two of every contract that holds one: two
///      `ParameterRegistry` instances, two `Tier0Underwriter`s, two `TieredUnderwriter`s,
///      two pools, two `IdentityFXRouter`s. Each is the *same bytecode* with different
///      constructor arguments — there is no `EurcIdentityFXRouter.sol` and there must
///      never be one (E-01).
///
/// @dev **Two new `ParameterRegistry` instances, and neither existing one is touched
///      (DEC-72, finding 29).** `_define` is private and constructor-only, nine contracts
///      hold the registry `immutable` with no setter, and `get()` reverts
///      `ParameterUndefined` on a key nobody set — so a row added to the library after a
///      deployment can never reach that deployment. Phase 7 adds fifteen rows, and
///      measured on chain 5042002 the live registry `0x753e08a6…` answers `isDefined`
///      **false** for `plazo.tier2.pledgeHaircutBps` and `plazo.fx.parBandBps`. Pointing
///      the composite, the guard or the corridor at either deployed instance would turn
///      every origination into a revert rather than into a smaller limit.
///
///      **Nothing deployed is repointed at these.** The live registry keeps every
///      merchant row and every pool row, `MerchantRegistry` holds it `immutable` and
///      keeps reading it, and the two escrows keep `escrowParameterRegistry`. Only the
///      contracts deployed alongside these instances read them.
///
///      **The second-order hazard, stated because four registries now answer the same
///      key.** They can answer it differently, and two of them answer in a different
///      currency. Measured before this deployment: the live registry carries
///      `plazo.tier0.bookShareBps = 2500` and `plazo.merchant.bondFloor = 0` where the
///      compiled defaults are 1000 and 250 USDC — governed values that a fresh instance
///      does not inherit, because a constructor seeds from constants. So the EURC book's
///      Tier-0 book share starts at 1000 bp while the dollar book's is 2500 bp. Any
///      reconciliation between these registries must say **which instance it read and in
///      which currency**, and `record-deployment.mjs` writes the currency beside each
///      address for exactly that reason.
///
/// @dev **The EURC parameter set's parity with the USD set is a launch hypothesis, not a
///      measurement (DEC-90).** The fourth instance is the same bytecode with the same
///      seeded integers, read as euro because the only book that reads it is the EURC
///      book. Nobody has measured that a 75-euro floor is the right floor, or that a
///      European cohort's delinquency curve matches a dollar one. Those figures
///      recalibrate through `set` and `narrowBand` inside their compiled bands on the
///      standing cohort track, exactly like every other Appendix A value. A deployment
///      that presented parity as measured would be the same class of defect as a
///      fabricated FX rate.
///
/// @dev **Nothing is revoked from the old router (D-24), and nothing here revokes
///      anything at all.** `recognise` is permissionless and `poolOf[planId]` for every
///      plan the 06-13 router originated lives on that address. `_report` prints both
///      books' open-plan counts before the broadcast so the operator sees what they are
///      keeping alive rather than assuming it is zero — 06-13 checked rather than
///      assumed and read zero, and the check is the point rather than the number.
///
/// @dev **Three things the live chain turned out to require that the plan's rewire list
///      does not name. Each was read off the chain before this file was written
///      (finding 30, DEC-73); each is forced, and none is a preference.**
///
///      **1. `PlanFactory.setOriginator` must move too.** `PlanFactory.originate` refuses
///      any caller that is not `originator`, and the live factory names the 06-13 router
///      `0x19Ca030e…`. A rewire that moved the pool's originator and not the factory's
///      would deploy a router that passes every gate and reverts at plan creation. It is
///      rotatable — that is what DEC-15 bought — so this is one call rather than a new
///      vintage. The consequence for the acceptance gate is stated plainly: `setOriginator`
///      appears **three** times below, not two, and the third one is the factory.
///
///      **2. `SettlementEscrow` is redeployed, because its router is one-way.**
///      `setRouter` reverts `RouterAlreadySet` once set, deliberately: a rotatable router
///      on a contract holding merchant money would be an admin key that can redirect
///      where a settlement is pulled from. The live escrow `0x37246b3c…` already names
///      the 06-13 router — read from the chain, not inferred — so a new `CheckoutRouter`
///      pointed at it would revert `OnlyRouter` on every escrowed origination. And
///      `SettlementCategory.Escrowed` is ordinal zero, so *every* unseasoned merchant
///      escrows. The new escrow reuses `escrowParameterRegistry`, which already defines
///      the three escrow rows and carries whatever governance has set on them.
///
///      **3. `RefundEscrow` is redeployed, because it takes the router as a constructor
///      argument.** It wraps `creditRefund`, which it structurally cannot call, and reads
///      `poolOf` to find the book a plan settled to. It comes last for that reason, and
///      `MerchantRegistry.SLASHER_ROLE` moves to it — D-03, the one role a throwaway
///      probe in plan 06-08 proved genuinely dangerous in an EOA's hands.
///
/// @dev **Running it.** Every existing address is read from the environment rather than
///      redeployed, and the values come out of `contracts/deployments/5042002.json` — the
///      record is the source, so nothing is retyped. Documented here rather than in
///      `.env.example`, which scopes itself to the operator database and says why
///      (DEC-55): a variable listed twice is one list eventually getting it wrong.
///
///          eval "$(node -e '
///            const d = require("./contracts/deployments/5042002.json");
///            const m = {
///              PLAZO_ELIGIBILITY_REGISTRY: "eligibilityRegistry",
///              PLAZO_PARAMETER_REGISTRY: "parameterRegistry",
///              PLAZO_ESCROW_PARAMETER_REGISTRY: "escrowParameterRegistry",
///              PLAZO_COMPLIANCE: "compliance",
///              PLAZO_FX_ROUTER: "fxRouter",
///              PLAZO_RECEIVABLE: "receivable",
///              PLAZO_MERCHANT_REGISTRY: "merchantRegistry",
///              PLAZO_POOL_REGISTRY: "poolRegistry",
///              PLAZO_CREDIT_POOL: "creditPool",
///              PLAZO_PASSPORT: "passport",
///              PLAZO_KILL_SWITCH: "killSwitch",
///              PLAZO_TIER0: "tier0",
///              PLAZO_PAUSES: "pauses",
///              PLAZO_PLAN_FACTORY: "planFactory",
///              PLAZO_PAYOUT_ROUTER: "payoutRouter",
///              PLAZO_CHECKOUT_ROUTER: "checkoutRouter",
///            };
///            for (const [k, v] of Object.entries(m)) console.log(`export ${k}=${d[v]}`);
///          ')"
///          forge script script/DeployCorridor.s.sol --root contracts --rpc-url arc_testnet --slow --broadcast
///          node tools/record-deployment.mjs 5042002
///
///      A bare local run — no `--rpc-url` — cannot work for this script or for
///      `Rewire.s.sol`: both read live contracts, and on an empty local EVM the first
///      `openPlans()` reverts `call to non-contract address`. The finding-10 gate is the
///      **simulation** against a fork with `--rpc-url` and no `--broadcast`, which is
///      what proves nothing in the body touches the USDC precompile.
contract DeployCorridor is Script {
    /// @dev The check rail and the base corridor's currency.
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    /// @dev EURC on Arc testnet. Full EIP-3009, canonical typehashes, `version() == "2"`,
    ///      `decimals() == 6` — all four read off the bytecode in plan 07-01 (finding 31).
    address internal constant ARC_EURC = 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a;

    /// @dev USYC, the pledge asset. **No EIP-3009** (finding 32), which is why
    ///      `PledgeVault` moves by `approve`/`transferFrom` and has no signature path.
    address internal constant ARC_USYC = 0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C;

    /// @notice A second product line. POOL-01: a deployment plus a row.
    bytes32 internal constant PAY_IN_4_EURC = keccak256("plazo.line.payin4.eurc");

    /// @dev The Pay-in-4 tenor band, identical to the dollar book's (DEC-26). A second
    ///      currency is a second balance sheet, not a second product.
    uint256 internal constant MIN_INSTALLMENTS = 2;
    uint256 internal constant MAX_INSTALLMENTS = 6;
    uint256 internal constant MIN_INTERVAL = 7 days;
    uint256 internal constant MAX_INTERVAL = 31 days;

    /// @dev What stays where it is.
    struct Existing {
        EligibilityRegistry eligibility;
        ParameterRegistry parameters;
        ParameterRegistry escrowParameters;
        address compliance;
        address fxRouter;
        ReceivableToken receivable;
        MerchantRegistry merchants;
        PoolRegistry pools;
        TranchedCreditPool pool;
        PlazoPassport passport;
        FirstPaymentDefaultSwitch killSwitch;
        Tier0Underwriter tier0;
        address pauses;
        PlanFactory factory;
        PayoutRouter payout;
        address oldRouter;
    }

    /// @dev What this script puts on chain. Eighteen creations, two of them nested
    ///      inside `TranchedCreditPool`'s constructor.
    struct Stack {
        ParameterRegistry fxParameters;
        ParameterRegistry eurcParameters;
        IdentityFXRouter eurcFxRouter;
        TranchedCreditPool eurcPool;
        FxDeviationGuard fxGuard;
        AmmVenue ammVenue;
        StableFxVenueStub stableFxStub;
        PledgeVault pledges;
        PayrollSweeper sweeper;
        PartnerUnderwriterStub partnerStub;
        TieredUnderwriter tiered;
        Tier0Underwriter eurcTier0;
        TieredUnderwriter eurcTiered;
        MerchantCurrencyRegistry currencies;
        SettlementEscrow settlementEscrow;
        CheckoutRouter router;
        RefundEscrow refundEscrow;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address usdc = vm.envOr("PLAZO_TOKEN", ARC_USDC);
        address eurc = vm.envOr("PLAZO_EURC", ARC_EURC);
        address usyc = vm.envOr("PLAZO_PLEDGE_ASSET", ARC_USYC);

        // Finding 34 decides this rather than an assumption: plan 07-01 probed seven AMM
        // candidates on Arc testnet and **none holds bytecode**, so the recorded answer is
        // the zero address and `AmmVenue` refuses every fill. The variable exists so a
        // venue appearing is a deployment argument rather than a code change; leaving it
        // unset is the shipped, tested configuration (DEC-93), not a placeholder.
        address ammRouter = vm.envOr("PLAZO_AMM_ROUTER", address(0));

        // The key `services/fx` signs mids with (DEC-94). One new role in the Phase 9
        // graph and no second pauser: the breaker reuses `OriginationPause.PAUSER_ROLE`,
        // which the deployer already holds on chain 5042002.
        address midSigner = vm.envOr("PLAZO_FX_MID_SIGNER", deployer);

        Existing memory e = _existing();

        // Read before the broadcast, so the number in the report is the state the operator
        // is deciding against rather than the state the deploy left (D-24).
        uint256 openPlans = e.pool.openPlans();

        vm.startBroadcast(deployerKey);

        Stack memory s = _deploy(e, deployer, usdc, eurc, usyc, ammRouter);
        _wire(e, s, deployer, usdc, eurc, midSigner);

        vm.stopBroadcast();

        _report(e, s, deployer, usdc, eurc, usyc, ammRouter, midSigner, openPlans);
    }

    /// @dev Addresses, not deployments. Nothing here is constructed.
    function _existing() private view returns (Existing memory e) {
        e.eligibility = EligibilityRegistry(vm.envAddress("PLAZO_ELIGIBILITY_REGISTRY"));
        e.parameters = ParameterRegistry(vm.envAddress("PLAZO_PARAMETER_REGISTRY"));
        e.escrowParameters = ParameterRegistry(vm.envAddress("PLAZO_ESCROW_PARAMETER_REGISTRY"));
        e.compliance = vm.envAddress("PLAZO_COMPLIANCE");
        e.fxRouter = vm.envAddress("PLAZO_FX_ROUTER");
        e.receivable = ReceivableToken(vm.envAddress("PLAZO_RECEIVABLE"));
        e.merchants = MerchantRegistry(vm.envAddress("PLAZO_MERCHANT_REGISTRY"));
        e.pools = PoolRegistry(vm.envAddress("PLAZO_POOL_REGISTRY"));
        e.pool = TranchedCreditPool(vm.envAddress("PLAZO_CREDIT_POOL"));
        e.passport = PlazoPassport(vm.envAddress("PLAZO_PASSPORT"));
        e.killSwitch = FirstPaymentDefaultSwitch(vm.envAddress("PLAZO_KILL_SWITCH"));
        e.tier0 = Tier0Underwriter(vm.envAddress("PLAZO_TIER0"));
        e.pauses = vm.envAddress("PLAZO_PAUSES");
        e.factory = PlanFactory(vm.envAddress("PLAZO_PLAN_FACTORY"));
        e.payout = PayoutRouter(vm.envAddress("PLAZO_PAYOUT_ROUTER"));
        e.oldRouter = vm.envAddress("PLAZO_CHECKOUT_ROUTER");
    }

    function _deploy(
        Existing memory e,
        address deployer,
        address usdc,
        address eurc,
        address usyc,
        address ammRouter
    ) private returns (Stack memory s) {
        // The third instance. Read by the dollar corridor's money rows, by the composite,
        // by the guard and by the vault — and by nothing already deployed.
        s.fxParameters = new ParameterRegistry(deployer);

        // The fourth. Same bytecode, same seeds, read as euro (DEC-90).
        s.eurcParameters = new ParameterRegistry(deployer);

        // E-01, in one constructor argument. The corridor's FX router is another instance
        // of the same contract with `accountingToken` set to EURC; the invariant is
        // literally the same invariant — normalize is the identity or it reverts.
        s.eurcFxRouter = new IdentityFXRouter(eurc);

        s.eurcPool = new TranchedCreditPool(
            TranchedCreditPool.Wiring({
                admin: deployer,
                token: eurc,
                parameters: address(s.eurcParameters),
                eligibility: address(e.eligibility),
                productLine: PAY_IN_4_EURC,
                minInstallments: MIN_INSTALLMENTS,
                maxInstallments: MAX_INSTALLMENTS,
                minInterval: MIN_INTERVAL,
                maxInterval: MAX_INTERVAL
            })
        );

        s.fxGuard = new FxDeviationGuard(deployer, address(s.fxParameters));
        s.ammVenue = new AmmVenue(ammRouter, usdc, eurc);
        s.stableFxStub = new StableFxVenueStub();

        // E-07: the pledge asset is USYC, which has no EIP-3009. The third argument must
        // be an instance carrying `TIER2_PLEDGE_HAIRCUT_BPS`, which neither deployed
        // registry does.
        s.pledges = new PledgeVault(deployer, usyc, address(s.fxParameters));

        // DEC-100: one factory is one vintage, and `sweep` binds its caller-supplied plan
        // to `factory.predictAddress(planId)` before any value moves. The record must
        // therefore pair `payrollSweeper` with the factory it serves.
        s.sweeper = new PayrollSweeper(address(e.factory));
        s.partnerStub = new PartnerUnderwriterStub();

        s.tiered = new TieredUnderwriter(
            deployer,
            address(e.tier0),
            address(s.pledges),
            address(s.sweeper),
            address(s.fxParameters),
            address(s.partnerStub)
        );

        // B-2a. The dollar book's `Tier0Underwriter` is already deployed and is reused,
        // which is why exactly one is constructed here and two composites are.
        s.eurcTier0 = new Tier0Underwriter(deployer, address(s.eurcParameters), address(e.killSwitch));
        s.eurcTiered = new TieredUnderwriter(
            deployer,
            address(s.eurcTier0),
            address(s.pledges),
            address(s.sweeper),
            address(s.eurcParameters),
            address(s.partnerStub)
        );

        // MERCH-07's currency half, as a side-car precisely so `MerchantRegistry` does not
        // have to be superseded a third time to carry one preference field. 06-13
        // superseded it once and stranded 46 USDC of merchant bond doing it.
        s.currencies = new MerchantCurrencyRegistry(deployer);

        // Forced deployment 2 in the header: the live escrow's router is one-way and
        // already spent.
        s.settlementEscrow = new SettlementEscrow(
            deployer, address(e.merchants), address(e.payout), address(e.escrowParameters)
        );

        s.router = new CheckoutRouter(
            deployer,
            CheckoutRouter.Wiring({
                factory: address(e.factory),
                pools: address(e.pools),
                passport: address(e.passport),
                merchants: address(e.merchants),
                currencies: address(s.currencies),
                receivable: address(e.receivable),
                underwriter: address(s.tiered),
                killSwitch: address(e.killSwitch),
                pauses: e.pauses,
                // The base corridor's **money** rows and every **time** row. It must be an
                // instance carrying `FX_CORRIDOR_HAIRCUT_BPS` and `FX_MID_MAX_TTL`, so it
                // is the third instance rather than the live registry — the constructor
                // seeds the USDC corridor from these four fields and `_sizeCheck` reads
                // `MIN_TICKET`, `MAX_TICKET` and `LIMIT_HARD_CEILING` off it.
                parameters: address(s.fxParameters),
                compliance: e.compliance,
                payout: address(e.payout),
                settlementEscrow: address(s.settlementEscrow),
                fxGuard: address(s.fxGuard),
                fxVenue: address(s.ammVenue),
                fxRouter: e.fxRouter,
                baseToken: usdc
            })
        );

        // Last, because it takes the router. Forced deployment 3 in the header.
        s.refundEscrow = new RefundEscrow(
            deployer,
            usdc,
            address(s.router),
            address(e.merchants),
            address(e.escrowParameters),
            address(s.settlementEscrow)
        );
    }

    /// @dev Every line below is a claim that some contract needs a capability, and GOV-02's
    ///      Phase 9 audit reads this function. The list being explicit — rather than a loop
    ///      over a table — is what makes it auditable.
    function _wire(
        Existing memory e,
        Stack memory s,
        address deployer,
        address usdc,
        address eurc,
        address midSigner
    ) private {
        // DEC-42's one-way handshake, on the new escrow. Unset, it accepts no `hold` at
        // all and every escrowed origination reverts `OnlyRouter`.
        s.settlementEscrow.setRouter(address(s.router));

        // POOL-01: a second product line is a deployment plus a row. One-way.
        e.pools.register(PAY_IN_4_EURC, address(s.eurcPool));

        // The three originator moves. Rotatable, which is what DEC-15 bought: under the
        // old one-shot form the factory line alone would have forced a new factory and
        // moved every plan id.
        e.factory.setOriginator(address(s.router));
        e.pool.setOriginator(address(s.router));
        s.eurcPool.setOriginator(address(s.router));

        // The dollar ladder. Two grants where there used to be one, and both are
        // load-bearing: granting either alone is an origination that passes every gate
        // and reverts on the last write.
        e.tier0.grantRole(e.tier0.ORIGINATOR_ROLE(), address(s.tiered));
        s.tiered.grantRole(s.tiered.ORIGINATOR_ROLE(), address(s.router));

        // The EURC mirror. Granting one book's and forgetting the other's is the
        // deployment gap `CorridorFixture` exists to surface in test rather than here.
        s.eurcTier0.setPool(address(s.eurcPool));
        s.eurcTier0.setPassport(address(e.passport));
        s.eurcTier0.grantRole(s.eurcTier0.ORIGINATOR_ROLE(), address(s.eurcTiered));
        s.eurcTiered.grantRole(s.eurcTiered.ORIGINATOR_ROLE(), address(s.router));

        // `Tier0Underwriter` reads and writes the Passport for its own counters. The
        // dollar instance already holds both on chain; the EURC instance is new and
        // holds neither.
        e.passport.grantRole(e.passport.WRITER_ROLE(), address(s.eurcTier0));
        e.passport.grantRole(e.passport.READER_ROLE(), address(s.eurcTier0));

        // Both composites bind pledges (DEC-108), so both need the role. One vault serves
        // both books because a pledge is dollar collateral and `limitFor` is gross
        // capacity — the netting is `bindPlan` refusing above `freeOf` (DEC-96).
        s.pledges.grantRole(s.pledges.BINDER_ROLE(), address(s.tiered));
        s.pledges.grantRole(s.pledges.BINDER_ROLE(), address(s.eurcTiered));

        // The four grants a new router needs from contracts it does not own.
        e.receivable.grantRole(e.receivable.ISSUER_ROLE(), address(s.router));
        e.merchants.grantRole(e.merchants.BOOKKEEPER_ROLE(), address(s.router));
        e.killSwitch.grantRole(e.killSwitch.REGISTRAR_ROLE(), address(s.router));
        e.passport.grantRole(e.passport.READER_ROLE(), address(s.router));

        // **The whole corridor in one call each, because `CorridorIncomplete` refuses a
        // half-configured one.** A corridor with a router but no parameter set would
        // silently fall back to another currency's bands, which is the exact money bug
        // the two-registry design closes. The dollar row restates what the router's
        // constructor already seeded, so a reader of this function sees two complete
        // books rather than one book and one implication.
        s.router.setCorridor(usdc, e.fxRouter, address(s.fxParameters), address(s.tiered));
        s.router.setCorridor(eurc, address(s.eurcFxRouter), address(s.eurcParameters), address(s.eurcTiered));

        // MERCH-07's allowlist. DEC-118: `payoutCurrencyOf` re-reads it, so withdrawing an
        // allowance returns a merchant to the plan's own currency rather than reverting
        // their checkout.
        s.currencies.allowCurrency(usdc, true);
        s.currencies.allowCurrency(eurc, true);

        // FX-05's one new role in the Phase 9 governance graph (DEC-94).
        s.fxGuard.grantRole(s.fxGuard.FX_SIGNER_ROLE(), midSigner);

        // The operator's underwriting key attests. Rotatable without a redeployment.
        s.router.grantRole(s.router.UNDERWRITER_ROLE(), deployer);

        // D-03, and the only address that ever holds it. A throwaway probe in plan 06-08
        // confirmed an EOA holding this took a merchant's entire bond in one transaction,
        // with no dispute and no delay.
        e.merchants.grantRole(e.merchants.SLASHER_ROLE(), address(s.refundEscrow));

        // Class B (DEC-46). `OperatorFreeFixture` grants and then revokes this, so a
        // deployment that never granted it would prove GOV-08 against a gate that was
        // never armed.
        s.refundEscrow.grantRole(s.refundEscrow.ARBITER_ROLE(), deployer);

        // Finding 16, exactly, and twice. Without these the router mints a receivable to
        // a pool whose default-deny transfer hook refuses it — an origination that passes
        // every gate and then fails on the last transfer, with an error naming the token
        // rather than the missing grant. The EURC *lender* is deliberately not accredited
        // here: two books mean two eligibility sets, and accrediting a lender is a
        // decision about a person rather than a step in a deployment.
        e.eligibility.setGlobal(address(s.router), true);
        e.eligibility.setGlobal(address(s.eurcPool), true);
    }

    function _report(
        Existing memory e,
        Stack memory s,
        address deployer,
        address usdc,
        address eurc,
        address usyc,
        address ammRouter,
        address midSigner,
        uint256 openPlans
    ) private view {
        console.log("deployer               ", deployer);
        console.log("USDC                   ", usdc);
        console.log("EURC                   ", eurc);
        console.log("USYC (pledge asset)    ", usyc);
        console.log("AMM router (finding 34)", ammRouter);
        console.log("FX mid signer          ", midSigner);
        console.log("");
        console.log("-- deployed --");
        console.log("ParameterRegistry(USD) ", address(s.fxParameters));
        console.log("ParameterRegistry(EUR) ", address(s.eurcParameters));
        console.log("IdentityFXRouter(EURC) ", address(s.eurcFxRouter));
        console.log("TranchedCreditPool(EUR)", address(s.eurcPool));
        console.log("  seniorShares         ", address(s.eurcPool.seniorShares()));
        console.log("  juniorShares         ", address(s.eurcPool.juniorShares()));
        console.log("FxDeviationGuard       ", address(s.fxGuard));
        console.log("AmmVenue               ", address(s.ammVenue));
        console.log("StableFxVenueStub      ", address(s.stableFxStub));
        console.log("PledgeVault            ", address(s.pledges));
        console.log("PayrollSweeper         ", address(s.sweeper));
        console.log("PartnerUnderwriterStub ", address(s.partnerStub));
        console.log("TieredUnderwriter(USD) ", address(s.tiered));
        console.log("Tier0Underwriter(EUR)  ", address(s.eurcTier0));
        console.log("TieredUnderwriter(EUR) ", address(s.eurcTiered));
        console.log("MerchantCurrencyReg    ", address(s.currencies));
        console.log("SettlementEscrow       ", address(s.settlementEscrow));
        console.log("CheckoutRouter         ", address(s.router));
        console.log("RefundEscrow           ", address(s.refundEscrow));
        console.log("");
        console.log("-- kept --");
        console.log("ParameterRegistry(live)", address(e.parameters));
        console.log("ParameterRegistry(esc) ", address(e.escrowParameters));
        console.log("EligibilityRegistry    ", address(e.eligibility));
        console.log("MerchantRegistry       ", address(e.merchants));
        console.log("TranchedCreditPool(USD)", address(e.pool));
        console.log("PlanFactory            ", address(e.factory));
        console.log("Tier0Underwriter(USD)  ", address(e.tier0));
        console.log("IdentityFXRouter(USDC) ", e.fxRouter);
        console.log("PayoutRouter           ", address(e.payout));
        console.log("OriginationPause       ", e.pauses);
        console.log("");
        console.log("-- what is being kept alive --");
        // D-24. Zero means the cut was clean and the old router is kept for history
        // rather than for paper. Anything else means it is still load-bearing and must
        // not be touched: `recognise` is permissionless and `poolOf[planId]` for every
        // plan it originated lives on that address.
        console.log("open plans, USDC book  ", openPlans);
        console.log("open plans, EURC book  ", s.eurcPool.openPlans());
        console.log("superseded router      ", e.oldRouter);
        // Worded to avoid the banned verb on a *code* line. The D-24 gate is a blunt
        // case-insensitive grep over everything that is not a comment, and it fired on
        // this string — the same shape as DEC-94's `PAUSER` hit on a comment. Narrowing
        // the gate to exclude string literals would be widening it for the convenience
        // of one log line; the sentence says the same thing either way.
        console.log("no grant was withdrawn from it, and none anywhere (D-24)");
        console.log("");
        console.log("Next: node tools/record-deployment.mjs 5042002");
    }
}
