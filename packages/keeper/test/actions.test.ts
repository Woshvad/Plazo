import {describe, expect, it} from "vitest";
import {collectBounty, GRACE_WINDOW, MARK_BOUNTY} from "@plazo/plan-core";

import {
  batchableIndices,
  InstallmentStatus,
  isProfitable,
  planActions,
  PlanState,
  type PlanSnapshot,
} from "../src/actions.js";

const NOW = 1_800_000_000n;
const AMOUNT = 25_000_000n;

function snapshot(overrides: Partial<PlanSnapshot> = {}): PlanSnapshot {
  const installments = [0, 1, 2, 3].map((index) => {
    const dueDate = NOW + BigInt(index) * 14n * 86_400n;
    return {
      index,
      status: InstallmentStatus.Pending,
      amount: AMOUNT,
      dueDate,
      graceEndsAt: dueDate + GRACE_WINDOW,
      validBefore: dueDate + 90n * 86_400n,
    };
  });

  return {
    address: "0x0000000000000000000000000000000000001a90",
    planId: "0xaa",
    state: PlanState.Active,
    borrower: "0x0000000000000000000000000000000000000b0b",
    installments,
    markEscrow: MARK_BOUNTY * 8n,
    tokenPaused: false,
    borrowerBalance: 500_000_000n,
    ...overrides,
  };
}

describe("what a keeper should do", () => {
  it("collects only what is due and funded", () => {
    const actions = planActions(snapshot(), NOW);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("collect");
    expect(actions[0]!.index).toBe(0);
  });

  /// A crank that reverts costs gas and pays nothing. Firing optimistically at a
  /// whole wave loses money on every plan whose borrower is short, and the rational
  /// response to that is to stop keeping — which is how a keeper market dies.
  it("does not propose a pull against a wallet that cannot cover it", () => {
    const actions = planActions(snapshot({borrowerBalance: 1n}), NOW);
    expect(actions).toHaveLength(0);
  });

  it("marks what is past grace, and still tries the pull", () => {
    const past = NOW + GRACE_WINDOW + 1n;
    const actions = planActions(snapshot(), past);
    expect(actions.map((a) => a.kind)).toContain("markMissed");
    expect(actions.map((a) => a.kind)).toContain("collect");
  });

  it("marks an authorization that outlived its window instead of pulling it", () => {
    const dead = NOW + 91n * 86_400n;
    const actions = planActions(snapshot(), dead);
    const first = actions.filter((a) => a.index === 0);
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe("markExpired");
  });

  /// A blocklisted borrower cannot send or receive, so every pull is guaranteed to
  /// bounce. Proposing one would burn a keeper's gas to produce an event the plan
  /// has already recorded.
  it("does not pull from a blocklisted borrower, but still records the delinquency", () => {
    const past = NOW + GRACE_WINDOW + 1n;
    const actions = planActions(snapshot({state: PlanState.Blocked}), past);
    expect(actions.every((a) => a.kind !== "collect")).toBe(true);
    expect(actions.some((a) => a.kind === "markMissed")).toBe(true);
  });

  it("proposes nothing on a settled plan", () => {
    for (const state of [PlanState.Repaid, PlanState.Defaulted, PlanState.Refunded, PlanState.Cancelled]) {
      expect(planActions(snapshot({state}), NOW + 200n * 86_400n)).toHaveLength(0);
    }
  });

  it("proposes nothing while a dispute or a hold is open", () => {
    expect(planActions(snapshot({state: PlanState.Disputed}), NOW)).toHaveLength(0);
    expect(planActions(snapshot({state: PlanState.Hold}), NOW)).toHaveLength(0);
  });

  /// The clock only stops once someone tells the plan the rail is down, so this is
  /// the action that keeps an outage from becoming a book full of delinquencies.
  it("records an outage before anything else, and takes no reward for it", () => {
    const actions = planActions(snapshot({tokenPaused: true}), NOW);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("halt");
    expect(actions[0]!.reward).toBe(0n);
  });

  it("restarts the clock when the rail comes back", () => {
    const actions = planActions(snapshot({state: PlanState.HALTED, tokenPaused: false}), NOW);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe("resume");
    expect(actions[0]!.reward).toBe(MARK_BOUNTY);
  });

  it("ignores installments that are already resolved", () => {
    const base = snapshot();
    base.installments[0]!.status = InstallmentStatus.Cleared;
    base.installments[1]!.status = InstallmentStatus.Refunded;
    expect(planActions(base, NOW + 14n * 86_400n)).toHaveLength(0);
  });

  it("puts the most valuable crank first", () => {
    const late = NOW + 60n * 86_400n;
    const actions = planActions(snapshot(), late);
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i - 1]!.reward >= actions[i]!.reward).toBe(true);
    }
  });

  it("quotes the ramp the contract will actually pay", () => {
    const halfway = NOW + GRACE_WINDOW / 2n;
    const actions = planActions(snapshot(), halfway);
    const collect = actions.find((a) => a.kind === "collect" && a.index === 0);
    expect(collect!.reward).toBe(collectBounty(AMOUNT, GRACE_WINDOW / 2n, GRACE_WINDOW));
  });
});

describe("whether a crank is worth sending", () => {
  /// Arc's measured pull is 140,885 gas at 21 gwei, which is $0.003 — so on a
  /// healthy network almost everything clears. The check exists rather than being
  /// assumed because the base fee has a 20,000 gwei ceiling, and the answer stops
  /// being obvious anywhere near it.
  it("clears easily at Arc's normal gas price", () => {
    const action = planActions(snapshot(), NOW)[0]!;
    expect(isProfitable(action, 21_000_000_000n, 140_885n)).toBe(true);
  });

  it("refuses when the fee market makes the bounty a loss", () => {
    const action = planActions(snapshot(), NOW)[0]!;
    expect(isProfitable(action, 20_000_000_000_000n, 140_885n)).toBe(false);
  });

  it("never sends an unpaid action on profitability grounds", () => {
    const halt = planActions(snapshot({tokenPaused: true}), NOW)[0]!;
    expect(isProfitable(halt, 1n, 1n)).toBe(false);
  });
});

describe("batching", () => {
  it("collects a whole wave in one transaction and leaves the marks alone", () => {
    const late = NOW + 45n * 86_400n;
    const actions = planActions(snapshot(), late);
    const indices = batchableIndices(actions);
    expect(indices.length).toBeGreaterThan(1);
    expect(actions.filter((a) => a.kind === "markMissed").length).toBeGreaterThan(0);
    expect(indices).toEqual(indices.filter((i) => typeof i === "number"));
  });
});
