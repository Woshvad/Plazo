/**
 * The origination service's operator-private tables — the `operator` half of the
 * storage split.
 *
 * OPS-08 and specification §9.3. `services/indexer/ponder.schema.ts` owns the `public`
 * schema and everything in it is reproducible from the chain alone; nothing there
 * identifies a person, because no event does. Everything here is the opposite: a
 * checkout session holds a wallet, an API key belongs to a merchant, and an external
 * reference is a merchant's own order id. `planId` is the only join key across the two,
 * and it is exactly what a deletion request severs.
 *
 * ## Why a Postgres schema and not a naming convention
 *
 * Declaring a real Postgres schema puts the boundary in the database rather than in a
 * code review (D-17). A convention is a claim; a schema is a grant that can be revoked, a search
 * path that can be constrained, and a `\dt` a reader can run. "PII never touches the
 * chain" is only checkable if the two halves are separable objects.
 *
 * ## Why the whole schema is declared here, before most of it is used
 *
 * Only `checkoutSession` has a writer today. `merchantApiKey`, `rateLimitBucket` and
 * `merchantAccount` are MERCH-05's, and `merchantExternalRef` is MERCH-08's. They are
 * declared now so plan 06-06 writes code against tables that already exist rather than
 * editing this file underneath another plan's migration. Two plans mutating one schema
 * file is how a shared database ends up with two conflicting migrations and no obvious
 * merge.
 *
 * ## House rules carried over from the indexer
 *
 * Money is `bigint`, never `numeric` and never a float. None of these five tables
 * carries a money column yet; when one arrives it follows that rule. Every column a
 * dashboard filters by gets an `index()`.
 */
import {sql} from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type {CheckoutSession} from "../session.js";

/**
 * The operator's schema. Ponder owns `public`.
 *
 * Both operator services — origination and servicing — declare their tables inside this
 * one schema. That is deliberate: they share a database and a transaction boundary. It
 * is also why each service's `drizzle.config.ts` carries a `tablesFilter`; see the note
 * there.
 */
export const operator = pgSchema("operator");

/**
 * A `CheckoutSession` at rest.
 *
 * JSON carries no bigints, so every monetary and numeric-256 field crosses as a decimal
 * string — the same rule `api.ts` applies at the HTTP boundary, applied at the storage
 * boundary for the same reason. The conversion is total and lossless in both directions
 * because a decimal string is exact; a float would not be, which is why nothing in the
 * round trip is allowed to go through `Number`.
 */
export type AtRest<T> = T extends bigint
  ? string
  : T extends readonly (infer Element)[]
    ? AtRest<Element>[]
    : T extends object
      ? {[Key in keyof T]: AtRest<T[Key]>}
      : T;

/**
 * Derived from `CheckoutSession`, never restated.
 *
 * A hand-written mirror of the session shape would be a second definition of the same
 * record that drifts the first time somebody adds a field, and the drift would surface
 * as a session that survives a restart with one term missing. The mapped type makes the
 * at-rest shape a consequence of the in-memory one: add a field to `CheckoutSession` and
 * this follows, or fails to compile.
 */
export type StoredSession = AtRest<CheckoutSession>;

/**
 * The resumable checkout state machine, made durable.
 *
 * CHKT-02. The record itself lives whole in `payload`, because session transitions are
 * free functions that return a **new** object rather than mutating one
 * (`session.ts::recordAuthorization`) — so the store is write-whole-row and a column
 * per field would buy nothing but drift. The columns beside it are denormalised copies
 * of the four things something other than the session machine needs to filter on: whose
 * it is, what state it is in, which plan it became, and when it dies.
 */
export const checkoutSession = operator.table(
  "checkout_session",
  {
    sessionId: text("session_id").primaryKey(),
    /**
     * Nullable until MERCH-05 issues keys.
     *
     * A session is opened today by a caller that presents a merchant address in a
     * header and is trusted (`api.ts`). There is no merchant account to point at yet,
     * and a `notNull` here would force `PgSessionStore` to invent one. Plan 06-06
     * populates it when a key identifies the merchant for real.
     */
    merchantId: uuid("merchant_id"),
    /** The merchant's settlement address. Present from the first session. */
    merchant: text("merchant").notNull(),
    state: text("state").notNull(),
    expiresAt: timestamp("expires_at", {withTimezone: true, mode: "date"}).notNull(),
    /** Counterfactual until origination, but derived at `openSession` and never null. */
    planId: text("plan_id"),
    payload: jsonb("payload").$type<StoredSession>().notNull(),
    createdAt: timestamp("created_at", {withTimezone: true, mode: "date"}).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", {withTimezone: true, mode: "date"}).notNull().defaultNow(),
  },
  (table) => [
    index("checkout_session_merchant_id_idx").on(table.merchantId),
    /** The sweeper reads this: everything past its deadline that never originated. */
    index("checkout_session_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * A merchant, as the operator plane knows them.
 *
 * `MerchantRegistry` on chain is the authority on whether a merchant may originate;
 * this row is the authority on who may call the API as them. The two are joined by
 * `address` and nothing else.
 *
 * `environment` is a column with a check constraint rather than a boolean because
 * `WHERE is_sandbox = false` is a filter somebody forgets, and the failure mode of
 * forgetting it is sandbox traffic settling real money (06-RESEARCH, "API keys —
 * prescriptive"). A sandbox merchant and a live merchant are different rows.
 */
export const merchantAccount = operator.table(
  "merchant_account",
  {
    merchantId: uuid("merchant_id").primaryKey().defaultRandom(),
    address: text("address").notNull().unique(),
    environment: text("environment").notNull(),
    createdAt: timestamp("created_at", {withTimezone: true, mode: "date"}).notNull().defaultNow(),
  },
  (table) => [
    check("merchant_account_environment_check", sql`${table.environment} in ('sandbox', 'live')`),
  ],
);

/**
 * An API key, stored as a hash and a display tail.
 *
 * MERCH-05, D-18. The column is named `secretHash` and not `secret` so that a future
 * writer cannot mistake it for a place a secret may go (T-06-02a-02). It holds hex
 * `sha256(secret)` and nothing else: the key is 32 bytes of `crypto.randomBytes`, so a
 * slow KDF buys no entropy it does not already have and costs a hash on every request.
 * `last4` is cleartext on purpose — a merchant needs to recognise which key is which.
 *
 * Rotation is `(createdAt, expiresAt, revokedAt, rotatedFrom)`: issuing a replacement
 * sets `expiresAt = now + overlap` on the old row rather than deleting it, so both
 * authenticate for the overlap window and a merchant's deploy is not a coin flip.
 * `revokedAt` is the immediate kill, distinct from expiry because "compromised" and
 * "superseded" must be tellable apart afterwards.
 */
export const merchantApiKey = operator.table(
  "merchant_api_key",
  {
    /** Public, indexable, non-secret. The lookup handle inside `plazo_{env}_{keyId}_…`. */
    keyId: text("key_id").primaryKey(),
    merchantId: uuid("merchant_id").notNull(),
    environment: text("environment").notNull(),
    /** Hex `sha256(secret)`. Never the secret. */
    secretHash: text("secret_hash").notNull(),
    last4: text("last4").notNull(),
    createdAt: timestamp("created_at", {withTimezone: true, mode: "date"}).notNull().defaultNow(),
    /** Set when a rotation supersedes this key. Null means "no scheduled end". */
    expiresAt: timestamp("expires_at", {withTimezone: true, mode: "date"}),
    /** Set on an immediate revocation. Distinct from expiry, deliberately. */
    revokedAt: timestamp("revoked_at", {withTimezone: true, mode: "date"}),
    /** The `keyId` this one replaced, for the rotation audit trail. */
    rotatedFrom: text("rotated_from"),
  },
  (table) => [
    index("merchant_api_key_merchant_id_idx").on(table.merchantId),
    check("merchant_api_key_environment_check", sql`${table.environment} in ('sandbox', 'live')`),
  ],
);

/**
 * A per-key token bucket, in Postgres on purpose.
 *
 * The default store for every rate limiter in the ecosystem is process memory, and an
 * in-memory limiter resets on every deploy — which means the limit is not a limit, it is
 * a limit between deploys. It also does not survive a second process. Postgres is the
 * datastore the operator already runs (D-17), so the bucket costs no new infrastructure.
 *
 * Keyed by `(keyId, windowStart)` so an expired window is a row to delete rather than
 * state to reconcile.
 */
export const rateLimitBucket = operator.table(
  "rate_limit_bucket",
  {
    keyId: text("key_id").notNull(),
    windowStart: timestamp("window_start", {withTimezone: true, mode: "date"}).notNull(),
    tokens: integer("tokens").notNull(),
    refilledAt: timestamp("refilled_at", {withTimezone: true, mode: "date"}).notNull().defaultNow(),
  },
  (table) => [primaryKey({columns: [table.keyId, table.windowStart]})],
);

/**
 * The merchant's own order id against the plan it became.
 *
 * MERCH-08's reconciliation join, and it belongs on this side of the split rather than
 * in the indexer. An order id is a merchant's internal key into their own customer
 * record: it is not PII itself, but it dereferences to PII in a system Plazo does not
 * control, and putting it in a chain-derived table would make the chain half no longer
 * reproducible from the chain (T-06-02a-01).
 */
export const merchantExternalRef = operator.table(
  "merchant_external_ref",
  {
    planId: text("plan_id").primaryKey(),
    merchantId: uuid("merchant_id").notNull(),
    externalId: text("external_id").notNull(),
    createdAt: timestamp("created_at", {withTimezone: true, mode: "date"}).notNull().defaultNow(),
  },
  (table) => [
    /** The reconciliation query is "this merchant's order X", so the pair is the index. */
    index("merchant_external_ref_merchant_external_idx").on(table.merchantId, table.externalId),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Tier-1 inflow evidence (Phase 7, UW-04)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A borrower's verified inflow, folded to one row per month.
 *
 * ## Why this is a table and not a query
 *
 * Ninety days of Arc at 0.514 s per block is roughly 15.1 million blocks against a
 * 10,000-block `eth_getLogs` cap, on an endpoint that sheds about a quarter of what it
 * is asked — some 1,510 requests per borrower per quote. A scan inside a quote request
 * times out, and it times out looking exactly like a code bug rather than like an
 * architecture that was never going to work. So the history is folded continuously by
 * the indexer and read here as one row (Pitfall 6).
 *
 * ## Why the key is a salted subject and can never be a wallet
 *
 * Income joined to an identity is the most sensitive data this project holds, and a
 * table of wallet addresses against monthly income figures is that join with none of
 * the protection. Every Passport record in this repo keys on
 * `keccak256(prefix ‖ salt ‖ borrower)` with the operator holding the salt; this is the
 * database side of the same rule (OPS-08, and `@plazo/events`' privacy test is the
 * event side). The wallet-to-subject mapping lives behind the consent gate, where a
 * deletion request can actually be honoured — and severing it is what a deletion does.
 *
 * ## House rules
 *
 * Money is `bigint` in 6-decimal minor units, narrowed exactly once by the indexer at
 * write time (`toMinor6`) and never re-narrowed here. No sequence-backed column, no
 * identity column, no database-level enum, no view and no function anywhere in the
 * `operator` schema, in either service (DEC-57 — measured, not inferred: one such
 * column on a `@plazo/servicing` table made *this* service's push emit a drop for a
 * sequence it had never heard of). Keys are writer-chosen (DEC-58).
 */
export const inflowSummary = operator.table(
  "inflow_summary",
  {
    /** `keccak256(prefix ‖ salt ‖ borrower)`. Never a wallet. */
    subjectId: text("subject_id").notNull(),
    /** `YYYY-MM`. The cadence test counts distinct values of this column. */
    monthBucket: text("month_bucket").notNull(),
    /** Distinct surviving counterparties in this bucket — the diversity test's input. */
    counterpartyCount: integer("counterparty_count").notNull().default(0),
    /**
     * 6-decimal minor units. Narrowed once, upstream.
     *
     * No column default, deliberately: `drizzle-kit` 0.31.10 cannot serialise a
     * `bigint` default and fails the whole `generate` with `Do not know how to
     * serialize a BigInt`. It is also the better shape — a summary row is written by a
     * fold that has already computed the total, so a default would only ever mask a
     * writer that forgot to.
     */
    totalMinor: bigint("total_minor", {mode: "bigint"}).notNull(),
    updatedAt: timestamp("updated_at", {withTimezone: true, mode: "date"}).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({columns: [table.subjectId, table.monthBucket]}),
    /** The quote-time read is "this subject, every bucket", so the subject is the index. */
    index("inflow_summary_subject_idx").on(table.subjectId),
  ],
);

/**
 * One counterparty of one subject, and the fact that makes the round-trip exclusion cheap.
 *
 * `sentToCount` is what stops Tier 1 being a self-serve limit printer. A borrower with
 * two wallets can cycle the same funds between them forever and manufacture unlimited
 * "income"; the exclusion is to discard every counterparty the borrower has ever *sent
 * to*, and counting that at write time is what keeps it out of the quote path. A
 * non-zero value here means this counterparty has received from the subject at least
 * once, and every inflow from them is discarded on that basis alone.
 *
 * `counterparty` is a wallet and is named as one, because it is the *other* party's
 * public address rather than the subject's identity. The subject is still a salted
 * subject and the two are deliberately different kinds of column.
 */
export const inflowCounterparty = operator.table(
  "inflow_counterparty",
  {
    subjectId: text("subject_id").notNull(),
    /** The other party's public chain address, lower-cased hex. */
    counterparty: text("counterparty").notNull(),
    firstSeen: timestamp("first_seen", {withTimezone: true, mode: "date"}).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", {withTimezone: true, mode: "date"}).notNull().defaultNow(),
    /** How many times the subject has paid *them*. Non-zero excludes every inflow. */
    sentToCount: integer("sent_to_count").notNull().default(0),
  },
  (table) => [
    primaryKey({columns: [table.subjectId, table.counterparty]}),
    index("inflow_counterparty_subject_idx").on(table.subjectId),
  ],
);
