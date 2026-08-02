/**
 * drizzle-kit for `@plazo/origination`.
 *
 * ## `tablesFilter` is load-bearing. Do not remove it.
 *
 * Both operator services — this one and `@plazo/servicing` — declare their tables inside
 * a single Postgres schema named `operator`. They share a database on purpose: one
 * transaction boundary, one connection story, one place an operator looks.
 *
 * drizzle-kit's model of the world is "the declared schema is the whole truth". Without
 * a filter it introspects every table in `operator`, finds the *other* service's tables
 * with no declaration behind them, concludes they are orphans, and offers to drop them.
 * Accepting that prompt once destroys the servicing service's delivery log and audit log
 * (T-06-02a-03). The filter is what makes two services able to share one schema safely,
 * and it is not redundant with the `schema` path above — that says where to read
 * declarations from, this says what the run is allowed to reach.
 *
 * Every table added to `src/db/schema.ts` must be added here too. That duplication is
 * the point: adding a table is a deliberate act, and so is widening what a migration can
 * touch.
 *
 * ## And the filter only covers tables. Declare nothing else in `operator`.
 *
 * `tablesFilter` scopes tables. It does not scope sequences, enums, views or functions —
 * those are schema-level objects, and a push from either service sees every one of them
 * that it did not declare as an orphan and proposes a `DROP`.
 *
 * Measured in plan 06-02b: a `bigserial` column on `operator.notice_delivery` — a
 * `@plazo/servicing` table this config has never heard of — made **this** config's push emit
 * `DROP SEQUENCE "operator"."notice_delivery_seq_seq"`. It failed only because Postgres
 * refuses to drop a sequence a live column's default depends on. A standalone sequence, or
 * a `DROP ... CASCADE`, would have gone through.
 *
 *   **No `serial`, no `bigserial`, no identity columns, no `pgEnum`, no views, no functions
 *   inside `operator`, in either service.** Use a `uuid` default, a `text` column with a
 *   `check` constraint, or a value the writer chooses.
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
    "checkout_session",
    "merchant_account",
    "merchant_api_key",
    "rate_limit_bucket",
    "merchant_external_ref",
  ],
  strict: true,
  verbose: true,
});
