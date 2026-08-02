/**
 * The operator composition root.
 *
 * Two services were built to be composed and nothing composed them. `ServicingDeps.merchants`
 * defaulted to `denyAllMerchants`, so every merchant route on the servicing side answered
 * **401**. `.webhooks` and `.attestations` were absent, so those routes answered **503**.
 * `MerchantPlane.emit` had no emitter, so **`key.rotated` was never sent** — the one piece
 * of D-18 that was specified and not delivered end to end.
 *
 * Each of those defaults is a refusal rather than a pretence, which is the correct
 * direction to fail in and is exactly why nothing broke while nobody owned this. It is also
 * why a merchant dashboard built against them looked broken and was not. This file is the
 * owner.
 *
 * ## Why a third package, and not a `main()` inside one of the two
 *
 * DEC-64: the key tables belong to `@plazo/origination`, the webhook fan-out belongs to
 * `@plazo/servicing`, and a dependency between them in either direction is a cycle in the
 * operator plane. A composition root is the standard answer — a package that depends on
 * both and is depended on by neither — and it is the only place in the tree that may
 * legitimately hold both halves.
 *
 * ## One process, one origin, three base URLs
 *
 * Both apps mount at the root of one Hono app. Their paths do not collide: origination owns
 * `/sandbox`, `/v1/quote`, `/v1/sessions/*` and `/v1/keys/*`; servicing owns `/me/*`,
 * `/ops/*`, `/v1/webhooks/*` and `/v1/payouts/*`. That means a deployment can point
 * `PLAZO_ORIGINATION_URL` and `PLAZO_SERVICING_URL` at the same origin, which is what a
 * single-process deployment wants, without either service learning about the other.
 *
 * **`/v1/*` is authenticated twice on the servicing routes, and that is not a defect.**
 * Origination's `app.use("/v1/*", requireKey(...))` matches every `/v1` path in the merged
 * router, including servicing's, so a servicing merchant request is verified and
 * rate-limited by origination's middleware and then scoped by servicing's own `merchantOf`.
 * The first check is what bounds the traffic; the second is what decides whose rows come
 * back. Removing either would be removing a control, so both stay, and the cost is one
 * extra index seek on an already-authenticated request.
 *
 * ## What is wired for real, and what is still a hole
 *
 * The **merchant** plane is wired end to end: keys, rate limiting, webhooks, replay,
 * attestations and the `key.rotated` fan-out.
 *
 * The **borrower** (`/me/*`) and **operator** (`/ops/*`) planes are not, and neither is
 * origination's `prepare`. Those are their own unbuilt requirements — a merchant key says
 * nothing about which borrower is asking or which member of staff is acting — and they are
 * left as `NotComposed` seams that answer **501** naming what owns them, rather than as
 * defaults that would answer plausibly and wrongly.
 */
import {Hono} from "hono";

import {
  KeyError,
  createApi,
  db as originationDb,
  resolveMerchantPlane,
  resolveRateLimiter,
  resolveSessionStore,
  type ApiConfig,
  type MerchantPlane,
  type PrepareRequest,
} from "@plazo/origination";
import {
  createServicingApi,
  db as servicingDb,
  resolveAttestationConsole,
  resolveAuditLog,
  resolveDeliveryLog,
  resolveWebhookConsole,
  type MerchantAuth,
  type ServicingDeps,
} from "@plazo/servicing";
import type {Address} from "viem";
import type {OpenSessionInput} from "@plazo/origination";

import {merchantEventEmitter} from "./merchant-events.js";
import {planOwnership} from "./ownership.js";

/**
 * A seam this process does not fill, named rather than faked.
 *
 * Thrown by the placeholder for every borrower-plane and operator-plane dependency, and
 * turned into a 501 by the app's error handler. The alternative shapes are both worse: a
 * stub returning empty data makes an unbuilt screen look like an empty account, and a
 * missing key on the deps object makes it a `TypeError` in a stack trace nobody can act on.
 */
export class NotComposed extends Error {
  constructor(
    readonly seam: string,
    readonly owner: string,
  ) {
    super(`${seam} is not wired in this process — it belongs to ${owner}`);
    this.name = "NotComposed";
  }
}

/** A placeholder that refuses loudly, with the name of what would fill it. */
function unbuilt(seam: string, owner: string): () => never {
  return () => {
    throw new NotComposed(seam, owner);
  };
}

/**
 * Adapt origination's key verifier to servicing's `MerchantAuth`.
 *
 * **This adapter is load-bearing and passing `resolveMerchantPlane().verify` straight
 * through would be a bug.** The two contracts disagree on the failure path in exactly the
 * way that matters: `MerchantPlane.verify` *throws* `KeyError`, while `MerchantAuth.verify`
 * is documented to "never throw for a bad key" and its callers return the `null` as a 401.
 * Wired directly, a merchant who presented an expired key would get a 500 with a stack
 * trace instead of a 401 telling them to rotate — and every 500 is an alert somebody has to
 * triage.
 *
 * It also narrows the identity. Origination's `MerchantIdentity` carries the settlement
 * `address`; servicing's deliberately does not, because that side only needs to know whose
 * rows these are. Copying the address across would be a second home for an identity with no
 * reader on the receiving side.
 *
 * A non-`KeyError` — the database being gone — is rethrown, because that is not a bad key
 * and must not be reported as one.
 */
export function merchantAuthFrom(plane: MerchantPlane): MerchantAuth {
  return {
    verify: async (presented) => {
      try {
        const identity = await plane.verify(presented);
        return {
          merchantId: identity.merchantId,
          keyId: identity.keyId,
          environment: identity.environment,
        };
      } catch (error) {
        if (error instanceof KeyError) return null;
        throw error;
      }
    },
  };
}

export interface ComposeOptions {
  /** Where both services' tables live. One database, one `operator` schema, two owners. */
  readonly databaseUrl?: string | undefined;
  /**
   * Which world this deployment serves. **Defaults to `sandbox`.**
   *
   * A production deployment that forgets to set `PLAZO_ENVIRONMENT` refuses every live key
   * on shape, one string comparison in, with no database reached. That is the correct
   * direction to fail in — a sandbox key must never settle real money — and it is worth
   * knowing before somebody spends an afternoon on it.
   */
  readonly environment?: "sandbox" | "live" | undefined;
  /** The relayer gate, so `GET /ops/keeper-share` can tell its cranks from everyone else's. */
  readonly gate?: Address | undefined;
  /**
   * CHKT-01's derivation: cart to plan terms. Unbuilt.
   *
   * Deliberately not defaulted to something plausible. `prepare` decides the plan id, the
   * payee, the schedule and the limit, and a composition root inventing any of them would
   * be the API becoming the place the deal is defined — which is the exact thing
   * `@plazo/plan-core` being open source and derivable exists to prevent.
   */
  readonly prepare?: ((request: PrepareRequest) => Promise<OpenSessionInput>) | undefined;
  /**
   * Everything the borrower and operator planes need. Unbuilt; see the header.
   *
   * Typed as a partial of `ServicingDeps` so a deployment that *does* build them can pass
   * them in without this file growing a parameter per seam.
   */
  readonly servicing?: Partial<ServicingDeps> | undefined;
  /**
   * Injected into the webhook sender: `fetch`, the clock, the resolver, the timeout.
   *
   * A test asserts a real delivery against a real socket without owning DNS. Nothing here
   * may inject around `assertDeliverable`, and nothing does — `deliver` calls it on every
   * attempt regardless of what is passed here.
   */
  readonly delivery?:
    | {
        readonly fetchImpl?: typeof fetch | undefined;
        readonly resolve?: ((hostname: string) => Promise<readonly string[]>) | undefined;
        readonly now?: (() => Date) | undefined;
        readonly timeoutMs?: number | undefined;
      }
    | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface ComposedOperator {
  readonly app: Hono;
  readonly environment: "sandbox" | "live";
  /** What the merchant plane resolved to, so a caller can issue keys without HTTP. */
  readonly merchants: MerchantPlane;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Build the process.
 *
 * Throws without a database URL, and does so before anything is mounted. That is DEC-63
 * applied at the composition level: merchant keys and the webhook delivery log have no
 * in-memory mode, so a process that came up without one would be an authentication system
 * that forgets and a delivery log that cannot answer the one question it exists for.
 */
export function composeOperator(options: ComposeOptions = {}): ComposedOperator {
  const url = options.databaseUrl ?? process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. The operator process has no in-memory mode: an " +
        "authentication store that forgets is not a weaker store, it is a different system, " +
        "and a delivery log that forgets cannot answer the one question it exists for (DEC-63).",
    );
  }

  const environment =
    options.environment ?? ((process.env["PLAZO_ENVIRONMENT"] as "sandbox" | "live") || "sandbox");
  const now = options.now ?? (() => new Date());

  const origination = originationDb(url);
  const servicing = servicingDb(url);

  /**
   * One transport for every outbound send in the process.
   *
   * Registration validates, replay sends, and the `key.rotated` fan-out sends. All three go
   * to a merchant-chosen URL, so all three get the same injected `fetch`, clock and
   * resolver — a suite that could assert one of them and not the others would be asserting
   * the easy one. None of it reaches around `assertDeliverable`, which every one of those
   * paths calls on every attempt.
   */
  const transport = {
    ...(options.delivery?.fetchImpl ? {fetchImpl: options.delivery.fetchImpl} : {}),
    ...(options.delivery?.resolve ? {resolve: options.delivery.resolve} : {}),
    ...(options.delivery?.now ? {now: options.delivery.now} : {}),
    ...(options.delivery?.timeoutMs !== undefined ? {timeoutMs: options.delivery.timeoutMs} : {}),
  };

  // ── The three seams 06-06 left, filled ──────────────────────────────────────

  const webhooks = resolveWebhookConsole(url, transport);
  const attestations = resolveAttestationConsole(planOwnership(origination), url);

  const merchants = resolveMerchantPlane(environment, url);
  /**
   * The emitter. `key.rotated` reaches a merchant's own endpoint from here and nowhere
   * else, because this is the only object in the tree holding both the key store and the
   * fan-out (D-18).
   */
  const plane: MerchantPlane = {
    ...merchants,
    emit: merchantEventEmitter({delivery: {...transport, db: servicing}}),
  };

  const apiConfig: ApiConfig = {
    sessions: resolveSessionStore(url),
    merchants: plane,
    limiter: resolveRateLimiter(url),
    signupLimiter: resolveRateLimiter(url),
    prepare: options.prepare ?? unbuilt("origination.prepare", "CHKT-01, still unbuilt"),
  };

  const servicingDeps: ServicingDeps = {
    deliveries: resolveDeliveryLog(url),
    audit: resolveAuditLog(url),
    now,
    gate: options.gate ?? (process.env["PLAZO_RELAYER_GATE_ADDRESS"] as Address) ?? ZERO_ADDRESS,

    // The merchant plane, wired. These three are what this file exists for.
    merchants: merchantAuthFrom(merchants),
    webhooks,
    attestations,

    // The borrower plane. Its identity requirement is unbuilt; see api.ts's header.
    balanceOf: unbuilt("servicing.balanceOf", "the borrower plane (APP-02), still unbuilt"),
    upcomingFor: unbuilt("servicing.upcomingFor", "the borrower plane (APP-02), still unbuilt"),
    plansOf: unbuilt("servicing.plansOf", "the borrower plane (APP-02), still unbuilt"),
    scheduleOf: unbuilt("servicing.scheduleOf", "the indexer read API, not yet wired here"),
    collectionsSince: unbuilt("servicing.collectionsSince", "the indexer read API, not yet wired here"),

    // The operator plane. Its credential is its own requirement and is unbuilt.
    operatorFor: unbuilt("servicing.operatorFor", "the operator credential (OPS-07), still unbuilt"),
    settleWaiver: unbuilt("servicing.settleWaiver", "the operator plane, still unbuilt"),
    sendParameter: unbuilt("servicing.sendParameter", "the operator plane, still unbuilt"),
    sendPause: unbuilt("servicing.sendPause", "the operator plane, still unbuilt"),
    resend: unbuilt("servicing.resend", "the operator plane, still unbuilt"),

    ...options.servicing,
  };

  return {app: createOperatorApp(apiConfig, servicingDeps), environment, merchants: plane};
}

/**
 * Mount both apps on one router.
 *
 * Origination first, because its `/v1/*` middleware is the rate limiter and the cheapest
 * refusal should be the first one a flood meets.
 */
export function createOperatorApp(apiConfig: ApiConfig, servicingDeps: ServicingDeps): Hono {
  const app = new Hono();

  /**
   * An unfilled seam is a 501 naming its owner, never a 500.
   *
   * A 500 says "this broke"; a 501 says "this was never built, and here is what would build
   * it". The difference decides whether the next person reads a stack trace or a sentence.
   */
  app.onError((error, c) => {
    if (error instanceof NotComposed) {
      return c.json({error: "not-composed", seam: error.seam, owner: error.owner}, 501);
    }
    throw error;
  });

  /** Liveness only. It says nothing about the database on purpose — see below. */
  app.get("/health", (c) => c.json({ok: true}));

  app.route("/", createApi(apiConfig));
  app.route("/", createServicingApi(servicingDeps));

  return app;
}
