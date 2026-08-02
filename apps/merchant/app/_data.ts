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
 * **The gap.** Four things this dashboard shows come from contract views that no service
 * exposes today: the merchant's registry row (bond, requirement, velocity, category), the
 * escrow rows and their timers, `RefundEscrow.refundPreview`, and `voidAmountFor`. None
 * of the three contracts behind them is deployed yet — plan 06-13 deploys them — so there
 * is no endpoint to call and nothing that could be live. Those payloads carry
 * `source: "chain"`, `live: false` and a sentence saying so, and **no fetch is attempted
 * for them**: a getter that called a route nobody has written would turn a configured
 * deployment into a 500 instead of a labelled sample.
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
 * - A failing fetch throws. It never degrades to a sample, because a silent sample is the
 *   exact failure the `live` flag exists to prevent.
 */

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
    ? "no service reads this yet — the contracts behind it land in 06-13"
    : `set ${env} to read live`;
};

const sample = (source: Source): Sourced => ({live: false, source, sampled: SAMPLED(source)});
const fromService = (source: Source): Sourced => ({live: true, source, sampled: ""});

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
 * Sample-only, and the reason is a missing route rather than a missing deployment.
 *
 * Plan 06-06 shipped `POST /v1/webhooks/endpoints` and no list route. Registration
 * returns the endpoint and its secret once; nothing reads them back. So this payload is
 * `servicing`-sourced and permanently sampled until that route exists, and the banner
 * says which of the two it is rather than implying the base URL is unset.
 */
const SAMPLE_ENDPOINTS: Endpoints = {
  live: false,
  source: "servicing",
  sampled: "the operator API has no endpoint-list route yet — only POST /v1/webhooks/endpoints",
  endpoints: [
    {id: "wep_1a2b3c", url: "https://hooks.example-merchant.com/plazo", status: "active", signingSecretCount: 1},
    {id: "wep_4d5e6f", url: "https://staging.example-merchant.com/plazo", status: "degraded", signingSecretCount: 2},
  ],
};

export async function endpoints(): Promise<Endpoints> {
  return SAMPLE_ENDPOINTS;
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

export async function escrows(): Promise<Escrows> {
  return SAMPLE_ESCROWS;
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

export async function refunds(): Promise<Refunds> {
  return SAMPLE_REFUNDS;
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

export async function treasury(): Promise<Treasury> {
  return SAMPLE_TREASURY;
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
