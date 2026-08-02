/**
 * Merchant webhooks: signing, delivery, the retry ladder, the delivery log, and replay.
 * MERCH-05 and D-18.
 *
 * ## The signature scheme is Standard Webhooks, over `node:crypto`
 *
 * Three headers, and the signature covers all three inputs:
 *
 *     webhook-id:        msg_2b3c…
 *     webhook-timestamp: 1785000000
 *     webhook-signature: v1,<base64(hmac_sha256(secret, `${id}.${ts}.${body}`))>
 *
 * The specification is followed and the package is not installed. `standardwebhooks@1.0.0`
 * was last published in March 2024 — about two and a half years — and it is roughly
 * fifteen lines of HMAC wrapping the standard library. Putting a stale dependency on the
 * signing path of an operator API buys a `require` and costs a supply-chain surface on
 * the one code path where a compromise is indistinguishable from Plazo itself.
 *
 * Following the published scheme rather than inventing one is the point: a merchant
 * verifies with whatever library they already have, and the test in this package proves
 * that by verifying against an implementation written from the spec rather than against
 * `verify()`.
 *
 * ## The replay window is five minutes, and the merchant enforces it
 *
 * `verify` rejects a timestamp more than five minutes from now in **either** direction —
 * future timestamps too, because a clock-skewed or forged-ahead timestamp is a signature
 * that stays valid for as long as the skew. Plazo cannot enforce this on the merchant's
 * behalf; it is documented so the merchant knows to.
 *
 * ## A replay carries a new `webhook-id`. Always
 *
 * The receiver is told to dedupe on `webhook-id`. That instruction and "replay re-sends
 * the original id" are mutually exclusive: a correctly-implemented receiver silently
 * drops the replay, the merchant reports "replay does nothing", and the operator spends a
 * day looking at the sender. So `replay` re-sends the stored body **verbatim** with a
 * fresh id and a fresh timestamp, and links to the original through `replayOf`. This is
 * Pitfall 8 and it is the single most common bug in this feature.
 *
 * ## No ordering is promised
 *
 * Deliveries race, retries reorder, and a queue with seven attempts and jitter cannot be
 * a sequence. Every payload carries the chain's `blockNumber` and `logIndex` so a merchant
 * can order for themselves — which is the only ordering that is true anyway, since it is
 * the chain's.
 */
import {createHmac, randomBytes, randomUUID, timingSafeEqual} from "node:crypto";

import {and, desc, eq} from "drizzle-orm";

import {webhookDelivery, webhookEndpoint} from "./db/schema.js";
import {assertDeliverable, assertNotRedirected, type Resolver} from "./ssrf.js";
import type {Db} from "./db/client.js";

/** The replay window, in seconds, in both directions. Documented because a merchant enforces it. */
export const REPLAY_WINDOW_SECONDS = 300;

/** Response bodies are stored truncated. A merchant's 500-page HTML error is not evidence. */
export const RESPONSE_BODY_CAP_BYTES = 4096;

/**
 * The retry ladder: immediate, then 30s, 2m, 10m, 1h, 6h, 24h.
 *
 * Seven entries and seven attempts. The first is zero because the overwhelming majority
 * of failures are a deploy in progress, and the second attempt a second later succeeds.
 */
export const RETRY_LADDER_MS = [0, 30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000] as const;

export const MAX_ATTEMPTS = RETRY_LADDER_MS.length;

/** After this long failing continuously, an endpoint stops being retried at all. */
export const DISABLE_AFTER_MS = 72 * 60 * 60 * 1000;

/** `whsec_` + 32 random bytes, base64. Separate from the API key, and rotated separately. */
export function newSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

/** `msg_` + a uuid. Opaque to the receiver, and the key they dedupe on. */
export function newWebhookId(): string {
  return `msg_${randomUUID()}`;
}

/**
 * Sign one delivery.
 *
 * The signed bytes are `${id}.${ts}.${body}` — id and timestamp inside the signature, so
 * neither can be altered to make a captured payload replayable outside its window.
 */
export function sign(secret: string, id: string, ts: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

/**
 * Verify a delivery against any of the secrets currently valid.
 *
 * The header may carry several space-separated signatures, which is exactly what makes a
 * secret rotation not an outage: Plazo signs with both during the overlap, the merchant
 * accepts either, and neither side has to deploy at the same moment as the other.
 *
 * Comparison is `timingSafeEqual`, never `===`. A signature check leaking a byte at a
 * time is the classic way an HMAC becomes forgeable.
 */
export function verify(
  secrets: readonly string[],
  id: string,
  ts: number,
  body: string,
  header: string,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!Number.isFinite(ts) || Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) return false;

  const presented = header.split(" ").filter((s) => s.length > 0);
  let matched = false;

  for (const secret of secrets) {
    const expected = Buffer.from(sign(secret, id, ts, body));
    for (const candidate of presented) {
      const got = Buffer.from(candidate);
      // No early exit on a match: the loop runs to the end so the number of comparisons
      // does not depend on which secret or which signature was the right one.
      if (got.length === expected.length && timingSafeEqual(got, expected)) matched = true;
    }
  }

  return matched;
}

/** Truncate to a byte budget, not a character count — a 4 KB cap in code points is not one. */
export function truncateBody(body: string, cap: number = RESPONSE_BODY_CAP_BYTES): string {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length <= cap) return body;
  // `toString` on a cut buffer can leave a partial code point; `TextDecoder` replaces it
  // rather than throwing, which is the right trade for a diagnostic field.
  return new TextDecoder("utf8").decode(bytes.subarray(0, cap));
}

/**
 * The queue key, mirroring the keeper's `${planId}:${installmentIndex}` idempotency.
 *
 * Block number and log index make it unique per chain event, so a duplicate crank — an
 * indexer replay, a job enqueued twice — is a no-op rather than a second delivery.
 */
export function jobKey(event: string, planId: string, blockNumber: bigint | string, logIndex: number | string): string {
  return `${event}:${planId}:${blockNumber}:${logIndex}`;
}

/**
 * When the next attempt is due, jittered.
 *
 * The jitter is ±20% and it is not decoration: seven thousand merchants whose endpoint
 * failed in the same incident would otherwise all retry in the same millisecond, and the
 * retry storm is what keeps the endpoint down.
 */
export function nextAttemptDelayMs(attempt: number, random: () => number = Math.random): number | null {
  if (attempt >= MAX_ATTEMPTS) return null;
  const base = RETRY_LADDER_MS[attempt]!;
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** What is sent, before it is signed. The chain coordinates ride along on every one. */
export interface WebhookPayload {
  readonly event: string;
  readonly planId?: string | undefined;
  readonly blockNumber?: string | undefined;
  readonly logIndex?: number | undefined;
  readonly data: Record<string, unknown>;
}

export interface EndpointRow {
  readonly id: string;
  readonly merchantId: string;
  readonly url: string;
  readonly signingSecrets: string[];
  readonly status: string;
}

export interface DeliveryDeps {
  readonly db: Db;
  /** Injected so a test asserts the request without a network. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: (() => Date) | undefined;
  /** Injected so a rebinding hostname can be asserted without controlling DNS. */
  readonly resolve?: Resolver | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface WebhookDeliveryOutcome {
  readonly deliveryId: string;
  readonly webhookId: string;
  readonly ok: boolean;
  readonly status: number | null;
  readonly latencyMs: number;
  /** Set when the attempt never produced a response at all. */
  readonly error?: string | undefined;
  /** When the next attempt is due, or null when the ladder is spent. */
  readonly retryInMs: number | null;
}

interface SendResult {
  readonly status: number | null;
  readonly body: string;
  readonly latencyMs: number;
  readonly error?: string | undefined;
}

/**
 * One HTTP attempt, with the destination re-validated first.
 *
 * `assertDeliverable` is called here — in the sender — and not at registration, because a
 * registration-time answer is a cached answer and a cached answer is a rebinding attack.
 */
async function send(
  deps: DeliveryDeps,
  endpoint: EndpointRow,
  headers: Record<string, string>,
  body: string,
): Promise<SendResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const started = Date.now();

  const target = await assertDeliverable(endpoint.url, {resolve: deps.resolve});

  const response = await fetchImpl(target.url, {
    method: "POST",
    headers: {...headers, "content-type": "application/json", "user-agent": "plazo-webhooks/1"},
    body,
    // A redirect is a request to skip every check above. It is refused, not followed.
    redirect: "manual",
    signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
  });

  assertNotRedirected(response);

  const text = await response.text().catch(() => "");
  return {status: response.status, body: truncateBody(text), latencyMs: Date.now() - started};
}

/**
 * Deliver one event and record the attempt, whether it worked or not.
 *
 * A delivery log holding only successes cannot tell a merchant that their endpoint has
 * been 502-ing for three days, which is the one question it exists to answer. So a refused
 * destination, a timeout and a 500 are all rows.
 */
export async function deliver(
  deps: DeliveryDeps,
  endpoint: EndpointRow,
  payload: WebhookPayload,
  attempt = 0,
): Promise<WebhookDeliveryOutcome> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const webhookId = newWebhookId();
  const timestamp = Math.floor(at.getTime() / 1000);
  const body = JSON.stringify(payload);

  const outcome = await attemptSend(deps, endpoint, webhookId, timestamp, body);

  const [row] = await deps.db
    .insert(webhookDelivery)
    .values({
      merchantId: endpoint.merchantId,
      endpointId: endpoint.id,
      event: payload.event,
      webhookId,
      attempt,
      requestBody: body,
      responseStatus: outcome.status,
      responseBodyTruncated: outcome.body,
      latencyMs: outcome.latencyMs,
      sentAt: at,
    })
    .returning({id: webhookDelivery.id});

  const ok = outcome.status !== null && outcome.status >= 200 && outcome.status < 300;

  return {
    deliveryId: row!.id,
    webhookId,
    ok,
    status: outcome.status,
    latencyMs: outcome.latencyMs,
    error: outcome.error,
    retryInMs: ok ? null : nextAttemptDelayMs(attempt + 1),
  };
}

/**
 * Sign and send, turning every failure into a recordable result.
 *
 * A throw here would leave no row, and a delivery attempt with no row is the failure mode
 * the log exists to make impossible.
 */
async function attemptSend(
  deps: DeliveryDeps,
  endpoint: EndpointRow,
  webhookId: string,
  timestamp: number,
  body: string,
): Promise<SendResult> {
  // Every valid secret signs, space-separated. This is what makes a rotation not an
  // outage: the merchant accepts either while they move.
  const signature = endpoint.signingSecrets
    .map((secret) => sign(secret, webhookId, timestamp, body))
    .join(" ");

  const headers = {
    "webhook-id": webhookId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signature,
  };

  try {
    return await send(deps, endpoint, headers, body);
  } catch (error) {
    return {status: null, body: "", latencyMs: 0, error: (error as Error).message};
  }
}

/**
 * Move an endpoint's status after a run of failures.
 *
 * `degraded` when the ladder is spent on one event; `disabled` after 72 hours of
 * continuous failure. Degraded still delivers — it is a state a merchant can be told
 * about, which a boolean cannot express (06-02b's schema note).
 */
export async function noteEndpointFailure(
  deps: DeliveryDeps,
  endpointId: string,
  firstFailureAt: Date,
): Promise<"active" | "degraded" | "disabled"> {
  const now = (deps.now ?? (() => new Date()))();
  const status = now.getTime() - firstFailureAt.getTime() >= DISABLE_AFTER_MS ? "disabled" : "degraded";

  await deps.db
    .update(webhookEndpoint)
    .set({status, disabledAt: status === "disabled" ? now : null})
    .where(eq(webhookEndpoint.id, endpointId));

  return status;
}

/** Back to healthy on the first success, so one bad afternoon is not a permanent label. */
export async function noteEndpointSuccess(deps: DeliveryDeps, endpointId: string): Promise<void> {
  await deps.db
    .update(webhookEndpoint)
    .set({status: "active", disabledAt: null})
    .where(eq(webhookEndpoint.id, endpointId));
}

export interface ReplayResult extends WebhookDeliveryOutcome {
  /** The delivery this one repeats. Never overwritten — the original failure is evidence. */
  readonly replayOf: string;
}

/**
 * Re-send a stored delivery, verbatim, with a fresh id and timestamp.
 *
 * The body is the bytes that were sent the first time, byte for byte, because a replay
 * that re-serialised the event would be a different message with the same name — and the
 * merchant would be reconciling against something Plazo never actually sent before.
 *
 * The id is **not** the original. See the header: a receiver deduping on `webhook-id`, as
 * instructed, would drop it.
 */
export async function replay(
  deps: DeliveryDeps,
  deliveryId: string,
  merchantId?: string,
): Promise<ReplayResult> {
  const where = merchantId
    ? and(eq(webhookDelivery.id, deliveryId), eq(webhookDelivery.merchantId, merchantId))
    : eq(webhookDelivery.id, deliveryId);

  const [original] = await deps.db.select().from(webhookDelivery).where(where).limit(1);
  if (!original) throw new Error(`no webhook delivery ${deliveryId}`);

  const [endpoint] = await deps.db
    .select()
    .from(webhookEndpoint)
    .where(eq(webhookEndpoint.id, original.endpointId))
    .limit(1);
  if (!endpoint) throw new Error(`webhook delivery ${deliveryId} has no endpoint`);

  const now = (deps.now ?? (() => new Date()))();
  const webhookId = newWebhookId();
  const timestamp = Math.floor(now.getTime() / 1000);

  const outcome = await attemptSend(
    deps,
    {
      id: endpoint.id,
      merchantId: endpoint.merchantId,
      url: endpoint.url,
      signingSecrets: endpoint.signingSecrets,
      status: endpoint.status,
    },
    webhookId,
    timestamp,
    original.requestBody,
  );

  const [row] = await deps.db
    .insert(webhookDelivery)
    .values({
      merchantId: original.merchantId,
      endpointId: original.endpointId,
      event: original.event,
      webhookId,
      attempt: 0,
      requestBody: original.requestBody,
      responseStatus: outcome.status,
      responseBodyTruncated: outcome.body,
      latencyMs: outcome.latencyMs,
      sentAt: now,
      replayOf: original.id,
    })
    .returning({id: webhookDelivery.id});

  const ok = outcome.status !== null && outcome.status >= 200 && outcome.status < 300;

  return {
    deliveryId: row!.id,
    webhookId,
    replayOf: original.id,
    ok,
    status: outcome.status,
    latencyMs: outcome.latencyMs,
    error: outcome.error,
    retryInMs: null,
  };
}

export interface RegisterEndpointInput {
  readonly merchantId: string;
  readonly url: string;
}

/**
 * Register a destination, and hand back the signing secret exactly once.
 *
 * The URL is validated here as a courtesy — so a merchant learns about a typo at
 * registration rather than from a silent delivery log — and validated again on every send,
 * which is the check that actually matters.
 */
export async function registerEndpoint(
  deps: DeliveryDeps,
  input: RegisterEndpointInput,
): Promise<{endpoint: EndpointRow; secret: string}> {
  await assertDeliverable(input.url, {resolve: deps.resolve});

  const secret = newSigningSecret();
  const [row] = await deps.db
    .insert(webhookEndpoint)
    .values({merchantId: input.merchantId, url: input.url, signingSecrets: [secret]})
    .returning();

  return {
    endpoint: {
      id: row!.id,
      merchantId: row!.merchantId,
      url: row!.url,
      signingSecrets: row!.signingSecrets,
      status: row!.status,
    },
    secret,
  };
}

/**
 * Add a second signing secret and keep the first, which is what an overlap is.
 *
 * The array is newest-first. Dropping the old one is a separate, later act — deliberately,
 * because a rotation that removed the old secret in the same call would be a rotation with
 * no overlap wearing the word.
 */
export async function rotateSigningSecret(
  deps: DeliveryDeps,
  endpointId: string,
): Promise<{secret: string; secrets: string[]}> {
  const [row] = await deps.db
    .select()
    .from(webhookEndpoint)
    .where(eq(webhookEndpoint.id, endpointId))
    .limit(1);
  if (!row) throw new Error(`no webhook endpoint ${endpointId}`);

  const secret = newSigningSecret();
  const secrets = [secret, ...row.signingSecrets].slice(0, 2);

  await deps.db
    .update(webhookEndpoint)
    .set({signingSecrets: secrets})
    .where(eq(webhookEndpoint.id, endpointId));

  return {secret, secrets};
}

/**
 * Every destination this merchant has registered, secrets included.
 *
 * Internal — this is what the fan-out needs and it is deliberately not what a route
 * returns. `listEndpoints` is the merchant-facing shape and it carries a count where this
 * carries the secrets themselves.
 */
export async function endpointsFor(db: Db, merchantId: string): Promise<EndpointRow[]> {
  const rows = await db
    .select()
    .from(webhookEndpoint)
    .where(eq(webhookEndpoint.merchantId, merchantId));

  return rows.map((row) => ({
    id: row.id,
    merchantId: row.merchantId,
    url: row.url,
    signingSecrets: row.signingSecrets,
    status: row.status,
  }));
}

/** A destination as a merchant may see it: never a secret, only how many are live. */
export interface EndpointView {
  readonly id: string;
  readonly url: string;
  /** `active` | `degraded` | `disabled`. */
  readonly status: string;
  /** How many signing secrets currently verify. Two during a rotation window. */
  readonly signingSecretCount: number;
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
}

/**
 * The destination list. 06-06 shipped the `POST` and no way to read it back.
 *
 * The secret is a **count** here and nowhere a value, and that is structural rather than
 * careful: `EndpointView` has no field a secret could be assigned to, so a route that
 * returned one would not compile. A merchant who has lost a secret rotates; there is no
 * recovery path and there must not be one (T-06-12-02).
 */
export async function listEndpoints(db: Db, merchantId: string): Promise<EndpointView[]> {
  const rows = await db
    .select()
    .from(webhookEndpoint)
    .where(eq(webhookEndpoint.merchantId, merchantId))
    .orderBy(desc(webhookEndpoint.createdAt));

  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    status: row.status,
    signingSecretCount: row.signingSecrets.length,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
  }));
}

/**
 * Deliver one event to every destination a merchant has registered.
 *
 * `disabled` endpoints are skipped and `degraded` ones are not: degraded means "failing
 * often enough to be worth telling somebody about", and an endpoint that stopped receiving
 * the moment it got that label could never demonstrate a recovery. `noteEndpointSuccess`
 * is what takes the label off, and it can only run if something was still being sent.
 *
 * Every attempt is a row whether it worked or not, because `deliver` writes one either way.
 * A merchant with no destination registered gets an empty array — that is a merchant who
 * has not asked for webhooks, not a failure, and it must not throw into the caller's
 * request.
 */
export async function fanout(
  deps: DeliveryDeps,
  merchantId: string,
  payload: WebhookPayload,
): Promise<WebhookDeliveryOutcome[]> {
  const endpoints = await endpointsFor(deps.db, merchantId);
  const outcomes: WebhookDeliveryOutcome[] = [];

  for (const endpoint of endpoints) {
    if (endpoint.status === "disabled") continue;
    outcomes.push(await deliver(deps, endpoint, payload));
  }

  return outcomes;
}

export interface DeliveryView {
  readonly id: string;
  readonly event: string;
  readonly webhookId: string;
  readonly endpointId: string;
  readonly attempt: number;
  readonly responseStatus: number | null;
  readonly latencyMs: number | null;
  readonly sentAt: Date;
  readonly replayOf: string | null;
  readonly requestBody?: string | undefined;
  readonly responseBodyTruncated?: string | null | undefined;
}

/** The merchant's own delivery log, newest first, scoped to them and nobody else. */
export async function listDeliveries(
  db: Db,
  merchantId: string,
  limit = 100,
): Promise<DeliveryView[]> {
  const rows = await db
    .select()
    .from(webhookDelivery)
    .where(eq(webhookDelivery.merchantId, merchantId))
    .orderBy(desc(webhookDelivery.sentAt))
    .limit(Math.min(Math.max(limit, 1), 500));

  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    webhookId: row.webhookId,
    endpointId: row.endpointId,
    attempt: row.attempt,
    responseStatus: row.responseStatus,
    latencyMs: row.latencyMs,
    sentAt: row.sentAt,
    replayOf: row.replayOf,
  }));
}

/** One delivery, with the bodies. The row MERCH-05's "inspect" reads. */
export async function getDelivery(
  db: Db,
  merchantId: string,
  deliveryId: string,
): Promise<DeliveryView | null> {
  const [row] = await db
    .select()
    .from(webhookDelivery)
    .where(and(eq(webhookDelivery.id, deliveryId), eq(webhookDelivery.merchantId, merchantId)))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    event: row.event,
    webhookId: row.webhookId,
    endpointId: row.endpointId,
    attempt: row.attempt,
    responseStatus: row.responseStatus,
    latencyMs: row.latencyMs,
    sentAt: row.sentAt,
    replayOf: row.replayOf,
    requestBody: row.requestBody,
    responseBodyTruncated: row.responseBodyTruncated,
  };
}
