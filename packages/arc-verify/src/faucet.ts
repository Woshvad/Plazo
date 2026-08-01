/**
 * Faucet aggregation: many small drips into one funding account.
 *
 * `faucet.circle.com` drips roughly 20 USDC per address and the full slice needs
 * north of 400, so the funding account cannot be filled directly. This stands up a
 * row of addresses to collect into, and sweeps them when they are full.
 *
 * **The addresses are derived, not generated.** Each one is
 * `keccak256(deployerKey + "/faucet/" + i)`, the same trick `slice.ts` uses for its
 * borrower and keeper — so there is no key file to write, to gitignore, to lose
 * between sessions, or to leak into a public repository. Run this on any machine
 * holding `DEPLOYER_PRIVATE_KEY` and the same twenty addresses come back. Nothing
 * about that is a convenience: a plaintext key file for twenty funded accounts is a
 * liability with a lifetime, and the alternative here costs nothing.
 *
 *     pnpm --filter @plazo/arc-verify faucet          # addresses, balances, progress
 *     pnpm --filter @plazo/arc-verify faucet sweep    # move it all to the deployer
 *
 * Sweeping is re-runnable. An address that is empty, or too thin to pay for its own
 * transfer, is reported and skipped rather than attempted.
 */
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {arcTestnet} from "viem/chains";

import {ARC_TESTNET_RPC_URL, ARC_USDC} from "@plazo/plan-core";

import {REQUIRED} from "./slice.js";

const TOKEN_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

/** How many collection addresses to stand up unless told otherwise. */
const DEFAULT_COUNT = 20;

/**
 * Gas for one ERC-20 transfer, fixed rather than estimated.
 *
 * `eth_estimateGas` is unusable here for the reason `slice.ts` documents at `send`:
 * the estimator prepays its upper bound out of the very balance the transfer moves,
 * so estimating a sweep of a whole account reports insolvency. A sweep is the exact
 * shape that breaks it. FiatToken's `transfer` into a recipient with a non-zero
 * balance costs ~55k; 80k is headroom, and unused gas is refunded.
 */
const SWEEP_GAS = 80_000n;

/** Native wei per ERC-20 unit. Arc USDC is 18 decimals native, 6 over ERC-20. */
const SCALE = 10n ** 12n;

const SHED_PATTERN = /request limit reached|-32011|too many requests|rate limit/i;

function isShed(error: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (e: unknown): boolean => {
    if (e == null || seen.has(e)) return false;
    seen.add(e);
    if (typeof e === "string") return SHED_PATTERN.test(e);
    if (typeof e !== "object") return false;
    const rec = e as Record<string, unknown>;
    if (rec["code"] === -32011) return true;
    for (const key of ["message", "shortMessage", "details", "reason"]) {
      const v = rec[key];
      if (typeof v === "string" && SHED_PATTERN.test(v)) return true;
    }
    return walk(rec["cause"]) || walk(rec["error"]);
  };
  return walk(error);
}

/** Arc's public RPC sheds ~25% of requests regardless of pacing. Retry those only. */
async function shed<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isShed(error)) throw error;
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  throw last;
}

function usdc(value: bigint): string {
  return `${formatUnits(value, 6)} USDC`;
}

/** The i-th collection address. Deterministic in the deployer key, and only in it. */
export function faucetAccount(deployerKey: Hex, index: number): Account {
  return privateKeyToAccount(keccak256(toHex(`${deployerKey}/faucet/${index}`)));
}

export function faucetAccounts(deployerKey: Hex, count = DEFAULT_COUNT): Account[] {
  return Array.from({length: count}, (_, i) => faucetAccount(deployerKey, i));
}

interface Holding {
  index: number;
  address: Address;
  /** Native balance, 18 decimals. Gas and the loan are one balance on Arc. */
  native: bigint;
}

export async function runFaucet(argv: string[] = process.argv.slice(2)): Promise<void> {
  const deployerKey = process.env["DEPLOYER_PRIVATE_KEY"] as Hex | undefined;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY is required.");

  const command = argv.find((a) => !a.startsWith("--")) ?? "list";
  if (command !== "list" && command !== "sweep") {
    throw new Error(`unknown command "${command}" — expected "list" or "sweep".`);
  }

  const countArg = argv.find((a) => a.startsWith("--count="));
  const count = countArg ? Number(countArg.slice("--count=".length)) : DEFAULT_COUNT;
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    throw new Error(`--count must be an integer in 1..200, got "${countArg}".`);
  }

  const toArg = argv.find((a) => a.startsWith("--to="));
  const deployer = privateKeyToAccount(deployerKey);
  const destination = (toArg ? toArg.slice("--to=".length) : deployer.address) as Address;

  const transport = http(process.env["ARC_TESTNET_RPC_URL"] ?? ARC_TESTNET_RPC_URL);
  const publicClient = createPublicClient({chain: arcTestnet, transport}) as PublicClient;

  const accounts = faucetAccounts(deployerKey, count);

  const holdings: Holding[] = [];
  for (const [index, account] of accounts.entries()) {
    const native = await shed(() => publicClient.getBalance({address: account.address}));
    holdings.push({index, address: account.address, native});
  }

  const collected = holdings.reduce((sum, h) => sum + h.native / SCALE, 0n);
  const onDeployer = (await shed(() => publicClient.getBalance({address: deployer.address}))) / SCALE;

  console.log(`\nFaucet collection addresses — chain ${arcTestnet.id}`);
  console.log(`Derived from DEPLOYER_PRIVATE_KEY; nothing is written to disk.\n`);

  for (const h of holdings) {
    const funded = h.native > 0n;
    console.log(
      `  ${String(h.index).padStart(2, " ")}  ${h.address}  ` +
        `${funded ? usdc(h.native / SCALE).padStart(14, " ") : "         empty"}`,
    );
  }

  const shortfall = REQUIRED > onDeployer + collected ? REQUIRED - onDeployer - collected : 0n;
  console.log(`\n  collected     ${usdc(collected)} across ${holdings.filter((h) => h.native > 0n).length}/${count} addresses`);
  console.log(`  on deployer   ${usdc(onDeployer)}  (${deployer.address})`);
  console.log(`  the slice needs ${usdc(REQUIRED)}`);
  console.log(
    shortfall > 0n
      ? `  still short   ${usdc(shortfall)}\n`
      : `  covered — sweep and run the slice\n`,
  );

  if (command === "list") return;

  // ── sweep ──────────────────────────────────────────────────────────────────
  //
  // Fees are read rather than assumed. Arc's base fee floors at 20 gwei but the
  // ceiling is 20,000, and a sweep computes the amount from the fee — get it wrong
  // low and the transfer reverts for exceeding a balance the gas already debited.
  const block = await shed(() => publicClient.getBlock());
  const baseFee = block.baseFeePerGas ?? 20_000_000_000n;
  const maxPriorityFeePerGas = 1_000_000_000n;
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
  const reserve = SWEEP_GAS * maxFeePerGas;

  console.log(`Sweeping to ${destination}`);
  console.log(`  base fee ${formatUnits(baseFee, 9)} gwei, holding back ${usdc(reserve / SCALE)} per address for gas\n`);

  let swept = 0n;
  let sent = 0;
  const failures: string[] = [];

  for (const h of holdings) {
    if (h.native <= reserve) {
      if (h.native > 0n) console.log(`  ${String(h.index).padStart(2, " ")}  too thin to pay for its own transfer, left alone`);
      continue;
    }

    // The gas is debited from this same balance before the token ever runs, so the
    // amount has to be what survives that, floored to the 6-decimal ERC-20 unit.
    const amount = (h.native - reserve) / SCALE;
    if (amount === 0n) continue;

    const wallet = createWalletClient({
      account: faucetAccount(deployerKey, h.index),
      chain: arcTestnet,
      transport,
    });

    try {
      const hash = await shed(() =>
        wallet.writeContract({
          address: ARC_USDC,
          abi: TOKEN_ABI,
          functionName: "transfer",
          args: [destination, amount],
          gas: SWEEP_GAS,
          maxFeePerGas,
          maxPriorityFeePerGas,
        } as never),
      );
      const receipt = await shed(() => publicClient.waitForTransactionReceipt({hash}));
      if (receipt.status !== "success") throw new Error(`reverted: ${hash}`);
      swept += amount;
      sent++;
      console.log(`  ${String(h.index).padStart(2, " ")}  ${usdc(amount).padStart(14, " ")}  ${hash}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`  ${String(h.index).padStart(2, " ")}  ${h.address}  ${message.split("\n")[0]}`);
      console.log(`  ${String(h.index).padStart(2, " ")}  FAILED — ${message.split("\n")[0]}`);
    }
  }

  const finalBalance = (await shed(() => publicClient.getBalance({address: destination}))) / SCALE;

  console.log(`\n  swept ${usdc(swept)} from ${sent} address${sent === 1 ? "" : "es"}`);
  console.log(`  ${destination} now holds ${usdc(finalBalance)}`);

  if (failures.length > 0) {
    console.log(`\n${failures.length} address${failures.length === 1 ? "" : "es"} did not sweep:`);
    for (const f of failures) console.log(f);
    console.log(`\nRe-running is safe: a swept address is empty and is skipped.`);
    throw new Error(`${failures.length} sweep(s) failed`);
  }

  if (finalBalance < REQUIRED) {
    console.log(`\nStill ${usdc(REQUIRED - finalBalance)} short of the slice.\n`);
  } else {
    console.log(`\nCovered. Next: pnpm --filter @plazo/arc-verify slice\n`);
  }
}
