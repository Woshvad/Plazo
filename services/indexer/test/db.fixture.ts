/**
 * A real Postgres, holding the real tables, for the first time in this package.
 *
 * The indexer has typechecked for three phases and never seen a row. A passing
 * `typecheck` is a false positive on whether a column exists, whether a `numeric(78)`
 * round-trips a `bigint` past the safe-integer boundary, or whether an
 * `onConflictDoUpdate` writes what its author meant — so this fixture exists to make
 * those questions answerable.
 *
 * ## The DDL is derived, never restated
 *
 * `CREATE TABLE` is emitted from the same `onchainTable` objects `ponder.schema.ts`
 * exports, through Drizzle's own `getTableConfig`. A hand-written copy of the schema in
 * a test directory is a second definition of the database that drifts from the first the
 * moment somebody adds a column — and the drift would present as a test that passes
 * against a table production does not have. Deriving it means a schema change either
 * flows through or fails here.
 *
 * This is not a migration and must not be mistaken for one. Ponder owns the production
 * DDL; this emits the minimum that makes an assertion possible, into a throwaway schema.
 *
 * ## Why it fails rather than skips
 *
 * A skipped database test is indistinguishable from a passing one in CI output, and the
 * whole point of this file is to stop `typecheck` standing in for evidence. If Postgres
 * is not there, the suite says so loudly and goes red.
 */
import {randomBytes} from "node:crypto";

import {getTableConfig, type PgTable} from "drizzle-orm/pg-core";
import {drizzle, type NodePgDatabase} from "drizzle-orm/node-postgres";
import {sql} from "drizzle-orm";
import pg from "pg";

/**
 * Matches `.env.example`, so the documented local setup needs no extra variable.
 *
 * Override with `PLAZO_TEST_DATABASE_URL` when Postgres is published somewhere else —
 * a host with 5432 already taken, for instance.
 */
const DEFAULT_URL = "postgresql://plazo:plazo@localhost:5432/plazo_test";

export const testDatabaseUrl = (): string =>
  process.env["PLAZO_TEST_DATABASE_URL"] ?? DEFAULT_URL;

/** How a value that `hasDefault` is written back into DDL. */
function renderDefault(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * `CREATE TABLE` for one Drizzle table, from its own configuration.
 *
 * Indexes are deliberately not emitted. An index changes the plan, never the answer,
 * and a test that asserted one existed would be asserting against `getTableConfig`
 * rather than against Postgres. The grep gates in the plan are what hold the indexes.
 */
export function createTableSql(table: PgTable, schema: string): string {
  const config = getTableConfig(table);

  const columns = config.columns.map((column) => {
    const parts = [`"${column.name}"`, column.getSQLType()];
    if (column.notNull) parts.push("not null");
    if (column.hasDefault && column.default !== undefined) {
      parts.push(`default ${renderDefault(column.default)}`);
    }
    return parts.join(" ");
  });

  const inlinePrimary = config.columns.filter((column) => column.primary).map((c) => `"${c.name}"`);
  const compositePrimary = config.primaryKeys.flatMap((key) =>
    key.columns.map((column) => `"${column.name}"`),
  );
  const primary = inlinePrimary.length > 0 ? inlinePrimary : compositePrimary;
  if (primary.length > 0) columns.push(`primary key (${primary.join(", ")})`);

  return `create table "${schema}"."${config.name}" (${columns.join(", ")})`;
}

export interface TestDatabase {
  db: NodePgDatabase<Record<string, never>>;
  schema: string;
  close: () => Promise<void>;
}

/**
 * The operator half's DDL, taken from the migration a reviewer actually reads.
 *
 * `services/origination/drizzle/0000_*.sql` is committed on purpose — it is the artefact
 * that stands in for running a database, and 06-02a said so. Restating one of its tables
 * here would make this fixture a second, unversioned definition of the operator schema,
 * and the drift would present as a cross-schema join that passes against a table
 * production does not have.
 *
 * The statements are rewritten to land in the throwaway schema rather than in a real
 * `operator` one. Test files run in parallel workers over a shared database, and a
 * global schema shared between them is a race, not a fixture. The reconciliation read
 * takes the schema name as configuration for exactly this reason.
 *
 * Applying it at all is worth something beyond this suite: until now nothing in this
 * repository had observed whether that DDL parses, let alone applies.
 */
export async function operatorDdl(schema: string): Promise<string[]> {
  const {readFile, readdir} = await import("node:fs/promises");
  const {join, dirname} = await import("node:path");
  const {fileURLToPath} = await import("node:url");

  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "origination", "drizzle");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error(`no committed migration found in ${dir}`);

  const sqlText = await readFile(join(dir, files[0]!), "utf8");

  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    // The migration creates the schema itself; the fixture already owns one.
    .filter((statement) => !/^CREATE SCHEMA/i.test(statement))
    .map((statement) => statement.replaceAll('"operator".', `"${schema}".`));
}

/**
 * A pool, a throwaway schema, and the requested tables inside it.
 *
 * A fresh schema per suite rather than a truncate between tests: truncation leaves
 * whatever the previous shape was, and the failure mode of a stale column is a test
 * that passes for the wrong reason. Dropping a schema cannot leave one behind.
 */
export async function openTestDatabase(
  tables: PgTable[],
  options: {withOperatorSchema?: boolean} = {},
): Promise<TestDatabase> {
  const url = testDatabaseUrl();
  const admin = new pg.Pool({connectionString: url, max: 1, connectionTimeoutMillis: 5_000});

  try {
    await admin.query("select 1");
  } catch (cause) {
    await admin.end().catch(() => undefined);
    throw new Error(
      `No Postgres at ${url}.\n` +
        "This suite asserts against real rows and will not skip. Bring the database up with\n" +
        "  docker compose up -d postgres\n" +
        "then create the test database:\n" +
        '  docker compose exec -T postgres psql -U plazo -d plazo -c "create database plazo_test"\n' +
        "Set PLAZO_TEST_DATABASE_URL if it is published on a port other than 5432.",
      {cause},
    );
  }

  const schema = `t_${randomBytes(6).toString("hex")}`;
  await admin.query(`create schema "${schema}"`);
  for (const table of tables) await admin.query(createTableSql(table, schema));
  if (options.withOperatorSchema) {
    for (const statement of await operatorDdl(schema)) await admin.query(statement);
  }

  /**
   * The search path is baked into the connection rather than set with a statement.
   *
   * `set search_path` binds to one backend connection, and a pool hands out whichever
   * is free — so a suite that set it once would pass or fail depending on which
   * connection a query happened to get. `options` applies it at connect time, to every
   * connection the pool opens. The handlers under test name their tables unqualified,
   * so the path has to be right for the query to mean anything at all.
   */
  const pool = new pg.Pool({
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: 5_000,
    options: `-c search_path=${schema}`,
  });

  return {
    db: drizzle(pool),
    schema,
    close: async () => {
      await pool.end().catch(() => undefined);
      await admin.query(`drop schema "${schema}" cascade`).catch(() => undefined);
      await admin.end();
    },
  };
}
