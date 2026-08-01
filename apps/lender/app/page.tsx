import {book, pct, price, queue, receivables, shortId, usd} from "./_data";

/**
 * The lender's screen. APP-04 and POOL-15.
 *
 * POOL-15 asks for per-receivable performance, buffer depth and the epoch fee schedule
 * *together*, and the word doing the work is "together". Each of the three is available
 * separately from a block explorer and each is useless on its own: buffer depth without
 * the queue does not say when you can leave, a fee schedule without the redemption
 * volume does not say whether it will apply to you, and receivable performance without
 * the provision does not say what the book has already admitted.
 *
 * Two things are shown that an LP dashboard usually hides.
 *
 * **The provision, per receivable, next to the loan it is held against.** A book that
 * reports only net NAV is a book asking to be trusted about the difference.
 *
 * **The liquidity fee, and the threshold that turns it on, before it turns on.** POOL-09
 * replaced a redemption gate with a uniform fee precisely because the *threat* of a gate
 * is what causes the run it is meant to survive. That argument only works if the terms
 * are visible in the calm — a fee discovered at the moment of redemption is a gate with
 * better manners.
 */
export const dynamic = "force-dynamic";

export default async function Yield() {
  const [state, loans, tickets] = await Promise.all([book(), receivables(), queue()]);

  const deployed = BigInt(state.buffer.deployed);
  const cash = BigInt(state.buffer.cash);
  const assets = BigInt(state.totalAssets);
  const bufferBps = assets === 0n ? 0 : Number(((cash + deployed) * 10_000n) / assets);

  return (
    <>
      <header className="sticky top-0 z-40 flex items-center gap-5 border-b-2 border-ink bg-paper px-6 py-2.5">
        <div className="font-display text-[length:var(--text-2xl)] font-bold tracking-tight">
          PLAZO<span className="text-green">.</span>
        </div>
        <nav className="flex gap-0.5">
          <span className="flex flex-col items-stretch gap-[3px] px-2.5 pt-2 pb-[5px] font-display text-[length:var(--text-md)] font-semibold">
            Yield
            <span className="block h-[3px] bg-accent" />
          </span>
        </nav>
        <div className="ml-auto font-mono text-[length:var(--text-xs)] text-muted">
          epoch {state.epoch} · {state.originationOpen ? "originating" : "closed to new credit"}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {state.live ? null : (
          <div className="mb-5 border-2 border-rule-strong bg-paper-raised px-4 py-2 font-mono text-[length:var(--text-xs)] text-muted">
            SAMPLE DATA — set PLAZO_INDEXER_URL to read a live book.
          </div>
        )}

        <div className="mb-6 grid grid-cols-3 gap-5">
          <Figure label="Book value" value={usd(state.totalAssets)} note={`epoch ${state.epoch} NAV`} />
          <Figure
            label="Senior"
            value={usd(state.senior.assets)}
            note={`${price(state.senior.nav)} per share · ${pct(state.seniorTargetApyBps)} target`}
          />
          <Figure
            label="Junior"
            value={usd(state.junior.assets)}
            note={`${price(state.junior.nav)} per share · residual`}
          />
        </div>

        <Panel title="What stands in front of you">
          <Row
            label="First-loss reserve"
            value={usd(state.reserve)}
            note={`${pct(state.reserveBps)} of the book`}
          />
          <Row
            label="Junior subordination"
            value={usd(state.junior.assets)}
            note={`${pct(state.subordinationBps)} — origination halts below ${pct(1000)}`}
          />
          <Row
            label="Provision already taken"
            value={usd(state.provisioned)}
            note="marked down against delinquent paper, released on cure"
          />
          <p className="mt-4 font-body text-[length:var(--text-xs)] text-muted">
            Losses take the reserve first, then junior, then senior. Every one is itemised in a{" "}
            <span className="font-mono">LossAbsorbed</span> event on chain, so the ordering is
            evidence rather than a sentence in a document.
          </p>
        </Panel>

        <Panel title="Getting out">
          <Row
            label="Cash on the book"
            value={usd(state.buffer.cash)}
            note={`${pct(bufferBps)} of assets — redemptions fill from here`}
          />
          <Row
            label="Earning in the savings venue"
            value={usd(state.buffer.deployed)}
            note={`floor is ${pct(state.buffer.floorBps)} kept liquid`}
          />
          <Row
            label="Liquidity fee this epoch"
            value={pct(state.liquidityFeeBps)}
            note={
              state.liquidityFeeBps === 0
                ? `switches on above ${pct(state.liquidityFeeThresholdBps)} net redemptions`
                : "charged to every redeemer filled this epoch, at the same rate"
            }
          />
          <p className="mt-4 font-body text-[length:var(--text-xs)] text-muted">
            There is no gate. Above the threshold every redeemer in the epoch pays the same fee
            and it stays in the tranche, so leaving first is worth nothing — which is the only
            arrangement under which a queue is not a race.
          </p>
        </Panel>

        <Panel title="Your redemption queue">
          {tickets.length === 0 ? (
            <p className="font-body text-[length:var(--text-sm)] text-muted">
              Nothing queued.
            </p>
          ) : (
            tickets.map((ticket) => (
              <Row
                key={`${ticket.tranche}-${ticket.index}`}
                label={`${ticket.tranche} — ticket ${ticket.index}`}
                value={
                  BigInt(ticket.ahead) === 0n
                    ? `${Math.round((Number(BigInt(ticket.filled)) / Number(BigInt(ticket.shares))) * 100)}% filled`
                    : `${usd(ticket.ahead, 2)} ahead of you`
                }
                note={new Date(ticket.requestedAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              />
            ))
          )}
        </Panel>

        <Panel title="Every receivable, and what the book thinks of it">
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-ink text-left">
                {["Plan", "Merchant", "Principal", "Outstanding", "State", "Provisioned"].map((h) => (
                  <th
                    key={h}
                    className="py-2 font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loans.map((loan) => (
                <tr key={loan.planId} className="border-b border-rule">
                  <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink">
                    {shortId(loan.planId)}
                  </td>
                  <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink-soft">
                    {shortId(loan.merchant)}
                  </td>
                  <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink">
                    {usd(loan.principal)}
                  </td>
                  <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink">
                    {usd(loan.outstanding)}
                  </td>
                  <td
                    className={`py-2 font-mono text-[length:var(--text-2xs)] tracking-caps uppercase ${
                      loan.state === "Delinquent" ? "text-danger" : "text-green"
                    }`}
                  >
                    {loan.state}
                    {loan.daysPastDue > 0 ? ` · ${loan.daysPastDue}d` : ""}
                  </td>
                  <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink">
                    {BigInt(loan.provisioned) === 0n ? "—" : usd(loan.provisioned)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <p className="mt-8 max-w-2xl font-body text-[length:var(--text-xs)] text-faint">
          Junior is first-loss and is expected to reach zero against a large enough loss. That
          is what it is for. Subordination is only worth what it says if the junior tranche is
          held independently of the parties originating the credit — in every comparable
          failure, it was not.
        </p>
      </main>
    </>
  );
}

function Figure({label, value, note}: {label: string; value: string; note: string}) {
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

function Panel({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <section className="mb-5 border-2 border-ink bg-white p-5 shadow-[var(--shadow-card)]">
      <h2 className="mb-3 font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({label, value, note}: {label: string; value: string; note?: string}) {
  return (
    <div className="flex items-baseline justify-between border-b border-rule py-2 last:border-b-0">
      <span className="font-body text-[length:var(--text-sm)] text-ink-soft">{label}</span>
      <span className="text-right">
        <span className="font-mono text-[length:var(--text-base)] text-ink">{value}</span>
        {note ? (
          <span className="ml-2 font-body text-[length:var(--text-xs)] text-faint">{note}</span>
        ) : null}
      </span>
    </div>
  );
}
