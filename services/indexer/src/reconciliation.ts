/**
 * MERCH-08: one row per settlement, carrying the merchant's own order id.
 *
 * A merchant reconciles against *their* ledger, not ours. A row that says a plan
 * settled for 86.40 is useless to an accounts department whose books are keyed by order
 * `A-10432`, so the `externalId` is not a nicety — it is the column that makes the
 * endpoint worth calling.
 *
 * ## The cross-schema read, and why it only goes one way
 *
 * `externalId` lives in `operator.merchant_external_ref`, on the private side of the
 * storage split (OPS-08, D-17). This read joins **chain-derived to operator-private**,
 * and that is the only direction permitted: the chain-derived schema must never gain a
 * column that identifies anyone, because everything in it is meant to be reproducible
 * from the chain alone and a column that is not reproducible makes the whole claim
 * false. An order id is a merchant's internal key into their own customer record — not
 * PII itself, but it dereferences to PII in a system Plazo does not control.
 *
 * `planId` is the only join key between the two schemas, and it is exactly what a
 * deletion request severs. Sever it and this endpoint still returns the settlement; it
 * simply no longer knows whose order it was. That is the design working, not the design
 * failing.
 *
 * The operator schema is named explicitly rather than left to the search path, because
 * the boundary is a real Postgres schema and a read that crosses it should say so in
 * the SQL a reviewer reads.
 *
 * ## Money crosses as a decimal string
 *
 * JSON does not carry bigints. Every monetary field is formatted at the leaf and
 * round-trips through `BigInt()` exactly; nothing goes through `Number`, because at
 * 6-decimal USDC the safe-integer boundary is about $9bn and a float would return a
 * neighbouring value that reads as an off-by-one rather than as a lost dollar.
 */
import {sql, type SQL} from "drizzle-orm";

import {payout, payoutDispatch, refund, settlementEscrow} from "../ponder.schema.js";

/** Where the operator-private half lives. A real schema, named on purpose. */
export const OPERATOR_SCHEMA = "operator";

/** JSON does not carry bigints. Everything monetary crosses as a decimal string. */
export const money = (value: bigint): string => value.toString();

/**
 * One settlement, as a merchant reads it.
 *
 * No borrower, and no field that could carry one. The events this is derived from do
 * not name a person and neither does the operator column joined onto them.
 */
export interface SettlementView {
  planId: string;
  /** The merchant's own order id. Null when nothing has been filed against this plan. */
  externalId: string | null;
  gross: string;
  mdr: string;
  withheld: string;
  net: string;
  refundedAmount: string;
  payoutDomain: number | null;
  payoutStatus: string;
  /** `held` | `attested` | `released` | `returned`, or null for an instant settlement. */
  escrowState: string | null;
  /** The origination. The merchant's key back to their own order. */
  txHash: string | null;
  /** The burn, when the settlement went through the queue. Circle's key. */
  dispatchTxHash: string | null;
  blockNumber: string;
  timestamp: number;
}

export interface SettlementQuery {
  merchant: string;
  /** Inclusive block-range bounds. Both indexed. */
  from?: bigint | undefined;
  to?: bigint | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  operatorSchema?: string | undefined;
}

/** Anything that can run a statement. `ponder:api`'s readonly Drizzle satisfies it. */
export interface QueryRunner {
  execute(query: SQL): Promise<{rows: Record<string, unknown>[]}>;
}

/** A decimal string from Postgres `numeric`, or a bigint, or a null meaning zero. */
const toBigInt = (value: unknown): bigint => {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  // `numeric` arrives as a string precisely so it cannot lose precision. A number here
  // would mean somebody taught the driver to parse it, which is the bug this catches.
  if (typeof value === "string") return BigInt(value);
  throw new TypeError(`refusing to read money from a ${typeof value}: ${String(value)}`);
};

const toNumberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const toStringOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * A Postgres identifier this code is willing to interpolate.
 *
 * The schema name is the one part of the statement that is not a bound parameter, so it
 * is the one part that could be an injection if it ever came from a request. It does
 * not today — it is configuration — and this keeps it that way rather than relying on
 * that staying true.
 */
function safeIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe schema identifier: ${name}`);
  return `"${name}"`;
}

/**
 * The statement, built from the schema objects rather than from table-name strings.
 *
 * Interpolating the Drizzle tables and columns means a rename in `ponder.schema.ts`
 * fails the build here instead of failing the query at runtime — which for a read this
 * far from the write path would otherwise be found by a merchant.
 */
export function settlementsQuery(params: SettlementQuery): SQL {
  const schema = safeIdentifier(params.operatorSchema ?? OPERATOR_SCHEMA);
  const external = sql.raw(`${schema}."merchant_external_ref"`);

  const filters: SQL[] = [sql`lower(${payout.merchant}) = lower(${params.merchant})`];
  if (params.from !== undefined) filters.push(sql`${payout.blockNumber} >= ${params.from}`);
  if (params.to !== undefined) filters.push(sql`${payout.blockNumber} <= ${params.to}`);
  if (params.status !== undefined) filters.push(sql`${payout.status} = ${params.status}`);

  return sql`
    select
      ${payout.planId} as plan_id,
      ${payout.gross} as gross,
      ${payout.mdr} as mdr,
      ${payout.withheld} as withheld,
      ${payout.net} as net,
      ${payout.domain} as payout_domain,
      ${payout.status} as payout_status,
      ${payout.txHash} as tx_hash,
      ${payout.dispatchTxHash} as dispatch_tx_hash,
      ${payout.blockNumber} as block_number,
      ${payout.timestamp} as timestamp,
      ${settlementEscrow.state} as escrow_state,
      coalesce(
        (select sum(${refund.amount}) from ${refund} where ${refund.planId} = ${payout.planId}),
        0
      ) as refunded_amount,
      ${external}."external_id" as external_id
    from ${payout}
    left join ${settlementEscrow} on ${settlementEscrow.planId} = ${payout.planId}
    left join ${external} on ${external}."plan_id" = ${payout.planId}
    where ${sql.join(filters, sql` and `)}
    order by ${payout.blockNumber} desc, ${payout.planId} asc
    limit ${Math.min(params.limit ?? 200, 1000)}
  `;
}

/** One row per settlement, newest first, every money figure a decimal string. */
export async function settlementsFor(
  db: QueryRunner,
  params: SettlementQuery,
): Promise<SettlementView[]> {
  const result = await db.execute(settlementsQuery(params));

  return result.rows.map((row) => ({
    planId: String(row["plan_id"]),
    externalId: toStringOrNull(row["external_id"]),
    gross: money(toBigInt(row["gross"])),
    mdr: money(toBigInt(row["mdr"])),
    withheld: money(toBigInt(row["withheld"])),
    net: money(toBigInt(row["net"])),
    refundedAmount: money(toBigInt(row["refunded_amount"])),
    payoutDomain: toNumberOrNull(row["payout_domain"]),
    payoutStatus: String(row["payout_status"]),
    escrowState: toStringOrNull(row["escrow_state"]),
    txHash: toStringOrNull(row["tx_hash"]),
    dispatchTxHash: toStringOrNull(row["dispatch_tx_hash"]),
    blockNumber: toBigInt(row["block_number"]).toString(),
    timestamp: Number(row["timestamp"]),
  }));
}

/**
 * The dispatches that have gone out and not yet been attested.
 *
 * **C10: Ponder is the trigger, never a Circle webhook.** A credit system's settlement
 * loop must not have a single vendor webhook on its critical path — a missed delivery
 * would present as money that silently stopped moving, and the operator would learn
 * about it from the merchant. This reads the indexer's own `payoutDispatch` table,
 * which is derived from the chain and therefore cannot be missed, only lagged.
 *
 * Ordered by block number because Iris attests in the order the burns landed, and a
 * poller that asked out of order would spend its budget on the ones least likely to be
 * ready.
 *
 * The transaction hash is the join, and DEC-31 is why: a CCTP v2 burn emits a **zero**
 * nonce, and the real `eventNonce` only comes back from Iris at attestation. There is
 * no on-chain identifier to ask about.
 */
export interface PendingDispatch {
  id: string;
  txHash: string;
  token: string;
  recipient: string;
  domain: number;
  amount: string;
  blockNumber: string;
  timestamp: number;
}

/**
 * Which dispatches the poller is told about, and where the attestation state lives.
 *
 * This returns every burn from a cursor forward and takes no view on which have already
 * been attested. That split is deliberate: the chain-derived schema is the authority on
 * what was dispatched, and the poller is the authority on what it has since heard back
 * from Iris. Putting an `attested` column on `payoutDispatch` would make a chain-derived
 * table hold a vendor's answer, and the table would no longer be reproducible from the
 * chain — which is the one property the whole storage split exists to keep.
 *
 * So the poller advances a cursor and filters against its own records. A dispatch it has
 * already completed costs it one comparison; a dispatch it has never seen cannot be
 * missed, because this table cannot miss a log.
 */
export async function pendingDispatches(
  db: QueryRunner,
  params: {after?: bigint | undefined; limit?: number | undefined} = {},
): Promise<PendingDispatch[]> {
  const filters: SQL[] = [sql`${payoutDispatch.kind} = 'dispatched'`];
  if (params.after !== undefined) filters.push(sql`${payoutDispatch.blockNumber} > ${params.after}`);

  const result = await db.execute(sql`
    select
      ${payoutDispatch.id} as id,
      ${payoutDispatch.txHash} as tx_hash,
      ${payoutDispatch.token} as token,
      ${payoutDispatch.recipient} as recipient,
      ${payoutDispatch.domain} as domain,
      ${payoutDispatch.amount} as amount,
      ${payoutDispatch.blockNumber} as block_number,
      ${payoutDispatch.timestamp} as timestamp
    from ${payoutDispatch}
    where ${sql.join(filters, sql` and `)}
    order by ${payoutDispatch.blockNumber} asc, ${payoutDispatch.logIndex} asc
    limit ${Math.min(params.limit ?? 100, 500)}
  `);

  return result.rows.map((row) => ({
    id: String(row["id"]),
    txHash: String(row["tx_hash"]),
    token: String(row["token"]),
    recipient: String(row["recipient"]),
    domain: Number(row["domain"]),
    amount: money(toBigInt(row["amount"])),
    blockNumber: toBigInt(row["block_number"]).toString(),
    timestamp: Number(row["timestamp"]),
  }));
}
