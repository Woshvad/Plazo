// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {ParameterRegistry} from "../src/ParameterRegistry.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {ReceivableToken} from "../src/ReceivableToken.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {TranchedCreditPool} from "../src/TranchedCreditPool.sol";
import {PlazoPassport} from "../src/PlazoPassport.sol";
import {FirstPaymentDefaultSwitch} from "../src/FirstPaymentDefaultSwitch.sol";
import {Tier0Underwriter} from "../src/Tier0Underwriter.sol";
import {PlanFactory} from "../src/PlanFactory.sol";
import {PayoutRouter} from "../src/PayoutRouter.sol";
import {RefundEscrow} from "../src/RefundEscrow.sol";
import {SettlementEscrow} from "../src/SettlementEscrow.sol";
import {CheckoutRouter} from "../src/CheckoutRouter.sol";

/// @title Rewire
/// @notice Puts the Phase 6 merchant plane on the live book, in one broadcast.
///
/// @dev **What this replaces, and what it deliberately leaves standing.** Vintage 3
///      deployed `ArcLocalPayout` and a `CheckoutRouter` that knew nothing about
///      escrowed settlement. This script deploys their Phase 6 successors —
///      `PayoutRouter`, `SettlementEscrow`, `RefundEscrow` and a new `CheckoutRouter`
///      — and grants the new router every role `Deploy.s.sol::_wire` grants.
///
///      **Nothing is revoked from the old router (D-24).** `recognise` is
///      permissionless and `poolOf[planId]` for every vintage-3 plan lives on the old
///      address, so forcing terminal states on live paper to enable a deploy would be
///      the tail wagging the dog. `_report` prints the pool's open-plan count so the
///      operator can see what they are keeping alive. It reads zero today; that is
///      checked rather than assumed.
///
///      The swap is cheap because `planId`'s preimage contains no router field
///      (DEC-15). It moves no plan id and invalidates no outstanding strip.
///
///      **This script moves no tokens, and cannot.** Arc USDC's movement runs through
///      a native precompile at `0x1800…` whose on-chain code is a single byte;
///      Foundry cannot execute it, and `forge script` executes its body locally to
///      collect the transactions it will broadcast. Any script touching USDC reverts
///      before it can broadcast, whatever `--skip-simulation` says (finding 10).
///      Contract creation and role grants move nothing, so they work here. Everything
///      that moves value runs from `packages/arc-verify` through viem.
///
///      The deployment record is written by `tools/record-deployment.mjs` from the
///      broadcast receipts, never inline — a script that writes its own record writes
///      it during the *local* execution, so a run that fails at the send step still
///      produces a file naming addresses that hold no code (finding 12).
///
/// @dev **Three things the live chain turned out to require, none of which were in the
///      plan. Each is forced; none is a preference.**
///
///      **1. `MerchantRegistry` is redeployed.** The live registry at vintage 3
///      predates plan 06-09 and has no `categoryOf`. The new
///      `CheckoutRouter._settleMerchant` calls it on *every* origination, so a rewire
///      that kept the old registry would deploy a router that reverts on every
///      checkout — measured, not inferred: an `eth_call` of `categoryOf` against the
///      live address reverts, while `vestingBpsFor`, `payoutRouteOf` and
///      `velocityCapFor` all answer. `MerchantRegistry` is a plain constructor
///      deployment with a new field inside its `Merchant` struct, so there is no
///      upgrade path and no migration to write. It is referenced only by
///      `CheckoutRouter`, `SettlementEscrow` and `RefundEscrow` — all three of which
///      are new here — so the blast radius is exactly this script. The merchant's
///      standing bond on the old registry is recoverable: `withdrawBond` is
///      merchant-callable and `requiredBond` is zero with no fronted exposure
///      outstanding.
///
///      **2. The two escrows read a second, escrow-only `ParameterRegistry`
///      (DEC-72).** `ParameterKeys.ESCROW_ATTESTATION_DEADLINE`,
///      `ESCROW_RELEASE_TIMER` and `ESCROW_DISPUTE_TIMELOCK` are seeded in
///      `ParameterRegistry`'s constructor by a **private** `_define`, and `get()`
///      reverts `ParameterUndefined` on a key nobody set. All three read UNDEFINED on
///      the live registry, which predates plan 06-14, and there is no function that
///      could add them. Without a registry that defines them, `release`,
///      `refundToPool` and `executeSlash` all revert — and since
///      `SettlementCategory.Escrowed` is ordinal zero, *every* unseasoned merchant
///      escrows, so every settlement on the new router would strand permanently.
///      The alternative is redeploying the registry the pool, the underwriter, the
///      kill switch, the passport and the relayer gate all hold as immutables, which
///      is a new pool and a migration of every tranche position — forbidden by the
///      standing Phase 5 constraint that the book is one contract.
///
///      So the split is by *reader*, and the two key sets are disjoint. The live
///      registry keeps `MDR_BPS`, `ATTESTATION_MAX_TTL`, `MIN_TICKET`, `MAX_TICKET`,
///      `LIMIT_HARD_CEILING`, every merchant row and every pool row, and keeps its
///      governance history — the new `MerchantRegistry` and the new `CheckoutRouter`
///      both take it, so nothing about origination, bonding or underwriting moves.
///      The escrow registry is read by `SettlementEscrow` and `RefundEscrow` and by
///      nothing else, for three rows nothing else reads. No value is duplicated in
///      use. Its bands are the same compiled `require()`s (GOV-01), so the 24-hour
///      dispute-timelock floor that keeps `SLASHER_ROLE` from becoming an instant key
///      over every bond is enforced exactly as it is in the suite.
///
///      **3. The deployment order is not the one the plan listed.** `RefundEscrow`
///      takes the `CheckoutRouter` as a constructor argument — it wraps
///      `creditRefund`, which it structurally cannot call, and reads `poolOf` — so it
///      must come last. There is no cycle and there must not become one:
///      `SettlementEscrow` knows nothing about `RefundEscrow`, only the reverse. If a
///      later change appears to need the back reference, it is asking for a setter on
///      a live escrow and the answer is no.
///
/// @dev **Running it.** Every existing address is read from the environment rather
///      than redeployed, and the values come out of `contracts/deployments/5042002.json`
///      — the record is the source, so nothing is retyped. Documented here rather than
///      in `.env.example`, which scopes itself to the operator database and says why
///      (DEC-55): a variable listed twice is one list eventually getting it wrong.
///
///          eval "$(node -e '
///            const d = require("./contracts/deployments/5042002.json");
///            const m = {
///              PLAZO_PARAMETER_REGISTRY: "parameterRegistry",
///              PLAZO_ELIGIBILITY_REGISTRY: "eligibilityRegistry",
///              PLAZO_COMPLIANCE: "compliance",
///              PLAZO_FX_ROUTER: "fxRouter",
///              PLAZO_RECEIVABLE: "receivable",
///              PLAZO_POOL_REGISTRY: "poolRegistry",
///              PLAZO_CREDIT_POOL: "creditPool",
///              PLAZO_PASSPORT: "passport",
///              PLAZO_KILL_SWITCH: "killSwitch",
///              PLAZO_TIER0: "tier0",
///              PLAZO_PAUSES: "pauses",
///              PLAZO_PLAN_FACTORY: "planFactory",
///            };
///            for (const [k, v] of Object.entries(m)) console.log(`export ${k}=${d[v]}`);
///          ')"
///          forge script script/Rewire.s.sol --root contracts --rpc-url arc_testnet --broadcast
///          node tools/record-deployment.mjs 5042002
contract Rewire is Script {
    /// @dev The check rail. Verified live on chain 5042002 by `pnpm arc:verify`.
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    /// @dev Circle's CCTP v2 `TokenMessengerV2` on Arc. Bytecode confirmed, and a real
    ///      burn through it measured in plan 06-01 (finding 28).
    address internal constant ARC_TOKEN_MESSENGER_V2 = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;

    /// @dev What stays where it is. The book, the people, the paper and the plan
    ///      implementation are all untouched by a router swap.
    struct Existing {
        ParameterRegistry parameters;
        EligibilityRegistry eligibility;
        address compliance;
        address fx;
        ReceivableToken receivable;
        address pools;
        TranchedCreditPool pool;
        PlazoPassport passport;
        FirstPaymentDefaultSwitch killSwitch;
        Tier0Underwriter underwriter;
        address pauses;
        PlanFactory factory;
    }

    /// @dev What this script puts on chain.
    struct Stack {
        MerchantRegistry merchants;
        PayoutRouter payout;
        ParameterRegistry escrowParameters;
        SettlementEscrow settlementEscrow;
        CheckoutRouter router;
        RefundEscrow refundEscrow;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address token = vm.envOr("PLAZO_TOKEN", ARC_USDC);
        address messenger = vm.envOr("PLAZO_TOKEN_MESSENGER", ARC_TOKEN_MESSENGER_V2);

        Existing memory e = _existing();

        // Read before the broadcast, so the number in the report is the state the
        // operator is deciding against rather than the state the deploy left. D-24:
        // a clean cut is only clean if nothing is open, and this is the check that
        // says so rather than the assumption that does not.
        uint256 openPlans = e.pool.openPlans();

        vm.startBroadcast(deployerKey);

        Stack memory s = _deploy(e, deployer, token, messenger);
        _wire(e, s, deployer);

        vm.stopBroadcast();

        _report(e, s, deployer, token, messenger, openPlans);
    }

    /// @dev Addresses, not deployments. Nothing here is constructed.
    function _existing() private view returns (Existing memory e) {
        e.parameters = ParameterRegistry(vm.envAddress("PLAZO_PARAMETER_REGISTRY"));
        e.eligibility = EligibilityRegistry(vm.envAddress("PLAZO_ELIGIBILITY_REGISTRY"));
        e.compliance = vm.envAddress("PLAZO_COMPLIANCE");
        e.fx = vm.envAddress("PLAZO_FX_ROUTER");
        e.receivable = ReceivableToken(vm.envAddress("PLAZO_RECEIVABLE"));
        e.pools = vm.envAddress("PLAZO_POOL_REGISTRY");
        e.pool = TranchedCreditPool(vm.envAddress("PLAZO_CREDIT_POOL"));
        e.passport = PlazoPassport(vm.envAddress("PLAZO_PASSPORT"));
        e.killSwitch = FirstPaymentDefaultSwitch(vm.envAddress("PLAZO_KILL_SWITCH"));
        e.underwriter = Tier0Underwriter(vm.envAddress("PLAZO_TIER0"));
        e.pauses = vm.envAddress("PLAZO_PAUSES");
        e.factory = PlanFactory(vm.envAddress("PLAZO_PLAN_FACTORY"));
    }

    function _deploy(
        Existing memory e,
        address deployer,
        address token,
        address messenger
    ) private returns (Stack memory s) {
        // Deployment reason 1 in the header: the live registry has no `categoryOf`.
        // It takes the **live** ParameterRegistry, so every merchant row the operator
        // has already governed — the zeroed bond floor, the bond and vesting bps, the
        // velocity cap and window — carries across unchanged.
        s.merchants = new MerchantRegistry(deployer, token, address(e.parameters));

        s.payout = new PayoutRouter(deployer, messenger);

        // Deployment reason 2 in the header (DEC-72). Read by the two escrows and by
        // nothing else, for three rows nothing else reads. Seeded at D-08's launch
        // hypotheses — 7 days to attest a shipment, 72 hours before a release, 72
        // hours before a dispute can reach a bond — inside the same compiled bands.
        s.escrowParameters = new ParameterRegistry(deployer);

        // MERCH-04. Before the router, because the router takes it as a constructor
        // immutable; the reference back is installed in `_wire` (DEC-42).
        s.settlementEscrow = new SettlementEscrow(
            deployer, address(s.merchants), address(s.payout), address(s.escrowParameters)
        );

        s.router = new CheckoutRouter(
            deployer,
            CheckoutRouter.Wiring({
                factory: address(e.factory),
                pools: e.pools,
                passport: address(e.passport),
                merchants: address(s.merchants),
                receivable: address(e.receivable),
                underwriter: address(e.underwriter),
                killSwitch: address(e.killSwitch),
                pauses: e.pauses,
                parameters: address(e.parameters),
                compliance: e.compliance,
                payout: address(s.payout),
                settlementEscrow: address(s.settlementEscrow),
                fxRouter: e.fx
            })
        );

        // Last, because it takes the router: it wraps `creditRefund`, which it
        // structurally cannot call, and reads `poolOf` to find the book a plan settled
        // to. `SettlementEscrow` is passed as `ISettlementEscrow` and is how a
        // borrower's non-attestation dispute route reaches the escrow row.
        s.refundEscrow = new RefundEscrow(
            deployer,
            token,
            address(s.router),
            address(s.merchants),
            address(s.escrowParameters),
            address(s.settlementEscrow)
        );
    }

    /// @dev `Deploy.s.sol::_wire` with the operator half unchanged, re-granted to the
    ///      new router. GOV-02's Phase 9 audit reads this: every grant below is a
    ///      claim that some contract needs a capability, and the list being short is
    ///      the point.
    function _wire(Existing memory e, Stack memory s, address deployer) private {
        // DEC-42's one-way handshake. Unset by default, so an escrow deployed without
        // it accepts no `hold` at all and every escrowed origination reverts
        // `OnlyRouter`.
        s.settlementEscrow.setRouter(address(s.router));

        // Rotatable now, which is what DEC-15 bought. Under the old one-shot form this
        // line alone would have forced a new factory and moved every plan id.
        e.factory.setOriginator(address(s.router));
        e.pool.setOriginator(address(s.router));

        e.receivable.grantRole(e.receivable.ISSUER_ROLE(), address(s.router));
        e.underwriter.grantRole(e.underwriter.ORIGINATOR_ROLE(), address(s.router));
        e.killSwitch.grantRole(e.killSwitch.REGISTRAR_ROLE(), address(s.router));
        s.merchants.grantRole(s.merchants.BOOKKEEPER_ROLE(), address(s.router));
        e.passport.grantRole(e.passport.READER_ROLE(), address(s.router));

        // The operator's underwriting key attests; the operator's KYB key clears a
        // merchant and, since plan 06-09, also holds the settlement-category opt-out.
        // Both are the deployer on testnet and both are rotatable without a
        // redeployment. The category opt-out is a materially larger capability than
        // "attest that KYB happened" and is worth a line of its own in the GOV-02 role
        // graph.
        s.router.grantRole(s.router.UNDERWRITER_ROLE(), deployer);
        s.merchants.grantRole(s.merchants.KYB_ROLE(), deployer);

        // Finding 16, exactly. Without this line the router mints a receivable to the
        // pool and `ReceivableToken`'s default-deny transfer hook refuses it — an
        // origination that passes every gate and then fails on the last transfer, with
        // an error that names the token rather than the missing grant. It is the one
        // line in this function whose absence is invisible in every local test,
        // because `OriginationFixture` grants eligibility as a side effect of
        // existing.
        e.eligibility.setGlobal(address(s.router), true);

        // D-03, and the first time this role is held by anything. A throwaway probe in
        // plan 06-08 confirmed it is genuinely dangerous — an EOA holding it took a
        // merchant's entire bond in one transaction, with no dispute and no delay — so
        // routing it through a contract with a dispute precondition and a registry
        // timelock is a mitigation rather than decoration. `RefundEscrow` and nothing
        // else.
        s.merchants.grantRole(s.merchants.SLASHER_ROLE(), address(s.refundEscrow));

        // Class B. Phase 6's two new operator roles, and GOV-08's claim is that the
        // servicing loop survives their absence. `OperatorFreeFixture` grants both and
        // then revokes both, so a deployment that never granted them would be proving
        // GOV-08 against gates that were never armed (DEC-46).
        s.refundEscrow.grantRole(s.refundEscrow.ARBITER_ROLE(), deployer);
        s.payout.grantRole(s.payout.DOMAIN_CURATOR_ROLE(), deployer);
    }

    function _report(
        Existing memory e,
        Stack memory s,
        address deployer,
        address token,
        address messenger,
        uint256 openPlans
    ) private view {
        console.log("deployer              ", deployer);
        console.log("token                 ", token);
        console.log("TokenMessengerV2      ", messenger);
        console.log("");
        console.log("-- deployed --");
        console.log("MerchantRegistry      ", address(s.merchants));
        console.log("PayoutRouter          ", address(s.payout));
        console.log("ParameterRegistry(esc)", address(s.escrowParameters));
        console.log("SettlementEscrow      ", address(s.settlementEscrow));
        console.log("CheckoutRouter        ", address(s.router));
        console.log("RefundEscrow          ", address(s.refundEscrow));
        console.log("");
        console.log("-- kept --");
        console.log("ParameterRegistry     ", address(e.parameters));
        console.log("EligibilityRegistry   ", address(e.eligibility));
        console.log("TranchedCreditPool    ", address(e.pool));
        console.log("PlanFactory           ", address(e.factory));
        console.log("Tier0Underwriter      ", address(e.underwriter));
        console.log("");
        // D-24. Zero means the cut was clean and the old router is being kept alive
        // for history rather than for paper. Anything else means the old router is
        // still load-bearing and must not be touched — `recognise` is permissionless
        // and `poolOf[planId]` for every vintage-3 plan lives on the old address.
        console.log("open plans on the book", openPlans);
        console.log("nothing was revoked from the old router (D-24)");
    }
}
