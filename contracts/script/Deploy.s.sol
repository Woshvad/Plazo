// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {PlanFactory} from "../src/PlanFactory.sol";
import {JurisdictionRegistry} from "../src/JurisdictionRegistry.sol";
import {IdentityFXRouter} from "../src/IdentityFXRouter.sol";

/// @title Deploy
/// @notice Deploys the Phase 2 stack to Arc.
///
/// @dev Deliberately does not originate anything, and that is a constraint rather
///      than a choice. Arc USDC's token movement runs through a native precompile at
///      `0x1800…` whose onchain code is a single byte; Foundry cannot execute it,
///      and `forge script` executes the script body locally to collect the
///      transactions it will broadcast. So any script that touches USDC — including
///      `originate`, which pulls the mark escrow — reverts before it can be
///      broadcast, whatever `--skip-simulation` is set to.
///
///      Contract deployment moves no tokens, so it works here. Everything that moves
///      value runs from `packages/arc-verify`'s slice runner instead, which sends
///      transactions through viem and never executes them locally.
///
///          forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast
///          node tools/record-deployment.mjs 5042002
///
///      The record is written by the second command, not by this one. This script
///      ran once with the write inline, failed at the send step for want of gas, and
///      still produced a file naming four addresses that held no code — because the
///      body had already executed locally. The indexer, the keeper and the slice
///      runner all read that file. Foundry's broadcast artefact is built from
///      receipts and cannot claim a transaction that was never mined, so the record
///      is derived from that instead.
contract Deploy is Script {
    /// @dev The check rail. Verified live on chain 5042002 by `pnpm arc:verify`.
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address token = vm.envOr("PLAZO_TOKEN", ARC_USDC);

        vm.startBroadcast(deployerKey);

        JurisdictionRegistry jurisdictions = new JurisdictionRegistry(deployer);
        IdentityFXRouter router = new IdentityFXRouter(token);
        InstallmentPlan implementation = new InstallmentPlan();
        PlanFactory factory = new PlanFactory(address(implementation), address(jurisdictions));

        vm.stopBroadcast();

        console.log("chainId               ", block.chainid);
        console.log("deployer              ", deployer);
        console.log("token                 ", token);
        console.log("JurisdictionRegistry  ", address(jurisdictions));
        console.log("IdentityFXRouter      ", address(router));
        console.log("InstallmentPlan (impl)", address(implementation));
        console.log("PlanFactory           ", address(factory));
        console.log("");
        console.log("Record the deployment from the broadcast receipts:");
        console.log("  node tools/record-deployment.mjs", block.chainid);
    }
}
