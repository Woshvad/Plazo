/**
 * What a keeper should do with a plan, as a pure function.
 *
 * The decision is separated from the chain deliberately. A keeper that could only
 * be tested by running it against a live network would be a keeper nobody could
 * check, and the claim this whole package exists to support — that collections do
 * not depend on the operator — rests on third parties being able to read, verify and
 * run it.
 *
 * Everything here derives from a snapshot the plan itself publishes. There is no
 * Plazo API call anywhere in this package, because the authorization strip is stored
 * onchain precisely so that a keeper needs the chain and nothing else.
 */
import {collectBounty, GRACE_WINDOW, MARK_BOUNTY} from "@plazo/plan-core";
import type {Address, Hex} from "viem";

/** Mirrors `IInstallmentPlan.PlanState`. Ordinals are the ABI and are frozen. */
export const PlanState = {
  Pending: 0,
  Active: 1,
  Grace: 2,
  Delinquent: 3,
  Disputed: 4,
  Hold: 5,
  HALTED: 6,
  Blocked: 7,
  FraudReversed: 8,
  SettledWithFeeOutstanding: 9,
  Repaid: 10,
  Defaulted: 11,
  Cancelled: 12,
  Refunded: 13,
} as const;
export type PlanState = (typeof PlanState)[keyof typeof PlanState];

/** Mirrors `IInstallmentPlan.InstallmentStatus`. */
export const InstallmentStatus = {
  Pending: 0,
  Cleared: 1,
  Bounced: 2,
  Missed: 3,
  Expired: 4,
  Refunded: 5,
} as const;
export type InstallmentStatus = (typeof InstallmentStatus)[keyof typeof InstallmentStatus];

export interface InstallmentSnapshot {
  index: number;
  status: InstallmentStatus;
  amount: bigint;
  dueDate: bigint;
  graceEndsAt: bigint;
  validBefore: bigint;
}

export interface PlanSnapshot {
  address: Address;
  planId: Hex;
  state: PlanState;
  borrower: Address;
  installments: InstallmentSnapshot[];
  markEscrow: bigint;
  /** Whether the rail itself is down. Read from the token, not from the plan. */
  tokenPaused: boolean;
  /** Whether the borrower's Arc balance covers a given installment. */
  borrowerBalance: bigint;
}

export type ActionKind = "collect" | "markMissed" | "markExpired" | "halt" | "resume";

export interface Action {
  kind: ActionKind;
  plan: Address;
  planId: Hex;
  /** Absent for plan-level actions. */
  index?: number;
  /** What this action pays, in 6-decimal USDC. */
  reward: bigint;
  /** Why it is worth doing now. Logged, so an operator can audit a keeper's choices. */
  reason: string;
}

/** States in which no pull will ever succeed and no mark is meaningful. */
const TERMINAL: ReadonlySet<number> = new Set([
  PlanState.Repaid,
  PlanState.Defaulted,
  PlanState.Cancelled,
  PlanState.Refunded,
]);

/** States where collection is suspended by design rather than by circumstance. */
const SUSPENDED: ReadonlySet<number> = new Set([
  PlanState.Disputed,
  PlanState.Hold,
  PlanState.SettledWithFeeOutstanding,
]);

function isOpen(status: InstallmentStatus): boolean {
  return status === InstallmentStatus.Pending || status === InstallmentStatus.Bounced;
}

/**
 * Everything worth doing to this plan right now, most valuable first.
 *
 * Deliberately conservative about what it proposes. A crank that reverts costs gas
 * and pays nothing, and a keeper that fires optimistically at a whole due-date wave
 * loses money on every plan whose borrower is short — which is the behaviour that
 * kills a keeper market rather than the behaviour that makes one.
 */
export function planActions(plan: PlanSnapshot, now: bigint): Action[] {
  const actions: Action[] = [];

  if (TERMINAL.has(plan.state)) return actions;

  // A paused token suspends the grace and delinquency clocks. Recording the outage
  // is what starts the suspension, and until someone does, every plan in the book is
  // burning grace against an outage nobody could have paid through.
  if (plan.tokenPaused) {
    if (plan.state !== PlanState.HALTED) {
      actions.push({
        kind: "halt",
        plan: plan.address,
        planId: plan.planId,
        // Unpaid: the bounty would be a transfer of the token that is paused. The
        // reward lands on `resume`.
        reward: 0n,
        reason: "the rail is down and this plan's clock is still running",
      });
    }
    return actions;
  }

  if (plan.state === PlanState.HALTED) {
    actions.push({
      kind: "resume",
      plan: plan.address,
      planId: plan.planId,
      reward: MARK_BOUNTY,
      reason: "the rail is back and the plan is still suspended",
    });
    return actions;
  }

  if (SUSPENDED.has(plan.state)) return actions;

  // A blocklisted borrower cannot receive or send, so a pull is guaranteed to bounce
  // and a mark is the only thing left — and even that only once grace has run.
  const blocked = plan.state === PlanState.Blocked;

  for (const installment of plan.installments) {
    if (!isOpen(installment.status)) continue;

    if (now >= installment.validBefore) {
      actions.push({
        kind: "markExpired",
        plan: plan.address,
        planId: plan.planId,
        index: installment.index,
        reward: MARK_BOUNTY,
        reason: "the authorization outlived its window",
      });
      continue;
    }

    if (now > installment.graceEndsAt) {
      actions.push({
        kind: "markMissed",
        plan: plan.address,
        planId: plan.planId,
        index: installment.index,
        reward: MARK_BOUNTY,
        reason: "grace expired uncured",
      });
      // Still worth attempting the pull as well: a borrower can fund an account the
      // moment after grace ends, and the debt survives the mark.
    }

    if (now < installment.dueDate) continue;
    if (blocked) continue;
    if (plan.borrowerBalance < installment.amount) continue;

    actions.push({
      kind: "collect",
      plan: plan.address,
      planId: plan.planId,
      index: installment.index,
      reward: collectBounty(installment.amount, now - installment.dueDate, GRACE_WINDOW),
      reason: "due and funded",
    });
  }

  return actions.sort((a, b) => (b.reward === a.reward ? 0 : b.reward > a.reward ? 1 : -1));
}

/**
 * Whether an action is worth sending at the current gas price.
 *
 * On Arc, gas is USDC and a pull measured at 140,885 gas costs about $0.003, so
 * almost everything clears — but the check exists rather than being assumed, because
 * the base fee has a 20,000 gwei ceiling and the answer stops being obvious near it.
 *
 * A zero-reward action (recording an outage) is judged on whether the keeper *wants*
 * the plan to keep running, not on the reward, and is left to the caller.
 */
export function isProfitable(action: Action, gasPriceWei: bigint, gasEstimate: bigint): boolean {
  if (action.reward === 0n) return false;
  // Arc USDC is 18-decimal natively and 6-decimal over ERC-20, on one balance.
  const costUsdc6 = (gasPriceWei * gasEstimate) / 1_000_000_000_000n;
  return action.reward > costUsdc6;
}

/** Batch the collects for one plan, which is what `collectBatch` exists for. */
export function batchableIndices(actions: Action[]): number[] {
  return actions
    .filter((a) => a.kind === "collect" && a.index !== undefined)
    .map((a) => a.index as number);
}
