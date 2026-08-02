// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {PlanFactory} from "../src/PlanFactory.sol";
import {JurisdictionRegistry} from "../src/JurisdictionRegistry.sol";
import {IdentityFXRouter} from "../src/IdentityFXRouter.sol";
import {ParameterRegistry} from "../src/ParameterRegistry.sol";
import {EligibilityRegistry} from "../src/EligibilityRegistry.sol";
import {AllowlistCompliance} from "../src/AllowlistCompliance.sol";
import {ArcLocalPayout} from "../src/ArcLocalPayout.sol";
import {ReceivableToken} from "../src/ReceivableToken.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {TranchedCreditPool} from "../src/TranchedCreditPool.sol";
import {PoolRegistry} from "../src/PoolRegistry.sol";
import {PlazoPassport} from "../src/PlazoPassport.sol";
import {AttestationSchemaRegistry} from "../src/AttestationSchemaRegistry.sol";
import {RelayerGate} from "../src/RelayerGate.sol";
import {ParkedYieldVenue} from "../src/ParkedYieldVenue.sol";
import {FirstPaymentDefaultSwitch} from "../src/FirstPaymentDefaultSwitch.sol";
import {Tier0Underwriter} from "../src/Tier0Underwriter.sol";
import {OriginationPause} from "../src/OriginationPause.sol";
import {SettlementEscrow} from "../src/SettlementEscrow.sol";
import {CheckoutRouter} from "../src/CheckoutRouter.sol";

/// @title Deploy
/// @notice Deploys the Phase 3 origination stack to Arc.
///
/// @dev Deliberately does not originate anything, and that is a constraint rather
///      than a choice. Arc USDC's token movement runs through a native precompile at
///      `0x1800…` whose onchain code is a single byte; Foundry cannot execute it,
///      and `forge script` executes the script body locally to collect the
///      transactions it will broadcast. So any script that touches USDC — including
///      `originate` and `fundReserve` — reverts before it can be broadcast, whatever
///      `--skip-simulation` is set to.
///
///      Contract deployment and role grants move no tokens, so they work here.
///      Everything that moves value runs from `packages/arc-verify`'s slice runner
///      instead, which sends transactions through viem and never executes them
///      locally.
///
///          forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast
///          node tools/record-deployment.mjs 5042002
///
///      The record is written by the second command, not by this one. This script
///      ran once with the write inline, failed at the send step for want of gas, and
///      still produced a file naming four addresses that held no code — because the
///      body had already executed locally. Foundry's broadcast artefact is built from
///      receipts and cannot claim a transaction that was never mined, so the record
///      is derived from that instead.
///
///      **This is vintage 3.** `InstallmentPlan` itself is unchanged from vintage 2,
///      but `PlanFactory` is not — Phase 5 replaced the flat funding book with a
///      tranched one, which forces a new router, which under the old one-shot
///      `setOriginator` forced a new factory. The factory is in the `planId` preimage,
///      so every plan id moves.
///
///      That is the last time it moves for this reason. `setOriginator` is now
///      rotatable by an admin (DEC-15), because the gate was always anti-griefing —
///      the plan re-verifies its own `planId`, `termsHash` and acceptance — and making
///      a router upgrade cost a migration of every outstanding strip was a price nobody
///      chose to pay.
contract Deploy is Script {
    /// @dev The check rail. Verified live on chain 5042002 by `pnpm arc:verify`.
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    /// @dev The one product line v1 funds.
    bytes32 internal constant PAY_IN_4 = keccak256("PLAZO.PAY_IN_4");

    struct Stack {
        JurisdictionRegistry jurisdictions;
        ParameterRegistry parameters;
        EligibilityRegistry eligibility;
        AllowlistCompliance compliance;
        IdentityFXRouter fx;
        ArcLocalPayout payout;
        ReceivableToken receivable;
        MerchantRegistry merchants;
        PoolRegistry pools;
        TranchedCreditPool pool;
        ParkedYieldVenue venue;
        PlazoPassport passport;
        AttestationSchemaRegistry schemas;
        RelayerGate relayer;
        FirstPaymentDefaultSwitch killSwitch;
        Tier0Underwriter underwriter;
        OriginationPause pauses;
        InstallmentPlan implementation;
        PlanFactory factory;
        SettlementEscrow settlementEscrow;
        CheckoutRouter router;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address token = vm.envOr("PLAZO_TOKEN", ARC_USDC);

        vm.startBroadcast(deployerKey);

        Stack memory s = _deploy(deployer, token);
        _wire(s, deployer);

        vm.stopBroadcast();

        _report(s, deployer, token);
    }

    function _deploy(address deployer, address token) private returns (Stack memory s) {
        s.jurisdictions = new JurisdictionRegistry(deployer);
        s.parameters = new ParameterRegistry(deployer);
        s.eligibility = new EligibilityRegistry(deployer);
        s.compliance = new AllowlistCompliance(deployer, deployer);
        s.fx = new IdentityFXRouter(token);
        s.payout = new ArcLocalPayout();

        s.receivable = new ReceivableToken(deployer, address(s.eligibility));
        s.merchants = new MerchantRegistry(deployer, token, address(s.parameters));
        s.pools = new PoolRegistry(deployer);
        s.passport = new PlazoPassport(deployer, address(s.parameters));
        s.schemas = new AttestationSchemaRegistry(deployer);
        s.relayer = new RelayerGate(deployer, address(s.parameters));
        s.venue = new ParkedYieldVenue(deployer, token);

        // Pay-in-4 only, in v1. The tenor band is the pool's own, so POOL-01's
        // no-commingling guarantee is enforced by the book rather than by a label on a
        // request — and Flex and Terms are a deployment plus a registry row.
        s.pool = new TranchedCreditPool(
            TranchedCreditPool.Wiring({
                admin: deployer,
                token: token,
                parameters: address(s.parameters),
                eligibility: address(s.eligibility),
                productLine: PAY_IN_4,
                minInstallments: 2,
                maxInstallments: 6,
                minInterval: 7 days,
                maxInterval: 31 days
            })
        );

        s.killSwitch = new FirstPaymentDefaultSwitch(deployer, address(s.parameters));
        s.underwriter = new Tier0Underwriter(deployer, address(s.parameters), address(s.killSwitch));
        s.pauses = new OriginationPause(deployer, deployer);

        s.implementation = new InstallmentPlan();
        s.factory = new PlanFactory(address(s.implementation), address(s.jurisdictions), deployer);

        // MERCH-04. Deployed before the router, because the router takes it as a
        // constructor immutable; the reference back is installed in `_wire`.
        s.settlementEscrow =
            new SettlementEscrow(deployer, address(s.merchants), address(s.payout), address(s.parameters));

        s.router = new CheckoutRouter(
            deployer,
            CheckoutRouter.Wiring({
                factory: address(s.factory),
                pools: address(s.pools),
                passport: address(s.passport),
                merchants: address(s.merchants),
                receivable: address(s.receivable),
                underwriter: address(s.underwriter),
                killSwitch: address(s.killSwitch),
                pauses: address(s.pauses),
                parameters: address(s.parameters),
                compliance: address(s.compliance),
                payout: address(s.payout),
                settlementEscrow: address(s.settlementEscrow),
                fxRouter: address(s.fx)
            })
        );
    }

    /// @dev The role graph, in one place. GOV-02's Phase 9 audit reads this: every
    ///      grant below is a claim that some contract needs a capability, and the
    ///      list being short is the point.
    function _wire(Stack memory s, address deployer) private {
        // The router is the only address that can create a plan or move the book.
        s.factory.setOriginator(address(s.router));
        s.settlementEscrow.setRouter(address(s.router));
        s.pools.register(PAY_IN_4, address(s.pool));
        s.pool.setOriginator(address(s.router));
        s.receivable.grantRole(s.receivable.ISSUER_ROLE(), address(s.router));
        s.underwriter.grantRole(s.underwriter.ORIGINATOR_ROLE(), address(s.router));
        s.killSwitch.grantRole(s.killSwitch.REGISTRAR_ROLE(), address(s.router));
        s.merchants.grantRole(s.merchants.BOOKKEEPER_ROLE(), address(s.router));

        // The operator's feed screens; the operator's underwriting key attests. Both
        // are the deployer on testnet and both are rotatable without a redeployment.
        s.merchants.grantRole(s.merchants.KYB_ROLE(), deployer);
        s.router.grantRole(s.router.UNDERWRITER_ROLE(), deployer);

        // Default deny means the protocol's own contracts have to be listed. The pool
        // holds receivables; the router mints them to it.
        s.eligibility.setGlobal(address(s.pool), true);
        s.eligibility.setGlobal(address(s.router), true);
        s.underwriter.setPool(address(s.pool));

        // PASS-01. The only writer is the underwriter, and every write it makes is
        // derived from a plan's own state through a permissionless, self-verifying
        // path. The router reads the coarse tier and nothing else (PASS-02).
        s.passport.grantRole(s.passport.WRITER_ROLE(), address(s.underwriter));
        s.passport.grantRole(s.passport.READER_ROLE(), address(s.router));
        s.passport.grantRole(s.passport.READER_ROLE(), address(s.underwriter));
        s.underwriter.setPassport(address(s.passport));

        // COLL-07. The operator's collection key holds nothing but this, so every
        // collection it makes is late and every earlier one is provably somebody else's.
        s.relayer.grantRole(s.relayer.RELAYER_ROLE(), deployer);

        // POOL-13. The venue is allowlisted but not activated; the buffer stays as cash
        // until a treasurer decides otherwise, which is the correct default for a book
        // whose redemption queue fills from cash.
        s.pool.setVenueAllowed(address(s.venue), true);
    }

    function _report(Stack memory s, address deployer, address token) private view {
        console.log("deployer              ", deployer);
        console.log("token                 ", token);
        console.log("JurisdictionRegistry  ", address(s.jurisdictions));
        console.log("ParameterRegistry     ", address(s.parameters));
        console.log("EligibilityRegistry   ", address(s.eligibility));
        console.log("AllowlistCompliance   ", address(s.compliance));
        console.log("IdentityFXRouter      ", address(s.fx));
        console.log("ArcLocalPayout        ", address(s.payout));
        console.log("ReceivableToken       ", address(s.receivable));
        console.log("MerchantRegistry      ", address(s.merchants));
        console.log("PoolRegistry          ", address(s.pools));
        console.log("TranchedCreditPool    ", address(s.pool));
        console.log("SeniorShares          ", address(s.pool.seniorShares()));
        console.log("JuniorShares          ", address(s.pool.juniorShares()));
        console.log("ParkedYieldVenue      ", address(s.venue));
        console.log("PlazoPassport         ", address(s.passport));
        console.log("AttestationSchemas    ", address(s.schemas));
        console.log("RelayerGate           ", address(s.relayer));
        console.log("FirstPaymentDefault   ", address(s.killSwitch));
        console.log("Tier0Underwriter      ", address(s.underwriter));
        console.log("OriginationPause      ", address(s.pauses));
        console.log("InstallmentPlan (impl)", address(s.implementation));
        console.log("PlanFactory           ", address(s.factory));
        console.log("SettlementEscrow      ", address(s.settlementEscrow));
        console.log("CheckoutRouter        ", address(s.router));
    }
}
