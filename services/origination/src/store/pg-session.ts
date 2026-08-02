/**
 * `SessionStore` over Postgres.
 *
 * A substitution, not a rewrite. `session.ts` declared the interface and said in its
 * docstring that the map was a placeholder for exactly this; nothing about the session
 * state machine changes here, and nothing in it needed to know it had been swapped. If
 * this file had needed a new method on `SessionStore`, that would have been the signal
 * that it was doing work belonging to the module that owns the interface.
 *
 * ## Write-whole-row
 *
 * Session transitions are free functions returning a **new** record
 * (`session.ts::recordAuthorization`), never mutations of an existing one. There is no
 * such thing as a partial update to apply, so `put` writes the whole row and lets
 * `onConflictDoUpdate` decide whether that was an insert. Patch-in-place would invent a
 * second model of how a session changes, and the two would eventually disagree about
 * what "signed check 3" means.
 *
 * ## Why the record is jsonb and not thirty columns
 *
 * The session is one value the machine reads and rewrites atomically. Exploding it into
 * columns would give a schema that has to change every time a term does, and would buy
 * query power nobody wants: nothing filters sessions by `interval` or `lateFeeFlat`. The
 * four things something *does* filter by — whose it is, what state it is in, which plan
 * it became, when it dies — are denormalised into real columns beside the payload, so
 * the dashboard never parses jsonb to draw a list.
 *
 * ## Money
 *
 * JSON carries no bigints, so every 256-bit field crosses as a decimal string, exactly
 * as `api.ts` does at the HTTP boundary. A decimal string is exact in both directions;
 * `Number` is not, and at 6-decimal USDC it stops being exact somewhere around nine
 * billion dollars. There is no float anywhere in this round trip and there must not be.
 */
import {eq} from "drizzle-orm";

import {checkoutSession, type StoredSession} from "../db/schema.js";
import type {Db} from "../db/client.js";
import type {CheckoutSession, SessionStore} from "../session.js";
import type {Hex} from "viem";

/**
 * The record as it goes to disk.
 *
 * Written out field by field rather than walked generically, because a generic walker
 * cannot be reversed: on the way back it has no way to know which strings were once
 * bigints, and would have to guess from shape. Guessing would turn a `termsHash` that
 * happens to be all digits into a number. The explicit map is longer and cannot do that.
 */
export function toStoredSession(session: CheckoutSession): StoredSession {
  return {
    sessionId: session.sessionId,
    merchant: session.merchant,
    borrower: session.borrower,
    state: session.state,
    terms: {
      chainId: session.terms.chainId.toString(),
      factory: session.terms.factory,
      implementation: session.terms.implementation,
      borrower: session.terms.borrower,
      merchant: session.terms.merchant,
      token: session.terms.token,
      principal: session.terms.principal.toString(),
      installmentCount: session.terms.installmentCount.toString(),
      firstDueDate: session.terms.firstDueDate.toString(),
      interval: session.terms.interval.toString(),
      originationNonce: session.terms.originationNonce.toString(),
      termsHash: session.terms.termsHash,
    },
    detail: {
      jurisdiction: session.detail.jurisdiction,
      lineItemsHash: session.detail.lineItemsHash,
      mdrBps: session.detail.mdrBps.toString(),
      lateFeeFlat: session.detail.lateFeeFlat.toString(),
      signerClass: session.detail.signerClass,
      settlementRecipient: session.detail.settlementRecipient,
      fxRouter: session.detail.fxRouter,
    },
    planId: session.planId,
    planAddress: session.planAddress,
    quote: {
      approved: session.quote.approved,
      principal: session.quote.principal.toString(),
      installments: session.quote.installments.map((value) => value.toString()),
      mdr: session.quote.mdr.toString(),
      merchantNet: session.quote.merchantNet.toString(),
      availableLimit: session.quote.availableLimit.toString(),
      // Spread rather than assign: under `exactOptionalPropertyTypes` an explicit
      // `undefined` is a different type from an absent key, and jsonb would store the
      // null.
      ...(session.quote.fallback
        ? {
            fallback: {
              upfront: session.quote.fallback.upfront.toString(),
              financed: session.quote.fallback.financed.toString(),
              installments: session.quote.fallback.installments.map((value) => value.toString()),
            },
          }
        : {}),
      ...(session.quote.declineReason !== undefined
        ? {declineReason: session.quote.declineReason}
        : {}),
    },
    signatures: session.signatures,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/** The exact inverse. Every `toString()` above has a `BigInt()` here and no other. */
export function fromStoredSession(stored: StoredSession): CheckoutSession {
  return {
    sessionId: stored.sessionId,
    merchant: stored.merchant,
    borrower: stored.borrower,
    state: stored.state,
    terms: {
      chainId: BigInt(stored.terms.chainId),
      factory: stored.terms.factory,
      implementation: stored.terms.implementation,
      borrower: stored.terms.borrower,
      merchant: stored.terms.merchant,
      token: stored.terms.token,
      principal: BigInt(stored.terms.principal),
      installmentCount: BigInt(stored.terms.installmentCount),
      firstDueDate: BigInt(stored.terms.firstDueDate),
      interval: BigInt(stored.terms.interval),
      originationNonce: BigInt(stored.terms.originationNonce),
      termsHash: stored.terms.termsHash,
    },
    detail: {
      jurisdiction: stored.detail.jurisdiction,
      lineItemsHash: stored.detail.lineItemsHash,
      mdrBps: BigInt(stored.detail.mdrBps),
      lateFeeFlat: BigInt(stored.detail.lateFeeFlat),
      signerClass: stored.detail.signerClass,
      settlementRecipient: stored.detail.settlementRecipient,
      fxRouter: stored.detail.fxRouter,
    },
    planId: stored.planId,
    planAddress: stored.planAddress,
    quote: {
      approved: stored.quote.approved,
      principal: BigInt(stored.quote.principal),
      installments: stored.quote.installments.map((value) => BigInt(value)),
      mdr: BigInt(stored.quote.mdr),
      merchantNet: BigInt(stored.quote.merchantNet),
      availableLimit: BigInt(stored.quote.availableLimit),
      ...(stored.quote.fallback
        ? {
            fallback: {
              upfront: BigInt(stored.quote.fallback.upfront),
              financed: BigInt(stored.quote.fallback.financed),
              installments: stored.quote.fallback.installments.map((value) => BigInt(value)),
            },
          }
        : {}),
      ...(stored.quote.declineReason !== undefined
        ? {declineReason: stored.quote.declineReason}
        : {}),
    },
    signatures: stored.signatures,
    expiresAt: stored.expiresAt,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

export class PgSessionStore implements SessionStore {
  constructor(private readonly database: Db) {}

  async get(sessionId: Hex): Promise<CheckoutSession | undefined> {
    const rows = await this.database
      .select({payload: checkoutSession.payload})
      .from(checkoutSession)
      .where(eq(checkoutSession.sessionId, sessionId))
      .limit(1);

    const row = rows[0];
    return row ? fromStoredSession(row.payload) : undefined;
  }

  async put(session: CheckoutSession): Promise<void> {
    const payload = toStoredSession(session);
    // Session timestamps are unix seconds, the units the strip signs in. The columns are
    // timestamptz because that is what a dashboard, a sweeper and a human all want to
    // read; the payload keeps the seconds, so nothing downstream inherits a timezone.
    const expiresAt = new Date(session.expiresAt * 1000);
    const updatedAt = new Date(session.updatedAt * 1000);

    await this.database
      .insert(checkoutSession)
      .values({
        sessionId: session.sessionId,
        merchant: session.merchant,
        state: session.state,
        expiresAt,
        planId: session.planId,
        payload,
        createdAt: new Date(session.createdAt * 1000),
        updatedAt,
      })
      .onConflictDoUpdate({
        target: checkoutSession.sessionId,
        set: {state: session.state, expiresAt, planId: session.planId, payload, updatedAt},
      });
  }
}
