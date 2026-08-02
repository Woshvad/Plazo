/**
 * A token bucket in Postgres, keyed by API key.
 *
 * ## Why not a library
 *
 * The obvious choice is `hono-rate-limiter`. It is 0.x, roughly seven months since its
 * last publish, and — the part that actually decides it — its default store is process
 * memory. An in-memory limiter is not a limit; it is a limit *between deploys*, and it is
 * a limit per process, so two replicas serve twice the quota and a rolling restart serves
 * an unbounded amount. Configuring a Postgres store for it is more code than the fifty
 * lines below, and it would still be a dependency on the authentication path.
 *
 * Postgres is already the operator's one datastore (D-17), so this costs no
 * infrastructure and survives everything a deploy can do to a process.
 *
 * ## Fixed window, not a sliding log
 *
 * `(keyId, windowStart)` is the primary key 06-02a declared, so a window is a row and an
 * expired window is a row to delete rather than state to reconcile. A sliding log would
 * be more precise at the boundary and would cost a row per request; the boundary
 * imprecision here is that a caller can spend two windows' quota across one window edge,
 * which for an operator API protecting against runaway automation is not a distinction
 * worth a table scan.
 *
 * ## The decrement is atomic in the database, not in this process
 *
 * One statement: insert the window, or decrement it if it exists **and has tokens left**.
 * If the guard fails, no row comes back and the request is refused. Two processes racing
 * cannot both see "one token left" and both spend it, because neither of them ever reads
 * a count into JavaScript and writes it back.
 */
import {and, eq, lt, sql} from "drizzle-orm";

import {rateLimitBucket} from "./db/schema.js";
import type {Db} from "./db/client.js";

/** Requests per window, and how long a window is. */
export interface BucketPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

/** The default: 300 requests a minute per key. Generous for a merchant, useless for a bot. */
export const DEFAULT_POLICY: BucketPolicy = {limit: 300, windowMs: 60_000};

export interface RateDecision {
  readonly allowed: boolean;
  /** Tokens left after this request. Zero on a refusal. */
  readonly remaining: number;
  /** When the window rolls over, which is when a refused caller may retry. */
  readonly resetAt: Date;
  readonly limit: number;
}

/** The seam. A route depends on this, not on Postgres. */
export interface RateLimiter {
  consume(key: string): Promise<RateDecision>;
}

/** Never refuses. For a process with no database wired, and for unit tests of routes. */
export const unlimited: RateLimiter = {
  consume: async () => ({allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetAt: new Date(0), limit: 0}),
};

function windowStartFor(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Spend one token, atomically.
 *
 * Returns the decision rather than throwing, because a refusal is a normal answer with a
 * status code and a `retry-after`, not an exception.
 */
export async function consume(
  db: Db,
  key: string,
  policy: BucketPolicy = DEFAULT_POLICY,
  now: Date = new Date(),
): Promise<RateDecision> {
  const windowStart = windowStartFor(now, policy.windowMs);
  const resetAt = new Date(windowStart.getTime() + policy.windowMs);

  const rows = await db
    .insert(rateLimitBucket)
    .values({keyId: key, windowStart, tokens: policy.limit - 1, refilledAt: now})
    .onConflictDoUpdate({
      target: [rateLimitBucket.keyId, rateLimitBucket.windowStart],
      set: {tokens: sql`${rateLimitBucket.tokens} - 1`, refilledAt: now},
      // The guard, and the whole reason this is one statement: a row with no tokens is
      // not updated, so nothing is returned and the caller is refused. Without it the
      // count would go negative and every subsequent request would still "succeed".
      setWhere: sql`${rateLimitBucket.tokens} > 0`,
    })
    .returning({tokens: rateLimitBucket.tokens});

  const row = rows[0];
  if (!row) return {allowed: false, remaining: 0, resetAt, limit: policy.limit};

  // A fresh window is the only time `tokens` comes back at `limit - 1`, so it is also the
  // cheapest moment to drop this key's dead windows. Doing it on every request would put
  // a delete on the hot path to reclaim rows that cost nothing until they accumulate.
  if (row.tokens === policy.limit - 1) {
    await db
      .delete(rateLimitBucket)
      .where(and(eq(rateLimitBucket.keyId, key), lt(rateLimitBucket.windowStart, windowStart)));
  }

  return {allowed: true, remaining: row.tokens, resetAt, limit: policy.limit};
}

/** The Postgres-backed limiter, bound to a policy and a clock. */
export function tokenBucket(
  db: Db,
  policy: BucketPolicy = DEFAULT_POLICY,
  now: () => Date = () => new Date(),
): RateLimiter {
  return {consume: (key) => consume(db, key, policy, now())};
}
