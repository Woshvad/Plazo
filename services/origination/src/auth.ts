/**
 * The middleware that turns a presented key into a merchant identity, and the only place
 * a merchant identity may come from.
 *
 * ## The rule this file exists to make structural
 *
 * Every `/v1` route reads `merchantId` **from the context**. Not from the body, not from
 * a header, not from a path segment. Before this file existed, `api.ts` took a merchant
 * address out of a request body and trusted it, and its own header comment said so — which
 * means any caller with any key could have originated as any merchant (T-06-06-05).
 *
 * Mounting is `app.use("/v1/*", requireKey(...))` rather than a per-route decorator, so a
 * route added later is authenticated by default rather than by remembering.
 *
 * ## Header only, and a query parameter is an error rather than an omission
 *
 * `Authorization: Bearer …` and nothing else. A key in a query string ends up in access
 * logs, in `Referer` headers on any outbound link, and in browser history, so a key that
 * arrives that way is already compromised. This refuses with a message that says to
 * rotate it, because silently accepting it would hide the leak and silently *ignoring* it
 * would present as a confusing 401.
 *
 * ## Rate limiting comes after authentication, deliberately
 *
 * The bucket is keyed by `keyId`, which does not exist until the key verifies. That
 * ordering also means an unauthenticated flood is refused by the cheaper check.
 */
import type {Context, MiddlewareHandler, Next} from "hono";

import {KeyError, type Environment, type MerchantIdentity} from "./keys.js";
import type {RateLimiter} from "./ratelimit.js";

/** The context variable map. `c.get("merchant")` is typed because of this. */
export interface MerchantEnv {
  Variables: {
    merchant: MerchantIdentity;
  };
}

/**
 * The verification seam.
 *
 * A route depends on this one method, not on Postgres and not on `keys.ts`, so an API
 * test can inject an identity without a database and the real wiring stays in one place.
 */
export interface KeyVerifier {
  verify(presented: string): Promise<MerchantIdentity>;
}

/** The real one. `environment` is the world this deployment serves. */
export function keyVerifier(
  verifyKey: (presented: string, environment: Environment) => Promise<MerchantIdentity>,
  environment: Environment,
): KeyVerifier {
  return {verify: (presented) => verifyKey(presented, environment)};
}

/** Query parameter names that have ever been used to smuggle a credential into a URL. */
const FORBIDDEN_QUERY_KEYS = ["api_key", "apiKey", "apikey", "key", "access_token", "token"];

/** `KeyError.code` → HTTP status. Everything the caller can fix is a 401. */
function statusFor(code: KeyError["code"]): 400 | 401 | 403 {
  switch (code) {
    case "malformed":
      return 400;
    case "not-yours":
      return 403;
    default:
      return 401;
  }
}

export interface RequireKeyOptions {
  readonly verifier: KeyVerifier;
  /** Applied after verification, keyed by `keyId`. Omit for no limit. */
  readonly limiter?: RateLimiter | undefined;
}

/**
 * Authenticate, rate limit, and put the merchant on the context.
 */
export function requireKey(options: RequireKeyOptions): MiddlewareHandler<MerchantEnv> {
  return async (c: Context<MerchantEnv>, next: Next) => {
    for (const name of FORBIDDEN_QUERY_KEYS) {
      if (c.req.query(name) !== undefined) {
        return c.json(
          {
            error: "key-in-query",
            message:
              "an api key must be presented in the Authorization header, never in a url. " +
              "a key that has been in a url is in logs and referrers — rotate it.",
          },
          400,
        );
      }
    }

    const header = c.req.header("authorization");
    if (!header) {
      return c.json({error: "unauthenticated", message: "Authorization: Bearer <api key> required"}, 401);
    }

    const [scheme, presented] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !presented) {
      return c.json({error: "unauthenticated", message: "Authorization must be a Bearer credential"}, 401);
    }

    let merchant: MerchantIdentity;
    try {
      merchant = await options.verifier.verify(presented);
    } catch (error) {
      if (error instanceof KeyError) {
        // The message is safe to return: it never contains the presented key, and telling
        // a caller that their key expired at the end of a rotation window is the whole
        // point of having distinguishable failure codes.
        return c.json({error: error.code, message: error.message}, statusFor(error.code));
      }
      throw error;
    }

    if (options.limiter) {
      const decision = await options.limiter.consume(merchant.keyId);
      if (!decision.allowed) {
        const retryAfter = Math.max(1, Math.ceil((decision.resetAt.getTime() - Date.now()) / 1000));
        c.header("retry-after", String(retryAfter));
        c.header("x-ratelimit-limit", String(decision.limit));
        c.header("x-ratelimit-remaining", "0");
        return c.json({error: "rate-limited", message: "too many requests for this api key"}, 429);
      }
      c.header("x-ratelimit-limit", String(decision.limit));
      c.header("x-ratelimit-remaining", String(decision.remaining));
    }

    c.set("merchant", merchant);
    await next();
    return undefined;
  };
}

/**
 * The merchant on the context, or a throw.
 *
 * Routes call this rather than `c.get("merchant")` directly so that a route mounted
 * outside the middleware fails loudly at the first request rather than reading
 * `undefined` and treating it as an anonymous caller.
 */
export function merchantOf(c: Context<MerchantEnv>): MerchantIdentity {
  const merchant = c.get("merchant");
  if (!merchant) {
    throw new Error("route is not behind requireKey — there is no merchant on the context");
  }
  return merchant;
}
