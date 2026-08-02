/**
 * The servicing plane: reminders, balances, top-ups, the relayer and the console.
 *
 * NOTIF-01 through NOTIF-05, OPS-04, OPS-07, XCH-03, XCH-04 and the service half of
 * COLL-07. Proprietary — this is the operator's, not the protocol's.
 *
 * The organising constraint is the same one the origination services were built under
 * and it is worth restating, because this is the layer most likely to violate it: none
 * of this may become load-bearing for a borrower who already holds a signed strip. A
 * plan collects because a keeper is paid to crank it, cures because `repay()` is never
 * pausable, and terminates because the mark is bountied. Everything in this package is
 * a courtesy on top of that — a warning before a bounce, a receipt after a payment, a
 * support agent who can waive a fee. GOV-08's requirement that the whole loop runs with
 * every operator role at the zero address is what that means in practice, and it is why
 * the fee waiver settles by paying the plan rather than by reaching into it.
 */
import {db} from "./db/client.js";
import {InMemoryAuditLog, type AuditLog} from "./console.js";
import {InMemoryDeliveryLog, type DeliveryLog} from "./ladder.js";
import {PgAuditLog} from "./store/pg-audit.js";
import {PgDeliveryLog} from "./store/pg-deliveries.js";
import {attestationFor} from "./cctp.js";
import {getDelivery, listDeliveries, registerEndpoint, replay} from "./webhooks.js";
import type {AttestationConsole, WebhookConsole} from "./api.js";

export * from "./balance.js";
export * from "./cctp.js";
export * from "./ladder.js";
export * from "./relayer.js";
export * from "./console.js";
export * from "./ssrf.js";
export * from "./webhooks.js";
export * from "./api.js";
export * from "./db/schema.js";
export * from "./db/client.js";
export * from "./store/pg-audit.js";
export * from "./store/pg-deliveries.js";

/**
 * Which stores the process is actually running on, said out loud.
 *
 * The banner is unconditional, matching the one `services/origination` prints for its
 * session store and the sample-data banner on `apps/lender`. An operator must never have
 * to infer whether the record in front of them is durable: "the audit log is gone" and
 * "the audit log is fine" look identical from a request that succeeded, and the difference
 * only surfaces after somebody has already asked for the log as evidence.
 *
 * That asymmetry is sharper here than it was for sessions. A lost checkout session costs
 * somebody a re-signature; a lost audit log costs the operator the ability to answer a
 * regulator, and it costs them it retroactively, for actions taken months earlier that
 * everybody believed were recorded (D-19).
 *
 * The switch is the presence of `DATABASE_URL` and nothing cleverer, and it **throws**
 * rather than degrading when the URL is set and the pool cannot be built. A store that
 * fell back to memory on an unreachable database would turn an outage into silent loss of
 * evidence; an unset variable is a deliberate choice and an unreachable database is a
 * fault, and the two must not have the same consequence.
 *
 * The URL is never logged. It carries a password.
 */
function banner(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

export function resolveAuditLog(url: string | undefined = process.env["DATABASE_URL"]): AuditLog {
  if (url) {
    banner("[plazo:servicing] audit log: postgres — append-only, hash-chained, survives a restart");
    return new PgAuditLog(db(url));
  }

  banner(
    "[plazo:servicing] audit log: in-memory — NOT EVIDENCE. Entries die with this process. Set DATABASE_URL to persist them.",
  );
  return new InMemoryAuditLog();
}

export function resolveDeliveryLog(
  url: string | undefined = process.env["DATABASE_URL"],
): DeliveryLog {
  if (url) {
    banner("[plazo:servicing] delivery log: postgres — every send attempt survives a restart");
    return new PgDeliveryLog(db(url));
  }

  banner(
    "[plazo:servicing] delivery log: in-memory — notice deliveries die with this process. Set DATABASE_URL to persist them.",
  );
  return new InMemoryDeliveryLog();
}

/**
 * The merchant-facing webhook surface. MERCH-05's wiring point.
 *
 * There is no in-memory variant, for the reason `resolveMerchantPlane` gives on the
 * origination side: a webhook delivery log that forgets is not a weaker log, it is a
 * different artefact — one that cannot answer "did you actually send it", which is the
 * only question it is ever asked.
 *
 * **Note what this does not resolve.** `ServicingDeps.merchants` — the thing that turns a
 * presented API key into a merchant — is not built here, because the key tables belong to
 * `@plazo/origination` and a dependency from this service to that one would be a cycle in
 * the operator plane. Whatever process serves both wires that seam from the origination
 * side. Until it does, `denyAllMerchants` refuses every key and the merchant routes serve
 * 401s, which is the correct behaviour for an unwired authenticator and is visible in a
 * way that an open door is not.
 */
export function resolveWebhookConsole(
  url: string | undefined = process.env["DATABASE_URL"],
): WebhookConsole {
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. The webhook delivery log has no in-memory mode: a log that " +
        "forgets cannot answer the one question it exists for. Set DATABASE_URL.",
    );
  }

  banner("[plazo:servicing] webhooks: postgres — every send attempt, success or failure, is a row");

  const handle = db(url);
  const deps = {db: handle};

  return {
    register: (merchantId, endpointUrl) => registerEndpoint(deps, {merchantId, url: endpointUrl}),
    deliveries: (merchantId, limit) => listDeliveries(handle, merchantId, limit),
    delivery: (merchantId, deliveryId) => getDelivery(handle, merchantId, deliveryId),
    replay: (merchantId, deliveryId) => replay(deps, deliveryId, merchantId),
  };
}

/** Whether this plan is this merchant's. See below for why it is a parameter. */
export type PlanOwnership = (merchantId: string, planId: string) => Promise<boolean>;

/**
 * The merchant-facing attestation read.
 *
 * `owns` has **no default and is required**, which is the whole design of this function.
 * The `planId → merchant` join lives in `merchant_external_ref`, a table `@plazo/origination`
 * owns, and this service cannot read it without either a cross-service dependency or a
 * second declaration of somebody else's table. So the composition root — the process that
 * holds both halves — passes the predicate, and it has to think about it to call this at
 * all. A default would have been either "allow", which leaks one merchant's payout status
 * to another, or "deny", which is a route that silently always 404s.
 *
 * Nothing behind this is secret: the burn hash is public and Circle's attestation is
 * served to anyone who asks. The scoping is about not confirming which plans belong to
 * whom, which is worth doing and is not worth a leaky default.
 */
export function resolveAttestationConsole(
  owns: PlanOwnership,
  url: string | undefined = process.env["DATABASE_URL"],
): AttestationConsole {
  if (!url) {
    throw new Error("DATABASE_URL is not set; the attestation store cannot be constructed without it");
  }

  const handle = db(url);

  return {
    for: async (merchantId, planId) =>
      (await owns(merchantId, planId)) ? attestationFor(handle, planId) : null,
  };
}
