/**
 * The attestation poller, and where it is allowed to learn that a burn happened.
 *
 * XCH-02. A cross-domain settlement leaves Arc as a CCTP v2 burn and arrives on the
 * destination only once Circle's attestation service has signed it. Something has to
 * notice each burn and go and ask.
 *
 * ## C10: Ponder is the trigger, never a Circle webhook
 *
 * Circle's Smart Contract Platform will happily deliver a webhook when a contract emits,
 * and it is tempting because it looks like less code. It is a single vendor on the
 * critical path of a credit system's settlement loop, and its failure mode is silence:
 * a missed delivery is not an error anyone sees, it is money that stopped moving, and
 * the operator finds out when the merchant asks. The indexer's `payoutDispatch` table
 * cannot miss a log, because it is derived from the chain — it can only lag, and a lag
 * is visible.
 *
 * So the provider below reads the indexer. There is no webhook path in this file, and a
 * grep gate says so.
 *
 * ## Why the provider is injected
 *
 * `pollDispatched` takes its dispatches rather than fetching them, so the loop can be
 * asserted without a network or a database, and so the read can be swapped without the
 * loop being rewritten. `noPendingDispatches` is the no-op default: a poller that is
 * wired up but not yet pointed anywhere does nothing rather than throwing at three in
 * the morning.
 *
 * ## Where the attestation state lives, and why not on the indexer's table
 *
 * `pendingDispatches` reports every burn from a cursor forward and takes no view on
 * which have already been attested. That is deliberate. An `attested` column on
 * `payoutDispatch` would put a vendor's answer in a chain-derived table, and the table
 * would stop being reproducible from the chain — the one property the whole storage
 * split exists to keep (OPS-08, D-17). The chain-derived schema is the authority on what
 * was dispatched; this poller is the authority on what it has since heard back.
 *
 * ## The transaction hash is the join, and there is no alternative
 *
 * DEC-31, finding 28: a CCTP v2 burn emits a **zero** nonce. The real `eventNonce` is
 * assigned by Iris at attestation, so at the moment the burn lands there is no on-chain
 * identifier for anything to key on. The join between Plazo's ledger and Circle's is the
 * transaction hash, and it is off-chain by construction rather than by omission.
 */

/**
 * One burn, as the indexer reports it.
 *
 * Money is a decimal string because JSON does not carry bigints, and because this record
 * arrives over HTTP from a service that formats at the leaf for that reason.
 */
export interface PendingDispatch {
  /** Block number and log index. Stable across replays; the poller's idempotency key. */
  readonly id: string;
  /** The burn. The only join to Circle's ledger. */
  readonly txHash: string;
  readonly token: string;
  readonly recipient: string;
  /** CCTP destination domain. Never 26 — settlement to Arc never leaves. */
  readonly domain: number;
  readonly amount: string;
  readonly blockNumber: string;
  readonly timestamp: number;
}

/** Where the poller gets its work. Injected so the loop is assertable. */
export type PendingDispatches = (params: {
  after?: bigint | undefined;
  limit?: number | undefined;
}) => Promise<readonly PendingDispatch[]>;

/**
 * The default. Does nothing, loudly enough to be found in a config, quietly enough to
 * not wake anybody.
 */
export const noPendingDispatches: PendingDispatches = async () => [];

/**
 * The real one: the indexer's own read of its own table.
 *
 * `PLAZO_INDEXER_URL` is the same variable the borrower and lender apps already use, so
 * an operator configures one indexer address and everything downstream of it follows.
 */
export function indexerPendingDispatches(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): PendingDispatches {
  const root = baseUrl.replace(/\/+$/, "");

  return async ({after, limit}) => {
    const url = new URL(`${root}/v1/payouts/dispatches`);
    if (after !== undefined) url.searchParams.set("after", after.toString());
    if (limit !== undefined) url.searchParams.set("limit", String(limit));

    const response = await fetchImpl(url, {headers: {accept: "application/json"}});
    if (!response.ok) {
      throw new Error(`indexer refused the dispatch read: ${response.status}`);
    }

    const body = (await response.json()) as {dispatches?: PendingDispatch[]};
    return body.dispatches ?? [];
  };
}

/** What the poller knows about attestations it has already completed. */
export interface AttestationRecord {
  readonly id: string;
  /** False while Iris has been asked and has not yet answered with a usable message. */
  readonly complete: boolean;
}

export interface PollDeps {
  /** Where the work comes from. Defaults to doing nothing. */
  readonly dispatches?: PendingDispatches;
  /** What the poller has already handled, by dispatch id. */
  readonly attestations: ReadonlyMap<string, AttestationRecord>;
  /** The block the poller last swept past. */
  readonly cursor?: bigint | undefined;
  readonly limit?: number | undefined;
}

export interface PollResult {
  /** Burns still owed an attestation, oldest first. */
  readonly outstanding: readonly PendingDispatch[];
  /** Where to resume. Unchanged when the sweep found nothing. */
  readonly cursor: bigint | undefined;
}

/**
 * One sweep.
 *
 * A dispatch is outstanding when the poller has no record of it **or** when the record
 * it has is incomplete — an attestation that was requested and never came back is
 * exactly the case that must be retried, and treating "we asked" as "it is done" is how
 * a settlement goes quiet forever.
 *
 * The cursor only advances past a prefix of fully-attested burns. Advancing past an
 * outstanding one would mean never seeing it again, so a single stuck attestation holds
 * the cursor rather than being silently abandoned — the sweep gets slower, which is
 * visible, instead of lossy, which is not.
 */
export async function pollDispatched(deps: PollDeps): Promise<PollResult> {
  const source = deps.dispatches ?? noPendingDispatches;
  const found = await source({after: deps.cursor, limit: deps.limit});

  const isDone = (dispatch: PendingDispatch): boolean =>
    deps.attestations.get(dispatch.id)?.complete === true;

  const outstanding = found.filter((dispatch) => !isDone(dispatch));

  let cursor = deps.cursor;
  for (const dispatch of found) {
    if (!isDone(dispatch)) break;
    cursor = BigInt(dispatch.blockNumber);
  }

  return {outstanding, cursor};
}
