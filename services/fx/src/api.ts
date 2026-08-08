/**
 * The FX service's HTTP surface. Two routes, over Hono.
 *
 * Hono because Ponder embeds it and `services/origination` and `services/servicing`
 * already speak it, so this is a third service with the same idioms rather than a third
 * runtime.
 *
 * ## Every `/v1` route derives its caller from the key (DEC-62)
 *
 * Never from a body field, never from a header, never from a path segment. The merchant
 * address left the request body in Phase 6 because a caller with any key could otherwise
 * price and open a session as anybody; the same rule applies to a route that returns a
 * **signed** rate, with more at stake — the signature is this operator's word about what a
 * euro cost, and it should not be obtainable by asserting an identity.
 *
 * ## An unfilled seam answers 501, naming its owner (DEC-78)
 *
 * Not 500, and never a plausible default. A 500 says "this broke"; a 501 says "this was
 * never built, and here is what would build it". `FxVenueNotConfigured` is exactly that
 * shape — it already carries the missing credential and the access track — so it maps
 * straight onto the status rather than being flattened into an error somebody has to
 * bisect. The failure this avoids is the worst one available to an FX service: a quote
 * endpoint that answers **something** when it has no venue.
 */
import {Hono} from "hono";
import {z} from "zod";
import type {Context, MiddlewareHandler, Next} from "hono";
import type {Hex} from "viem";

import {FxVenueNotConfigured, type FxPair, type FxVenue} from "./venue.js";
import type {Environment} from "./config.js";
import type {SignedMid} from "./mid.js";

/** Who the presented key says you are. The only source of a caller identity here. */
export interface FxIdentity {
  readonly merchantId: string;
  readonly environment: Environment;
}

/** The verification seam. Injected, so a route test needs no database. */
export interface FxKeyVerifier {
  verify(presented: string): Promise<FxIdentity>;
}

/** An unfilled seam, carrying what would fill it. Mirrors `@plazo/operator`'s. */
export class NotComposed extends Error {
  constructor(
    readonly seam: string,
    readonly owner: string,
  ) {
    super(`${seam} is not composed — ${owner}`);
    this.name = "NotComposed";
  }
}

/**
 * What `GET /v1/fx/corridor/:corridor` answers. Produced by the breaker.
 *
 * `trips` is `readonly string[]` rather than the breaker's `TripReason` union on purpose:
 * this is the serialisation boundary, and JSON has no unions. `breaker.ts` owns the
 * vocabulary and its `CorridorHealth` satisfies this shape structurally, so the seam does
 * not force a dependency from the HTTP layer onto the poll.
 */
export interface CorridorSnapshot {
  readonly corridor: Hex;
  readonly healthy: boolean;
  readonly trips: readonly string[];
  /** Whether the corridor is paused on chain right now. A read, never inferred. */
  readonly pausedOnChain: boolean;
  readonly observedAt: string;
}

export interface FxApiConfig {
  readonly verifier: FxKeyVerifier;
  readonly venue: FxVenue;
  /**
   * The mid signer. Absent until `PLAZO_FX_MID_SIGNER_KEY` and the guard address exist,
   * and absent means 501 rather than an unsigned rate — a rate the guard cannot check is
   * not a cheaper rate, it is a different product.
   */
  readonly sign?: ((input: SignQuoteRequest) => Promise<SignedMid>) | undefined;
  /** The breaker's snapshot for one corridor. Absent means the poll is not composed. */
  readonly health?: ((corridor: Hex) => Promise<CorridorSnapshot>) | undefined;
}

export interface SignQuoteRequest {
  readonly pair: FxPair;
  readonly amount: string;
  readonly rate: string;
  readonly sessionId: Hex;
  readonly ttlSeconds: bigint;
}

interface FxEnv {
  Variables: {caller: FxIdentity};
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

const quoteRequestSchema = z.object({
  from: z.string().min(3).max(8),
  to: z.string().min(3).max(8),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "money crosses as a decimal string, never a number"),
  sessionId: z.string().regex(HEX32, "sessionId is the 32-byte session the guard consumes once"),
  ttlSeconds: z.number().int().positive().max(3600).optional(),
});

/**
 * `Authorization: Bearer …` and nothing else.
 *
 * A key in a query string ends up in access logs, in `Referer` headers and in browser
 * history, so `services/origination` refuses one outright rather than ignoring it. Same
 * rule, same reason.
 */
export function requireKey(verifier: FxKeyVerifier): MiddlewareHandler<FxEnv> {
  return async (c: Context<FxEnv>, next: Next) => {
    const header = c.req.header("Authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return c.json({error: "unauthorized", message: "present the key as Authorization: Bearer …"}, 401);
    }
    try {
      c.set("caller", await verifier.verify(header.slice("Bearer ".length)));
    } catch {
      return c.json({error: "unauthorized", message: "that key did not verify"}, 401);
    }
    await next();
  };
}

/**
 * Two routes, both key-derived.
 *
 * `POST /v1/fx/quote` returns the rate, its expiry, the venue's name and the signed mid.
 * The mid is what the chain will see; the rate is what a human will read; and the venue
 * name is there because "which venue answered" must never have to be inferred from a
 * missing field.
 *
 * `GET /v1/fx/corridor/:corridor` returns the breaker's current view **and whether the
 * corridor is paused on chain**, which are two different facts. A snapshot saying
 * "unhealthy" while the chain says "open" is the interesting case, and collapsing them
 * into one boolean would hide it.
 */
export function createFxApi(config: FxApiConfig): Hono<FxEnv> {
  const app = new Hono<FxEnv>();

  app.use("/v1/*", requireKey(config.verifier));

  app.post("/v1/fx/quote", async (c) => {
    const parsed = quoteRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({error: "bad-request", issues: parsed.error.issues}, 400);
    }
    const body = parsed.data;
    const pair: FxPair = {from: body.from, to: body.to};

    try {
      const quote = await config.venue.quote(pair, body.amount, "tradable");
      const sign = config.sign;
      if (sign === undefined) {
        throw new NotComposed(
          "fx.mid-signer",
          "PLAZO_FX_MID_SIGNER_KEY and PLAZO_FX_GUARD_ADDRESS; the signer must hold FxDeviationGuard.FX_SIGNER_ROLE",
        );
      }
      const signed = await sign({
        pair,
        amount: body.amount,
        rate: quote.rate,
        sessionId: body.sessionId as Hex,
        ttlSeconds: BigInt(body.ttlSeconds ?? 60),
      });

      return c.json({
        venue: quote.venue,
        rate: quote.rate,
        quoteId: quote.quoteId,
        expiresAt: quote.expiresAt,
        // Passed through exactly as the venue sent it (E-04). Never reassembled here.
        typedData: quote.typedData ?? null,
        mid: {
          corridor: signed.mid.corridor,
          midE18: signed.mid.midE18.toString(),
          validUntil: signed.mid.validUntil.toString(),
          sessionId: signed.mid.sessionId,
          signature: signed.signature,
          clamped: signed.clamped,
        },
      });
    } catch (error) {
      return refuse(c, error);
    }
  });

  app.get("/v1/fx/corridor/:corridor", async (c) => {
    const corridor = c.req.param("corridor");
    if (!HEX32.test(corridor)) {
      return c.json({error: "bad-request", message: "corridor is a 32-byte id from corridorOf(token)"}, 400);
    }
    try {
      const health = config.health;
      if (health === undefined) {
        throw new NotComposed(
          "fx.corridor-poll",
          "runCorridorPoll on graphile-worker, plus PLAZO_ORIGINATION_PAUSE_ADDRESS",
        );
      }
      return c.json(await health(corridor as Hex));
    } catch (error) {
      return refuse(c, error);
    }
  });

  return app;
}

/**
 * One place where a refusal becomes a status.
 *
 * Both unfilled-seam shapes land on **501**: `NotComposed` because nothing built it, and
 * `FxVenueNotConfigured` because the credential that would build it is on an access track
 * nobody in this repository controls. Neither is a 500 and neither is a default rate.
 */
function refuse(c: Context<FxEnv>, error: unknown) {
  if (error instanceof NotComposed) {
    return c.json({error: "not-composed", seam: error.seam, owner: error.owner}, 501);
  }
  if (error instanceof FxVenueNotConfigured) {
    return c.json(
      {
        error: "not-composed",
        seam: `fx.venue:${error.venue}`,
        owner: `${error.missing} — ${error.accessTrack}`,
      },
      501,
    );
  }
  return c.json({error: "upstream", message: error instanceof Error ? error.message : "unknown"}, 502);
}
