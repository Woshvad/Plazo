/**
 * The merchant dashboard's numbers.
 *
 * Three services and one gap, and the gap is labelled rather than hidden.
 *
 * - `PLAZO_INDEXER_URL` → settlements. Chain-derived, joined to the merchant's own order
 *   id inside the indexer (`GET /v1/merchants/:merchant/settlements`, plan 06-11).
 * - `PLAZO_SERVICING_URL` → the webhook delivery log and the CCTP payout attestations.
 * - `PLAZO_ORIGINATION_URL` → API keys.
 *
 * **Why keys are a third base URL and not the second one.** The plan text puts keys on
 * `PLAZO_SERVICING_URL`. They are not there. Plan 06-06 put every key route on
 * `services/origination` and said why in DEC-64: the key tables belong to
 * `@plazo/origination`, and a dependency from servicing to origination would be a cycle
 * in the operator plane, so servicing takes an injected `merchants` seam instead of
 * owning the store. Pointing this app's key reads at the servicing base would produce a
 * 404 on a correctly-deployed stack. A third variable is the cost of that being true.
 *
 * **The gap 06-13 closed.** Four things this dashboard shows come from contract views:
 * the merchant's registry row (bond, requirement, velocity, category), the escrow rows and
 * their timers, `RefundEscrow.refundPreview`, and `voidAmountFor`. 06-12 left all four
 * sample-only under DEC-68, because the contracts behind them were not deployed and a
 * getter calling a route nobody had written would have turned a configured deployment into
 * a 500 where a labelled sample degrades.
 *
 * **06-13 deployed them**, so the premise is gone. Those four now read the chain directly
 * through `_chain.ts` — not through a service route, because these are unauthenticated
 * views of public state and a route would be a second place the ABI lives and a cache with
 * no invalidation story in front of numbers a merchant is about to act on. They stay
 * `source: "chain"` and become `live` when the addresses are configured.
 *
 * **The one payload still sampled by construction** is the webhook destination list, and
 * only until a deployment points `PLAZO_SERVICING_URL` at a process that serves
 * `GET /v1/webhooks/endpoints`. The banner names it with that reason rather than telling a
 * merchant to set a variable that is already set.
 *
 * ## The rules this file follows
 *
 * - Every payload carries `live: boolean`, a `source`, and — when it is not live — the
 *   reason. `page.tsx` renders one banner naming exactly which sources are sampled,
 *   unconditionally and with no dismiss. A demo indistinguishable from production is how
 *   a screenshot ends up in a deck describing a book that does not exist, and a dashboard
 *   that is *half* live is more misleading than one that is wholly sampled.
 * - The API key is sent as `Authorization: Bearer` and never as a query parameter. A key
 *   that has been in a URL is already in an access log, a `Referer` and browser history.
 *   The operator API refuses a credential-shaped query parameter with a 400 telling the
 *   caller to rotate it (plan 06-06); this side simply never produces one.
 * - Money crosses as a decimal **string** and is formatted at the leaf. Nothing monetary
 *   goes through `Number`: at 6-decimal USDC the safe-integer boundary is about $9bn and
 *   a float returns a neighbouring value that reads as an off-by-one rather than as a
 *   lost dollar.
 * - `process.env["X"]`, bracket access, **read at call time**. `apps/lender/app/_data.ts`
 *   reads its base at module load; `apps/lender/app/_crosschain.ts` reads at call time and
 *   has a test asserting it. Call time is the better of the two conventions in the same
 *   app family, because a module-load read cannot be exercised by a test at all.
 * - A failing **service** fetch throws. It never degrades to a sample, because a silent
 *   sample is the exact failure the `live` flag exists to prevent.
 * - A failing **chain** read does not throw — it comes back `live: false` with the failure
 *   named in `sampled`, and the banner prints it. That divergence is deliberate and the
 *   reason is measured: Arc's public RPC sheds roughly a quarter of requests regardless of
 *   pacing (Phase 1, still true), so a dashboard that 500s on a shed request is not a
 *   dashboard. It is not silent — naming the RPC in the banner is more use to the reader
 *   than a stack trace, and it is exactly the sort of thing a per-payload reason can say
 *   and a single stripe cannot.
 */

import {
  client,
  CONTRACTS,
  ESCROW_STATE,
  INSTALLMENT_PLAN_ABI,
  installmentStatus,
  MERCHANT_REGISTRY_ABI,
  PARAMETER_KEYS,
  PARAMETER_REGISTRY_ABI,
  PLAN_FACTORY_ABI,
  REFUND_ESCROW_ABI,
  rpcUrl,
  SETTLEMENT_CATEGORY,
  SETTLEMENT_ESCROW_ABI,
  UINT256_MAX,
} from "./_chain";

// ─────────────────────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────────────────────

/** Where a payload came from, or would have come from. */
export type Source = "indexer" | "servicing" | "origination" | "chain";

/** The env var that turns each source live. `chain` has none, which is the point. */
export const SOURCE_ENV: Record<Source, string | null> = {
  indexer: "PLAZO_INDEXER_URL",
  servicing: "PLAZO_SERVICING_URL",
  origination: "PLAZO_ORIGINATION_URL",
  chain: null,
};

export interface Sourced {
  readonly live: boolean;
  readonly source: Source;
  /** Why this payload is a sample. The empty string when it is live. */
  readonly sampled: string;
}

const SAMPLED = (source: Source): string => {
  const env = SOURCE_ENV[source];
  return env === null
    ? "set the contract addresses to read this from chain — see app/_chain.ts"
    : `set ${env} to read live`;
};

const sample = (source: Source): Sourced => ({live: false, source, sampled: SAMPLED(source)});
const fromService = (source: Source): Sourced => ({live: true, source, sampled: ""});

/**
 * A chain read that could not be completed, named rather than thrown.
 *
 * The message carries the RPC's own words. A merchant reading "sheddable public endpoint"
 * or "execution reverted" in the banner can tell an outage from a misconfiguration, and
 * neither of those is a thing a generic "sample data" stripe could ever say.
 */
const fromChain = (): Sourced => ({live: true, source: "chain", sampled: ""});

/**
 * Bounds on the fan-out.
 *
 * Every one of these is a call per plan per field against an endpoint that sheds a quarter
 * of its requests. Unbounded, one merchant with a long book turns a page load into several
 * hundred RPC calls and the shed rate compounds. The caps are the page's, not the chain's,
 * and they are here rather than inline so there is one place to move them.
 */
const MAX_PLAN_READS = 50;
const MAX_REFUND_READS = 5;
const MAX_PREVIEWS = 8;

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as const;

/** The clock the timers are read against, so a render says which moment it is describing. */
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const chainFailed = (reason: unknown): Sourced => ({
  live: false,
  source: "chain",
  sampled: `the chain read failed against ${rpcUrl()} — ${
    reason instanceof Error ? reason.message.split("\n")[0] : String(reason)
  }`,
});

// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────

const trimmed = (value: string | undefined): string | undefined => {
  const raw = value?.trim();
  return raw === undefined || raw === "" ? undefined : raw.replace(/\/+$/, "");
};

const baseFor = (source: Source): string | undefined => {
  const env = SOURCE_ENV[source];
  return env === null ? undefined : trimmed(process.env[env]);
};

/** The merchant whose book this deployment shows. Only used to address the indexer. */
export const merchantAddress = (): string | undefined => trimmed(process.env["PLAZO_MERCHANT_ADDRESS"]);

/**
 * The credential, as a header and only as a header.
 *
 * Cleartext refused outright: a bearer token on `http://` to anything but a loopback
 * host is a credential handed to every hop on the path, and the operator API's own rule
 * is that a leaked key must be rotated rather than tolerated. Failing here is the only
 * answer that does not require somebody to notice later.
 */
function authorization(base: string): Record<string, string> {
  const key = trimmed(process.env["PLAZO_MERCHANT_API_KEY"]);
  if (key === undefined) return {};

  const url = new URL(base);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error(
      `refusing to send PLAZO_MERCHANT_API_KEY to ${url.origin} in cleartext — use https, or rotate the key if it has already gone out`,
    );
  }

  return {authorization: `Bearer ${key}`};
}

/**
 * One read. Throws on anything but a 2xx.
 *
 * `cache: "no-store"` because a settlement book cached between requests is a book that
 * shows one merchant's numbers to the next request that arrives.
 */
async function read<T>(source: Source, path: string): Promise<T> {
  const base = baseFor(source);
  if (base === undefined) throw new Error(`${source} is not configured`);

  const response = await fetch(`${base}${path}`, {
    cache: "no-store",
    headers: authorization(base),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

/**
 * One write. The same credential rules, and the same refusal to guess.
 *
 * Separate from `read` rather than a flag on it, because the two failure modes are not
 * alike: a read that fails can be retried by reloading, and a write that fails may or may
 * not have happened. The error carries the status so the caller can say which.
 */
export async function post<T>(source: Source, path: string, body?: unknown): Promise<T> {
  const base = baseFor(source);
  if (base === undefined) throw new Error(`${source} is not configured`);

  const response = await fetch(`${base}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: {...authorization(base), "content-type": "application/json"},
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settlements — MERCH-08
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One settlement as the indexer reports it, field for field.
 *
 * `txHash` and `dispatchTxHash` are two columns and not one (DEC-51). A queued
 * settlement has two transactions: the origination is the merchant's key back to their
 * own order, and the burn is Circle's key to the attestation. Folding them answers the
 * second question by destroying the answer to the first.
 */
export interface Settlement {
  readonly planId: string;
  /** The merchant's own order id. Null when nothing has been filed against this plan. */
  readonly externalId: string | null;
  readonly gross: string;
  readonly mdr: string;
  readonly withheld: string;
  readonly net: string;
  readonly refundedAmount: string;
  readonly payoutDomain: number | null;
  readonly payoutStatus: string;
  readonly escrowState: string | null;
  readonly txHash: string | null;
  readonly dispatchTxHash: string | null;
  readonly blockNumber: string;
  readonly timestamp: number;
}

export interface Settlements extends Sourced {
  readonly settlements: readonly Settlement[];
}

export interface SettlementFilter {
  readonly status?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** The `payout.status` values the indexer will accept as a filter. */
export const PAYOUT_STATUSES = ["settled", "queued", "dispatched", "escrowed", "returned"] as const;

const SAMPLE_SETTLEMENTS: Settlements = {
  ...sample("indexer"),
  settlements: [
    {
      planId: "0x8f2c19a4b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873a5e1c0b64f2a9d38e77",
      externalId: "A-10432",
      gross: "126000000",
      mdr: "5040000",
      withheld: "12096000",
      net: "108864000",
      refundedAmount: "0",
      payoutDomain: 26,
      payoutStatus: "settled",
      escrowState: null,
      txHash: "0x4c1d0f2a9b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873a5e1c0b64f2a9d38e10",
      dispatchTxHash: null,
      blockNumber: "54714201",
      timestamp: 1_754_060_400,
    },
    {
      planId: "0x3a71c8e02f9d465b1e7a04c93f28d6b5079e14a3c8b60d92f5e37a1b48c609dd",
      externalId: "A-10433",
      gross: "824000000",
      mdr: "32960000",
      withheld: "0",
      net: "791040000",
      refundedAmount: "0",
      payoutDomain: 6,
      payoutStatus: "dispatched",
      escrowState: null,
      txHash: "0x77a2c8e02f9d465b1e7a04c93f28d6b5079e14a3c8b60d92f5e37a1b48c609a1",
      dispatchTxHash: "0xb90e14a3c8b60d92f5e37a1b48c609dd3a71c8e02f9d465b1e7a04c93f28d6b5",
      blockNumber: "54714388",
      timestamp: 1_754_061_900,
    },
    {
      planId: "0x5d0b64f2a9d38e778f2c19a4b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873a5e",
      externalId: "A-10440",
      gross: "349500000",
      mdr: "13980000",
      withheld: "33552000",
      net: "301968000",
      refundedAmount: "87375000",
      payoutDomain: 26,
      payoutStatus: "escrowed",
      escrowState: "held",
      txHash: "0x2ee04f9b2d873a5e1c0b64f2a9d38e778f2c19a4b7e35d016c4a9f2e83b7d5a1",
      dispatchTxHash: null,
      blockNumber: "54714902",
      timestamp: 1_754_064_100,
    },
    {
      planId: "0x91c0b64f2a9d38e778f2c19a4b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873ff",
      externalId: null,
      gross: "58000000",
      mdr: "2320000",
      withheld: "5568000",
      net: "50112000",
      refundedAmount: "0",
      payoutDomain: 6,
      payoutStatus: "queued",
      escrowState: null,
      txHash: "0x0af9b2d873a5e1c0b64f2a9d38e778f2c19a4b7e35d016c4a9f2e83b7d5a1c6e",
      dispatchTxHash: null,
      blockNumber: "54715110",
      timestamp: 1_754_065_000,
    },
  ],
};

/**
 * MERCH-08's read. One row per settlement, carrying the merchant's own order id.
 *
 * The merchant address is configuration, not a request field. Plan 06-06 took the
 * merchant out of every request body precisely so that a caller cannot ask about somebody
 * else; once the key middleware is mounted on the indexer route the `:merchant` segment
 * will be checked against the key rather than trusted, and this app will still be sending
 * its own address.
 */
export async function settlements(filter: SettlementFilter = {}): Promise<Settlements> {
  const merchant = merchantAddress();
  if (baseFor("indexer") === undefined || merchant === undefined) return SAMPLE_SETTLEMENTS;

  const query = new URLSearchParams();
  if (filter.status !== undefined && filter.status !== "") query.set("status", filter.status);
  if (filter.from !== undefined && filter.from !== "") query.set("from", filter.from);
  if (filter.to !== undefined && filter.to !== "") query.set("to", filter.to);
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;

  const body = await read<{settlements: Settlement[]}>(
    "indexer",
    `/v1/merchants/${merchant}/settlements${suffix}`,
  );
  return {...fromService("indexer"), settlements: body.settlements};
}

// ─────────────────────────────────────────────────────────────────────────────
// Payout attestations — XCH-02, D-12
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a merchant needs to finish a cross-chain payout themselves.
 *
 * **The identifier is the transaction hash, never a nonce** (finding 28 / DEC-31). A
 * CCTP v2 burn emits a *zero* nonce; the real `eventNonce` only comes back from Iris at
 * attestation, so there is no on-chain identifier to quote and a UI that showed one would
 * be showing a zero to every merchant on the page.
 */
export interface Attestation {
  readonly planId: string;
  readonly domain: number;
  readonly txHash: string;
  readonly status: string;
  /** The CCTP message bytes. Null until Iris has attested. */
  readonly message: string | null;
  readonly attestation: string | null;
  /** Polls so far. A large number on a pending row is a stuck settlement, not a slow one. */
  readonly attempts: number;
  readonly polledAt: string | null;
}

export interface Attestations extends Sourced {
  readonly attestations: readonly Attestation[];
}

const SAMPLE_ATTESTATIONS: Attestations = {
  ...sample("servicing"),
  attestations: [
    {
      planId: "0x3a71c8e02f9d465b1e7a04c93f28d6b5079e14a3c8b60d92f5e37a1b48c609dd",
      domain: 6,
      txHash: "0xb90e14a3c8b60d92f5e37a1b48c609dd3a71c8e02f9d465b1e7a04c93f28d6b5",
      status: "complete",
      message: `0x000000010000001a00000006${"a3".repeat(96)}`,
      attestation: `0x${"5c".repeat(65)}${"9e".repeat(65)}`,
      attempts: 3,
      polledAt: "2026-08-02T09:14:22.000Z",
    },
    {
      planId: "0x91c0b64f2a9d38e778f2c19a4b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873ff",
      domain: 6,
      txHash: "0x0af9b2d873a5e1c0b64f2a9d38e778f2c19a4b7e35d016c4a9f2e83b7d5a1c6e",
      status: "pending",
      message: null,
      attestation: null,
      attempts: 11,
      polledAt: "2026-08-02T09:15:02.000Z",
    },
  ],
};

/**
 * The attestations for the plans that actually went cross-chain.
 *
 * One request per plan, because the operator API keys attestations by `planId` and there
 * is no list route. Bounded by the caller's own list rather than by a page size, and a
 * `404` — a burn the poller has never recorded — is skipped rather than thrown, because
 * "not attested yet" is the normal state of a fresh dispatch and not an error.
 */
export async function attestations(planIds: readonly string[]): Promise<Attestations> {
  if (baseFor("servicing") === undefined || planIds.length === 0) return SAMPLE_ATTESTATIONS;

  const rows: Attestation[] = [];
  for (const planId of planIds.slice(0, 50)) {
    try {
      rows.push(await read<Attestation>("servicing", `/v1/payouts/${planId}/attestation`));
    } catch (error) {
      if (!/returned 404$/.test((error as Error).message)) throw error;
    }
  }
  return {...fromService("servicing"), attestations: rows};
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook deliveries — MERCH-05
// ─────────────────────────────────────────────────────────────────────────────

export interface Delivery {
  readonly id: string;
  readonly event: string;
  readonly webhookId: string;
  readonly endpointId: string;
  readonly attempt: number;
  readonly responseStatus: number | null;
  readonly latencyMs: number | null;
  readonly sentAt: string;
  /** Set on a replay, pointing at the delivery it re-sends. */
  readonly replayOf: string | null;
}

export interface Deliveries extends Sourced {
  readonly deliveries: readonly Delivery[];
}

const SAMPLE_DELIVERIES: Deliveries = {
  ...sample("servicing"),
  deliveries: [
    {
      id: "dlv_7f21c0",
      event: "plan.originated",
      webhookId: "msg_0b4c1e2a-77a1-4f0e-9d33-8f61a2c5b0d4",
      endpointId: "wep_1a2b3c",
      attempt: 1,
      responseStatus: 200,
      latencyMs: 142,
      sentAt: "2026-08-02T09:14:20.000Z",
      replayOf: null,
    },
    {
      id: "dlv_7f21c1",
      event: "payout.dispatched",
      webhookId: "msg_2c9d4e1b-11f2-4a3c-8e77-3b6d9a1f5c02",
      endpointId: "wep_1a2b3c",
      attempt: 3,
      responseStatus: 500,
      latencyMs: 3011,
      sentAt: "2026-08-02T09:16:44.000Z",
      replayOf: null,
    },
    {
      id: "dlv_7f21c2",
      event: "payout.dispatched",
      webhookId: "msg_5e01a7c3-3d55-49b8-b0a2-6c1e4f7d2b98",
      endpointId: "wep_1a2b3c",
      attempt: 1,
      responseStatus: 200,
      latencyMs: 118,
      sentAt: "2026-08-02T09:31:05.000Z",
      replayOf: "dlv_7f21c1",
    },
    {
      id: "dlv_7f21c3",
      event: "refund.credited",
      webhookId: "msg_9a3f2b81-6c07-4d12-a5be-0f8c2d3e1a47",
      endpointId: "wep_1a2b3c",
      attempt: 2,
      responseStatus: null,
      latencyMs: null,
      sentAt: "2026-08-02T09:44:12.000Z",
      replayOf: null,
    },
  ],
};

export async function deliveries(limit = 100): Promise<Deliveries> {
  if (baseFor("servicing") === undefined) return SAMPLE_DELIVERIES;
  const body = await read<{deliveries: Delivery[]}>("servicing", `/v1/webhooks/deliveries?limit=${limit}`);
  return {...fromService("servicing"), deliveries: body.deliveries};
}

/**
 * One delivery, with the bodies.
 *
 * **The list omits bodies and the single read includes them, and that split is
 * deliberate** (plan 06-06). A log view that shipped every request and every truncated
 * response would be megabytes on a screen where the reader is looking for one row. So a
 * body is fetched only for the row a merchant actually opened — which is a search
 * parameter and a server round trip, not a client bundle.
 */
export interface DeliveryDetail extends Delivery {
  readonly requestBody: string | null;
  readonly responseBodyTruncated: string | null;
}

const SAMPLE_DELIVERY_BODIES: Record<string, {requestBody: string; responseBodyTruncated: string | null}> = {
  dlv_7f21c1: {
    requestBody: JSON.stringify(
      {
        event: "payout.dispatched",
        planId: "0x3a71c8e02f9d465b1e7a04c93f28d6b5079e14a3c8b60d92f5e37a1b48c609dd",
        blockNumber: "54714388",
        logIndex: 4,
        data: {domain: 6, amount: "791040000", txHash: "0xb90e14a3…"},
      },
      null,
      2,
    ),
    responseBodyTruncated: "<html><head><title>502 Bad Gateway</title></head><body>…",
  },
};

export async function deliveryDetail(id: string): Promise<DeliveryDetail | null> {
  if (baseFor("servicing") === undefined) {
    const row = SAMPLE_DELIVERIES.deliveries.find((delivery) => delivery.id === id);
    if (row === undefined) return null;
    const bodies = SAMPLE_DELIVERY_BODIES[id];
    return {
      ...row,
      requestBody: bodies?.requestBody ?? null,
      responseBodyTruncated: bodies?.responseBodyTruncated ?? null,
    };
  }
  try {
    return await read<DeliveryDetail>("servicing", `/v1/webhooks/deliveries/${id}`);
  } catch (error) {
    if (/returned 404$/.test((error as Error).message)) return null;
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Keys — MERCH-05, D-18
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiKey {
  readonly keyId: string;
  readonly environment: string;
  /** The last four characters of the secret. Enough to recognise, useless to present. */
  readonly last4: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly rotatedFrom: string | null;
}

export interface Keys extends Sourced {
  readonly keys: readonly ApiKey[];
}

const SAMPLE_KEYS: Keys = {
  ...sample("origination"),
  keys: [
    {
      keyId: "3f9c2a71b04e8d55",
      environment: "sandbox",
      last4: "kQ7f",
      createdAt: "2026-07-26T11:02:19.000Z",
      expiresAt: "2026-08-09T10:41:03.000Z",
      revokedAt: null,
      rotatedFrom: null,
    },
    {
      keyId: "a7150cd2e9b34f68",
      environment: "sandbox",
      last4: "2Wxm",
      createdAt: "2026-08-02T10:41:03.000Z",
      expiresAt: null,
      revokedAt: null,
      rotatedFrom: "3f9c2a71b04e8d55",
    },
    {
      keyId: "0c48be71a2d95f30",
      environment: "sandbox",
      last4: "hR4t",
      createdAt: "2026-06-11T08:20:44.000Z",
      expiresAt: null,
      revokedAt: "2026-07-26T11:02:19.000Z",
      rotatedFrom: null,
    },
  ],
};

export async function keys(): Promise<Keys> {
  if (baseFor("origination") === undefined) return SAMPLE_KEYS;
  const body = await read<{keys: ApiKey[]}>("origination", "/v1/keys");
  return {...fromService("origination"), keys: body.keys};
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A registered destination.
 *
 * **The signing secret is never here and there is no field for it.** Only its identifier
 * — a merchant who needs the secret rotates and reads the new one from the one response
 * that carries it (T-06-12-02).
 */
export interface Endpoint {
  readonly id: string;
  readonly url: string;
  /** `active` | `degraded` | `disabled`. */
  readonly status: string;
  /** How many signing secrets are live. Two during a rotation. */
  readonly signingSecretCount: number;
}

export interface Endpoints extends Sourced {
  readonly endpoints: readonly Endpoint[];
}

/**
 * The reason this was sampled has moved, and the string moved with it.
 *
 * 06-06 shipped `POST /v1/webhooks/endpoints` and no list route, so 06-12 recorded the
 * reason as "the operator API has no endpoint-list route yet" rather than "set
 * `PLAZO_SERVICING_URL`" — the second sentence would have sent a merchant to set a variable
 * that was already set. **The route exists now.** What is left is a deployment pointing at
 * a process that serves it, which is the ordinary unset-variable case, so the ordinary
 * sentence is the true one again.
 */
const SAMPLE_ENDPOINTS: Endpoints = {
  ...sample("servicing"),
  endpoints: [
    {id: "wep_1a2b3c", url: "https://hooks.example-merchant.com/plazo", status: "active", signingSecretCount: 1},
    {id: "wep_4d5e6f", url: "https://staging.example-merchant.com/plazo", status: "degraded", signingSecretCount: 2},
  ],
};

/**
 * The registered destinations.
 *
 * The route reports **how many** signing secrets verify and never which. A merchant who has
 * lost one rotates; a route that could hand it back would be a second place it lives
 * (T-06-12-02), and `EndpointView` on the service side has no field one could be assigned
 * to.
 */
export async function endpoints(): Promise<Endpoints> {
  if (baseFor("servicing") === undefined) return SAMPLE_ENDPOINTS;
  const body = await read<{endpoints: Endpoint[]}>("servicing", "/v1/webhooks/endpoints");
  return {...fromService("servicing"), endpoints: body.endpoints};
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrow — MERCH-04, D-07
// ─────────────────────────────────────────────────────────────────────────────

export interface EscrowRow {
  readonly planId: string;
  readonly externalId: string | null;
  readonly amount: string;
  /** `held` | `attested` | `released` | `returned`. */
  readonly state: string;
  readonly heldAt: number;
  /** Zero means never attested, which is also what makes `release` impossible. */
  readonly attestedAt: number;
  /** `heldAt + plazo.escrow.attestationDeadline`. */
  readonly returnableAt: number;
  /** `attestedAt + plazo.escrow.releaseTimer`. Zero while unattested. */
  readonly releasableAt: number;
  readonly recipient: string;
  readonly domain: number;
  readonly carrierRef: string | null;
  readonly disputeEligible: boolean;
}

export interface Escrows extends Sourced {
  readonly escrows: readonly EscrowRow[];
  /** `plazo.escrow.attestationDeadline`, in seconds. D-08's launch hypothesis is 7 days. */
  readonly attestationDeadlineSeconds: number;
  /** `plazo.escrow.releaseTimer`, in seconds. D-08's launch hypothesis is 72 hours. */
  readonly releaseTimerSeconds: number;
  /** The clock the timers are read against, so a render is reproducible. */
  readonly now: number;
}

const SAMPLE_ESCROWS: Escrows = {
  ...sample("chain"),
  attestationDeadlineSeconds: 7 * 24 * 60 * 60,
  releaseTimerSeconds: 72 * 60 * 60,
  now: 1_754_240_000,
  escrows: [
    {
      planId: "0x5d0b64f2a9d38e778f2c19a4b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873a5e",
      externalId: "A-10440",
      amount: "301968000",
      state: "held",
      heldAt: 1_754_064_100,
      attestedAt: 0,
      returnableAt: 1_754_064_100 + 7 * 24 * 60 * 60,
      releasableAt: 0,
      recipient: "0x00000000000000000000000000000000000acced",
      domain: 26,
      carrierRef: null,
      disputeEligible: false,
    },
    {
      planId: "0xcc19a4b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873a5e1c0b64f2a9d38e7712",
      externalId: "A-10428",
      amount: "144200000",
      state: "attested",
      heldAt: 1_753_930_000,
      attestedAt: 1_754_150_000,
      returnableAt: 1_753_930_000 + 7 * 24 * 60 * 60,
      releasableAt: 1_754_150_000 + 72 * 60 * 60,
      recipient: "0x00000000000000000000000000000000000acced",
      domain: 26,
      carrierRef: "0x6b1f0d2c9e73a48501bc2d6e8f37a41905cd2e6b7f8a03d19c4e5b2a70f6d381",
      disputeEligible: false,
    },
    {
      planId: "0xee73a48501bc2d6e8f37a41905cd2e6b7f8a03d19c4e5b2a70f6d3816b1f0d2c",
      externalId: "A-10399",
      amount: "62500000",
      state: "returned",
      heldAt: 1_753_300_000,
      attestedAt: 0,
      returnableAt: 1_753_300_000 + 7 * 24 * 60 * 60,
      releasableAt: 0,
      recipient: "0x00000000000000000000000000000000000acced",
      domain: 26,
      carrierRef: null,
      disputeEligible: true,
    },
  ],
};

/**
 * The held settlements, read from `SettlementEscrow` for the plans this book names.
 *
 * Keyed by plan id from the caller rather than enumerated, for the same reason
 * `attestations` is: there is no list route and no on-chain enumeration, and the settlements
 * payload already carries `escrowState`. So the escrow rows are looked up for the plans that
 * have one, and a plan the escrow has never seen (`state === none`) is dropped rather than
 * rendered as an empty row.
 *
 * The two timers come from the **escrow** `ParameterRegistry` and not from the live one.
 * The three `plazo.escrow.*` rows cannot exist on the vintage-3 registry — `_define` is
 * private and constructor-only, and `get()` reverts on an unset key (DEC-72) — so reading
 * them from the wrong address is a revert, not a wrong number. That is the good failure of
 * the two and it surfaces in the banner.
 */
export async function escrows(planIds: readonly string[] = []): Promise<Escrows> {
  const escrow = CONTRACTS.settlementEscrow();
  const parameters = CONTRACTS.escrowParameters();
  if (escrow === undefined || parameters === undefined) return SAMPLE_ESCROWS;
  if (planIds.length === 0) {
    return {...fromChain(), escrows: [], attestationDeadlineSeconds: 0, releaseTimerSeconds: 0, now: nowSeconds()};
  }

  try {
    const rpc = client();
    const registry = {address: parameters, abi: PARAMETER_REGISTRY_ABI} as const;

    const [attestationDeadline, releaseTimer] = await Promise.all([
      rpc.readContract({...registry, functionName: "get", args: [PARAMETER_KEYS.escrowAttestationDeadline]}),
      rpc.readContract({...registry, functionName: "get", args: [PARAMETER_KEYS.escrowReleaseTimer]}),
    ]);

    const rows = await Promise.all(
      planIds.slice(0, MAX_PLAN_READS).map(async (planId) => {
        const at = {address: escrow, abi: SETTLEMENT_ESCROW_ABI} as const;
        const id = planId as `0x${string}`;
        const [row, releasableAt, returnableAt, disputeEligible] = await Promise.all([
          rpc.readContract({...at, functionName: "escrowOf", args: [id]}),
          rpc.readContract({...at, functionName: "releasableAt", args: [id]}),
          rpc.readContract({...at, functionName: "returnableAt", args: [id]}),
          rpc.readContract({...at, functionName: "disputeEligible", args: [id]}),
        ]);
        return {planId, row, releasableAt, returnableAt, disputeEligible};
      }),
    );

    return {
      ...fromChain(),
      attestationDeadlineSeconds: Number(attestationDeadline),
      releaseTimerSeconds: Number(releaseTimer),
      now: nowSeconds(),
      escrows: rows
        // Ordinal zero is `None` — a plan this escrow has never held. Dropped rather than
        // rendered, because an all-zero row on a screen about money is a lie with a shape.
        .filter(({row}) => row.state !== 0)
        .map(({planId, row, releasableAt, returnableAt, disputeEligible}) => ({
          planId,
          // The merchant's own order id lives in the operator database, not on chain. The
          // caller joins it; this read cannot.
          externalId: null,
          amount: row.amount.toString(),
          state: ESCROW_STATE[row.state] ?? "held",
          heldAt: Number(row.heldAt),
          attestedAt: Number(row.attestedAt),
          // `returnableAt` reads zero once the row has left `Held`, so the deadline is
          // reconstructed from `heldAt` for a row that has already moved on. A merchant
          // looking at a released settlement still wants to know what the deadline was.
          returnableAt:
            returnableAt === 0n
              ? Number(row.heldAt) + Number(attestationDeadline)
              : Number(returnableAt),
          releasableAt: Number(releasableAt),
          recipient: row.recipient,
          domain: row.domain,
          carrierRef: row.carrierRef === ZERO_BYTES32 ? null : row.carrierRef,
          disputeEligible,
        })),
    };
  } catch (error) {
    return {...SAMPLE_ESCROWS, ...chainFailed(error)};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Refunds — MERCH-03, D9
// ─────────────────────────────────────────────────────────────────────────────

export type InstallmentStatus = "cleared" | "due" | "suppressed";

export interface Installment {
  readonly index: number;
  readonly dueAt: number;
  readonly amount: string;
  readonly status: InstallmentStatus;
}

/**
 * `RefundEscrow.refundPreview`'s four values, plus the amount they answer for.
 *
 * `firstSuppressedIndex` is `null` where the contract returns `type(uint256).max` —
 * a refund that suppresses nothing.
 */
export interface RefundPreview {
  readonly amount: string;
  readonly appliedPrincipal: string;
  readonly toBorrower: string;
  readonly firstSuppressedIndex: number | null;
  readonly mdrRebate: string;
  /** True when `amount` equals `voidAmountFor(planId)`. A full-value refund before fulfilment. */
  readonly isVoid: boolean;
}

export interface RefundCandidate {
  readonly planId: string;
  readonly externalId: string | null;
  readonly principal: string;
  readonly outstandingPrincipal: string;
  /** `RefundEscrow.voidAmountFor` — the exact argument that voids this plan. */
  readonly voidAmount: string;
  readonly schedule: readonly Installment[];
  /**
   * The previews this deployment can answer for, keyed by amount.
   *
   * **A lookup, never arithmetic.** `refundPreview` is a read of the plan's state through
   * D9's waterfall and the contract's own docstring argues for keeping it thin rather than
   * clever; computing it a second time in TypeScript would be a fourth implementation of
   * the suppression walk, and the one nobody tests against the chain.
   */
  readonly previews: readonly RefundPreview[];
}

export interface Refunds extends Sourced {
  readonly candidates: readonly RefundCandidate[];
}

const DAY = 24 * 60 * 60;
const SCHEDULE_START = 1_754_064_100;

const SAMPLE_REFUNDS: Refunds = {
  ...sample("chain"),
  candidates: [
    {
      planId: "0x3a71c8e02f9d465b1e7a04c93f28d6b5079e14a3c8b60d92f5e37a1b48c609dd",
      externalId: "A-10433",
      principal: "824000000",
      outstandingPrincipal: "618000000",
      voidAmount: "824000000",
      schedule: [
        {index: 0, dueAt: SCHEDULE_START, amount: "206000000", status: "cleared"},
        {index: 1, dueAt: SCHEDULE_START + 14 * DAY, amount: "206000000", status: "due"},
        {index: 2, dueAt: SCHEDULE_START + 28 * DAY, amount: "206000000", status: "due"},
        {index: 3, dueAt: SCHEDULE_START + 42 * DAY, amount: "206000000", status: "due"},
      ],
      previews: [
        {
          // Retires exactly the final installment. D9 suppresses from the end, so index 3
          // goes and indices 1 and 2 keep the due dates they already had.
          amount: "206000000",
          appliedPrincipal: "206000000",
          toBorrower: "0",
          firstSuppressedIndex: 3,
          mdrRebate: "10986666",
          isVoid: false,
        },
        {
          amount: "824000000",
          appliedPrincipal: "618000000",
          toBorrower: "206000000",
          firstSuppressedIndex: 1,
          mdrRebate: "32960000",
          isVoid: true,
        },
      ],
    },
  ],
};

/**
 * The refund candidates, read from `RefundEscrow` and from the plans themselves.
 *
 * ## `previews` is still a lookup keyed by amount, and still never arithmetic (DEC-71)
 *
 * A live deployment could answer for any amount, but the screen reads a bounded list — so
 * this asks the contract for the amounts a merchant will plausibly choose: **the amount
 * they actually typed**, the void amount, the outstanding principal, and each remaining
 * installment. Every one of those four is a `refundPreview` call. Nothing is computed
 * here, which is the point: `refundPreview` is itself a thin read of the plan's state
 * through D9's waterfall, and a TypeScript reimplementation would be the fourth copy of the
 * suppression walk and the one with no chain to disagree with it.
 *
 * ## A plan that cannot be voided is not a candidate
 *
 * `voidAmountFor` reverts with `PlanNotVoidable` on a plan that has already settled,
 * because a "void" of a repaid plan is a merchant sending money to a schedule that owes
 * nothing. That revert is the filter: a plan whose void amount cannot be read is dropped
 * from the list rather than shown with a disabled button, because the merchant's question
 * is "what can I refund" and a terminal plan is not an answer to it.
 */
export async function refunds(
  planIds: readonly string[] = [],
  requestedAmount?: string | undefined,
): Promise<Refunds> {
  const refundEscrow = CONTRACTS.refundEscrow();
  const planFactory = CONTRACTS.planFactory();
  if (refundEscrow === undefined || planFactory === undefined) return SAMPLE_REFUNDS;
  if (planIds.length === 0) return {...fromChain(), candidates: []};

  try {
    const rpc = client();
    const candidates = await Promise.all(
      planIds.slice(0, MAX_REFUND_READS).map((planId) =>
        refundCandidate(rpc, refundEscrow, planFactory, planId as `0x${string}`, requestedAmount),
      ),
    );
    return {...fromChain(), candidates: candidates.filter((c): c is RefundCandidate => c !== null)};
  } catch (error) {
    return {...SAMPLE_REFUNDS, ...chainFailed(error)};
  }
}

/** One plan, or `null` when the chain says it is not refundable. */
async function refundCandidate(
  rpc: ReturnType<typeof client>,
  refundEscrow: `0x${string}`,
  planFactory: `0x${string}`,
  planId: `0x${string}`,
  requestedAmount: string | undefined,
): Promise<RefundCandidate | null> {
  const escrow = {address: refundEscrow, abi: REFUND_ESCROW_ABI} as const;

  const voidAmount = await rpc
    .readContract({...escrow, functionName: "voidAmountFor", args: [planId]})
    .catch(() => null);
  if (voidAmount === null) return null;

  const planAddress = await rpc.readContract({
    address: planFactory,
    abi: PLAN_FACTORY_ABI,
    functionName: "predictAddress",
    args: [planId],
  });
  const plan = {address: planAddress, abi: INSTALLMENT_PLAN_ABI} as const;

  const [principal, outstanding, count] = await Promise.all([
    rpc.readContract({...plan, functionName: "principal"}),
    rpc.readContract({...plan, functionName: "outstandingPrincipal"}),
    rpc.readContract({...plan, functionName: "installmentCount"}),
  ]);

  const schedule = await Promise.all(
    Array.from({length: Number(count)}, async (_, index) => {
      const at = [BigInt(index)] as const;
      const [amount, dueAt, status] = await Promise.all([
        rpc.readContract({...plan, functionName: "installmentAmount", args: at}),
        rpc.readContract({...plan, functionName: "dueDate", args: at}),
        rpc.readContract({...plan, functionName: "installmentStatus", args: at}),
      ]);
      return {
        index,
        dueAt: Number(dueAt),
        amount: amount.toString(),
        status: installmentStatus(status),
      };
    }),
  );

  /**
   * The amounts worth asking about, deduplicated and bounded.
   *
   * The merchant's own typed amount is first, so a live deployment answers the question
   * they actually asked rather than the ones this file guessed at. Zero is excluded — a
   * zero refund does nothing and `Refunds.tsx` says so without needing a preview for it.
   */
  const amounts = [
    requestedAmount,
    voidAmount.toString(),
    outstanding.toString(),
    ...schedule.filter((row) => row.status === "due").map((row) => row.amount),
  ]
    .filter((value): value is string => value !== undefined && /^\d+$/.test(value) && BigInt(value) > 0n)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, MAX_PREVIEWS);

  const previews = await Promise.all(
    amounts.map(async (amount) => {
      const [appliedPrincipal, toBorrower, firstSuppressedIndex, mdrRebate] = await rpc.readContract({
        ...escrow,
        functionName: "refundPreview",
        args: [planId, BigInt(amount)],
      });
      return {
        amount,
        appliedPrincipal: appliedPrincipal.toString(),
        toBorrower: toBorrower.toString(),
        // The contract returns `type(uint256).max` for "suppresses nothing"; the screen
        // renders `null` as a sentence rather than a number nobody can read.
        firstSuppressedIndex: firstSuppressedIndex === UINT256_MAX ? null : Number(firstSuppressedIndex),
        mdrRebate: mdrRebate.toString(),
        isVoid: BigInt(amount) === voidAmount,
      };
    }),
  );

  return {
    planId,
    externalId: null,
    principal: principal.toString(),
    outstandingPrincipal: outstanding.toString(),
    voidAmount: voidAmount.toString(),
    schedule,
    previews,
  };
}

/** The preview for `amount`, or null when this deployment cannot answer for it. */
export function previewFor(candidate: RefundCandidate, amount: string | undefined): RefundPreview | null {
  if (amount === undefined || amount === "") return null;
  return candidate.previews.find((preview) => preview.amount === amount) ?? null;
}

/**
 * The schedule as it would stand after `preview`.
 *
 * Suppression is applied from `firstSuppressedIndex` to the tail and **nothing before it
 * moves** — not the amounts and not the due dates. That is D9's behaviour, and rendering
 * it beside the "before" is the only way a merchant can see that a refund does not push
 * the borrower's next due date around.
 */
export function scheduleAfter(
  schedule: readonly Installment[],
  preview: RefundPreview,
): readonly Installment[] {
  const from = preview.firstSuppressedIndex;
  if (from === null) return schedule;
  return schedule.map((row) => (row.index >= from ? {...row, status: "suppressed" as const} : row));
}

// ─────────────────────────────────────────────────────────────────────────────
// Treasury — the merchant's registry row
// ─────────────────────────────────────────────────────────────────────────────

export interface Treasury extends Sourced {
  readonly recipient: string;
  readonly domain: number;
  readonly bond: string;
  /** The slice of the bond that arrived by withholding rather than by deposit. */
  readonly bondFromWithholding: string;
  /** `MerchantRegistry.requiredBond` — scales with outstanding fronted exposure. */
  readonly requiredBond: string;
  readonly outstandingFronted: string;
  readonly vestingBps: number;
  /** `type(uint256).max` on chain reads as null here: no cap. */
  readonly velocityCap: string | null;
  readonly velocityUsed: string;
  /** `Escrowed` | `Instant`. */
  readonly settlementCategory: string;
  readonly kybVerified: boolean;
  readonly registeredAt: number;
}

const SAMPLE_TREASURY: Treasury = {
  ...sample("chain"),
  recipient: "0x00000000000000000000000000000000000acced",
  domain: 26,
  bond: "118400000",
  bondFromWithholding: "51216000",
  requiredBond: "96500000",
  outstandingFronted: "965000000",
  vestingBps: 1000,
  velocityCap: "2500000000",
  velocityUsed: "965000000",
  settlementCategory: "Escrowed",
  kybVerified: true,
  registeredAt: 1_751_500_000,
};

/**
 * The merchant's registry row, read from `MerchantRegistry`.
 *
 * Everything on this screen is one address's row plus four derived views. `merchantOf`
 * returns the struct whole — DEC-33's named-struct form, so the field names travel through
 * the ABI rather than being positional — and `requiredBond`, `velocityCapFor`,
 * `velocityUsed` and `vestingBpsFor` are the four the struct cannot answer because each is
 * a function of registry parameters as they stand right now.
 *
 * **`categoryOf` is read rather than taken from the struct.** The struct's `category` is
 * the stored value; `categoryOf` is what the router will actually act on, and 06-13 found
 * out the hard way that the two can be different contracts' ideas (finding 30, DEC-73). The
 * screen shows the one that decides.
 *
 * An unregistered merchant is not an error. `registered: false` renders as a screen saying
 * so, which is the true state of a merchant who has not called `register` yet.
 */
export async function treasury(): Promise<Treasury> {
  const registry = CONTRACTS.merchantRegistry();
  const merchant = merchantAddress();
  if (registry === undefined || merchant === undefined) return SAMPLE_TREASURY;

  try {
    const rpc = client();
    const at = {address: registry, abi: MERCHANT_REGISTRY_ABI} as const;
    const args = [merchant as `0x${string}`] as const;

    const [row, requiredBond, vestingBps, velocityCap, velocityUsed, category] = await Promise.all([
      rpc.readContract({...at, functionName: "merchantOf", args}),
      rpc.readContract({...at, functionName: "requiredBond", args}),
      rpc.readContract({...at, functionName: "vestingBpsFor", args}),
      rpc.readContract({...at, functionName: "velocityCapFor", args}),
      rpc.readContract({...at, functionName: "velocityUsed", args}),
      rpc.readContract({...at, functionName: "categoryOf", args}),
    ]);

    return {
      ...fromChain(),
      recipient: row.payoutRecipient,
      domain: row.payoutDomain,
      bond: row.bond.toString(),
      bondFromWithholding: row.withheld.toString(),
      requiredBond: requiredBond.toString(),
      outstandingFronted: row.outstandingFronted.toString(),
      vestingBps: Number(vestingBps),
      // `type(uint256).max` means "no cap". Printing the number would be worse than
      // printing nothing, so it becomes null and the screen says "no cap".
      velocityCap: velocityCap === UINT256_MAX ? null : velocityCap.toString(),
      velocityUsed: velocityUsed.toString(),
      settlementCategory: SETTLEMENT_CATEGORY[category] ?? "Escrowed",
      kybVerified: row.kybVerified,
      registeredAt: Number(row.registeredAt),
    };
  } catch (error) {
    return {...SAMPLE_TREASURY, ...chainFailed(error)};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting — at the leaf, never before
// ─────────────────────────────────────────────────────────────────────────────

/** 6-decimal USDC. Never through a float. */
export function usd(value: string, decimals = 2): string {
  const units = BigInt(value);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / 1_000_000n;
  const frac = (magnitude % 1_000_000n) / (decimals === 2 ? 10_000n : 1n);
  return `${negative ? "-" : ""}$${whole.toLocaleString("en-US")}.${frac.toString().padStart(decimals, "0")}`;
}

export function pct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function shortId(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 10)}…${id.slice(-4)}`;
}

export function day(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-US", {month: "short", day: "numeric", year: "numeric"});
}

export function stamp(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * A duration, rounded to the unit a merchant would say out loud.
 *
 * Negative means the moment has passed, which the caller renders differently — a deadline
 * two days gone and a deadline two days away are not the same sentence.
 */
export function until(seconds: number): string {
  const magnitude = Math.abs(seconds);
  if (magnitude < 3600) return `${Math.round(magnitude / 60)}m`;
  if (magnitude < 2 * 24 * 3600) return `${Math.round(magnitude / 3600)}h`;
  return `${Math.round(magnitude / (24 * 3600))}d`;
}

/**
 * A file the browser can save without a byte leaving the page.
 *
 * The CCTP message and its attestation are the two values a merchant needs on another
 * chain and they are far too long to retype. A `data:` URL on an `<a download>` needs no
 * script, no clipboard permission and no round trip.
 */
export function dataUrl(contents: string): string {
  return `data:text/plain;charset=utf-8,${encodeURIComponent(contents)}`;
}
