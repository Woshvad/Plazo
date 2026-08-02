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
import {check, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid} from "drizzle-orm/pg-core";

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
