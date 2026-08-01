/**
 * The epoch crank, as a keeper job.
 *
 * POOL-04 and COLL-04. The book's NAV is struck by two permissionless calls —
 * `markEpoch` walks the open plans in bounded batches, `closeEpoch` prices the epoch and
 * fills the queues — and neither of them belongs to the operator.
 *
 * That is not a stylistic preference. GOV-08 requires the whole loop to run with every
 * operator role at the zero address, and an epoch only the operator can close is an
 * epoch whose NAV is the operator's opinion about *when* to publish it. A book that has
 * taken a loss and has not closed is a book still quoting yesterday's price, and the
 * party who benefits from the delay is whoever is redeeming.
 *
 * There is no bounty on the crank. The incentive is structural instead: deposits and
 * redemptions do not settle until the epoch closes, so every lender with money in the
 * queue has a reason to run this, and running it costs about a tenth of a cent on Arc.
 * A bounty would have to come from somewhere, and the only somewhere is the LPs who
 * would otherwise have run it for free.
 */

import type {Address, PublicClient, WalletClient} from "viem";

export const POOL_EPOCH_ABI = [
  {
    type: "function",
    name: "markEpoch",
    stateMutability: "nonpayable",
    inputs: [{name: "limit", type: "uint256"}],
    outputs: [{name: "walked", type: "uint256"}],
  },
  {
    type: "function",
    name: "closeEpoch",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "markComplete",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "bool"}],
  },
  {
    type: "function",
    name: "epochEndsAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "currentEpoch",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "openPlans",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "unmarkedDelinquencies",
    stateMutability: "view",
    inputs: [],
    outputs: [{type: "uint256"}],
  },
] as const;

export interface EpochStatus {
  readonly epoch: bigint;
  readonly endsAt: bigint;
  readonly openPlans: bigint;
  readonly markComplete: boolean;
  readonly unmarkedDelinquencies: bigint;
  readonly now: bigint;
}

export interface EpochPlan {
  readonly status: EpochStatus;
  /** Whether the epoch's window has passed. */
  readonly due: boolean;
  /** How many `markEpoch` batches to send before trying to close. */
  readonly batches: number;
  /** Whether `closeEpoch` would succeed after those batches. */
  readonly closable: boolean;
  /** Why it would not, in a sentence a human can act on. */
  readonly blockedBy: string | null;
}

export async function readStatus(
  client: PublicClient,
  pool: Address,
  now: bigint,
): Promise<EpochStatus> {
  const read = {address: pool, abi: POOL_EPOCH_ABI} as const;

  const [epoch, endsAt, openPlans, markComplete, unmarked] = await Promise.all([
    client.readContract({...read, functionName: "currentEpoch"}),
    client.readContract({...read, functionName: "epochEndsAt"}),
    client.readContract({...read, functionName: "openPlans"}),
    client.readContract({...read, functionName: "markComplete"}),
    client.readContract({...read, functionName: "unmarkedDelinquencies"}),
  ]);

  return {epoch, endsAt, openPlans, markComplete, unmarkedDelinquencies: unmarked, now};
}

/**
 * What this pass would do, and why it might not.
 *
 * Every refusal here is one a third party could work out for themselves from the same
 * three reads — which is the property that makes the crank genuinely permissionless
 * rather than merely public.
 */
export function planEpoch(status: EpochStatus, batchSize: number): EpochPlan {
  const due = status.now >= status.endsAt;

  const remaining = status.markComplete ? 0n : status.openPlans;
  const batches = remaining === 0n ? 0 : Number((remaining + BigInt(batchSize) - 1n) / BigInt(batchSize));

  let blockedBy: string | null = null;
  if (!due) {
    blockedBy = `the epoch runs until ${status.endsAt}`;
  } else if (status.unmarkedDelinquencies > 0n) {
    // COLL-04. Somebody has to be paid to record a delinquency nobody profits from
    // collecting, and this is what makes that payment happen: the book cannot publish a
    // NAV while one is outstanding, so every lender in the queue now wants a marker.
    blockedBy = `${status.unmarkedDelinquencies} delinquenc${
      status.unmarkedDelinquencies === 1n ? "y is" : "ies are"
    } unmarked — crank markMissed on them first`;
  }

  return {
    status,
    due,
    batches,
    closable: due && blockedBy === null,
    blockedBy,
  };
}

export interface EpochResult {
  readonly plan: EpochPlan;
  readonly marked: number;
  readonly closed: boolean;
  readonly error?: string;
}

/**
 * Run one pass: walk what needs walking, then close if it will close.
 *
 * Never throws. A crank that dies leaves the book unpriced, and the whole argument for
 * making it permissionless is that a single failure should not be able to do that.
 */
export async function runEpoch(input: {
  publicClient: PublicClient;
  walletClient?: WalletClient;
  account?: Address;
  pool: Address;
  batchSize: number;
  now: bigint;
  send: boolean;
}): Promise<EpochResult> {
  const status = await readStatus(input.publicClient, input.pool, input.now);
  const plan = planEpoch(status, input.batchSize);

  if (!input.send || !plan.due) return {plan, marked: 0, closed: false};

  let marked = 0;
  try {
    for (let i = 0; i < plan.batches; ++i) {
      await write(input, "markEpoch", [BigInt(input.batchSize)]);
      marked += 1;
    }
  } catch (error) {
    return {plan, marked, closed: false, error: message(error)};
  }

  // Re-read rather than trusting the plan. A collection landing between the mark phase
  // and the close is ordinary, and it can move a plan past grace — in which case the
  // close will refuse, correctly, and this pass reports why instead of reverting.
  const after = await readStatus(input.publicClient, input.pool, input.now);
  const revised = planEpoch(after, input.batchSize);
  if (!revised.closable) return {plan: revised, marked, closed: false};

  try {
    await write(input, "closeEpoch", []);
    return {plan: revised, marked, closed: true};
  } catch (error) {
    return {plan: revised, marked, closed: false, error: message(error)};
  }
}

async function write(
  input: {
    walletClient?: WalletClient;
    account?: Address;
    pool: Address;
  },
  functionName: "markEpoch" | "closeEpoch",
  args: readonly bigint[],
): Promise<void> {
  if (!input.walletClient || !input.account) throw new Error("no wallet configured");

  await input.walletClient.writeContract({
    address: input.pool,
    abi: POOL_EPOCH_ABI,
    functionName,
    args: args as never,
    account: input.account,
    chain: null,
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One line for a human watching the crank. */
export function describe(result: EpochResult): string {
  const {plan} = result;
  if (!plan.due) return `epoch ${plan.status.epoch} is still open (${plan.blockedBy})`;
  if (result.closed) return `epoch ${plan.status.epoch} closed after ${result.marked} mark batches`;
  if (result.error) return `epoch ${plan.status.epoch} did not close: ${result.error}`;
  return `epoch ${plan.status.epoch} did not close: ${plan.blockedBy ?? "the mark phase is incomplete"}`;
}
