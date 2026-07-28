#!/usr/bin/env node
/**
 * The mainnet-readiness gate.
 *
 * Runs on every CI build against Arc testnet. When Arc mainnet exists, the same
 * suite runs against it by flipping `--network mainnet` and supplying an RPC URL —
 * no code changes, which is the point. Mainnet is a config entry and a re-run of
 * this file, not a phase.
 */
import {
  ARC_MAINNET_CHAIN_ID,
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_RPC_URL,
  ARC_USDC,
  ARC_USDC_IMPLEMENTATION,
} from "@plazo/plan-core";

import {runChecks, type NetworkProfile} from "./checks.js";

const PROFILES: Record<string, NetworkProfile> = {
  testnet: {
    label: "Arc testnet",
    chainId: ARC_TESTNET_CHAIN_ID,
    rpcUrl: process.env["ARC_TESTNET_RPC_URL"] ?? ARC_TESTNET_RPC_URL,
    usdc: ARC_USDC,
    expectedImplementation: ARC_USDC_IMPLEMENTATION,
  },
  mainnet: {
    label: "Arc mainnet",
    chainId: ARC_MAINNET_CHAIN_ID,
    // Arc mainnet is not live and has no announced date. The profile exists so
    // that the day it does, this is a config change rather than a project.
    rpcUrl: process.env["ARC_MAINNET_RPC_URL"] ?? "",
    usdc: (process.env["ARC_MAINNET_USDC"] as `0x${string}`) ?? ARC_USDC,
    expectedImplementation:
      (process.env["ARC_MAINNET_USDC_IMPLEMENTATION"] as `0x${string}`) ?? ARC_USDC_IMPLEMENTATION,
  },
};

function parseNetwork(argv: string[]): string {
  const i = argv.indexOf("--network");
  return i >= 0 ? (argv[i + 1] ?? "testnet") : "testnet";
}

const GREEN = "[32m";
const RED = "[31m";
const DIM = "[2m";
const BOLD = "[1m";
const RESET = "[0m";

async function main(): Promise<void> {
  const network = parseNetwork(process.argv.slice(2));
  const profile = PROFILES[network];

  if (!profile) {
    console.error(`Unknown network "${network}". Expected: ${Object.keys(PROFILES).join(", ")}`);
    process.exit(2);
  }

  if (!profile.rpcUrl) {
    if (network === "mainnet") {
      console.error(
        `${RED}Arc mainnet has no RPC.${RESET}\n\n` +
          "Not a misconfiguration: the network is not live and Circle has announced no\n" +
          "date. `rpc.mainnet.arc.io` returns UNAUTHORIZED and viem ships chain 5042 with\n" +
          "an empty RPC array. Set ARC_MAINNET_RPC_URL when that changes.",
      );
      process.exit(2);
    }
    console.error(`No RPC URL for ${network}.`);
    process.exit(2);
  }

  console.log(`\n${BOLD}Arc primitive verification${RESET} ${DIM}— ${profile.label}${RESET}\n`);

  const results = await runChecks(profile);
  const failures = results.filter((r) => !r.ok);

  for (const r of results) {
    const mark = r.ok ? `${GREEN}ok${RESET}  ` : `${RED}FAIL${RESET}`;
    console.log(`  ${mark}  ${r.name.padEnd(34)} ${DIM}${r.detail}${RESET}`);
  }

  console.log();

  if (failures.length === 0) {
    console.log(`${GREEN}${results.length} checks passed.${RESET} Arc is what the protocol assumes.\n`);
    return;
  }

  console.log(`${RED}${BOLD}${failures.length} of ${results.length} checks failed.${RESET}\n`);
  for (const f of failures) {
    console.log(`  ${RED}${f.name}${RESET}`);
    console.log(`    ${f.detail}`);
    if (f.because) console.log(`    ${DIM}${f.because}${RESET}`);
    console.log();
  }

  console.log(
    "An assumption the protocol is built on no longer holds. Do not ship past this\n" +
      "gate by relaxing the check — find out what changed on Arc first.\n",
  );
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`\n${RED}Verification could not run.${RESET}\n`);
  console.error(error);
  process.exit(2);
});
