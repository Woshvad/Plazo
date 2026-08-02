/**
 * The indexer's read API.
 *
 * Ponder embeds Hono and executes exactly this file — `src/api/index.ts`, not
 * `src/api.ts`; the path is fixed by `ponder`'s own options and a file anywhere else is
 * silently not an API — and it must default-export a Hono instance. Nothing in the
 * indexing path may import from here, which is why the queries live in
 * `../reconciliation.js` and this file is only routing and serialisation.
 *
 * `/v1/` and money-as-decimal-string match the origination service, because a merchant
 * integrating against two Plazo services should not have to learn two conventions.
 */
import {db} from "ponder:api";
import {Hono} from "hono";

import {
  pendingDispatches,
  settlementsFor,
  type QueryRunner,
  type SettlementQuery,
} from "../reconciliation.js";

const app = new Hono();

/** Ponder's readonly Drizzle can run a statement; that is all these reads need. */
const runner = db as unknown as QueryRunner;

/** A block number from a query string, or undefined. Rejects anything that is not one. */
function blockParam(raw: string | undefined, name: string): bigint | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) throw new BadRequest(`${name} must be a block number`);
  return BigInt(raw);
}

const STATUSES = new Set(["settled", "queued", "dispatched", "escrowed", "returned"]);

class BadRequest extends Error {}

/**
 * MERCH-08. One row per settlement, carrying the merchant's own order id.
 *
 * The `externalId` comes from `operator.merchant_external_ref`, joined on `planId`.
 * That is a **cross-schema read** — chain-derived joining operator-private — and it is
 * the only direction permitted: the chain-derived schema must never gain a column that
 * identifies anyone. `planId` is the only join key between the two schemas, and it is
 * exactly what a deletion request severs.
 *
 * Scoped by the `:merchant` path segment. A merchant must see their own settlements and
 * nobody else's, and the enforcement of that — deriving the merchant from a verified API
 * key and rejecting a mismatch — is MERCH-05's key middleware, which this route is
 * mounted behind once plan 06-06 ships it. Until then the segment is trusted, which is
 * the same posture the origination service's routes carry and is marked the same way so
 * it cannot be mistaken for finished.
 */
app.get("/v1/merchants/:merchant/settlements", async (c) => {
  const merchant = c.req.param("merchant");
  if (!/^0x[0-9a-fA-F]{40}$/.test(merchant)) {
    return c.json({error: "merchant must be an address"}, 400);
  }

  const status = c.req.query("status");
  if (status !== undefined && !STATUSES.has(status)) {
    return c.json({error: `status must be one of ${[...STATUSES].join(", ")}`}, 400);
  }

  let query: SettlementQuery;
  try {
    query = {
      merchant,
      from: blockParam(c.req.query("from"), "from"),
      to: blockParam(c.req.query("to"), "to"),
      status,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    };
  } catch (error) {
    if (error instanceof BadRequest) return c.json({error: error.message}, 400);
    throw error;
  }

  return c.json({settlements: await settlementsFor(runner, query)});
});

/**
 * The burns the attestation poller has to ask Iris about.
 *
 * **C10: Ponder is the trigger, never a Circle webhook.** The poller reads this rather
 * than waiting to be told, so a missed delivery is a lag rather than money that silently
 * stopped moving.
 *
 * `after` is a block-number cursor. The poller keeps it, along with which of these it has
 * already attested — see `pendingDispatches` for why that state stays on the poller's
 * side of the line rather than becoming a column on a chain-derived table.
 */
app.get("/v1/payouts/dispatches", async (c) => {
  const raw = c.req.query("after");
  if (raw !== undefined && raw !== "" && !/^\d+$/.test(raw)) {
    return c.json({error: "after must be a block number"}, 400);
  }

  const dispatches = await pendingDispatches(runner, {
    after: raw ? BigInt(raw) : undefined,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  });

  return c.json({dispatches});
});

export default app;
