/**
 * The audit log against a real Postgres. D-19.
 *
 * Two claims are under test and neither can be made without a database.
 *
 * **It survives a restart.** An in-memory audit log is not evidence; it says whatever the
 * process holding it happened to remember, and it remembers nothing across a deploy. The
 * restart is simulated the only honest way — a second, independent connection reads back
 * what the first wrote, with no shared object between them.
 *
 * **It cannot fork.** Two entries claiming the same predecessor are two mutually
 * inconsistent histories, either of which can be presented as "the log". The plan's whole
 * design turns on that being a database constraint rather than an application check, and
 * the difference only shows up under a genuine read-then-write race — which is why the fork
 * test below goes to the trouble of holding a transaction open rather than appending twice
 * and hoping.
 */
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import type postgres from "postgres";

import {GENESIS, verifyChain, type AuditEntry} from "../src/console.js";
import {AuditForkError, PgAuditLog} from "../src/store/pg-audit.js";
import {PgDeliveryLog} from "../src/store/pg-deliveries.js";
import {openTestDatabase, type TestDatabase} from "./db.fixture.js";

const PLAN = "0x1111111111111111111111111111111111111111111111111111111111111111";
const AT = new Date("2026-08-02T09:00:00.000Z");

let fixture: TestDatabase;

beforeAll(async () => {
  fixture = await openTestDatabase();
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

function entry(n: number, overrides: Partial<Parameters<PgAuditLog["append"]>[0]> = {}) {
  return {
    at: new Date(AT.getTime() + n * 60_000),
    operator: "sam",
    capability: "fee.waive" as const,
    subject: PLAN,
    reason: `waiver number ${n}`,
    detail: {amount: String(n * 1_000_000)},
    ...overrides,
  };
}

describe("the audit log, persisted", () => {
  it("chains three entries and verifies", async () => {
    const log = new PgAuditLog(fixture.db);

    const first = await log.append(entry(0));
    const second = await log.append(entry(1));
    const third = await log.append(entry(2));

    expect(first.seq).toBe(0);
    expect(first.previous).toBe(GENESIS);
    expect(second.previous).toBe(first.hash);
    expect(third.previous).toBe(second.hash);

    expect(await log.head()).toBe(third.hash);
    expect(await log.verify()).toEqual({ok: true});
  });

  /**
   * The restart. A second connection, a second store object, no shared state — which is
   * exactly what a redeploy leaves behind.
   *
   * `verifyChain` is run over the rows the *reader* got rather than trusting the writer's
   * return values, because the interesting failure is a `jsonb` payload coming back with
   * its keys reordered. `auditPreimage` sorts `detail` before hashing precisely so that
   * cannot break the chain, and this is the assertion that proves the sort is doing it.
   */
  it("survives a restart, and the chain still verifies on the other side", async () => {
    const reader = new PgAuditLog(fixture.connect());
    const entries = await reader.all();

    expect(entries).toHaveLength(3);
    expect(entries[0]?.reason).toBe("waiver number 0");
    expect(entries[0]?.detail).toEqual({amount: "0"});
    expect(entries[2]?.detail).toEqual({amount: "2000000"});
    expect(verifyChain(entries as readonly AuditEntry[])).toEqual({ok: true});
  });

  it("filters by subject without losing the sequence", async () => {
    const log = new PgAuditLog(fixture.db);
    await log.append(entry(3, {subject: "plazo.pool.epochLength", capability: "parameter.set"}));

    const forPlan = await log.for(PLAN);
    expect(forPlan).toHaveLength(3);
    expect(forPlan.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it("refuses an action with no reason, before it reaches the database", async () => {
    const log = new PgAuditLog(fixture.db);
    const before = (await log.all()).length;

    await expect(log.append(entry(9, {reason: "   "}))).rejects.toThrow(/reason/);
    expect(await log.all()).toHaveLength(before);
  });

  /**
   * The fork, reproduced rather than simulated.
   *
   * A racing writer reads the head, chains onto it, and inserts. Two of them read the same
   * head. To get that deterministically, one writer's insert is held inside an open
   * transaction: `PgAuditLog.append` then reads a head that does not yet include it —
   * because an uncommitted row is invisible — chains onto the same predecessor, and blocks
   * on the unique index. Committing the held transaction is what turns the block into
   * SQLSTATE 23505.
   *
   * Appending twice concurrently and hoping the reads interleave would test the scheduler,
   * not the constraint, and would go green on a slow day for the wrong reason.
   *
   * ## Why the racer takes a `seq` far from the next one
   *
   * The first version of this test gave the racer the seq the store was about to use, which
   * is what a real race produces — and it passed with the `prev_hash` unique constraint
   * *deleted*, because the primary key on `seq` raises SQLSTATE 23505 too. It was asserting
   * that some constraint fired, which is not the claim. Moving the racer's seq out of the
   * way leaves `prev_hash` as the only thing the two rows can collide on, so deleting that
   * constraint turns this red, which is the whole reason for running the check.
   */
  it("raises AuditForkError rather than inserting a second entry on the same predecessor", async () => {
    const log = new PgAuditLog(fixture.db);
    const sql = fixture.raw();

    const head = await log.head();
    const before = (await log.all()).length;
    // Deliberately not `before` — see the note above. Only `prev_hash` may collide.
    const racerSeq = before + 7;

    let releaseHeld: () => void = () => {};
    let insertLanded: () => void = () => {};
    const held = new Promise<void>((resolve) => (releaseHeld = resolve));
    const landed = new Promise<void>((resolve) => (insertLanded = resolve));

    const racer = sql.begin(async (tx) => {
      await tx`
        insert into operator.audit_entry
          (seq, prev_hash, entry_hash, actor, capability, subject, reason, payload, at)
        values (
          ${racerSeq}, ${head}, ${"0x" + "ab".repeat(32)}, 'racer', 'fee.waive',
          ${PLAN}, 'the other writer got there first', ${sql.json({})}, ${new Date()}
        )`;
      insertLanded();
      await held;
    });

    await landed;
    const attempt = log.append(entry(4));
    await waitUntilBlocked(sql, fixture.name);
    releaseHeld();
    await racer;

    await expect(attempt).rejects.toBeInstanceOf(AuditForkError);
    await expect(attempt).rejects.toThrow(/fork/);

    // The refused append left nothing behind: the racer's row is the only new one.
    const after = await log.all();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)?.reason).toBe("the other writer got there first");
  }, 30_000);
});

describe("the notice delivery log, persisted", () => {
  it("records a send, a failure, and survives a restart", async () => {
    const writer = new PgDeliveryLog(fixture.db);

    await writer.record({
      key: `${PLAN}:0:receipt`,
      kind: "receipt",
      planId: PLAN,
      channel: "email",
      recipient: "a@b.c",
      outcome: "sent",
      at: AT,
    });
    await writer.record({
      key: `${PLAN}:1:upcoming`,
      kind: "upcoming",
      planId: PLAN,
      channel: "email",
      recipient: "a@b.c",
      outcome: "failed",
      at: new Date(AT.getTime() + 1000),
      detail: "mailbox full",
    });

    const reader = new PgDeliveryLog(fixture.connect());

    expect(await reader.wasSent(`${PLAN}:0:receipt`)).toBe(true);
    // A failed attempt must not suppress the retry, which is the one rule that decides
    // whether a borrower whose mail server hiccuped once ever hears about a payment again.
    expect(await reader.wasSent(`${PLAN}:1:upcoming`)).toBe(false);

    const failures = await reader.failures();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.detail).toBe("mailbox full");

    const sent = (await reader.for(PLAN)).find((r) => r.outcome === "sent");
    expect(sent?.at.toISOString()).toBe(AT.toISOString());
    // Absent, not null: `detail` is optional and a stored null would make the restored
    // record unequal to the one that was written.
    expect(sent && "detail" in sent).toBe(false);
  });
});

/**
 * Wait until something in this database is blocked on a lock.
 *
 * Polling `pg_stat_activity` rather than sleeping a guessed interval: a fixed sleep is a
 * flake that only appears on a loaded machine, and this asserts the state the test actually
 * depends on instead of hoping for it.
 */
async function waitUntilBlocked(sql: postgres.Sql, datname: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await sql`
      select 1 from pg_stat_activity
      where datname = ${datname} and state = 'active' and wait_event_type = 'Lock'`;
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the second append never blocked on the unique index — the constraint may be missing");
}
