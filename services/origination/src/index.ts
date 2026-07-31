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
export * from "./session.js";
export * from "./underwriting.js";
export * from "./compliance.js";
export * from "./api.js";
