import {Developers, takeCreatedKey} from "./Developers";
import {Escrow} from "./Escrow";
import {Payouts} from "./Payouts";
import {Refunds} from "./Refunds";
import {Settlements} from "./Settlements";
import {Treasury} from "./Treasury";
import {
  SOURCE_ENV,
  attestations,
  deliveries,
  deliveryDetail,
  endpoints,
  escrows,
  keys,
  refunds,
  settlements,
  treasury,
  usd,
  type Delivery,
  type Sourced,
} from "./_data";

/**
 * The merchant dashboard. APP-03, and MERCH-08's screen.
 *
 * Six sections on one surface, because the questions a merchant actually asks are not
 * separable: "did I get paid", "what did it cost", "where did it go", "what happens if I
 * refund this", "why is this one held", and "why did my webhook stop". A dashboard that
 * puts those behind six routes makes the merchant hold the join in their head.
 *
 * **The banner names which source is sampled, not merely that something is.** A dashboard
 * reading three services can be live on one and sampled on two, and a single
 * "SAMPLE DATA" stripe over a page where the settlements are real would be worse than no
 * stripe at all — it would train the reader to ignore it. So the banner enumerates.
 *
 * It is rendered unconditionally on `!live`, is not dismissible, and there is no
 * configuration that removes it while any payload is a sample.
 */
export const dynamic = "force-dynamic";

export default async function Merchant({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string): string | undefined => {
    const raw = params[key];
    return Array.isArray(raw) ? raw[0] : raw;
  };

  const filter = {status: one("status"), from: one("from"), to: one("to")};
  const book = await settlements(filter);

  /**
   * The chain reads are keyed by the plans this book already names.
   *
   * There is no enumeration on any of these contracts and there should not be — a mapping
   * keyed by `planId` is the right shape for a ledger and the wrong shape for a list. The
   * settlements payload is the list, so the escrow rows are looked up for the plans it says
   * are escrowed and the refund candidates for the plans that are not already terminal.
   * A sampled settlements payload therefore samples these too, which is correct: they are
   * derived from it.
   */
  const escrowed = book.settlements
    .filter((s) => s.escrowState !== null || s.payoutStatus === "escrowed")
    .map((s) => s.planId);
  const refundablePlans = book.settlements
    .filter((s) => s.payoutStatus !== "returned")
    .map((s) => s.planId);

  const [attested, held, refundable, log, issued, destinations, book2] = await Promise.all([
    attestations(book.settlements.filter((s) => s.dispatchTxHash !== null).map((s) => s.planId)),
    escrows(escrowed),
    refunds(refundablePlans, one("amount")),
    deliveries(),
    keys(),
    endpoints(),
    treasury(),
  ]);

  /**
   * The merchant's own order id, joined back on.
   *
   * `externalId` lives in `merchant_external_ref` on the operator side and never on chain,
   * so a contract read cannot carry it — it comes back `null` and is joined here from the
   * settlements payload, which is the one source that has both. MERCH-08 says reconciliation
   * starts from the merchant's books, and an escrow row a merchant cannot tie to an order is
   * a row they cannot act on.
   */
  const externalIds = new Map(book.settlements.map((s) => [s.planId, s.externalId]));
  const withRefs = {
    escrows: {
      ...held,
      escrows: held.escrows.map((row) => ({...row, externalId: row.externalId ?? externalIds.get(row.planId) ?? null})),
    },
    refunds: {
      ...refundable,
      candidates: refundable.candidates.map((c) => ({
        ...c,
        externalId: c.externalId ?? externalIds.get(c.planId) ?? null,
      })),
    },
  };

  // Consumed here and nowhere else. `takeCreatedKey` deletes as it reads, so a refresh
  // shows nothing — which is what "the secret is shown exactly once" has to mean if it is
  // going to be true rather than merely stated.
  const created = takeCreatedKey(one("created"));
  const deliveryFilter = {event: one("event"), status: one("deliveryStatus")};
  const shown = {...log, deliveries: filterDeliveries(log.deliveries, deliveryFilter)};
  const openedId = one("delivery");
  const opened = openedId === undefined ? null : await deliveryDetail(openedId);

  const gross = sum(book.settlements.map((s) => s.gross));
  const mdr = sum(book.settlements.map((s) => s.mdr));
  const net = sum(book.settlements.map((s) => s.net));

  return (
    <>
      <header className="sticky top-0 z-40 flex items-center gap-5 border-b-2 border-ink bg-paper px-6 py-2.5">
        <div className="font-display text-[length:var(--text-2xl)] font-bold tracking-tight">
          PLAZO<span className="text-green">.</span>
        </div>
        <nav className="flex gap-0.5">
          <span className="flex flex-col items-stretch gap-[3px] px-2.5 pt-2 pb-[5px] font-display text-[length:var(--text-md)] font-semibold">
            Merchant
            <span className="block h-[3px] bg-accent" />
          </span>
        </nav>
        <div className="ml-auto font-mono text-[length:var(--text-xs)] text-muted">
          {book.settlements.length} settlement{book.settlements.length === 1 ? "" : "s"}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <SampleBanner
          payloads={[
            {label: "Settlements", payload: book},
            {label: "Payout attestations", payload: attested},
            {label: "Held settlements", payload: withRefs.escrows},
            {label: "Refund previews", payload: withRefs.refunds},
            {label: "Webhook deliveries", payload: log},
            {label: "Webhook destinations", payload: destinations},
            {label: "API keys", payload: issued},
            {label: "Treasury", payload: book2},
          ]}
        />

        <div className="mb-6 grid grid-cols-3 gap-5">
          <Figure label="Gross" value={usd(gross)} note="what buyers were charged" />
          <Figure label="MDR" value={usd(mdr)} note="Plazo's fee on the same settlements" />
          <Figure label="Net settled" value={usd(net)} note="before withholding" />
        </div>

        <Settlements data={book} filter={filter} />
        <Payouts settlements={book} attestations={attested} />
        <Refunds data={withRefs.refunds} planId={one("plan")} amount={one("amount")} />
        <Escrow data={withRefs.escrows} />
        <Treasury data={book2} />
        <Developers
          keys={issued}
          endpoints={destinations}
          deliveries={shown}
          created={created}
          opened={opened}
          replayedWebhookId={one("replayed")}
          filter={deliveryFilter}
        />
      </main>
    </>
  );
}

/** Money is summed as `bigint`. A running total through `Number` is a rounding error. */
function sum(values: readonly string[]): string {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
}

/**
 * The delivery-log filters, applied here rather than in the operator API.
 *
 * `GET /v1/webhooks/deliveries` takes a limit and nothing else. Filtering the fetched page
 * client-side of that route is a smaller lie than a query parameter the API silently
 * ignores: the merchant sees the rows the filter matched *within what was fetched*, and a
 * filter that appeared to search the whole log while searching one page would be worse.
 */
function filterDeliveries(
  rows: readonly Delivery[],
  filter: {event?: string | undefined; status?: string | undefined},
): Delivery[] {
  return rows.filter((row) => {
    if (filter.event !== undefined && filter.event !== "" && row.event !== filter.event) return false;
    switch (filter.status) {
      case "ok":
        return row.responseStatus !== null && row.responseStatus < 300;
      case "failed":
        return row.responseStatus !== null && row.responseStatus >= 300;
      case "never-sent":
        return row.responseStatus === null;
      default:
        return true;
    }
  });
}

export function Figure({label, value, note}: {label: string; value: string; note: string}) {
  return (
    <div className="border-2 border-ink bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
        {label}
      </div>
      <div className="font-display text-[length:var(--text-4xl)] leading-tight font-bold text-ink">
        {value}
      </div>
      <div className="font-body text-[length:var(--text-xs)] text-faint">{note}</div>
    </div>
  );
}

/**
 * The unconditional banner.
 *
 * One row per sampled payload, each naming the thing that is sampled and the reason. A
 * reader who sees three rows knows exactly how much of the page is real, which is the
 * only version of this warning that survives being seen every day.
 */
export function SampleBanner({payloads}: {payloads: {label: string; payload: Sourced}[]}) {
  const sampled = payloads.filter(({payload}) => !payload.live);
  if (sampled.length === 0) return null;

  return (
    <div className="mb-5 border-2 border-rule-strong bg-paper-raised px-4 py-3">
      <div className="font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
        Sample data — not this merchant&rsquo;s book
      </div>
      <ul className="mt-1.5">
        {sampled.map(({label, payload}) => (
          <li key={label} className="font-mono text-[length:var(--text-xs)] text-muted">
            {label} — {payload.sampled}
            {SOURCE_ENV[payload.source] === null ? "" : ` (${payload.source})`}
          </li>
        ))}
      </ul>
    </div>
  );
}
