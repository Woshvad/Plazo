/**
 * Ponder configuration for Arc.
 *
 * Reorg handling — Ponder's hardest problem on other chains — is free here. Arc has
 * deterministic single-slot finality under Malachite BFT and zero reorgs, so there
 * is no rollback path to get wrong.
 *
 * What is not free is the RPC. See `src/transport.ts`: the public endpoint sheds a
 * quarter of requests and caps `eth_getLogs` at 10,000 blocks.
 *
 * `startBlock` is the deployment block, never genesis. Arc is past 54 million
 * blocks at roughly half a second each; a genesis backfill would sweep years of
 * unrelated history to find nothing.
 */
import {createConfig} from "ponder";

import {ARC_TESTNET_CHAIN_ID} from "@plazo/plan-core";
import {ABI} from "@plazo/events";

import {arcTransport} from "./src/transport.js";

/**
 * Phase 1 has no deployed contracts — `PlanFactory` deploys in Phase 2 with the
 * vertical slice. The address and start block arrive from the deployment script's
 * output. Until then the indexer typechecks, its schema is frozen, and it has
 * nothing to ingest, which is the correct state for a phase that owns the schema
 * rather than the contracts.
 */
const PLAN_FACTORY = process.env["PLAZO_PLAN_FACTORY_ADDRESS"] as `0x${string}` | undefined;
const START_BLOCK = process.env["PLAZO_START_BLOCK"];

if (!PLAN_FACTORY) {
  console.warn(
    "PLAZO_PLAN_FACTORY_ADDRESS is unset — indexing no contracts.\n" +
      "Expected until Phase 2 deploys the factory.",
  );
}

export default createConfig({
  chains: {
    arcTestnet: {
      id: ARC_TESTNET_CHAIN_ID,
      rpc: arcTransport(),
      // The public endpoint sheds under load, so ask for less than it will take.
      maxRequestsPerSecond: 5,
    },
  },
  contracts: {
    PlanFactory: {
      chain: "arcTestnet",
      abi: ABI as readonly string[],
      address: PLAN_FACTORY ?? "0x0000000000000000000000000000000000000000",
      startBlock: START_BLOCK ? Number(START_BLOCK) : "latest",
    },
  },
});
