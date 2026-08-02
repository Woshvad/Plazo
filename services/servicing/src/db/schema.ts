/**
 * The servicing service's operator-private tables — the second half of the `operator`
 * schema.
 *
 * OPS-08 and specification §9.3, the same split `services/origination/src/db/schema.ts`
 * declares and for the same reason: `services/indexer/ponder.schema.ts` owns `public` and
 * everything there is reproducible from the chain alone, while everything here is the
 * opposite. An audit entry names a member of staff, a notice delivery names an address a
 * message was sent to, and a webhook endpoint holds a signing secret. `planId` is the only
 * join key across the two halves, and it is exactly what a deletion request severs.
 *
 * ## One Postgres schema, two services, and why that is safe
 *
 * These tables live inside the same `operator` schema the origination service declares.
 * They share a database on purpose — one transaction boundary, one connection story, one
 * place an operator looks. What makes it safe is that each service's `drizzle.config.ts`
 * carries a `tablesFilter` naming only its own tables; without it a push from either side
 * introspects the whole schema, finds the other side's tables with no declaration behind
 * them, calls them orphans and offers to drop them (T-06-02b-02). See the note in
 * `drizzle.config.ts`.
 *
 * `CREATE SCHEMA "operator"` belongs to whichever migration runs first. drizzle-kit emits
 * it without `IF NOT EXISTS`; the committed servicing migration has that guard added by
 * hand so neither service's DDL depends on the other having been applied already.
 *
 * ## Why the whole schema is declared here, before most of it is used
 *
 * Only `auditEntry` and `noticeDelivery` have writers today. `webhookEndpoint`,
 * `webhookDelivery` and `payoutAttestation` are plan 06-06's — the webhook fan-out and
 * the Iris attestation poller. They are declared now so 06-06 writes code against tables
 * that already exist rather than editing this file underneath another plan's migration.
 *
 * ## House rules carried over from the indexer
 *
 * Money is `bigint`, never `numeric` and never a float. Every column a dashboard filters
 * by gets an `index()`. No column here identifies a borrower.
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

/**
 * The operator's schema. Ponder owns `public`.
 *
 * Declared identically in both operator services. It is the same Postgres object, and
 * drizzle-kit reconciles the two declarations against one live schema — which is why the
 * `tablesFilter` in each config is load-bearing rather than decorative.
 */
export const operator = pgSchema("operator");

/**
 * The hash-chained audit log, made durable. D-19.
 *
 * The chain is the property; the storage is not. An in-memory audit log is not evidence —
 * it says whatever the process that held it happened to remember, and it remembers nothing
 * across a restart. `console.ts` computes the chain and this holds it.
 *
 * ## `prev_hash` is unique, and that is the whole point
 *
 * Two entries claiming the same predecessor is a **fork**: two mutually inconsistent
 * histories, either of which can be presented as "the log". In memory that is a silent
 * branch nobody notices. Here it is a unique-constraint violation, raised by Postgres
 * before either row lands, and `PgAuditLog` rethrows it as `AuditForkError`. That is the
 * difference between a log that cannot be forked and a log that merely has not been.
 *
 * `entry_hash` is unique for the same family of reasons, and because a duplicate hash is
 * either a replay or a collision and both deserve to fail loudly.
 *
 * ## Why `seq` is a plain `bigint` and not a `bigserial`
 *
 * The sequence number is **inside the hash preimage**. A server-assigned value is not
 * known until after the insert, so the hash could not be computed before it — the writer
 * would have to insert, read back the assigned number and then rewrite the hash, which is
 * a two-step append and therefore not an append at all. The store chooses `seq` as
 * `previous.seq + 1` in the same expression that chains the hash, and Postgres holds it as
 * a primary key. Starting at 0 matches the in-memory implementation exactly, so the two
 * produce byte-identical chains from the same inputs.
 *
 * There is no update and no delete path — not in this file, not in the store, and in a
 * deployed environment not in the grants either.
 */
export const auditEntry = operator.table(
  "audit_entry",
  {
    /** Chosen by the writer, never by a sequence. See above. */
    seq: bigint("seq", {mode: "number"}).primaryKey(),
    /**
     * The previous entry's hash; the 32 zero bytes for the first.
     *
     * Unique. A second entry naming a predecessor that already has a successor is a fork,
     * and a fork is a constraint violation rather than a branch (T-06-02b-01).
     */
    prevHash: text("prev_hash").notNull().unique(),
    entryHash: text("entry_hash").notNull().unique(),
    /**
     * The member of staff who acted. Named `actor` rather than `operator` because the
     * schema is already called `operator` and `operator.audit_entry.operator` reads like a
     * typo even when it is not.
     */
    actor: text("actor").notNull(),
    capability: text("capability").notNull(),
    /** What was acted on — a plan id, a parameter key, a corridor. */
    subject: text("subject").notNull(),
    /**
     * Free text, mandatory, and unhelpfully so on purpose. "Waived the late fee" tells a
     * regulator nothing; the reason is what decides whether a waiver was policy or a
     * favour.
     */
    reason: text("reason").notNull(),
    /** The entry's `detail` map, whole. It is inside the hash, so it cannot be edited. */
    payload: jsonb("payload").$type<Record<string, string>>().notNull(),
    at: timestamp("at", {withTimezone: true, mode: "date"}).notNull(),
  },
  (table) => [
    /** "Everything that ever touched this plan" is the question support actually asks. */
    index("audit_entry_subject_idx").on(table.subject),
    index("audit_entry_actor_idx").on(table.actor),
  ],
);

/**
 * Where a merchant wants their webhooks delivered. MERCH-05, plan 06-06 writes it.
 *
 * `signing_secrets` is an array rather than a column because a rotation window means two
 * secrets are valid at once: a merchant adds the new one to their verifier, Plazo signs
 * with both for the overlap, and then the old one is dropped. A single-secret column makes
 * every rotation an outage, which in practice means rotations do not happen.
 *
 * `status` is a checked string and not a boolean. `degraded` — delivering, but failing
 * often enough to be worth telling somebody about — is a real state, and a boolean forces
 * it to be either "fine" or "off".
 */
export const webhookEndpoint = operator.table(
  "webhook_endpoint",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    url: text("url").notNull(),
    /** Valid signing secrets, newest first. Two during a rotation window. */
    signingSecrets: text("signing_secrets").array().notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", {withTimezone: true, mode: "date"}).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", {withTimezone: true, mode: "date"}),
  },
  (table) => [
    index("webhook_endpoint_merchant_id_idx").on(table.merchantId),
    check(
      "webhook_endpoint_status_check",
      sql`${table.status} in ('active', 'degraded', 'disabled')`,
    ),
  ],
);

/**
 * Every webhook send attempt, including the ones that failed.
 *
 * A delivery log containing only successes cannot tell a merchant that their endpoint has
 * been 502-ing for three days, which is the one thing they need it for.
 *
 * `response_body_truncated` holds at most 4 KB, enforced in the code that writes it rather
 * than by a `varchar(4096)`: the cap is a storage policy that will be tuned, and a column
 * type is the wrong place to put a number somebody will want to change. The name says the
 * value may be short of the truth so nobody debugs against it believing otherwise.
 *
 * `replay_of` points at the delivery this one repeats. A replay that overwrote the
 * original would destroy the evidence that the first attempt failed.
 */
export const webhookDelivery = operator.table(
  "webhook_delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id").notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    event: text("event").notNull(),
    /** The idempotency key the merchant dedupes on, carried in the request header. */
    webhookId: text("webhook_id").notNull(),
    attempt: integer("attempt").notNull(),
    requestBody: text("request_body").notNull(),
    responseStatus: integer("response_status"),
    /** At most 4 KB. Capped by the writer; see above. */
    responseBodyTruncated: text("response_body_truncated"),
    latencyMs: integer("latency_ms"),
    sentAt: timestamp("sent_at", {withTimezone: true, mode: "date"}).notNull().defaultNow(),
    replayOf: uuid("replay_of"),
  },
  (table) => [
    /** The merchant's own dashboard: "my deliveries, newest first". */
    index("webhook_delivery_merchant_sent_at_idx").on(table.merchantId, table.sentAt),
    /** "Show me every attempt at this one webhook", which is what a support ticket is. */
    index("webhook_delivery_webhook_id_idx").on(table.webhookId),
  ],
);

/**
 * The persisted form of `ladder.ts`'s delivery log. NOTIF-02.
 *
 * There is **no borrower column**. Plans are keyed by `planId` and the borrower join lives
 * behind the consent gate; a borrower address here would put the identity join in the one
 * table an operator reads most often (T-06-02b-03).
 *
 * `recipient` is here and is deliberate. It is the address the message actually went to,
 * and without it the log cannot answer the question it exists to answer — "we notified
 * you" is the claim a borrower disputes, in exactly the jurisdictions where the answer
 * decides whether a fee stands. That is operator-private data living in the operator
 * schema, which is what this schema is for; it is not a chain-derived table and never
 * becomes one.
 *
 * Failures are rows, not discards, and there is no update path: a second attempt is a
 * second row.
 */
export const noticeDelivery = operator.table(
  "notice_delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * `${planId}:${index}:${kind}` — the notice's idempotency key, the same shape the
     * keeper's job key uses. `wasSent` reads this, so sending twice is impossible rather
     * than merely unlikely.
     */
    noticeKey: text("notice_key").notNull(),
    planId: text("plan_id").notNull(),
    kind: text("kind").notNull(),
    channel: text("channel").notNull(),
    recipient: text("recipient").notNull(),
    outcome: text("outcome").notNull(),
    /** Why it failed, when it did. Null on a send. */
    detail: text("detail"),
    sentAt: timestamp("sent_at", {withTimezone: true, mode: "date"}).notNull(),
  },
  (table) => [
    index("notice_delivery_plan_id_idx").on(table.planId),
    /** `wasSent` is a point lookup on the key and runs on every dispatch pass. */
    index("notice_delivery_notice_key_idx").on(table.noticeKey),
    check(
      "notice_delivery_outcome_check",
      sql`${table.outcome} in ('sent', 'failed', 'suppressed')`,
    ),
  ],
);

/**
 * The Iris attestation poller's state. Plan 06-06 builds the poller; the table is here so
 * that plan writes against something that already exists.
 *
 * DEC-53 puts this on the operator side rather than on `payout_dispatch`: an `attested`
 * column on a chain-derived table would put a vendor's answer in a table whose one
 * property is being reproducible from the chain.
 *
 * Keyed by `(planId, destinationDomain)` and not by a nonce, because DEC-31 established
 * that a CCTP v2 burn's onchain message carries a zero nonce — the real identifier is
 * assigned by Iris at attestation time and does not exist when this row is created.
 * `tx_hash` is the join back to Circle's ledger.
 */
export const payoutAttestation = operator.table(
  "payout_attestation",
  {
    planId: text("plan_id").notNull(),
    /** The CCTP domain the burn is headed for. Arc is 26. */
    destinationDomain: integer("destination_domain").notNull(),
    /** The burn transaction. The only durable join to Iris (DEC-31). */
    txHash: text("tx_hash").notNull(),
    /** The CCTP message bytes, once Iris has them. */
    message: text("message"),
    attestation: text("attestation"),
    status: text("status").notNull().default("pending"),
    polledAt: timestamp("polled_at", {withTimezone: true, mode: "date"}),
    /** Poll count, so a permanently-stuck burn is visible rather than merely slow. */
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [
    primaryKey({columns: [table.planId, table.destinationDomain]}),
    index("payout_attestation_status_idx").on(table.status),
    index("payout_attestation_tx_hash_idx").on(table.txHash),
  ],
);
