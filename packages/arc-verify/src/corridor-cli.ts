#!/usr/bin/env node
/**
 * `corridor` — the Phase 7 corridor read back off the chain it was deployed to.
 *
 *     DEPLOYER_PRIVATE_KEY=0x… pnpm --filter @plazo/arc-verify corridor
 *
 * It spends nothing. Every call is an `eth_call`, an `eth_getCode` or a balance read, so
 * it is safe to re-run — and re-running is the point, because the funding branch changes
 * the moment someone tops up an address.
 *
 * **Both funding branches exit 0.** An unfunded corridor is a result this phase was
 * written to accept, and the checks that catch finding 30 — every grant re-read from the
 * deployed contract, every selector the new router will call probed by name — need reads
 * rather than capital, so they land on either branch. A non-zero exit means either the
 * chain did not answer or the deployment is wired wrong, which are different things from
 * a precondition that was not met and exit differently on purpose.
 *
 * Whatever it prints goes into `contracts/test/fork/FINDINGS.md`, findings 35 and 36.
 */
import {runCorridorVerify} from "./corridor.js";

runCorridorVerify().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
