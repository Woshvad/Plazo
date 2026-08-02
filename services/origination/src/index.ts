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
import {db} from "./db/client.js";
import {InMemorySessionStore, type SessionStore} from "./session.js";
import {PgSessionStore} from "./store/pg-session.js";

export * from "./session.js";
export * from "./underwriting.js";
export * from "./compliance.js";
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
