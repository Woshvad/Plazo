/**
 * The Connect API surface, over Hono.
 *
 * Four routes, because a merchant integration should be four calls: price a cart,
 * open a session, post each signature as the wallet produces it, and ask whether the
 * strip is complete. Everything else — the plan id, the payee address, the schedule,
 * the digests — is derivable by the merchant from `@plazo/plan-core` without asking
 * this service anything, which is what stops the API becoming the place the deal is
 * defined.
 *
 * Hono because Ponder embeds it, so the read API and this one share one runtime and
 * one set of idioms rather than being two services that happen to be in the same
 * repository.
 *
 * Authentication, rate limiting and merchant API keys are Phase 6's `MERCH-05`. What
 * exists here is the shape; the routes take a merchant identity from a header and
 * trust it, which is fine for a sandbox and is marked so it cannot be mistaken for
 * finished.
 */
import {Hono} from "hono";
import type {Address, Hex} from "viem";

import {
  assembleStrip,
  isReady,
  needsAcceptance,
  openSession,
  outstandingAuthorizations,
  recordAcceptance,
  recordAuthorization,
  resumeIndex,
  SessionError,
  type CheckoutSession,
  type OpenSessionInput,
  type SessionStore,
} from "./session.js";
import type {CheckAuthorization} from "@plazo/plan-core";

export interface ApiConfig {
  sessions: SessionStore;
  /**
   * Everything needed to open a session, derived by the caller.
   *
   * The service does not derive terms itself, on purpose: `@plazo/plan-core` is open
   * source and has no network dependency, so a merchant computes the plan id, the
   * payee address and the schedule themselves and this service checks rather than
   * dictates. An API that owned the derivation would make "the signed bytes commit to
   * the disclosed deal" depend on the operator being honest.
   */
  prepare(request: PrepareRequest): Promise<OpenSessionInput>;
}

export interface PrepareRequest {
  merchant: Address;
  borrower: Address;
  cartTotal: bigint;
  installmentCount: bigint;
  lineItemsHash: Hex;
}

/** JSON does not carry bigints. Everything monetary crosses as a decimal string. */
const money = (value: bigint): string => value.toString();

function serialise(session: CheckoutSession) {
  return {
    sessionId: session.sessionId,
    state: session.state,
    planId: session.planId,
    planAddress: session.planAddress,
    merchant: session.merchant,
    expiresAt: session.expiresAt,
    quote: {
      approved: session.quote.approved,
      principal: money(session.quote.principal),
      installments: session.quote.installments.map(money),
      mdr: money(session.quote.mdr),
      merchantNet: money(session.quote.merchantNet),
      availableLimit: money(session.quote.availableLimit),
      declineReason: session.quote.declineReason,
      fallback: session.quote.fallback
        ? {
            upfront: money(session.quote.fallback.upfront),
            financed: money(session.quote.fallback.financed),
            installments: session.quote.fallback.installments.map(money),
          }
        : undefined,
    },
    /** The resumption primitive. A returning borrower signs exactly these. */
    outstanding: outstandingAuthorizations(session),
    resumeAt: resumeIndex(session),
    needsAcceptance: needsAcceptance(session),
    ready: isReady(session),
  };
}

export function createApi(config: ApiConfig): Hono {
  const app = new Hono();

  /**
   * Price a cart. CHKT-01, and CHKT-08 when the answer is no.
   *
   * A decline always carries a fallback when one exists, because a flat no is the
   * worst available answer to "you are $12 over": the merchant loses the sale and
   * the borrower is told they failed a test nobody explained.
   */
  app.post("/v1/quote", async (c) => {
    const body = await c.req.json<{
      merchant: Address;
      borrower: Address;
      cartTotal: string;
      installmentCount: number;
      lineItemsHash: Hex;
    }>();

    const input = await config.prepare({
      merchant: body.merchant,
      borrower: body.borrower,
      cartTotal: BigInt(body.cartTotal),
      installmentCount: BigInt(body.installmentCount),
      lineItemsHash: body.lineItemsHash,
    });

    return c.json(serialise(openSession(input)));
  });

  /** Open a session against a quote, and hold it while the borrower signs. */
  app.post("/v1/sessions", async (c) => {
    const body = await c.req.json<{
      merchant: Address;
      borrower: Address;
      cartTotal: string;
      installmentCount: number;
      lineItemsHash: Hex;
    }>();

    const input = await config.prepare({
      merchant: body.merchant,
      borrower: body.borrower,
      cartTotal: BigInt(body.cartTotal),
      installmentCount: BigInt(body.installmentCount),
      lineItemsHash: body.lineItemsHash,
    });

    const session = openSession(input);
    await config.sessions.put(session);
    return c.json(serialise(session), 201);
  });

  /**
   * Read a session. The whole of CHKT-02 from the client's side.
   *
   * A borrower who abandoned after two checks and came back on a different device
   * calls this and is told which indices remain. Nothing they already signed is
   * re-prompted.
   */
  app.get("/v1/sessions/:sessionId", async (c) => {
    const session = await config.sessions.get(c.req.param("sessionId") as Hex);
    if (!session) return c.json({error: "not-found"}, 404);
    return c.json(serialise(session));
  });

  /** Post one signed authorization, in any order, exactly once. */
  app.post("/v1/sessions/:sessionId/authorizations/:index", async (c) => {
    const sessionId = c.req.param("sessionId") as Hex;
    const index = Number(c.req.param("index"));

    const session = await config.sessions.get(sessionId);
    if (!session) return c.json({error: "not-found"}, 404);

    const body = await c.req.json<{signature: Hex; authorization: SerialisedAuthorization}>();

    try {
      const next = recordAuthorization(
        session,
        index,
        body.signature,
        deserialiseAuthorization(body.authorization),
      );
      await config.sessions.put(next);
      return c.json(serialise(next));
    } catch (error) {
      if (error instanceof SessionError) return c.json({error: error.code, message: error.message}, 409);
      throw error;
    }
  });

  /** Post the typed acceptance — the payload the borrower's wallet renders. */
  app.post("/v1/sessions/:sessionId/acceptance", async (c) => {
    const sessionId = c.req.param("sessionId") as Hex;

    const session = await config.sessions.get(sessionId);
    if (!session) return c.json({error: "not-found"}, 404);

    const body = await c.req.json<{signature: Hex}>();

    try {
      const next = recordAcceptance(session, body.signature);
      await config.sessions.put(next);
      return c.json(serialise(next));
    } catch (error) {
      if (error instanceof SessionError) return c.json({error: error.code, message: error.message}, 409);
      throw error;
    }
  });

  /**
   * The assembled strip, in installment order.
   *
   * Refuses a partial strip rather than returning one. A caller that submitted a
   * strip with a hole would get an origination the plan rejects for a length
   * mismatch, which is a confusing way to learn the borrower never finished signing.
   */
  app.get("/v1/sessions/:sessionId/strip", async (c) => {
    const session = await config.sessions.get(c.req.param("sessionId") as Hex);
    if (!session) return c.json({error: "not-found"}, 404);

    try {
      return c.json({strip: assembleStrip(session), acceptance: session.signatures.acceptance});
    } catch (error) {
      if (error instanceof SessionError) {
        return c.json({error: error.code, outstanding: outstandingAuthorizations(session)}, 409);
      }
      throw error;
    }
  });

  return app;
}

interface SerialisedAuthorization {
  index: number;
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

function deserialiseAuthorization(a: SerialisedAuthorization): CheckAuthorization {
  return {
    index: a.index,
    from: a.from,
    to: a.to,
    value: BigInt(a.value),
    validAfter: BigInt(a.validAfter),
    validBefore: BigInt(a.validBefore),
    nonce: a.nonce,
  };
}
