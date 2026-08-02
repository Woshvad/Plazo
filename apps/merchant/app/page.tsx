import {Escrow} from "./Escrow";
import {Payouts} from "./Payouts";
import {Refunds} from "./Refunds";
import {Settlements} from "./Settlements";
import {
  SOURCE_ENV,
  attestations,
  escrows,
  refunds,
  settlements,
  usd,
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

  const [attested, held, refundable] = await Promise.all([
    attestations(book.settlements.filter((s) => s.dispatchTxHash !== null).map((s) => s.planId)),
    escrows(),
    refunds(),
  ]);

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
            {label: "Held settlements", payload: held},
            {label: "Refund previews", payload: refundable},
          ]}
        />

        <div className="mb-6 grid grid-cols-3 gap-5">
          <Figure label="Gross" value={usd(gross)} note="what buyers were charged" />
          <Figure label="MDR" value={usd(mdr)} note="Plazo's fee on the same settlements" />
          <Figure label="Net settled" value={usd(net)} note="before withholding" />
        </div>

        <Settlements data={book} filter={filter} />
        <Payouts settlements={book} attestations={attested} />
        <Refunds data={refundable} planId={one("plan")} amount={one("amount")} />
        <Escrow data={held} />
      </main>
    </>
  );
}

/** Money is summed as `bigint`. A running total through `Number` is a rounding error. */
function sum(values: readonly string[]): string {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
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
