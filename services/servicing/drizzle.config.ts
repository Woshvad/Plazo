/**
 * drizzle-kit for `@plazo/servicing`.
 *
 * ## `tablesFilter` is load-bearing. Do not remove it.
 *
 * Both operator services — this one and `@plazo/origination` — declare their tables inside
 * a single Postgres schema named `operator`. They share a database on purpose: one
 * transaction boundary, one connection story, one place an operator looks.
 *
 * drizzle-kit's model of the world is "the declared schema is the whole truth". Without a
 * filter it introspects every table in `operator`, finds the *other* service's five tables
 * with no declaration behind them, concludes they are orphans, and offers to drop them.
 * Accepting that prompt once destroys the origination service's checkout sessions, merchant
 * accounts and API keys (T-06-02b-02).
 *
 * The guard is only symmetric if both sides carry it. The origination config's filter
 * protects **these** five tables; the filter below protects **those** five. Deleting either
 * one arms the other service's next push.
 *
 * It is not redundant with the `schema` path above — that says where to read declarations
 * from, this says what the run is allowed to reach. Every table added to `src/db/schema.ts`
 * must be added here too. The duplication is the point: widening what a migration can touch
 * is a deliberate act.
 *
 * ## And the filter only covers tables. Declare nothing else in `operator`.
 *
 * `tablesFilter` scopes tables. It does not scope sequences, enums, views or functions —
 * those are schema-level objects, and the other service's push sees every one of them as an
 * orphan with no declaration behind it and proposes a `DROP`.
 *
 * This is measured, not theoretical. A `bigserial` column added to `operator.notice_delivery`
 * made `drizzle-kit push` from `services/origination` emit
 * `DROP SEQUENCE "operator"."notice_delivery_seq_seq"`. It failed only because Postgres
 * refused to drop a sequence a live column's default depends on; a standalone sequence would
 * have gone. The rule that follows is a hard one for both services:
 *
 *   **No `serial`, no `bigserial`, no identity columns, no `pgEnum`, no views, no functions
 *   inside `operator`.** Use a `uuid` default, a `text` column with a `check` constraint, or
 *   a value the writer chooses. Plan 06-06 adds tables here and inherits this rule.
 */
import {defineConfig} from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgresql://plazo:plazo@localhost:5432/plazo",
  },
  schemaFilter: ["operator"],
  tablesFilter: [
    "audit_entry",
    "webhook_endpoint",
    "webhook_delivery",
    "notice_delivery",
    "payout_attestation",
  ],
  strict: true,
  verbose: true,
});
