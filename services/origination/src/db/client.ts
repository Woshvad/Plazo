/**
 * One connection pool per process, per URL.
 *
 * `postgres` (porsager) is the driver Drizzle recommends and it is zero-dependency,
 * which matters on a service whose whole job is holding merchant credentials. The pool
 * is memoised because a module that opened a socket per call would exhaust Postgres's
 * connection limit under exactly the load it is meant to survive, and because a test
 * that builds two clients against one URL should get one pool and one transaction view.
 *
 * Memoised by URL and not by module, so a test can point at `PLAZO_TEST_DATABASE_URL`
 * while the process's default stays on `DATABASE_URL`.
 *
 * No migration runs here. `drizzle-kit` owns DDL, the generated SQL is committed and
 * reviewable, and a service that quietly migrated its own database on boot would make a
 * deploy and a schema change the same event.
 */
import {drizzle} from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

const pools = new Map<string, Db>();

/**
 * The database handle.
 *
 * Bracket access on `process.env` throughout — the repo's TypeScript settings treat the
 * environment as an index signature, and dotted access on one is the kind of typo that
 * reads fine and returns `undefined`.
 */
export function db(url: string | undefined = process.env["DATABASE_URL"]): Db {
  if (!url) {
    throw new Error("DATABASE_URL is not set; the Postgres stores cannot be constructed without it");
  }
  const existing = pools.get(url);
  if (existing) return existing;

  const created = drizzle(postgres(url), {schema});
  pools.set(url, created);
  return created;
}

/** Whether a Postgres store can be built at all. Read at startup, never per request. */
export function hasDatabaseUrl(): boolean {
  return Boolean(process.env["DATABASE_URL"]);
}
