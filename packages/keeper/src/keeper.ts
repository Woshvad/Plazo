/**
 * The keeper loop.
 *
 * Discovers plans from the factory's own event stream, reads each one's state
 * directly, decides what is worth cranking, and sends it. There is no Plazo endpoint
 * in this file and there is not supposed to be: the authorization strip lives onchain
 * so that a keeper needs the chain and a key, and nothing else.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {arcTestnet} from "viem/chains";
import {ARC_MAX_LOG_RANGE, ARC_TESTNET_RPC_URL, ARC_USDC} from "@plazo/plan-core";

import {FACTORY_ABI, PLAN_ABI, TOKEN_ABI} from "./abi.js";
import {
  batchableIndices,
  isProfitable,
  planActions,
  type Action,
  type InstallmentSnapshot,
  type InstallmentStatus,
  type PlanSnapshot,
  type PlanState,
} from "./actions.js";

export interface KeeperConfig {
  factory: Address;
  /** Defaults to the public Arc testnet RPC, which needs no signup and no key. */
  rpcUrl?: string;
  token?: Address;
  /** Where to start scanning. Defaults to the factory's own deployment block. */
  startBlock?: bigint;
  /** Rough gas for one crank. Measured at 140,885 on live Arc; padded here. */
  gasEstimate?: bigint;
  /** Log line sink. Defaults to stdout. */
  log?: (message: string) => void;
  /** Set false to decide and report without sending anything. */
  send?: boolean;
}

const DEFAULT_GAS_ESTIMATE = 200_000n;

/**
 * Arc's public RPC sheds roughly a quarter of requests with JSON-RPC -32011,
 * regardless of pacing, and viem does not retry it: a shed request arrives as HTTP
 * 200 with an error body. Anything that reads Arc needs this, so a keeper written
 * without it appears to work and then silently misses cranks.
 */
const SHED = /request limit reached|-32011|too many requests|rate limit/i;

async function withShedRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!SHED.test(message)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
    }
  }
  throw lastError;
}

export class Keeper {
  readonly config: Required<Pick<KeeperConfig, "factory" | "gasEstimate" | "send">> & KeeperConfig;
  readonly publicClient: PublicClient;
  private readonly wallet?: WalletClient;
  private readonly account?: Account;
  private readonly token: Address;
  private readonly log: (message: string) => void;

  constructor(config: KeeperConfig, account?: Account) {
    this.config = {gasEstimate: DEFAULT_GAS_ESTIMATE, send: true, ...config};
    this.token = config.token ?? ARC_USDC;
    this.log = config.log ?? ((message) => console.log(message));

    const transport = http(config.rpcUrl ?? ARC_TESTNET_RPC_URL);
    this.publicClient = createPublicClient({chain: arcTestnet, transport}) as PublicClient;
    if (account) {
      this.account = account;
      this.wallet = createWalletClient({account, chain: arcTestnet, transport});
    }
  }

  /**
   * Every plan the factory has ever deployed.
   *
   * Chunked below 10,000 blocks because the public RPC hard-errors above it with
   * -32614. Arc is past 53 million blocks at half-second block times, so a keeper
   * starts from the factory's deployment rather than from genesis.
   */
  async discoverPlans(fromBlock: bigint, toBlock: bigint): Promise<Address[]> {
    const plans: Address[] = [];
    const step = BigInt(ARC_MAX_LOG_RANGE - 1);

    for (let start = fromBlock; start <= toBlock; start += step) {
      const end = start + step - 1n > toBlock ? toBlock : start + step - 1n;
      const logs = await withShedRetry(() =>
        this.publicClient.getLogs({
          address: this.config.factory,
          fromBlock: start,
          toBlock: end,
        }),
      );
      for (const parsed of parseEventLogs({abi: FACTORY_ABI, eventName: "PlanDeployed", logs})) {
        plans.push(parsed.args.plan);
      }
    }

    return plans;
  }

  /** Read everything the decision needs, in as few round trips as the RPC allows. */
  async snapshot(plan: Address): Promise<PlanSnapshot> {
    const contract = {address: plan, abi: PLAN_ABI} as const;

    const [planId, state, borrower, count, markEscrow] = await withShedRetry(() =>
      this.publicClient.multicall({
        contracts: [
          {...contract, functionName: "planId"},
          {...contract, functionName: "state"},
          {...contract, functionName: "borrower"},
          {...contract, functionName: "installmentCount"},
          {...contract, functionName: "markEscrow"},
        ],
        allowFailure: false,
      }),
    );

    const indices = Array.from({length: Number(count)}, (_, i) => BigInt(i));
    const reads = await withShedRetry(() =>
      this.publicClient.multicall({
        contracts: indices.flatMap((index) => [
          {...contract, functionName: "installmentStatus", args: [index]} as const,
          {...contract, functionName: "installmentAmount", args: [index]} as const,
          {...contract, functionName: "dueDate", args: [index]} as const,
          {...contract, functionName: "graceEndsAt", args: [index]} as const,
          {...contract, functionName: "validBefore", args: [index]} as const,
        ]),
        allowFailure: false,
      }),
    );

    const installments: InstallmentSnapshot[] = indices.map((_, i) => ({
      index: i,
      status: Number(reads[i * 5]) as InstallmentStatus,
      amount: reads[i * 5 + 1] as bigint,
      dueDate: reads[i * 5 + 2] as bigint,
      graceEndsAt: reads[i * 5 + 3] as bigint,
      validBefore: reads[i * 5 + 4] as bigint,
    }));

    const [tokenPaused, borrowerBalance] = await withShedRetry(() =>
      this.publicClient.multicall({
        contracts: [
          {address: this.token, abi: TOKEN_ABI, functionName: "paused"} as const,
          {
            address: this.token,
            abi: TOKEN_ABI,
            functionName: "balanceOf",
            args: [borrower as Address],
          } as const,
        ],
        allowFailure: false,
      }),
    );

    return {
      address: plan,
      planId: planId as Hex,
      state: Number(state) as PlanState,
      borrower: borrower as Address,
      installments,
      markEscrow: markEscrow as bigint,
      tokenPaused: tokenPaused as boolean,
      borrowerBalance: borrowerBalance as bigint,
    };
  }

  /**
   * One pass over the book.
   *
   * Returns what it did rather than logging and forgetting, so the same code can run
   * as a daemon, as a one-shot cron, or inside a test.
   */
  async run(plans: Address[]): Promise<{actions: Action[]; sent: Hex[]}> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const gasPrice = await withShedRetry(() => this.publicClient.getGasPrice());

    const chosen: Action[] = [];
    const sent: Hex[] = [];

    for (const plan of plans) {
      const snapshot = await this.snapshot(plan);
      const actions = planActions(snapshot, now);
      if (actions.length === 0) continue;

      const worthwhile = actions.filter(
        (action) =>
          action.kind === "halt" || isProfitable(action, gasPrice, this.config.gasEstimate!),
      );
      if (worthwhile.length === 0) {
        this.log(`skip  ${plan} — ${actions.length} action(s) below the gas floor`);
        continue;
      }

      chosen.push(...worthwhile);
      if (!this.config.send || !this.wallet || !this.account) continue;

      for (const hash of await this.execute(worthwhile)) sent.push(hash);
    }

    return {actions: chosen, sent};
  }

  private async execute(actions: Action[]): Promise<Hex[]> {
    const wallet = this.wallet!;
    const account = this.account!;
    const hashes: Hex[] = [];
    const plan = actions[0]!.plan;

    // Batch the collects. Each index still pays its own bounty at its own point on
    // the ramp, so this is purely a saving on calldata and signatures — a batch never
    // costs the keeper a discount, which is what keeps single cranks viable.
    const collects = batchableIndices(actions);
    if (collects.length > 1) {
      hashes.push(
        await wallet.writeContract({
          account,
          chain: arcTestnet,
          address: plan,
          abi: PLAN_ABI,
          functionName: "collectBatch",
          args: [collects.map(BigInt)],
        }),
      );
    }

    for (const action of actions) {
      if (action.kind === "collect" && collects.length > 1) continue;

      const args = action.index === undefined ? [] : [BigInt(action.index)];
      hashes.push(
        await wallet.writeContract({
          account,
          chain: arcTestnet,
          address: plan,
          abi: PLAN_ABI,
          functionName: action.kind,
          args: args as never,
        }),
      );
      this.log(`send  ${action.kind}(${action.index ?? ""}) on ${plan} — ${action.reason}`);
    }

    return hashes;
  }
}
