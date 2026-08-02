/**
 * `AuditLog` over Postgres. D-19.
 *
 * The hash chain is the property; the storage is not — so the chain computation stays
 * exactly where it was, in `console.ts`, and only the storage moves. `chainEntry` and
 * `verifyChain` are the same functions the in-memory implementation calls, which is what
 * makes the two produce byte-identical chains from the same inputs and what makes a log
 * written by one verifiable by the other.
 *
 * ## The fork, and why it is a constraint rather than a check
 *
 * An append reads the head, chains onto it and inserts. Two appends racing read the same
 * head and chain onto the same predecessor. A store that checked "does an entry with this
 * predecessor already exist?" in application code would lose that race by construction:
 * both readers see no such entry, both insert, and the log now has two mutually
 * inconsistent futures either of which can be presented as the record. That is a fork, and
 * a forked audit log is not evidence of anything.
 *
 * `operator.audit_entry.prev_hash` is `UNIQUE`. The second insert raises SQLSTATE 23505
 * inside the database, before either row is visible to anybody, and this file rethrows it
 * as `AuditForkError`. Never swallowed and never retried: a retry would silently reorder
 * two audited actions, and the caller is the only party that knows whether re-attempting
 * its action is safe.
 *
 * ## No mutation path
 *
 * There is no update and no delete here, and their absence is the point rather than an
 * oversight (T-06-02b-01). In a deployed environment the application role's grants on this
 * table are `INSERT` and `SELECT` only, so the absence is enforced twice: once in code a
 * reviewer reads, once in a grant a reviewer can query.
 */
import {asc, desc} from "drizzle-orm";

import {auditEntry} from "../db/schema.js";
import {
  chainEntry,
  GENESIS,
  verifyChain,
  type AuditAppend,
  type AuditEntry,
  type AuditIntegrity,
  type AuditLog,
} from "../console.js";
import type {Db} from "../db/client.js";
import type {Hex} from "viem";

/**
 * Two entries claimed the same predecessor.
 *
 * A typed error rather than a re-thrown driver exception, because the caller has to be
 * able to tell "somebody else appended first, re-read and try again" apart from "the
 * database is down". Those want opposite responses and a bare `PostgresError` makes them
 * look the same.
 */
export class AuditForkError extends Error {
  constructor(
    readonly previous: Hex,
    readonly seq: number,
    options?: {cause?: unknown},
  ) {
    super(
      `audit log fork: an entry already claims predecessor ${previous} (attempted seq ${seq}). ` +
        "The append was refused by the database, not merely detected.",
      options,
    );
    this.name = "AuditForkError";
  }
}

/**
 * SQLSTATE 23505, wherever it ended up in the chain.
 *
 * Drizzle wraps a driver error in a `DrizzleQueryError` and hangs the original off `cause`,
 * so the code is one level down and not always the same level — checking only the top of
 * the chain silently misses every violation, which is exactly what the fork test caught the
 * first time it ran. Walking the chain is bounded rather than recursive because a cycle in a
 * `cause` chain is not impossible and a hang here would look like a deadlock.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    if ((current as {code?: unknown}).code === "23505") return true;
    current = (current as {cause?: unknown}).cause;
  }

  return false;
}

/**
 * The row as it comes back, turned into the entry the chain was computed over.
 *
 * `at` is a `timestamptz` and comes back as a `Date`; `payload` is `jsonb` and comes back
 * with its keys in whatever order Postgres chose. Neither matters, because `auditPreimage`
 * sorts `detail` before hashing and `toISOString()` is exact — which is the reason it sorts.
 */
function toEntry(row: typeof auditEntry.$inferSelect): AuditEntry {
  return {
    seq: row.seq,
    at: row.at,
    operator: row.actor,
    capability: row.capability as AuditEntry["capability"],
    subject: row.subject,
    reason: row.reason,
    detail: row.payload,
    previous: row.prevHash as Hex,
    hash: row.entryHash as Hex,
  };
}

export class PgAuditLog implements AuditLog {
  constructor(private readonly database: Db) {}

  async head(): Promise<Hex> {
    const rows = await this.database
      .select({entryHash: auditEntry.entryHash})
      .from(auditEntry)
      .orderBy(desc(auditEntry.seq))
      .limit(1);

    return (rows[0]?.entryHash as Hex | undefined) ?? GENESIS;
  }

  async all(): Promise<readonly AuditEntry[]> {
    const rows = await this.database.select().from(auditEntry).orderBy(asc(auditEntry.seq));
    return rows.map(toEntry);
  }

  async for(subject: string): Promise<readonly AuditEntry[]> {
    const rows = await this.database.select().from(auditEntry).orderBy(asc(auditEntry.seq));
    return rows.filter((row) => row.subject === subject).map(toEntry);
  }

  /**
   * Read the tail, chain onto it, insert.
   *
   * The read and the insert are deliberately **not** wrapped in a transaction taking a
   * lock. A lock would serialise appends and hide the race rather than resolve it, and the
   * hiding is worse: the fork would become impossible to observe in testing and would
   * reappear the first time two processes ran. The unique constraint is the resolution,
   * and it works across processes, across connections and across restarts, which a
   * application-level lock does not.
   */
  async append(input: AuditAppend): Promise<AuditEntry> {
    const tail = await this.database
      .select({seq: auditEntry.seq, entryHash: auditEntry.entryHash})
      .from(auditEntry)
      .orderBy(desc(auditEntry.seq))
      .limit(1);

    const previous = (tail[0]?.entryHash as Hex | undefined) ?? GENESIS;
    const seq = tail[0] ? tail[0].seq + 1 : 0;
    const entry = chainEntry(previous, seq, input);

    try {
      await this.database.insert(auditEntry).values({
        seq: entry.seq,
        prevHash: entry.previous,
        entryHash: entry.hash,
        actor: entry.operator,
        capability: entry.capability,
        subject: entry.subject,
        reason: entry.reason,
        payload: entry.detail as Record<string, string>,
        at: entry.at,
      });
    } catch (cause) {
      if (isUniqueViolation(cause)) throw new AuditForkError(previous, seq, {cause});
      throw cause;
    }

    return entry;
  }

  /**
   * Recompute the whole chain from the rows.
   *
   * Reads everything on purpose. A verification that trusted an index, a cached head or a
   * stored "last verified" marker would be verifying the thing it is meant to be checking.
   * The log is an operator-action log rather than a transaction log, so the row count is
   * bounded by how often humans act, and reading it whole is affordable for the whole life
   * of the system.
   */
  async verify(): Promise<AuditIntegrity> {
    return verifyChain(await this.all());
  }
}
