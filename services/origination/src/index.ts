/**
 * The origination services: quote, session, underwriting and compliance.
 *
 * OPS-02, OPS-03 and OPS-05, plus the service halves of CHKT-01, CHKT-02 and
 * CHKT-08. Proprietary — this is the operator's, not the protocol's.
 *
 * Everything here is arranged so that none of it is load-bearing for a borrower who
 * already holds a signed strip. A borrower mid-plan needs a keeper and a network;
 * they do not need this service to exist, and GOV-08's requirement that the whole
 * loop runs with every operator role at the zero address is what that means in
 * practice. What these services own is the *entry*: pricing a cart, holding a
 * half-signed strip while someone finds their phone, and deciding a limit.
 */
import {eq} from "drizzle-orm";

import {db} from "./db/client.js";
import {merchantExternalRef} from "./db/schema.js";
import {
  createSandboxMerchant,
  issueKey,
  listKeys,
  revokeKey,
  rotateKey,
  verifyKey,
  type Environment,
} from "./keys.js";
import {tokenBucket, type RateLimiter} from "./ratelimit.js";
import {InMemorySessionStore, type SessionStore} from "./session.js";
import {PgSessionStore} from "./store/pg-session.js";
import type {MerchantPlane} from "./api.js";

export * from "./session.js";
export * from "./underwriting.js";
export * from "./compliance.js";
export * from "./keys.js";
export * from "./auth.js";
export * from "./ratelimit.js";
export * from "./api.js";
export * from "./db/schema.js";
export * from "./db/client.js";
export * from "./store/pg-session.js";

/**
 * Which store the process is actually running on, said out loud.
 *
 * The banner is unconditional, in the same spirit as the sample-data banner on
 * `apps/lender`: an operator must never have to infer whether the state in front of
 * them is durable. "Sessions are gone" and "sessions are fine" look identical from a
 * request that succeeded, and the difference only surfaces after a restart has already
 * eaten someone's half-signed strip.
 *
 * The switch is the presence of `DATABASE_URL` and nothing cleverer. A store that fell
 * back to memory when Postgres was merely *unreachable* would turn an outage into
 * silent data loss; an unset variable is a deliberate choice, an unreachable database
 * is a fault, and the two must not have the same consequence. So this throws rather
 * than degrades when the URL is set and the connection cannot be built.
 *
 * The URL is never logged. It carries a password.
 */
export function resolveSessionStore(url: string | undefined = process.env["DATABASE_URL"]): SessionStore {
  if (url) {
    // eslint-disable-next-line no-console
    console.log("[plazo:origination] session store: postgres — checkout sessions survive a restart");
    return new PgSessionStore(db(url));
  }

  // eslint-disable-next-line no-console
  console.log(
    "[plazo:origination] session store: in-memory — checkout sessions die with this process. Set DATABASE_URL to persist them.",
  );
  return new InMemorySessionStore();
}

/**
 * The merchant plane. MERCH-05's wiring point.
 *
 * There is **no in-memory variant, and there must not be one.** A forgetful session store
 * costs a borrower a re-signature; a forgetful key store is an authentication system that
 * forgets who is allowed, and the failure is not that it stops working — it is that it
 * keeps working while meaning nothing. So this throws when `DATABASE_URL` is unset rather
 * than degrading, which is the same rule `resolveSessionStore` applies to an unreachable
 * database, applied here to an absent one.
 *
 * `environment` is what this deployment serves, and it is the value a presented key's
 * prefix must match. A sandbox deployment reads `sandbox`; production reads `live` and
 * refuses a `plazo_test_…` key on shape (D-18).
 */
export function resolveMerchantPlane(
  environment: Environment = (process.env["PLAZO_ENVIRONMENT"] as Environment) ?? "sandbox",
  url: string | undefined = process.env["DATABASE_URL"],
): MerchantPlane {
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Merchant API keys have no in-memory mode: an authentication " +
        "store that forgets is not a weaker store, it is a different system. Set DATABASE_URL.",
    );
  }

  // eslint-disable-next-line no-console
  console.log(`[plazo:origination] merchant plane: postgres — serving the '${environment}' environment`);

  const handle = db(url);

  return {
    verify: (presented) => verifyKey(handle, presented, {environment}),
    issue: (merchantId, keyEnvironment) => issueKey(handle, {merchantId, environment: keyEnvironment}),
    list: (merchantId) => listKeys(handle, merchantId),
    rotate: (merchantId, keyId, overlapDays) => rotateKey(handle, keyId, {merchantId, overlapDays}),
    revoke: (merchantId, keyId) => revokeKey(handle, keyId, {merchantId}),
    selfServeSandbox: (address) => createSandboxMerchant(handle, address),
    linkExternalRef: async (merchantId, planId, externalId) => {
      await handle
        .insert(merchantExternalRef)
        .values({planId, merchantId, externalId})
        // A merchant who re-opens a session for the same counterfactual plan is correcting
        // their own order id, not forking the join. Last write wins, scoped to the owner.
        .onConflictDoUpdate({
          target: merchantExternalRef.planId,
          set: {externalId},
          setWhere: eq(merchantExternalRef.merchantId, merchantId),
        });
    },
  };
}

/** The per-key rate limiter, over the same Postgres. */
export function resolveRateLimiter(url: string | undefined = process.env["DATABASE_URL"]): RateLimiter {
  if (!url) {
    throw new Error("DATABASE_URL is not set; the Postgres token bucket cannot be constructed without it");
  }
  return tokenBucket(db(url));
}
