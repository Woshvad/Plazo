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
