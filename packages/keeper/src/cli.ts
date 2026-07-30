#!/usr/bin/env node
/**
 * `plazo-keeper` — the zero-configuration entry point.
 *
 * COLL-08 asks for a published keeper a third party can run against the network with
 * no setup. "No setup" means what it says: the RPC is public and needs no signup, the
 * factory address ships as a default, and the strip the keeper collects against is
 * already onchain. The only thing it cannot supply for you is a key.
 *
 *     PLAZO_KEEPER_KEY=0x… npx @plazo/keeper
 *
 * Add `--dry-run` to see what it would do without sending anything, which is also
 * how you check that the operator is not the only one collecting.
 */
import {privateKeyToAccount} from "viem/accounts";
import type {Address, Hex} from "viem";

import {Keeper} from "./keeper.js";

/**
 * The Arc testnet `PlanFactory`.
 *
 * Overridable with `PLAZO_FACTORY`, but shipping a default is the point: a keeper
 * that required an address from somewhere would require somewhere to get it from,
 * and that somewhere would be Plazo.
 */
const DEFAULT_FACTORY = (process.env.PLAZO_FACTORY ?? "") as Address;

/** Blocks to look back when no start is given. Arc runs at 0.514s, so ~24 hours. */
const DEFAULT_LOOKBACK = 160_000n;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const key = process.env.PLAZO_KEEPER_KEY as Hex | undefined;

  if (!DEFAULT_FACTORY) {
    console.error("Set PLAZO_FACTORY to the PlanFactory address on the network you are keeping.");
    process.exit(2);
  }
  if (!key && !dryRun) {
    console.error("Set PLAZO_KEEPER_KEY, or pass --dry-run to see what would be cranked.");
    process.exit(2);
  }

  const account = key ? privateKeyToAccount(key) : undefined;
  const keeper = new Keeper(
    {
      factory: DEFAULT_FACTORY,
      ...(process.env.PLAZO_RPC_URL ? {rpcUrl: process.env.PLAZO_RPC_URL} : {}),
      send: !dryRun,
    },
    account,
  );

  const head = await keeper.publicClient.getBlockNumber();
  const start = process.env.PLAZO_START_BLOCK
    ? BigInt(process.env.PLAZO_START_BLOCK)
    : head > DEFAULT_LOOKBACK
      ? head - DEFAULT_LOOKBACK
      : 0n;

  const plans = await keeper.discoverPlans(start, head);
  console.log(`found ${plans.length} plan(s) between block ${start} and ${head}`);

  const {actions, sent} = await keeper.run(plans);

  const earnings = actions.reduce((total, action) => total + action.reward, 0n);
  console.log(
    `${actions.length} action(s) worth ${Number(earnings) / 1e6} USDC${
      dryRun ? " — dry run, nothing sent" : `, ${sent.length} transaction(s) sent`
    }`,
  );
  for (const action of actions) {
    console.log(`  ${action.kind}${action.index === undefined ? "" : `(${action.index})`} ${action.plan} — ${action.reason}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
