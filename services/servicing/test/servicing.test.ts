import {describe, expect, it} from "vitest";
import type {Address, Hex} from "viem";

import {
  DEFAULT_HORIZON_MS,
  needsAttention,
  shortfalls,
  sizeTopUp,
  type BalanceSnapshot,
  type UpcomingInstallment,
} from "../src/balance.js";
import {
  DeliveryLog,
  dispatch,
  LEAD_TIMES_MS,
  ladderFor,
  missedNotices,
  receiptNotice,
  type Notice,
  type Transport,
} from "../src/ladder.js";
import {
  AuditLog,
  can,
  NotAuthorized,
  perform,
  waiveFee,
  type ConsoleDeps,
  type Operator,
} from "../src/console.js";
import {batch, eligible, keeperShare, runOnce, type DueInstallment} from "../src/relayer.js";

const BORROWER = "0x00000000000000000000000000000000000b0110" as Address;
const PLAN = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const PLAN_B = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
const NOW = new Date("2026-08-01T12:00:00Z");

function at(hours: number): Date {
  return new Date(NOW.getTime() + hours * 60 * 60 * 1000);
}

function balance(collectable: bigint, elsewhere = 0n): BalanceSnapshot {
  return {borrower: BORROWER, collectable, elsewhere, at: NOW};
}

function due(index: number, amount: bigint, hours: number, planId: Hex = PLAN): UpcomingInstallment {
  return {planId, index, amount, dueAt: at(hours)};
}

// ─────────────────────────────────────────────────────────────────────────────
// XCH-03 / XCH-04 / NOTIF-05
// ─────────────────────────────────────────────────────────────────────────────

describe("the collectable balance", () => {
  it("reports no shortfall when the money is there", () => {
    expect(shortfalls(balance(100_000_000n), [due(0, 25_000_000n, 24)])).toEqual([]);
  });

  /**
   * The case a naive implementation gets wrong. Each installment on its own is covered;
   * together they are not, and together is what a keeper will actually collect.
   */
  it("consumes one balance across the whole window, in due order", () => {
    const found = shortfalls(balance(30_000_000n), [
      due(0, 25_000_000n, 24),
      due(1, 25_000_000n, 48),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]?.index).toBe(1);
    expect(found[0]?.missing).toBe(20_000_000n);
  });

  it("ignores installments beyond the horizon", () => {
    const beyond = DEFAULT_HORIZON_MS / (60 * 60 * 1000) + 24;
    expect(shortfalls(balance(0n), [due(0, 25_000_000n, beyond)])).toEqual([]);
  });

  /**
   * DEC-19. A Gateway balance is never added to the collectable one, because a check on
   * Arc cannot debit it — but it is the difference between "you are short" and "your
   * money is in the wrong place, here is the button".
   */
  it("never counts a cross-chain balance as collectable", () => {
    const found = shortfalls(balance(0n, 100_000_000n), [due(0, 25_000_000n, 24)]);

    expect(found).toHaveLength(1);
    expect(found[0]?.missing).toBe(25_000_000n);
    expect(found[0]?.coveredByElsewhere).toBe(true);
  });

  it("sizes a top-up to the whole window rather than the next payment", () => {
    const topUp = sizeTopUp(balance(0n), [due(0, 25_000_000n, 24), due(1, 25_000_000n, 48)]);

    expect(topUp?.amount).toBe(50_000_000n);
    expect(topUp?.by).toEqual(at(24));
    expect(topUp?.source).toBe("external");
  });

  it("routes the top-up through Gateway when the money exists elsewhere", () => {
    const topUp = sizeTopUp(balance(0n, 60_000_000n), [due(0, 25_000_000n, 24)]);
    expect(topUp?.source).toBe("gateway");
  });

  /** A screen that always shows a top-up button teaches borrowers to ignore it. */
  it("offers nothing when nothing is short", () => {
    expect(sizeTopUp(balance(100_000_000n), [due(0, 25_000_000n, 24)])).toBeNull();
    expect(needsAttention(balance(100_000_000n), [due(0, 25_000_000n, 24)])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NOTIF-01 / NOTIF-02 / NOTIF-03
// ─────────────────────────────────────────────────────────────────────────────

describe("the reminder ladder", () => {
  const schedule = {
    planId: PLAN,
    installments: [
      {index: 0, dueAt: at(24 * 14)},
      {index: 1, dueAt: at(24 * 28)},
    ],
  };

  it("produces one notice per lead time per installment, in send order", () => {
    const ladder = ladderFor(schedule);
    expect(ladder).toHaveLength(2 * LEAD_TIMES_MS.length);

    const times = ladder.map((n) => n.sendAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("keys every notice so a retry cannot produce a second message", async () => {
    const log = new DeliveryLog();
    const notice = receiptNotice(PLAN, 0, NOW);
    const transport: Transport = {send: async () => {}};

    const first = await dispatch([notice], [{channel: "email", address: "a@b.c"}], transport, log, NOW);
    const second = await dispatch([notice], [{channel: "email", address: "a@b.c"}], transport, log, NOW);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(log.all()).toHaveLength(1);
  });

  it("does not send a notice before its time", async () => {
    const log = new DeliveryLog();
    const future: Notice = {...receiptNotice(PLAN, 0, at(48)), sendAt: at(48)};

    const sent = await dispatch([future], [{channel: "email", address: "a@b.c"}], {send: async () => {}}, log, NOW);
    expect(sent).toBe(0);
  });

  /** A log containing only successes cannot tell you an address has been bouncing. */
  it("records failures as well as sends", async () => {
    const log = new DeliveryLog();
    const transport: Transport = {
      send: async () => {
        throw new Error("mailbox full");
      },
    };

    await dispatch([receiptNotice(PLAN, 0, NOW)], [{channel: "email", address: "a@b.c"}], transport, log, NOW);

    expect(log.failures()).toHaveLength(1);
    expect(log.failures()[0]?.detail).toBe("mailbox full");
    expect(log.wasSent(receiptNotice(PLAN, 0, NOW).key)).toBe(false);
  });

  /**
   * The audit the log exists for. The ladder is derivable from the chain by anybody, so
   * "we sent it" is checkable rather than assertable.
   */
  it("reports the notices that should have gone out and did not", () => {
    const log = new DeliveryLog();
    const past = {
      planId: PLAN,
      installments: [{index: 0, dueAt: new Date(NOW.getTime() - 60 * 60 * 1000)}],
    };

    const missed = missedNotices(ladderFor(past), log, NOW);
    expect(missed.length).toBe(LEAD_TIMES_MS.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OPS-04 / COLL-07 / COLL-10
// ─────────────────────────────────────────────────────────────────────────────

describe("the relayer", () => {
  const config = {delayFloorMs: 30 * 60 * 1000, batchSize: 10};

  function installment(overrides: Partial<DueInstallment> = {}): DueInstallment {
    return {
      planId: PLAN,
      plan: "0x00000000000000000000000000000000000a0001" as Address,
      index: 0,
      dueAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      settled: false,
      funded: true,
      ...overrides,
    };
  }

  it("waits out the floor", () => {
    const justDue = installment({dueAt: new Date(NOW.getTime() - 60 * 1000)});
    expect(eligible([justDue], config, NOW)).toEqual([]);
    expect(eligible([installment()], config, NOW)).toHaveLength(1);
  });

  it("skips what a third party already cranked", () => {
    expect(eligible([installment({settled: true})], config, NOW)).toEqual([]);
  });

  /** A pull against an empty balance only produces a bounce the market is paid to record. */
  it("skips an installment the borrower cannot fund", () => {
    expect(eligible([installment({funded: false})], config, NOW)).toEqual([]);
  });

  it("groups a due-date wave into one transaction per plan", () => {
    const planA = "0x00000000000000000000000000000000000a0001" as Address;
    const planB = "0x00000000000000000000000000000000000a0002" as Address;

    const work = batch([
      installment({plan: planA, index: 0}),
      installment({plan: planA, index: 1}),
      installment({plan: planB, index: 0, planId: PLAN_B}),
    ]);

    expect(work).toHaveLength(2);
    expect(work.find((w) => w.plan === planA)?.indices).toEqual([0, 1]);
  });

  /** A relayer that dies on one bad plan stops servicing every other one. */
  it("survives a failing plan and keeps going", async () => {
    const bad = "0x00000000000000000000000000000000000bad01" as Address;
    const good = "0x00000000000000000000000000000000000600d1" as Address;

    const results = await runOnce(
      [installment({plan: bad}), installment({plan: good, planId: PLAN_B})],
      config,
      {
        collectBatch: async (plan) => {
          if (plan === bad) throw new Error("reverted");
        },
      },
      NOW,
    );

    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.error).toBe("reverted");
  });

  it("measures the share of collections the operator did not make", () => {
    const gate = "0x0000000000000000000000000000000000009a7e" as Address;
    const share = keeperShare(
      [
        {planId: PLAN, index: 0, keeper: gate, at: NOW},
        {planId: PLAN, index: 1, keeper: "0x00000000000000000000000000000000000ee111" as Address, at: NOW},
        {planId: PLAN, index: 2, keeper: "0x00000000000000000000000000000000000ee222" as Address, at: NOW},
        {planId: PLAN, index: 3, keeper: "0x00000000000000000000000000000000000ee111" as Address, at: NOW},
      ],
      gate,
    );

    expect(share.total).toBe(4);
    expect(share.byOperator).toBe(1);
    expect(share.thirdPartyBps).toBe(7500);
    expect(share.distinctKeepers).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NOTIF-04 / OPS-07
// ─────────────────────────────────────────────────────────────────────────────

describe("the operator console", () => {
  const support: Operator = {id: "sam", roles: ["support"]};
  const risk: Operator = {id: "rae", roles: ["risk"]};
  const viewer: Operator = {id: "vic", roles: ["readonly"]};

  function deps(): ConsoleDeps {
    return {log: new AuditLog(), now: () => NOW};
  }

  it("grants capabilities by role and nothing beyond them", () => {
    expect(can(support, "fee.waive")).toBe(true);
    expect(can(support, "parameter.set")).toBe(false);
    expect(can(risk, "parameter.set")).toBe(true);
    expect(can(risk, "fee.waive")).toBe(false);
    expect(can(viewer, "plan.read")).toBe(true);
    expect(can(viewer, "plan.note")).toBe(false);
  });

  /**
   * Stopping is an emergency and starting again is a decision. Three roles can trip a
   * pause; one can clear it.
   */
  it("lets more people stop than start", () => {
    expect(can(risk, "pause.trip")).toBe(true);
    expect(can(risk, "pause.clear")).toBe(false);
    expect(can({id: "ada", roles: ["admin"]}, "pause.clear")).toBe(true);
  });

  it("refuses an action the operator does not hold", async () => {
    const d = deps();
    await expect(
      perform(d, support, "parameter.set", "plazo.pool.epochLength", "because", async () => 1),
    ).rejects.toBeInstanceOf(NotAuthorized);
    expect(d.log.all()).toHaveLength(0);
  });

  it("records every action it does allow", async () => {
    const d = deps();
    await waiveFee(
      d,
      support,
      {planId: PLAN, amount: 5_000_000n, reason: "bank held the transfer two days"},
      async () => {},
    );

    expect(d.log.all()).toHaveLength(1);
    expect(d.log.all()[0]?.reason).toContain("bank held");
    expect(d.log.all()[0]?.detail.amount).toBe("5000000");
  });

  /** "Waived the late fee" tells a regulator nothing. The reason is the record. */
  it("will not accept an action without a reason", async () => {
    const d = deps();
    await expect(
      waiveFee(d, support, {planId: PLAN, amount: 1n, reason: "   "}, async () => {}),
    ).rejects.toThrow(/reason/);
  });

  it("chains entries so the log verifies", async () => {
    const d = deps();
    await waiveFee(d, support, {planId: PLAN, amount: 1n, reason: "one"}, async () => {});
    await waiveFee(d, support, {planId: PLAN_B, amount: 2n, reason: "two"}, async () => {});

    expect(d.log.verify()).toEqual({ok: true});
    expect(d.log.all()[1]?.previous).toBe(d.log.all()[0]?.hash);
  });

  /**
   * The property that makes the log evidence rather than a table: an altered entry
   * breaks every hash after it, and `verify` says which one.
   */
  it("reports where a tampered log stops adding up", async () => {
    const log = new AuditLog();
    const d: ConsoleDeps = {log, now: () => NOW};

    await waiveFee(d, support, {planId: PLAN, amount: 1n, reason: "one"}, async () => {});
    await waiveFee(d, support, {planId: PLAN_B, amount: 2n, reason: "two"}, async () => {});

    // Somebody edits the record of the first waiver. The cast through `unknown` is the
    // point: the type system forbids this, so tampering has to be deliberate — and the
    // hash chain is what catches it when somebody deliberate does it anyway.
    const entries = log.all() as unknown as {reason: string}[];
    entries[0]!.reason = "no reason given";

    expect(log.verify()).toEqual({ok: false, brokenAt: 0});
  });
});
