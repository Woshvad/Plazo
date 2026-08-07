#!/usr/bin/env node
/**
 * `inflow` — the EIP-7708 stream, read at 18 decimals against real Arc blocks.
 *
 *     pnpm --filter @plazo/arc-verify inflow
 *
 * It spends nothing and needs no key. Every call is an `eth_getLogs`, an
 * `eth_getBalance`, an `eth_call` or an `eth_getBlockByNumber`, so it is safe to
 * re-run — and re-running is the point, because the window is the last two hundred
 * blocks and what it contains changes every couple of minutes.
 *
 * What it prints is E-08 as arithmetic: the correct income figure for the window,
 * beside the 2× a scale-reconciled double-count produces, beside the 10^12 a raw sum
 * produces. A risk described in a comment is a risk somebody reads past; a wrong
 * number printed next to the right one is not.
 *
 * **A quiet window exits 0.** Rows that can only be witnessed when the chain happens
 * to carry the right organic traffic are `note`d and uncounted (findings 16-27). A
 * non-zero exit means an assertion actually failed — the two views of one balance
 * disagreed, or `toMinor6` stopped reproducing the ERC-20 stream — and both of those
 * say the arithmetic every Tier-1 limit rests on has moved.
 *
 * Whatever it prints belongs in `contracts/test/fork/FINDINGS.md`.
 */
import {runInflow} from "./inflow.js";

runInflow().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
