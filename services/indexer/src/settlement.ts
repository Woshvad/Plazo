/**
 * What the settlement plane *means*, kept separate from where it is registered.
 *
 * `payout.ts` imports `ponder:registry` — a virtual module that exists only inside
 * Ponder's own runtime — so anything in that file is unreachable from a test process.
 * The decisions below are the ones worth cornering, so they live here instead, in a
 * module a test can simply import.
 *
 * This is not a layering flourish. The queued → dispatched transition is not expressible
 * as a primary-key update, because a dispatch names a **route** and never a plan
 * (DEC-36): the whole semantics is a predicate over rows, and a predicate that cannot be
 * called outside a running indexer is a predicate nobody has checked. Keeping it here
 * means the version under test is the version that ships, rather than a SQL string
 * restated in a fixture.
 */

/** Arc's own CCTP domain. Settlement to 26 never left the chain. */
export const ARC_DOMAIN = 26;

/** The address that means "not known yet", for a route an escrow has not announced. */
export const ZERO_ADDRESS = `0x${"00".repeat(20)}` as const;

/**
 * Where a settlement has got to.
 *
 * `settled` and `returned` are terminal. `queued` and `escrowed` are waiting on
 * something a stranger can crank — a `dispatch()` or a release timer — and `dispatched`
 * is waiting only on Circle.
 */
export type PayoutStatus = "settled" | "queued" | "dispatched" | "escrowed" | "returned";

/** What the adapter did, as recorded on the route ledger. */
export type DispatchKind = "paid" | "queued" | "dispatched";

/** A payout route, as the adapter names one. Three keys, and DEC-36 says why. */
export interface Route {
  token: string;
  recipient: string;
  domain: number;
}

/** An append-only log's identity: the block it landed in and its place within it. */
export const eventId = (event: {block: {number: bigint}; log: {logIndex: number}}): string =>
  `${event.block.number}-${event.log.logIndex}`;

/** Origination cohort as `YYYY-MM`, for loss calibration. */
export const cohortOf = (timestamp: number): string => {
  const date = new Date(timestamp * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

/**
 * What actually left the pool for the merchant.
 *
 * `CheckoutRouter._settleMerchant` hands the adapter `ctx.net - ctx.withholding`, and
 * `ctx.net` is `principal - mdr` (`CheckoutRouter.sol:268`, `:380`). No event carries
 * the figure, so the row restates the arithmetic — which is what keeps it checkable
 * against the chain rather than merely consistent with itself.
 */
export const netOf = (principal: bigint, mdr: bigint, withheld: bigint): bigint =>
  principal - mdr - withheld;

/** The status an origination-time settlement lands in, given what the adapter did. */
export function statusFromDispatch(kind: DispatchKind): PayoutStatus {
  return kind === "paid" ? "settled" : kind === "queued" ? "queued" : "dispatched";
}

/**
 * Whether one `dispatch()` closes out a given settlement row.
 *
 * Only `queued` rows move. A `settled` row never went through the queue, an `escrowed`
 * row has not reached the adapter yet, and a `returned` row is over — reopening any of
 * them because a later, unrelated dispatch happened to share a route would be a
 * reconciliation that reports money as in flight after it has gone home.
 *
 * All three components of the route must match. DEC-36 made the queue three-keyed
 * precisely because `dispatch()` is permissionless and a two-key queue would let a
 * stranger choose which chain a merchant's settlement landed on; an indexer that closed
 * out on two of the three would report that confusion as fact.
 */
export function dispatchClosesOut(
  row: {status: string; token: string; recipient: string | null; domain: number | null},
  route: Route,
): boolean {
  return (
    row.status === "queued" &&
    row.token.toLowerCase() === route.token.toLowerCase() &&
    (row.recipient ?? "").toLowerCase() === route.recipient.toLowerCase() &&
    row.domain === route.domain
  );
}

/**
 * The plans one `dispatch()` closes out, out of the open rows it was given.
 *
 * The sweep is deliberately two-stage. The SQL narrows to `status = 'queued'` so
 * Postgres uses the index; this decides. Restating the status filter in both places is
 * duplication on purpose — the SQL is an optimisation and this is the meaning, and if
 * they ever disagree the predicate is the one that is right.
 */
export function planIdsClosedOutBy<
  Row extends {
    planId: string;
    status: string;
    token: string;
    recipient: string | null;
    domain: number | null;
  },
>(rows: readonly Row[], route: Route): string[] {
  return rows.filter((row) => dispatchClosesOut(row, route)).map((row) => row.planId);
}

/**
 * The adapter log that settled a given origination, out of the logs in its transaction.
 *
 * Returns the newest adapter log that is **below** the origination's own log index and
 * moved **exactly** the payable amount.
 *
 * Both conditions matter. The log-index bound is `CheckoutRouter`'s ordering guarantee
 * written down as a filter: `_settleMerchant` runs before `emit OriginationCompleted`
 * (`CheckoutRouter.sol:226` then `:229`), so the adapter's log is always the lower one.
 * The amount is what keeps a transaction that originated two plans from handing the
 * first plan the second plan's route — a merchant's money reported as going to another
 * merchant's address, which is the worst thing this table could say.
 */
export function settlementLogFor<Row extends {logIndex: number; amount: bigint}>(
  rows: readonly Row[],
  origination: {logIndex: number; payable: bigint},
): Row | undefined {
  return rows
    .filter((row) => row.logIndex < origination.logIndex && row.amount === origination.payable)
    .sort((a, b) => a.logIndex - b.logIndex)
    .at(-1);
}

/** The shape every adapter event shares. */
export interface AdapterEvent {
  args: {token: `0x${string}`; recipient: `0x${string}`; domain: number; amount: bigint};
  block: {number: bigint; timestamp: bigint};
  log: {logIndex: number};
  transaction: {hash: `0x${string}`};
}

/**
 * One row per adapter event, and the same row shape for all three.
 *
 * Written with `.onConflictDoNothing()` at the call site, because a log is an immutable
 * fact: the id is block number and log index, and a replay of the same block must be a
 * no-op rather than a rewrite.
 */
export function dispatchRow(kind: DispatchKind, event: AdapterEvent) {
  return {
    id: eventId(event),
    kind,
    token: event.args.token,
    recipient: event.args.recipient,
    domain: event.args.domain,
    amount: event.args.amount,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: Number(event.block.timestamp),
  };
}
