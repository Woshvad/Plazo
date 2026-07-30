#!/usr/bin/env node
/**
 * `arc-slice` — the vertical slice against live Arc.
 *
 * Deploy first, then run this:
 *
 *     forge script script/Deploy.s.sol --root contracts --rpc-url arc_testnet --broadcast
 *     pnpm --filter @plazo/arc-verify slice
 *
 * It needs a funded key, and that is the only thing it needs. Everything else — the
 * strip, the acceptance, the payee address — is derived from `@plazo/plan-core`, the
 * same code a checkout runs and a borrower can re-run without us.
 */
import {runSlice} from "./slice.js";

runSlice().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
