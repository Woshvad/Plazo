#!/usr/bin/env node
/**
 * `arc-faucet` — stand up collection addresses, then sweep them.
 *
 *     pnpm --filter @plazo/arc-verify faucet                  # addresses and progress
 *     pnpm --filter @plazo/arc-verify faucet -- --count=30    # more of them
 *     pnpm --filter @plazo/arc-verify faucet sweep            # into the deployer
 *     pnpm --filter @plazo/arc-verify faucet sweep -- --to=0x…
 *
 * Needs `DEPLOYER_PRIVATE_KEY`, and nothing else. The addresses are derived from it,
 * so they are the same every run and there is no key material on disk.
 */
import {runFaucet} from "./faucet.js";

runFaucet().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
