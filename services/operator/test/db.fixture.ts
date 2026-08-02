/**
 * A throwaway Postgres database carrying **both** services' committed migrations.
 *
 * This is the first fixture in the tree that applies both, and applying both is the point:
 * the composition root's whole claim is that one `operator` schema holds
 * `merchant_api_key`, `merchant_external_ref`, `webhook_endpoint` and `webhook_delivery`
 * together, and that claim is not testable from inside either service. Each of them has a
 * `tablesFilter` naming only its own tables (DEC-57), which is exactly what keeps their
 * pushes from dropping each other's work — and exactly what means neither of their fixtures
 * has ever seen the other's tables.
 *
 * Order matters and is asserted by construction: origination's `0000` and servicing's
 * `0000` both create the schema, and only the servicing one is guarded with
 * `IF NOT EXISTS`. So origination goes first. A run in the other order would fail on the
 * duplicate `CREATE SCHEMA`, which is worth knowing rather than papering over — it is the
 * same ordering hazard a real deployment has.
 *
 * ## Why it fails rather than skips
 *
 * A skipped integration test is indistinguishable from a passing one in CI output. If
 * `PLAZO_TEST_DATABASE_URL` is unset, or Postgres is not there, this throws with the
 * command that fixes it (DEC-60).
 */
import {randomBytes} from "node:crypto";
import {readdir, readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import postgres from "postgres";

const HERE = dirname(fileURLToPath(import.meta.url));

const BRING_UP = [
  "  cp .env.example .env        # then set PLAZO_PG_PORT if 5432 is taken on this host",
  "  docker compose up -d postgres",
  '  docker compose exec -T postgres psql -U plazo -d plazo -c "create database plazo_test"',
].join("\n");

/**
 * Origination first. See the header — only servicing's `CREATE SCHEMA` is guarded.
 */
const MIGRATION_DIRS = [
  join(HERE, "..", "..", "origination", "drizzle"),
  join(HERE, "..", "..", "servicing", "drizzle"),
];

export function testDatabaseUrl(): string {
  const url = process.env["PLAZO_TEST_DATABASE_URL"];
  if (!url) {
    throw new Error(
      "PLAZO_TEST_DATABASE_URL is not set.\n" +
        "This suite asserts against real rows and a real socket, and will not skip — a\n" +
        "skipped integration test reads exactly like a passing one. Set the variable, or\n" +
        "put it in the repo-root `.env` (vitest reads that one key; see tools/test-env.mjs):\n\n" +
        BRING_UP,
    );
  }
  return url;
}

async function migrationStatements(): Promise<string[]> {
  const statements: string[] = [];
  for (const dir of MIGRATION_DIRS) {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    if (files.length === 0) throw new Error(`no committed migration found in ${dir}`);
    for (const file of files) {
      const text = await readFile(join(dir, file), "utf8");
      for (const statement of text.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) statements.push(trimmed);
      }
    }
  }
  return statements;
}

export interface OperatorTestDatabase {
  /** The URL the composition root should be pointed at. */
  url: string;
  name: string;
  /** A raw driver handle, for the assertions a store deliberately cannot make. */
  raw: () => postgres.Sql;
  close: () => Promise<void>;
}

export async function openOperatorDatabase(): Promise<OperatorTestDatabase> {
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

  const name = `plazo_op_${randomBytes(6).toString("hex")}`;
  // Interpolated because CREATE DATABASE takes an identifier and not a value. The name is
  // 12 hex characters generated one line above, so there is nothing to inject.
  await admin.unsafe(`create database "${name}"`);

  const target = new URL(url);
  target.pathname = `/${name}`;
  const targetUrl = target.toString();

  const setup = postgres(targetUrl, {max: 1, onnotice: () => {}});
  try {
    for (const statement of await migrationStatements()) await setup.unsafe(statement);
  } finally {
    await setup.end();
  }

  const open: postgres.Sql[] = [];
  const raw = (): postgres.Sql => {
    const sql = postgres(targetUrl, {max: 4, onnotice: () => {}});
    open.push(sql);
    return sql;
  };

  return {
    url: targetUrl,
    name,
    raw,
    close: async () => {
      await Promise.all(open.map((sql) => sql.end().catch(() => undefined)));
      // The composition root memoises a pool per URL inside each service's `db()`; the URL
      // is unique per run, so the pool is this run's and closing the database out from under
      // it is safe. `with (force)` is what makes that true rather than hopeful.
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.end();
    },
  };
}
