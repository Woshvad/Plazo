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
 * ## Authentication
 *
 * Every `/v1` route is behind `requireKey` and derives its merchant from the verified
 * key on the context — never from a body field, never from a header, never from a path
 * segment. `POST /sandbox` is the one unauthenticated route in the file, because it is
 * the door a merchant walks through to get their first key, and it can only ever create
 * a sandbox account.
 *
 * The merchant address that used to arrive in a request body is gone. It was the shape
 * of the whole authorization bug: a caller who could reach this API could price and open
 * a session as anybody (T-06-06-05).
 */
import {zValidator} from "@hono/zod-validator";
import {Hono} from "hono";
import {z} from "zod";
import type {Context} from "hono";
import type {Address, Hex} from "viem";

import {merchantOf, requireKey, type MerchantEnv} from "./auth.js";
import {
  KeyError,
  MAX_OVERLAP_DAYS,
  type Environment,
  type IssuedKey,
  type KeyRecord,
  type MerchantIdentity,
  type Rotation,
} from "./keys.js";
import type {RateLimiter} from "./ratelimit.js";
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
  /** Keys, accounts and the reconciliation join. The only source of a merchant identity. */
  merchants: MerchantPlane;
  /** Applied after key verification, keyed by `keyId`. */
  limiter?: RateLimiter | undefined;
  /**
   * Applied to sandbox self-serve, keyed by the requested address.
   *
   * A separate limiter because the two have nothing in common: one bounds a paying
   * integrator's traffic, the other bounds how fast a stranger can manufacture merchant
   * accounts. Sharing a policy would make the second as generous as the first.
   */
  signupLimiter?: RateLimiter | undefined;
}

/**
 * The merchant plane, as the API depends on it.
 *
 * The interface lives here, beside its consumer, matching `SessionStore` and
 * `ServicingDeps`. `resolveMerchantPlane()` in `index.ts` builds the Postgres one.
 */
export interface MerchantPlane {
  /** Verify a presented key. Throws `KeyError`. */
  verify(presented: string): Promise<MerchantIdentity>;
  issue(merchantId: string, environment: Environment): Promise<IssuedKey>;
  list(merchantId: string): Promise<KeyRecord[]>;
  rotate(merchantId: string, keyId: string, overlapDays?: number): Promise<Rotation>;
  revoke(merchantId: string, keyId: string): Promise<KeyRecord>;
  /** Create a sandbox account and its first key. Never a live one. */
  selfServeSandbox(address: string): Promise<{merchantId: string; address: string; issued: IssuedKey}>;
  /** MERCH-08's reconciliation join: the merchant's own order id against the plan. */
  linkExternalRef(merchantId: string, planId: Hex, externalId: string): Promise<void>;
  /**
   * Tell the merchant's own automation that something happened to their credentials.
   *
   * Optional and injected because the webhook fan-out lives in `@plazo/servicing`, and a
   * dependency from this service to that one would be a cycle in the operator plane. An
   * unwired emitter means a merchant sees a rotation in their dashboard rather than in
   * their inbox — a degradation, not a failure.
   */
  emit?(event: MerchantEvent): Promise<void>;
}

/** The events a merchant's own automation can act on. `key.rotated` is D-18's. */
export interface MerchantEvent {
  readonly event: "key.rotated";
  readonly merchantId: string;
  readonly payload: Record<string, string | null>;
}

export interface PrepareRequest {
  merchant: Address;
  borrower: Address;
  cartTotal: bigint;
  installmentCount: bigint;
  lineItemsHash: Hex;
}

/**
 * Request schemas. ASVS V5: every route validates before it reaches a handler.
 *
 * `merchant` is deliberately absent from every one of them. It comes from the key.
 */
const HEX = /^0x[0-9a-fA-F]+$/;
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address");
const decimal = z.string().regex(/^\d+$/, "money crosses as a decimal string, never a number");

const quoteSchema = z.object({
  borrower: address,
  cartTotal: decimal,
  installmentCount: z.number().int().positive().max(64),
  lineItemsHash: z.string().regex(HEX),
});

const sessionSchema = quoteSchema.extend({
  /**
   * The merchant's own order id. MERCH-08.
   *
   * Bounded because it is a foreign key into a system Plazo does not control and an
   * unbounded string on a table an operator reads is a denial-of-service with extra
   * steps.
   */
  externalId: z.string().min(1).max(256).optional(),
});

const authorizationSchema = z.object({
  signature: z.string().regex(HEX),
  authorization: z.object({
    index: z.number().int().nonnegative(),
    from: address,
    to: address,
    value: decimal,
    validAfter: decimal,
    validBefore: decimal,
    nonce: z.string().regex(HEX),
  }),
});

const acceptanceSchema = z.object({signature: z.string().regex(HEX)});

const rotateSchema = z.object({
  overlapDays: z.number().int().min(0).max(MAX_OVERLAP_DAYS).optional(),
});

const sandboxSchema = z.object({address});

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

/**
 * Tell the merchant's own automation that their credentials moved. D-18's `key.rotated`.
 *
 * ## Why this is here and not in `keys.ts`
 *
 * `rotateKey` is the store operation and it must stay one: a function that wrote a row and
 * then made an outbound HTTP call would make the row's durability depend on a merchant's
 * server being up. The route is the place that already owns "the rotation happened and the
 * caller is being told about it", so it is the place that tells everybody else.
 *
 * ## The payload carries no secret, and cannot
 *
 * `MerchantEvent.payload` is `Record<string, string | null>` and the two things worth
 * sending are identifiers and a timestamp. The new secret is in the HTTP response to the
 * caller and nowhere else — a webhook is delivered to a URL the *merchant* chose, over a
 * channel Plazo does not control the far end of, and putting a live credential in it would
 * hand the credential to whoever most recently edited that destination. The rotation is a
 * cue to go and read the response, exactly as `onComplete` is a cue in the embed.
 *
 * ## A failed notification is not a failed rotation
 *
 * The key has already moved by the time this runs. Throwing here would report a rotation
 * that happened as one that did not, and the merchant's next act would be to rotate again.
 * So every failure is swallowed after `deliver` has already written its row — the delivery
 * log is where a merchant finds out their endpoint is down, and it is populated whether
 * this returns or not.
 */
async function emitKeyRotated(
  config: ApiConfig,
  merchantId: string,
  rotation: Rotation,
): Promise<void> {
  if (!config.merchants.emit) return;
  try {
    await config.merchants.emit({
      event: "key.rotated",
      merchantId,
      payload: {
        keyId: rotation.issued.record.keyId,
        last4: rotation.issued.record.last4,
        environment: rotation.issued.record.environment,
        retiredKeyId: rotation.retired.keyId,
        /** When the retired key stops authenticating. The whole point of an overlap. */
        retiredExpiresAt: rotation.retired.expiresAt?.toISOString() ?? null,
      },
    });
  } catch {
    // Deliberately swallowed. See above.
  }
}

/** A key, as everyone but its creator sees it: a shape, a tail, and a lifecycle. */
function serialiseKey(record: KeyRecord) {
  return {
    keyId: record.keyId,
    environment: record.environment,
    last4: record.last4,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    rotatedFrom: record.rotatedFrom,
  };
}

export function createApi(config: ApiConfig): Hono<MerchantEnv> {
  const app = new Hono<MerchantEnv>();

  /**
   * Self-serve a sandbox. MERCH-05's first sentence, and the only unauthenticated route.
   *
   * It cannot create a live merchant. A live account is made by an operator process after
   * KYB and after `MerchantRegistry.attestKyb` on chain, so a sandbox key issued here
   * points at a deployment that would refuse to originate even if the key somehow escaped
   * its environment.
   *
   * Deliberately outside `/v1`, so that "every `/v1` route derives its merchant from a
   * verified key" stays true without an exception clause.
   */
  app.post("/sandbox", zValidator("json", sandboxSchema), async (c) => {
    const {address: merchantAddress} = c.req.valid("json");

    if (config.signupLimiter) {
      const decision = await config.signupLimiter.consume(`signup:${merchantAddress.toLowerCase()}`);
      if (!decision.allowed) {
        c.header("retry-after", String(Math.max(1, Math.ceil((decision.resetAt.getTime() - Date.now()) / 1000))));
        return c.json({error: "rate-limited", message: "too many sandbox signups for that address"}, 429);
      }
    }

    try {
      const created = await config.merchants.selfServeSandbox(merchantAddress);
      return c.json(
        {
          merchantId: created.merchantId,
          address: created.address,
          environment: "sandbox" as const,
          key: serialiseKey(created.issued.record),
          /** The one and only time this is readable. There is no recovery path. */
          secret: created.issued.key,
        },
        201,
      );
    } catch (error) {
      if (error instanceof KeyError) return c.json({error: error.code, message: error.message}, 409);
      throw error;
    }
  });

  /**
   * Everything under `/v1` is authenticated, by mounting rather than by remembering.
   *
   * A route added below this line inherits the guard. A route that wanted to opt out
   * would have to be moved out of `/v1` — which is a visible act in a diff, unlike a
   * missing decorator.
   */
  app.use(
    "/v1/*",
    requireKey({verifier: {verify: (presented) => config.merchants.verify(presented)}, limiter: config.limiter}),
  );

  /**
   * A session, but only if it is this merchant's.
   *
   * A session id is a random 32-byte value and guessing one is not the threat; the threat
   * is a merchant who has legitimately seen an id — from a support ticket, from a shared
   * integration, from their own logs of somebody else's traffic — reading or advancing a
   * session that is not theirs. Scoping the read is the cheap half of T-06-06-05, and a
   * miss is reported as `not-found` rather than `forbidden` so the route does not confirm
   * that an id exists.
   */
  async function sessionFor(c: Context<MerchantEnv>, sessionId: Hex): Promise<CheckoutSession | undefined> {
    const merchant = merchantOf(c);
    const session = await config.sessions.get(sessionId);
    if (!session) return undefined;
    return session.merchant.toLowerCase() === merchant.address.toLowerCase() ? session : undefined;
  }

  // ─── Keys (MERCH-05, D-18) ───────────────────────────────────────────────

  /** Issue another key in the merchant's own environment. */
  app.post("/v1/keys", async (c) => {
    const merchant = merchantOf(c);
    const issued = await config.merchants.issue(merchant.merchantId, merchant.environment);
    return c.json({key: serialiseKey(issued.record), secret: issued.key}, 201);
  });

  /** List them. Tails and lifecycles, never a secret. */
  app.get("/v1/keys", async (c) => {
    const merchant = merchantOf(c);
    return c.json({keys: (await config.merchants.list(merchant.merchantId)).map(serialiseKey)});
  });

  /**
   * Rotate with an overlap. Both keys work until the old one's `expiresAt`.
   *
   * The default is 7 days and the ceiling is 30 (D-18). A merchant whose deploy takes
   * longer than a month has a problem this API cannot solve.
   */
  app.post("/v1/keys/:keyId/rotate", zValidator("json", rotateSchema), async (c) => {
    const merchant = merchantOf(c);
    try {
      const rotation = await config.merchants.rotate(
        merchant.merchantId,
        c.req.param("keyId"),
        c.req.valid("json").overlapDays,
      );
      await emitKeyRotated(config, merchant.merchantId, rotation);
      return c.json({
        key: serialiseKey(rotation.issued.record),
        secret: rotation.issued.key,
        retired: serialiseKey(rotation.retired),
      });
    } catch (error) {
      if (error instanceof KeyError) {
        return c.json({error: error.code, message: error.message}, error.code === "not-yours" ? 403 : 404);
      }
      throw error;
    }
  });

  /** Kill a key now. The row stays, so the rotation history keeps its shape. */
  app.delete("/v1/keys/:keyId", async (c) => {
    const merchant = merchantOf(c);
    try {
      return c.json({key: serialiseKey(await config.merchants.revoke(merchant.merchantId, c.req.param("keyId")))});
    } catch (error) {
      if (error instanceof KeyError) return c.json({error: error.code, message: error.message}, 404);
      throw error;
    }
  });

  // ─── Checkout ────────────────────────────────────────────────────────────

  /**
   * Price a cart. CHKT-01, and CHKT-08 when the answer is no.
   *
   * A decline always carries a fallback when one exists, because a flat no is the
   * worst available answer to "you are $12 over": the merchant loses the sale and
   * the borrower is told they failed a test nobody explained.
   */
  app.post("/v1/quote", zValidator("json", quoteSchema), async (c) => {
    const merchant = merchantOf(c);
    const body = c.req.valid("json");

    const input = await config.prepare({
      merchant: merchant.address as Address,
      borrower: body.borrower as Address,
      cartTotal: BigInt(body.cartTotal),
      installmentCount: BigInt(body.installmentCount),
      lineItemsHash: body.lineItemsHash as Hex,
    });

    return c.json(serialise(openSession(input)));
  });

  /** Open a session against a quote, and hold it while the borrower signs. */
  app.post("/v1/sessions", zValidator("json", sessionSchema), async (c) => {
    const merchant = merchantOf(c);
    const body = c.req.valid("json");

    const input = await config.prepare({
      merchant: merchant.address as Address,
      borrower: body.borrower as Address,
      cartTotal: BigInt(body.cartTotal),
      installmentCount: BigInt(body.installmentCount),
      lineItemsHash: body.lineItemsHash as Hex,
    });

    const session = openSession(input);
    await config.sessions.put(session);

    /**
     * MERCH-08's join, written at the only moment both halves exist.
     *
     * `planId` is counterfactual until origination but is derived at `openSession`, so
     * the merchant's own order id can be bound to it before anything is signed. Stored
     * operator-side, never on the chain-derived schema: an order id is not PII, but it
     * dereferences to PII in a system Plazo does not control.
     */
    if (body.externalId) {
      await config.merchants.linkExternalRef(merchant.merchantId, session.planId, body.externalId);
    }

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
    const session = await sessionFor(c, c.req.param("sessionId") as Hex);
    if (!session) return c.json({error: "not-found"}, 404);
    return c.json(serialise(session));
  });

  /** Post one signed authorization, in any order, exactly once. */
  app.post("/v1/sessions/:sessionId/authorizations/:index", zValidator("json", authorizationSchema), async (c) => {
    const sessionId = c.req.param("sessionId") as Hex;
    const index = Number(c.req.param("index"));

    const session = await sessionFor(c, sessionId);
    if (!session) return c.json({error: "not-found"}, 404);

    const body = c.req.valid("json");

    try {
      const next = recordAuthorization(
        session,
        index,
        body.signature as Hex,
        deserialiseAuthorization(body.authorization as unknown as SerialisedAuthorization),
      );
      await config.sessions.put(next);
      return c.json(serialise(next));
    } catch (error) {
      if (error instanceof SessionError) return c.json({error: error.code, message: error.message}, 409);
      throw error;
    }
  });

  /** Post the typed acceptance — the payload the borrower's wallet renders. */
  app.post("/v1/sessions/:sessionId/acceptance", zValidator("json", acceptanceSchema), async (c) => {
    const sessionId = c.req.param("sessionId") as Hex;

    const session = await sessionFor(c, sessionId);
    if (!session) return c.json({error: "not-found"}, 404);

    const body = c.req.valid("json");

    try {
      const next = recordAcceptance(session, body.signature as Hex);
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
    const session = await sessionFor(c, c.req.param("sessionId") as Hex);
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
