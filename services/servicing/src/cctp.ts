/**
 * The attestation poller, and where it is allowed to learn that a burn happened.
 *
 * XCH-02. A cross-domain settlement leaves Arc as a CCTP v2 burn and arrives on the
 * destination only once Circle's attestation service has signed it. Something has to
 * notice each burn and go and ask.
 *
 * ## C10: Ponder is the trigger, never a Circle webhook
 *
 * Circle's Smart Contract Platform will happily deliver a webhook when a contract emits,
 * and it is tempting because it looks like less code. It is a single vendor on the
 * critical path of a credit system's settlement loop, and its failure mode is silence:
 * a missed delivery is not an error anyone sees, it is money that stopped moving, and
 * the operator finds out when the merchant asks. The indexer's `payoutDispatch` table
 * cannot miss a log, because it is derived from the chain — it can only lag, and a lag
 * is visible.
 *
 * So the provider below reads the indexer. There is no webhook path in this file, and a
 * grep gate says so.
 *
 * ## Why the provider is injected
 *
 * `pollDispatched` takes its dispatches rather than fetching them, so the loop can be
 * asserted without a network or a database, and so the read can be swapped without the
 * loop being rewritten. `noPendingDispatches` is the no-op default: a poller that is
 * wired up but not yet pointed anywhere does nothing rather than throwing at three in
 * the morning.
 *
 * ## Where the attestation state lives, and why not on the indexer's table
 *
 * `pendingDispatches` reports every burn from a cursor forward and takes no view on
 * which have already been attested. That is deliberate. An `attested` column on
 * `payoutDispatch` would put a vendor's answer in a chain-derived table, and the table
 * would stop being reproducible from the chain — the one property the whole storage
 * split exists to keep (OPS-08, D-17). The chain-derived schema is the authority on what
 * was dispatched; this poller is the authority on what it has since heard back.
 *
 * ## The transaction hash is the join, and there is no alternative
 *
 * DEC-31, finding 28: a CCTP v2 burn emits a **zero** nonce. The real `eventNonce` is
 * assigned by Iris at attestation, so at the moment the burn lands there is no on-chain
 * identifier for anything to key on. The join between Plazo's ledger and Circle's is the
 * transaction hash, and it is off-chain by construction rather than by omission.
 *
 * ## The endpoint that actually routes, and the 404 that does not mean what it says
 *
 * Circle's own guide documents a query-parameter form on `/v2/messages`. It returns an
 * **HTML** 404 and does not route (Pitfall 6, verified). The working shape is
 * `/v2/messages/{sourceDomain}` with a `transactionHash` query parameter, and it answers a
 * **JSON** 404 — `{"error":"Message not found for provided parameters"}` — while the burn
 * is not yet indexed.
 *
 * Both are 404s, so branching on the status code cannot tell them apart, and a poller that
 * does will retry a routing error forever without ever saying anything. `fetchAttestation`
 * branches on the **body shape**: a JSON error is "wait and ask again", an HTML body is
 * "the URL is wrong and waiting will never fix it", and the second throws.
 */
import {ARC_CCTP_DOMAIN, IRIS_SANDBOX_BASE_URL} from "@plazo/plan-core";
import {and, eq, sql} from "drizzle-orm";

import {payoutAttestation} from "./db/schema.js";
import type {Db} from "./db/client.js";

/**
 * One burn, as the indexer reports it.
 *
 * Money is a decimal string because JSON does not carry bigints, and because this record
 * arrives over HTTP from a service that formats at the leaf for that reason.
 */
export interface PendingDispatch {
  /** Block number and log index. Stable across replays; the poller's idempotency key. */
  readonly id: string;
  /** The burn. The only join to Circle's ledger. */
  readonly txHash: string;
  readonly token: string;
  readonly recipient: string;
  /** CCTP destination domain. Never 26 — settlement to Arc never leaves. */
  readonly domain: number;
  readonly amount: string;
  readonly blockNumber: string;
  readonly timestamp: number;
}

/** Where the poller gets its work. Injected so the loop is assertable. */
export type PendingDispatches = (params: {
  after?: bigint | undefined;
  limit?: number | undefined;
}) => Promise<readonly PendingDispatch[]>;

/**
 * The default. Does nothing, loudly enough to be found in a config, quietly enough to
 * not wake anybody.
 */
export const noPendingDispatches: PendingDispatches = async () => [];

/**
 * The real one: the indexer's own read of its own table.
 *
 * `PLAZO_INDEXER_URL` is the same variable the borrower and lender apps already use, so
 * an operator configures one indexer address and everything downstream of it follows.
 */
export function indexerPendingDispatches(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): PendingDispatches {
  const root = baseUrl.replace(/\/+$/, "");

  return async ({after, limit}) => {
    const url = new URL(`${root}/v1/payouts/dispatches`);
    if (after !== undefined) url.searchParams.set("after", after.toString());
    if (limit !== undefined) url.searchParams.set("limit", String(limit));

    const response = await fetchImpl(url, {headers: {accept: "application/json"}});
    if (!response.ok) {
      throw new Error(`indexer refused the dispatch read: ${response.status}`);
    }

    const body = (await response.json()) as {dispatches?: PendingDispatch[]};
    return body.dispatches ?? [];
  };
}

/** What the poller knows about attestations it has already completed. */
export interface AttestationRecord {
  readonly id: string;
  /** False while Iris has been asked and has not yet answered with a usable message. */
  readonly complete: boolean;
}

export interface PollDeps {
  /** Where the work comes from. Defaults to doing nothing. */
  readonly dispatches?: PendingDispatches;
  /** What the poller has already handled, by dispatch id. */
  readonly attestations: ReadonlyMap<string, AttestationRecord>;
  /** The block the poller last swept past. */
  readonly cursor?: bigint | undefined;
  readonly limit?: number | undefined;
}

export interface PollResult {
  /** Burns still owed an attestation, oldest first. */
  readonly outstanding: readonly PendingDispatch[];
  /** Where to resume. Unchanged when the sweep found nothing. */
  readonly cursor: bigint | undefined;
}

/**
 * One sweep.
 *
 * A dispatch is outstanding when the poller has no record of it **or** when the record
 * it has is incomplete — an attestation that was requested and never came back is
 * exactly the case that must be retried, and treating "we asked" as "it is done" is how
 * a settlement goes quiet forever.
 *
 * The cursor only advances past a prefix of fully-attested burns. Advancing past an
 * outstanding one would mean never seeing it again, so a single stuck attestation holds
 * the cursor rather than being silently abandoned — the sweep gets slower, which is
 * visible, instead of lossy, which is not.
 */
export async function pollDispatched(deps: PollDeps): Promise<PollResult> {
  const source = deps.dispatches ?? noPendingDispatches;
  const found = await source({after: deps.cursor, limit: deps.limit});

  const isDone = (dispatch: PendingDispatch): boolean =>
    deps.attestations.get(dispatch.id)?.complete === true;

  const outstanding = found.filter((dispatch) => !isDone(dispatch));

  let cursor = deps.cursor;
  for (const dispatch of found) {
    if (!isDone(dispatch)) break;
    cursor = BigInt(dispatch.blockNumber);
  }

  return {outstanding, cursor};
}

// ─── Iris ────────────────────────────────────────────────────────────────────

/**
 * The attestation service's base URL.
 *
 * Read at call time rather than at module load, so a test and a deployment can differ
 * without a module cache deciding which one won.
 */
export function irisBaseUrl(): string {
  return (process.env["PLAZO_IRIS_URL"] ?? IRIS_SANDBOX_BASE_URL).replace(/\/+$/, "");
}

/** What Iris hands back once it has signed the burn. Both halves are needed to mint. */
export interface IrisAttestation {
  readonly message: `0x${string}`;
  readonly attestation: `0x${string}`;
  /** Assigned by Iris, not by the chain (DEC-31). Present once the message is complete. */
  readonly eventNonce?: string | undefined;
}

export interface FetchAttestationDeps {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly baseUrl?: string | undefined;
  readonly domain?: number | undefined;
}

/**
 * The error raised when Iris answers in a way that waiting will not fix.
 *
 * Separate from "not indexed yet" on purpose: one is a retry and the other is a page.
 */
export class IrisRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IrisRoutingError";
  }
}

const looksLikeHtml = (body: string): boolean => /^\s*<(?:!doctype|html)/i.test(body);

/**
 * Ask Iris about one burn.
 *
 * Returns `null` when the message is not indexed yet or is indexed but not yet complete —
 * both are "ask again later" and the job retries. Throws on anything that means the poller
 * itself is wrong.
 */
export async function fetchAttestation(
  txHash: string,
  deps: FetchAttestationDeps = {},
): Promise<IrisAttestation | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.baseUrl ?? irisBaseUrl();
  const domain = deps.domain ?? ARC_CCTP_DOMAIN;

  // The form that routes. The documented one — `/v2/messages` with a `txHash` query
  // parameter — answers an HTML 404 and never resolves (Pitfall 6).
  const url = `${base}/messages/${domain}?transactionHash=${txHash}`;

  const response = await fetchImpl(url);
  const body = await response.text();

  if (looksLikeHtml(body)) {
    throw new IrisRoutingError(
      `iris answered ${response.status} with an HTML body for ${url}. That is a routing ` +
        "failure, not an unindexed message: the guide's `/v2/messages` + `txHash` query " +
        "form does not route. Use `/v2/messages/{sourceDomain}` with `transactionHash`.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new IrisRoutingError(
      `iris answered ${response.status} with a body that is neither JSON nor HTML for ${url}`,
    );
  }

  if (!response.ok) {
    const error = (parsed as {error?: unknown}).error;
    // A JSON error body is Iris speaking: the message is simply not there yet.
    if (response.status === 404 && typeof error === "string") return null;
    throw new Error(`iris ${response.status}: ${typeof error === "string" ? error : body.slice(0, 200)}`);
  }

  const message = (parsed as {messages?: {status?: string; message?: string; attestation?: string; eventNonce?: string}[]})
    .messages?.[0];

  if (!message || message.status !== "complete") return null;
  if (!message.message || !message.attestation) return null;

  return {
    message: message.message as `0x${string}`,
    attestation: message.attestation as `0x${string}`,
    eventNonce: message.eventNonce,
  };
}

/**
 * The job key for one burn's attestation poll.
 *
 * `payout:${planId}:${domain}` — the same idempotency shape as the keeper's
 * `${planId}:${installmentIndex}`, so a duplicate crank is a no-op rather than a second
 * poll. It is also exactly the primary key of `payout_attestation`, which is not a
 * coincidence: the job and the row are the same fact.
 */
export function attestationJobKey(planId: string, domain: number): string {
  return `payout:${planId}:${domain}`;
}

export interface PollRecord {
  readonly planId: string;
  readonly destinationDomain: number;
  readonly txHash: string;
}

/**
 * Write down what one poll found, and that a poll happened at all.
 *
 * `attempts` increments on **every** poll, including the ones that found nothing. A burn
 * that has been asked about four hundred times and is still pending is a stuck settlement,
 * and the difference between "stuck" and "slow" is a number nobody has unless it was
 * recorded. Without the counter a permanently-lost message looks exactly like one that has
 * not been asked about yet.
 */
export async function notePoll(
  db: Db,
  record: PollRecord,
  found: IrisAttestation | null,
  now: Date = new Date(),
): Promise<void> {
  const status = found ? "complete" : "pending";

  await db
    .insert(payoutAttestation)
    .values({
      planId: record.planId,
      destinationDomain: record.destinationDomain,
      txHash: record.txHash,
      message: found?.message ?? null,
      attestation: found?.attestation ?? null,
      status,
      polledAt: now,
      attempts: 1,
    })
    .onConflictDoUpdate({
      target: [payoutAttestation.planId, payoutAttestation.destinationDomain],
      set: {
        txHash: record.txHash,
        message: found?.message ?? sql`${payoutAttestation.message}`,
        attestation: found?.attestation ?? sql`${payoutAttestation.attestation}`,
        status,
        polledAt: now,
        attempts: sql`${payoutAttestation.attempts} + 1`,
      },
    });
}

export interface AttestationView {
  readonly planId: string;
  readonly destinationDomain: number;
  readonly txHash: string;
  readonly message: string | null;
  readonly attestation: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly polledAt: Date | null;
}

/**
 * What the operator has heard back about one plan's payout.
 *
 * Surfaced to the merchant so they can call `receiveMessage` on the destination chain
 * themselves (D-12). Plazo holds no gas token on any chain but Arc, so the last mile is
 * the merchant's — which is a property of the design and not a gap in it: the message and
 * the attestation are all that is needed, and anybody holding them can complete the mint.
 */
export async function attestationFor(
  db: Db,
  planId: string,
  domain?: number,
): Promise<AttestationView | null> {
  const where =
    domain === undefined
      ? eq(payoutAttestation.planId, planId)
      : and(
          eq(payoutAttestation.planId, planId),
          eq(payoutAttestation.destinationDomain, domain),
        );

  const [row] = await db.select().from(payoutAttestation).where(where).limit(1);
  if (!row) return null;

  return {
    planId: row.planId,
    destinationDomain: row.destinationDomain,
    txHash: row.txHash,
    message: row.message,
    attestation: row.attestation,
    status: row.status,
    attempts: row.attempts,
    polledAt: row.polledAt,
  };
}
