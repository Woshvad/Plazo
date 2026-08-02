/**
 * Whose plan is this?
 *
 * `resolveAttestationConsole` takes this predicate as a **required** argument with no
 * default, and DEC-65 says why: the `planId → merchant` join lives in
 * `merchant_external_ref`, a table `@plazo/origination` owns, and `@plazo/servicing` cannot
 * read it without either a cross-service dependency or a second declaration of somebody
 * else's table. A default would have been either "allow" — one merchant reads another
 * merchant's payout status — or "deny", which is a route that silently always 404s.
 *
 * This file is the answer, and it is the reason the composition root has to exist at all:
 * it is the only place in the tree that legitimately holds both halves.
 *
 * ## `merchant_external_ref` is the join, and its absence is a "no"
 *
 * The row is written at `POST /v1/sessions` when the merchant supplies their own order id,
 * and `planId` is the primary key. A plan with no row is a plan no merchant filed an
 * external reference against, and the honest answer for it is **false** — not "probably
 * theirs". The route turns a false into a 404 rather than a 403, so it does not confirm
 * that the plan id exists.
 *
 * The cost is real and is worth stating: a merchant who never sends `externalId` cannot
 * read their own attestations through this route. The alternative — inferring ownership
 * from the settlement address on chain — would put a chain read on an authorization path,
 * and an authorization that depends on an RPC answering is an authorization that opens or
 * closes depending on the network. The chain-derived route to the same bytes exists and is
 * public: the burn hash is on chain and Iris serves the attestation to anybody who asks.
 * Nothing here is secret; the scoping is about not confirming which plans belong to whom.
 */
import {and, eq} from "drizzle-orm";

import {merchantExternalRef, type Db as OriginationDb} from "@plazo/origination";
import type {PlanOwnership} from "@plazo/servicing";

/**
 * The predicate, over the **origination** handle.
 *
 * The handle is origination's and the parameter name says so. Both services export a type
 * called `Db` over their own schema, and passing the servicing one here would read every
 * bit as well as it would compile badly — which is why it is aliased at the import rather
 * than left to look interchangeable.
 */
export function planOwnership(db: OriginationDb): PlanOwnership {
  return async (merchantId: string, planId: string): Promise<boolean> => {
    const [row] = await db
      .select({planId: merchantExternalRef.planId})
      .from(merchantExternalRef)
      .where(
        and(eq(merchantExternalRef.planId, planId), eq(merchantExternalRef.merchantId, merchantId)),
      )
      .limit(1);

    return row !== undefined;
  };
}
