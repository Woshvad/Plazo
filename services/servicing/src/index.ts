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

export * from "./balance.js";
export * from "./cctp.js";
export * from "./ladder.js";
export * from "./relayer.js";
export * from "./console.js";
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
