/**
 * A throwaway Postgres database per suite, built from the committed migrations.
 *
 * `typecheck` and `build` both pass on this package without a database, because Drizzle's
 * types come from `src/db/schema.ts` rather than from a live server. That is a
 * false-positive verification state — it says nothing about whether the DDL applies,
 * whether a `jsonb` round-trips a `Record<string, string>` with its keys in a different
 * order, or whether the `prev_hash` unique constraint actually exists — and closing it is
 * the entire reason this file exists.
 *
 * ## The DDL is the committed migration, applied verbatim
 *
 * Every `.sql` under `drizzle/`, in order, statement by statement. Not a hand-written copy
 * and not a `getTableConfig` re-derivation: the committed migration is the artefact a
 * reviewer reads instead of running a database, so the useful thing to assert against is
 * that exact text. A second definition of the schema in a test directory drifts from the
 * first the moment somebody adds a column, and the drift presents as a test that passes
 * against a table production does not have.
 *
 * Applying `0002` after `0001` also exercises the chain rather than only its endpoint.
 *
 * ## A database, not a schema
 *
 * The indexer's fixture (`services/indexer/test/db.fixture.ts`) creates a throwaway
 * *schema*, which works there because Ponder's tables are unqualified and a `search_path`
 * can redirect them. These tables are declared `pgSchema("operator")` and every query
 * Drizzle emits names that schema explicitly, so a `search_path` would be ignored. A fresh
 * database is the only way to run the real, schema-qualified SQL against real tables.
 *
 * It is also the safer of the two. This fixture drops only a database it created moments
 * earlier under a random name; it can never be aimed at a developer's own data, which a
 * `drop schema` fixture pointed at the wrong URL absolutely can.
 *
 * ## Why it fails rather than skips
 *
 * A skipped integration test is indistinguishable from a passing one in CI output. That is
 * how the indexer went five phases without ever touching a database. If
 * `PLAZO_TEST_DATABASE_URL` is unset, or Postgres is not there, this throws with the
 * command that fixes it.
 */
import {randomBytes} from "node:crypto";
import {readdir, readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {drizzle} from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../src/db/schema.js";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const BRING_UP = [
  "  cp .env.example .env        # then set PLAZO_PG_PORT if 5432 is taken on this host",
  "  docker compose up -d postgres",
  '  docker compose exec -T postgres psql -U plazo -d plazo -c "create database plazo_test"',
].join("\n");

/**
 * The configured test database URL, or a loud failure.
 *
 * No default. A default is how a suite ends up quietly asserting against whatever Postgres
 * happens to be listening on 5432 — which on a developer's machine is usually another
 * project's — and reporting the resulting credential failure as if the code were broken.
 */
export function testDatabaseUrl(): string {
  const url = process.env["PLAZO_TEST_DATABASE_URL"];
  if (!url) {
    throw new Error(
      "PLAZO_TEST_DATABASE_URL is not set.\n" +
        "This suite asserts against real rows and will not skip — a skipped integration test\n" +
        "reads exactly like a passing one. Set the variable, or put it in the repo-root `.env`\n" +
        "(vitest reads that one key; see tools/test-env.mjs):\n\n" +
        BRING_UP,
    );
  }
  return url;
}

/** Every committed migration, in order, split into executable statements. */
async function migrationStatements(): Promise<string[]> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error(`no committed migration found in ${dir}`);

  const statements: string[] = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8");
    for (const statement of text.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) statements.push(trimmed);
    }
  }
  return statements;
}

export interface TestDatabase {
  db: TestDb;
  /** The throwaway database's name, for a test that wants to say what it ran against. */
  name: string;
  /** Open a second, independent handle — the way to prove a row survived the first. */
  connect: () => TestDb;
  /** A raw driver handle, for the things a store deliberately cannot do. */
  raw: () => postgres.Sql;
  close: () => Promise<void>;
}

export async function openTestDatabase(): Promise<TestDatabase> {
  const url = testDatabaseUrl();
  const admin = postgres(url, {max: 1, connect_timeout: 5, onnotice: () => {}});

  try {
    await admin`select 1`;
  } catch (cause) {
    await admin.end().catch(() => undefined);
    throw new Error(
      `No Postgres at ${url.replace(/:[^:@/]*@/, ":***@")}.\n` +
        "This suite asserts against real rows and will not skip. Bring the database up:\n\n" +
        BRING_UP,
      {cause},
    );
  }

  const name = `plazo_t_${randomBytes(6).toString("hex")}`;
  // Interpolated rather than parameterised because CREATE DATABASE takes an identifier and
  // not a value. The name is 12 hex characters this function generated one line above, so
  // there is no input to inject; parameterising it is not possible and quoting it is honest.
  await admin.unsafe(`create database "${name}"`);

  const target = new URL(url);
  target.pathname = `/${name}`;

  const setup = postgres(target.toString(), {max: 1, onnotice: () => {}});
  try {
    for (const statement of await migrationStatements()) await setup.unsafe(statement);
  } finally {
    await setup.end();
  }

  const open: postgres.Sql[] = [];
  const raw = (): postgres.Sql => {
    const sql = postgres(target.toString(), {max: 4, onnotice: () => {}});
    open.push(sql);
    return sql;
  };
  const connect = (): TestDb => drizzle(raw(), {schema});

  return {
    db: connect(),
    name,
    connect,
    raw,
    close: async () => {
      // Every connection must be gone before the drop: Postgres refuses to drop a database
      // anything is still attached to, and a fixture that left one open would leak a
      // database per run until somebody noticed the disk.
      await Promise.all(open.map((sql) => sql.end().catch(() => undefined)));
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.end();
    },
  };
}

/** Open, run, and drop — the shape most suites want. */
export async function withDb<T>(fn: (fixture: TestDatabase) => Promise<T>): Promise<T> {
  const fixture = await openTestDatabase();
  try {
    return await fn(fixture);
  } finally {
    await fixture.close();
  }
}
