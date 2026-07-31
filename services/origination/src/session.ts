/**
 * The checkout session — a per-authorization state machine that can be resumed.
 *
 * CHKT-02 and OPS-02. The requirement is that a borrower who abandons mid-strip can
 * return and continue rather than restart, and the reason it is a requirement rather
 * than a nicety is arithmetic: a four-check Pay-in-4 plan needs four typed-data
 * signatures plus an acceptance, and there is no batch typed-data signing RPC in any
 * wallet. Five prompts is already the worst part of this product. Making someone
 * redo three of them because their phone locked is how a checkout loses a sale it had
 * already won.
 *
 * ## What is and is not stored
 *
 * Signatures are stored. They have to be — that is the whole mechanism, and they are
 * useless to anyone but this plan: each one names the plan's CREATE2 address as payee
 * and carries a nonce derived from the plan id, so a stolen strip cannot be redirected
 * anywhere.
 *
 * The borrower's *decision* is stored as an attestation, not as a set of inputs.
 * Nothing here holds underwriting features, and nothing here holds PII — those live
 * in the operator's private schema behind the consent gate, and a session record that
 * quietly accumulated them would make the storage split a claim rather than a
 * property.
 *
 * ## Why the state machine is per-authorization
 *
 * A session that tracked "in progress / done" would have to restart on resume,
 * because it would not know which signatures it already had. Tracking the exact
 * index is what makes resumption free. It also makes the abandonment data legible:
 * "borrowers drop at check three" is a fact a product can act on, and "borrowers drop
 * during checkout" is not.
 */
import type {Address, Hex} from "viem";

import {
  buildQuote,
  type CheckAuthorization,
  type PlanTerms,
  type Quote,
  type TermsDetail,
} from "@plazo/plan-core";

export type SessionState =
  /** Quoted, nothing signed. The borrower has seen a price. */
  | "quoted"
  /** At least one authorization signed, strip incomplete. */
  | "signing"
  /** Every authorization and the acceptance signed. Ready to originate. */
  | "ready"
  /** Originated onchain. Terminal. */
  | "originated"
  /** Abandoned past its deadline, or explicitly cancelled. Terminal. */
  | "expired";

export interface SessionSignatures {
  /** Index → signature. Sparse: a borrower may sign out of order. */
  strip: Record<number, Hex>;
  acceptance?: Hex;
}

export interface CheckoutSession {
  sessionId: Hex;
  merchant: Address;
  borrower: Address;
  state: SessionState;
  terms: PlanTerms;
  detail: TermsDetail;
  planId: Hex;
  /** The plan's counterfactual address — the payee of every authorization. */
  planAddress: Address;
  quote: Quote;
  signatures: SessionSignatures;
  /** Unix seconds. A session that outlives this cannot originate. */
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionStore {
  get(sessionId: Hex): Promise<CheckoutSession | undefined>;
  put(session: CheckoutSession): Promise<void>;
}

/**
 * The default store: a map.
 *
 * Sessions are minutes-long and worthless once originated, so durability buys very
 * little and a Postgres round trip per signature buys nothing at all. Phase 4 swaps
 * this for the operator's schema when the borrower app needs sessions to survive a
 * process restart; the interface is here so that is a substitution rather than a
 * rewrite.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<Hex, CheckoutSession>();

  async get(sessionId: Hex): Promise<CheckoutSession | undefined> {
    return this.sessions.get(sessionId);
  }

  async put(session: CheckoutSession): Promise<void> {
    this.sessions.set(session.sessionId, session);
  }

  get size(): number {
    return this.sessions.size;
  }
}

export interface OpenSessionInput {
  sessionId: Hex;
  terms: PlanTerms;
  detail: TermsDetail;
  planId: Hex;
  planAddress: Address;
  /** What the borrower's chain-derived limit is right now. */
  availableLimit: bigint;
  cartTotal: bigint;
  mdrBps?: bigint;
  minTicket?: bigint;
  maxTicket?: bigint;
  /** Seconds. Long enough to sign five prompts, short enough not to be a bearer. */
  ttlSeconds?: number;
  now?: number;
}

/**
 * Twenty minutes.
 *
 * Long enough for five wallet prompts on a bad connection with a passkey ceremony in
 * the middle; short enough that an abandoned session is not a standing offer to
 * originate credit at a price that has moved. The attestation inside it is far
 * shorter-lived and is re-issued at origination, so this bound is about the cart, not
 * about the credit decision.
 */
export const DEFAULT_SESSION_TTL = 20 * 60;

export function openSession(input: OpenSessionInput): CheckoutSession {
  const now = input.now ?? Math.floor(Date.now() / 1000);

  // Spread rather than assign the optionals: under `exactOptionalPropertyTypes` an
  // explicit `undefined` is not the same as an absent key, and `buildQuote`'s
  // defaults only apply to the latter.
  const quote = buildQuote({
    cartTotal: input.cartTotal,
    installmentCount: input.terms.installmentCount,
    availableLimit: input.availableLimit,
    ...(input.mdrBps !== undefined ? {mdrBps: input.mdrBps} : {}),
    ...(input.minTicket !== undefined ? {minTicket: input.minTicket} : {}),
    ...(input.maxTicket !== undefined ? {maxTicket: input.maxTicket} : {}),
  });

  return {
    sessionId: input.sessionId,
    merchant: input.terms.merchant,
    borrower: input.terms.borrower,
    state: "quoted",
    terms: input.terms,
    detail: input.detail,
    planId: input.planId,
    planAddress: input.planAddress,
    quote,
    signatures: {strip: {}},
    expiresAt: now + (input.ttlSeconds ?? DEFAULT_SESSION_TTL),
    createdAt: now,
    updatedAt: now,
  };
}

export class SessionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not-found"
      | "expired"
      | "terminal"
      | "index-out-of-range"
      | "already-signed"
      | "wrong-payee"
      | "not-ready",
  ) {
    super(message);
    this.name = "SessionError";
  }
}

function assertLive(session: CheckoutSession, now: number): void {
  if (session.state === "originated" || session.state === "expired") {
    throw new SessionError(`session is ${session.state}`, "terminal");
  }
  if (now > session.expiresAt) {
    throw new SessionError("session expired", "expired");
  }
}

/**
 * Record one signed authorization.
 *
 * Idempotent by index and order-independent. A wallet that presents check 3 before
 * check 2 is unusual but not wrong, and a state machine that insisted on order would
 * turn a wallet quirk into a failed checkout.
 */
export function recordAuthorization(
  session: CheckoutSession,
  index: number,
  signature: Hex,
  authorization: CheckAuthorization,
  now = Math.floor(Date.now() / 1000),
): CheckoutSession {
  assertLive(session, now);

  const count = Number(session.terms.installmentCount);
  if (index < 0 || index >= count) {
    throw new SessionError(`index ${index} outside a ${count}-installment strip`, "index-out-of-range");
  }
  if (session.signatures.strip[index]) {
    throw new SessionError(`authorization ${index} is already signed`, "already-signed");
  }

  // The payee is the plan's own counterfactual address and nothing else. A signature
  // naming a different `to` is either a client bug or an attempt to have the borrower
  // sign a transfer to somewhere the protocol does not control, and the difference
  // does not matter — neither should be stored.
  if (authorization.to.toLowerCase() !== session.planAddress.toLowerCase()) {
    throw new SessionError(
      `authorization ${index} names ${authorization.to}, not the plan`,
      "wrong-payee",
    );
  }

  const strip = {...session.signatures.strip, [index]: signature};
  const complete = Object.keys(strip).length === count && Boolean(session.signatures.acceptance);

  return {
    ...session,
    signatures: {...session.signatures, strip},
    state: complete ? "ready" : "signing",
    updatedAt: now,
  };
}

export function recordAcceptance(
  session: CheckoutSession,
  signature: Hex,
  now = Math.floor(Date.now() / 1000),
): CheckoutSession {
  assertLive(session, now);

  const count = Number(session.terms.installmentCount);
  const complete = Object.keys(session.signatures.strip).length === count;

  return {
    ...session,
    signatures: {...session.signatures, acceptance: signature},
    state: complete ? "ready" : session.state === "quoted" ? "signing" : session.state,
    updatedAt: now,
  };
}

/**
 * What the borrower still has to sign.
 *
 * The resumption primitive: a returning borrower is handed exactly this, and the
 * indices they already signed are never re-prompted. Sorted, so the client's prompt
 * order is deterministic across resumes — a borrower who left after check 2 comes
 * back to check 3, not to a shuffle.
 */
export function outstandingAuthorizations(session: CheckoutSession): number[] {
  const count = Number(session.terms.installmentCount);
  const missing: number[] = [];
  for (let i = 0; i < count; i++) {
    if (!session.signatures.strip[i]) missing.push(i);
  }
  return missing;
}

export function needsAcceptance(session: CheckoutSession): boolean {
  return !session.signatures.acceptance;
}

/** The exact index to resume at, or `null` when the strip is complete. */
export function resumeIndex(session: CheckoutSession): number | null {
  const missing = outstandingAuthorizations(session);
  return missing.length > 0 ? missing[0]! : null;
}

export function isReady(session: CheckoutSession): boolean {
  return outstandingAuthorizations(session).length === 0 && !needsAcceptance(session);
}

/**
 * The strip, in installment order, ready to submit.
 *
 * Throws rather than returning a partial array. A caller that submitted a strip with
 * a hole would produce an origination the plan rejects for a length mismatch, which
 * is a confusing way to learn the borrower never finished signing.
 */
export function assembleStrip(session: CheckoutSession): Hex[] {
  if (!isReady(session)) {
    throw new SessionError("strip is incomplete", "not-ready");
  }
  const count = Number(session.terms.installmentCount);
  return Array.from({length: count}, (_, i) => session.signatures.strip[i]!);
}

export function markOriginated(
  session: CheckoutSession,
  now = Math.floor(Date.now() / 1000),
): CheckoutSession {
  return {...session, state: "originated", updatedAt: now};
}

export function expire(session: CheckoutSession, now = Math.floor(Date.now() / 1000)): CheckoutSession {
  return {...session, state: "expired", updatedAt: now};
}

/** Whether the wall clock has run out, regardless of what the record says. */
export function hasExpired(session: CheckoutSession, now = Math.floor(Date.now() / 1000)): boolean {
  return session.state !== "originated" && now > session.expiresAt;
}
