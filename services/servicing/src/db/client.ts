/**
 * One connection pool per process, per URL.
 *
 * The same shape `services/origination/src/db/client.ts` uses, deliberately: two operator
 * services sharing one database should not have two ideas about how to open it. `postgres`
 * (porsager) is the driver Drizzle recommends and is zero-dependency, which matters on a
 * service that holds an audit log.
 *
 * Memoised by URL and not by module, so a test can point at `PLAZO_TEST_DATABASE_URL`
 * while the process's default stays on `DATABASE_URL`, and so a module that builds two
 * handles against one URL gets one pool and one transaction view rather than exhausting
 * the connection limit under exactly the load it is meant to survive.
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
 * Bracket access on `process.env` throughout — `noPropertyAccessFromIndexSignature` is on,
 * and dotted access on an index signature is the kind of typo that reads fine and returns
 * `undefined`.
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
