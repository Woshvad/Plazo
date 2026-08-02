#!/usr/bin/env node
/**
 * `spike:cctp` — one real `depositForBurn` out of Arc.
 *
 *     DEPLOYER_PRIVATE_KEY=0x… pnpm --filter @plazo/arc-verify spike:cctp
 *
 * It spends about one USDC of testnet money and cannot be undone. Run it when
 * there is a reason to measure the call again, not as part of a build — it is a
 * spike, not a gate. The standing gate is `pnpm arc:verify`, which reads the same
 * contracts without spending anything.
 *
 * Whatever happens, it goes into `contracts/test/fork/FINDINGS.md`. A failure is
 * the more valuable outcome and the one most easily retried into silence.
 */
import {runCctpSpike} from "./cctp-spike.js";

runCctpSpike().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
