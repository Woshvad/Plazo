#!/usr/bin/env node
/**
 * `spike:fx` — the corridor's three preconditions, measured.
 *
 *     DEPLOYER_PRIVATE_KEY=0x… pnpm --filter @plazo/arc-verify spike:fx
 *
 * It spends nothing. Every call is an `eth_call`, an `eth_getCode`, an
 * `eth_getStorageAt` or a balance read, so it is safe to re-run and re-running is
 * the point: the EURC funding branch and the AMM venue branch both change the
 * moment someone tops up an address or a DEX lands on Arc.
 *
 * **Every branch exits 0.** An unfunded corridor and an absent venue are results
 * this phase was written to accept, and the one thing that would make them
 * worthless is a run that quietly reported a plausible number instead. A non-zero
 * exit from this command means the chain did not answer, which is a different
 * thing entirely.
 *
 * Whatever it prints goes into `contracts/test/fork/FINDINGS.md`, findings 31-34.
 */
import {runFxSpike} from "./fx-spike.js";

runFxSpike().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
