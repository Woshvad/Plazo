/**
 * The operator's keeper — redundancy, not infrastructure.
 *
 * OPS-04 and COLL-07. The claim this protocol makes is that collections happen because
 * a bounty makes them worth cranking, not because a company runs a cron job, and
 * COLL-10 measures whether that is true. This service exists so that the claim is
 * testable rather than aspirational: it collects only what nobody else did, only after
 * the floor, and only through `RelayerGate`.
 *
 * Three properties, and all three are what make the measurement meaningful.
 *
 * **It goes through the gate.** Every transaction the operator sends comes from one
 * address whose contract refuses to forward a crank inside the delay floor. An outsider
 * can therefore verify from the chain alone that the operator's collections all came
 * from there and all came late — which is not a claim anyone has to take on trust, and
 * would be if the delay lived in this file's configuration.
 *
 * **It skips what is already done.** A plan a third party has cranked is not re-cranked;
 * there is nothing to collect and the transaction would burn gas to emit nothing.
 *
 * **It can be switched off.** GOV-08 says the whole loop runs with every operator role
 * at the zero address. Nothing in the servicing stack is allowed to become the reason a
 * borrower's plan works, and this is the component most likely to drift into it.
 */

import type {Address, Hex} from "viem";

export interface DueInstallment {
  readonly planId: Hex;
  readonly plan: Address;
  readonly index: number;
  readonly dueAt: Date;
  /** Whether an installment has already reached a terminal status. */
  readonly settled: boolean;
  /** Whether the borrower's collectable balance covers it. */
  readonly funded: boolean;
}

export interface RelayerConfig {
  /**
   * The onchain floor, read from `RelayerGate.delayFloor()` rather than configured.
   *
   * Passed in rather than hard-coded so this service cannot disagree with the contract
   * that will refuse it. If they ever differ, the contract wins and this just wastes a
   * transaction — which is the correct direction for the disagreement to fail.
   */
  readonly delayFloorMs: number;
  /** How many cranks to send in one pass. */
  readonly batchSize: number;
}

export interface CrankPlan {
  readonly plan: Address;
  readonly indices: readonly number[];
}

/**
 * What the operator is allowed to crank right now.
 *
 * Everything filtered out here is filtered out for a reason a third party could also
 * work out: it is not due yet, the floor has not passed, someone already did it, or the
 * borrower has no money and the pull would only produce a bounce the market is already
 * paid to record.
 */
export function eligible(
  due: readonly DueInstallment[],
  config: RelayerConfig,
  now: Date,
): DueInstallment[] {
  return due
    .filter((i) => !i.settled)
    .filter((i) => i.funded)
    .filter((i) => now.getTime() >= i.dueAt.getTime() + config.delayFloorMs)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
    .slice(0, config.batchSize);
}

/**
 * Group eligible cranks by plan, so a due-date wave costs one transaction per plan.
 *
 * `collectBatch` prices each index at its own point on the Dutch ramp, so batching costs
 * exactly what the same cranks would cost sent singly. There is no discount, which is
 * deliberate — a batch discount would quietly make single collection unprofitable and
 * hand the keeper market to whoever can afford to aggregate.
 */
export function batch(eligibleInstallments: readonly DueInstallment[]): CrankPlan[] {
  const byPlan = new Map<Address, number[]>();

  for (const installment of eligibleInstallments) {
    const indices = byPlan.get(installment.plan) ?? [];
    indices.push(installment.index);
    byPlan.set(installment.plan, indices);
  }

  return [...byPlan.entries()].map(([plan, indices]) => ({plan, indices}));
}

export interface CrankResult {
  readonly plan: Address;
  readonly indices: readonly number[];
  readonly ok: boolean;
  readonly error?: string;
}

export interface GateClient {
  collectBatch(plan: Address, indices: readonly number[]): Promise<void>;
}

/**
 * Run one pass. Never throws — a relayer that dies on one bad plan stops servicing
 * every other one, and the plans it stopped servicing are collectable by anybody.
 */
export async function runOnce(
  due: readonly DueInstallment[],
  config: RelayerConfig,
  gate: GateClient,
  now: Date,
): Promise<CrankResult[]> {
  const work = batch(eligible(due, config, now));
  const results: CrankResult[] = [];

  for (const item of work) {
    try {
      await gate.collectBatch(item.plan, item.indices);
      results.push({plan: item.plan, indices: item.indices, ok: true});
    } catch (error) {
      results.push({
        plan: item.plan,
        indices: item.indices,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// COLL-10 — the measurement
// ─────────────────────────────────────────────────────────────────────────────

export interface CollectionRecord {
  readonly planId: Hex;
  readonly index: number;
  readonly keeper: Address;
  readonly at: Date;
}

export interface KeeperShare {
  readonly total: number;
  readonly byOperator: number;
  readonly byThirdParty: number;
  /** The number the claim rests on, in basis points. */
  readonly thirdPartyBps: number;
  readonly distinctKeepers: number;
}

/**
 * How much of the collection work the operator is not doing.
 *
 * The honest version of "permissionless collection". A protocol whose collections
 * technically may be cranked by anyone but where nobody ever does has an operator
 * dependency it has not admitted to, and this is the number that would show it.
 *
 * `gate` is the `RelayerGate` address, because that — not the operator's EOA — is the
 * `msg.sender` of every crank the operator makes.
 */
export function keeperShare(
  collections: readonly CollectionRecord[],
  gate: Address,
): KeeperShare {
  const gateLower = gate.toLowerCase();
  const byOperator = collections.filter((c) => c.keeper.toLowerCase() === gateLower).length;
  const total = collections.length;
  const byThirdParty = total - byOperator;

  return {
    total,
    byOperator,
    byThirdParty,
    thirdPartyBps: total === 0 ? 0 : Math.round((byThirdParty * 10_000) / total),
    distinctKeepers: new Set(
      collections.map((c) => c.keeper.toLowerCase()).filter((k) => k !== gateLower),
    ).size,
  };
}
