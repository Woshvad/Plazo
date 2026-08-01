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
 *
 * `--epoch` runs the funding book's crank instead: `markEpoch` in bounded batches,
 * then `closeEpoch`. It pays no bounty and does not need to — deposits and redemptions
 * do not settle until the epoch closes, so every lender with money in the queue has a
 * reason to run it, and on Arc it costs about a tenth of a cent. Set `PLAZO_POOL`.
 */
import {privateKeyToAccount} from "viem/accounts";
import type {Address, Hex} from "viem";

import {Keeper} from "./keeper.js";
import {describe as describeEpoch, runEpoch} from "./epoch.js";

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

  if (process.argv.includes("--epoch")) return epoch(dryRun, key);

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

/**
 * POOL-04 and COLL-04, from the outside.
 *
 * The refusals are the interesting output. An epoch that will not close because a
 * delinquency is unmarked is the book telling whoever wants their money that somebody
 * has to be paid to record a loss first — which is exactly the pressure that makes the
 * bountied mark happen at all.
 */
async function epoch(dryRun: boolean, key: Hex | undefined): Promise<void> {
  const pool = process.env.PLAZO_POOL as Address | undefined;
  if (!pool) {
    console.error("Set PLAZO_POOL to the TranchedCreditPool address.");
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

  const block = await keeper.publicClient.getBlock();
  const result = await runEpoch({
    publicClient: keeper.publicClient,
    ...(keeper.walletClient ? {walletClient: keeper.walletClient} : {}),
    ...(account ? {account: account.address} : {}),
    pool,
    batchSize: Number(process.env.PLAZO_EPOCH_BATCH ?? "32"),
    now: block.timestamp,
    send: !dryRun && account !== undefined,
  });

  console.log(describeEpoch(result));
  console.log(
    `  open plans ${result.plan.status.openPlans}, mark phase ${
      result.plan.status.markComplete ? "complete" : "incomplete"
    }, unmarked delinquencies ${result.plan.status.unmarkedDelinquencies}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
