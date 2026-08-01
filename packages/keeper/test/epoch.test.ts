import {describe, expect, it} from "vitest";

import {describe as describeEpoch, planEpoch, type EpochStatus} from "../src/epoch.js";

function status(overrides: Partial<EpochStatus> = {}): EpochStatus {
  return {
    epoch: 7n,
    endsAt: 1_000n,
    openPlans: 100n,
    markComplete: false,
    unmarkedDelinquencies: 0n,
    now: 2_000n,
    ...overrides,
  };
}

describe("the epoch crank", () => {
  it("waits for the epoch to end", () => {
    const plan = planEpoch(status({now: 500n}), 32);
    expect(plan.due).toBe(false);
    expect(plan.closable).toBe(false);
    expect(plan.blockedBy).toContain("1000");
  });

  it("sizes the mark phase to the open book", () => {
    expect(planEpoch(status({openPlans: 100n}), 32).batches).toBe(4);
    expect(planEpoch(status({openPlans: 32n}), 32).batches).toBe(1);
    expect(planEpoch(status({openPlans: 0n}), 32).batches).toBe(0);
  });

  it("asks for no batches once the phase is complete", () => {
    expect(planEpoch(status({markComplete: true}), 32).batches).toBe(0);
  });

  /**
   * COLL-04, and the reason it is the requirement it is. The book cannot publish a NAV
   * while a delinquency is unrecorded, so every lender waiting on a fill now has a
   * reason to pay for a mark nobody profits from cranking.
   */
  it("refuses to close on an unmarked delinquency, and says so", () => {
    const plan = planEpoch(status({markComplete: true, unmarkedDelinquencies: 3n}), 32);
    expect(plan.due).toBe(true);
    expect(plan.closable).toBe(false);
    expect(plan.blockedBy).toContain("3 delinquencies are unmarked");
  });

  it("gets the singular right, because a human reads it", () => {
    const plan = planEpoch(status({markComplete: true, unmarkedDelinquencies: 1n}), 32);
    expect(plan.blockedBy).toContain("1 delinquency is unmarked");
  });

  it("closes a walked book with nothing outstanding", () => {
    const plan = planEpoch(status({markComplete: true}), 32);
    expect(plan.closable).toBe(true);
    expect(plan.blockedBy).toBeNull();
  });

  it("describes what happened in one line", () => {
    const plan = planEpoch(status({markComplete: true}), 32);
    expect(describeEpoch({plan, marked: 2, closed: true})).toContain("closed after 2 mark batches");
    expect(describeEpoch({plan, marked: 0, closed: false, error: "reverted"})).toContain("reverted");
  });
});
