import {
  PAYOUT_STATUSES,
  day,
  shortId,
  usd,
  type SettlementFilter,
  type Settlements as SettlementsPayload,
} from "./_data";

/**
 * MERCH-08's screen: reconciliation against the merchant's own ledger.
 *
 * **The merchant's order id leads every row.** Reconciliation starts from their books,
 * not from ours. A row that opens with `0x3a71c8e0…` is a row an accounts department has
 * to key backwards from, and a settlements export they cannot join to their orders is a
 * settlements export they will re-derive from their PSP statement instead. `externalId`
 * comes from `operator.merchant_external_ref`, joined on `planId` inside the indexer —
 * the only direction that cross-schema read is permitted to go (D-17, OPS-08).
 *
 * **The MDR is shown as arithmetic, not as four columns.** `gross − mdr − withheld = net`
 * is rendered as a line the merchant can read left to right and check, with the equality
 * actually evaluated over `bigint` and flagged when it does not hold. Four unrelated
 * columns invite the reader to assume the subtraction; a printed subtraction invites them
 * to verify it, and this is the one screen whose entire purpose is verification.
 *
 * Withholding is not a fee and is labelled so. It is the merchant's own money moved into
 * their own bond while they are unseasoned (DEC-09), and a merchant who reads it as a
 * second charge will conclude the MDR is triple what it is.
 *
 * **Filtering with no JavaScript.** A plain `GET` form: the filters are search parameters,
 * `page.tsx` passes them to the indexer, and a filtered view is a URL a merchant can
 * bookmark or paste into a ticket. There is no client bundle on this screen at all.
 */
export function Settlements({
  data,
  filter,
}: {
  data: SettlementsPayload;
  filter: SettlementFilter;
}) {
  return (
    <section className="mb-5 border-2 border-ink bg-white p-5 shadow-[var(--shadow-card)]">
      <h2 className="mb-3 font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
        Settlements — your order id first
      </h2>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3 border-b border-rule pb-4">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase">
            Status
          </span>
          <select
            name="status"
            defaultValue={filter.status ?? ""}
            className="border-2 border-ink bg-paper px-2 py-1 font-mono text-[length:var(--text-xs)] text-ink"
          >
            <option value="">any</option>
            {PAYOUT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase">
            From block
          </span>
          <input
            name="from"
            inputMode="numeric"
            defaultValue={filter.from ?? ""}
            className="w-36 border-2 border-ink bg-paper px-2 py-1 font-mono text-[length:var(--text-xs)] text-ink"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase">
            To block
          </span>
          <input
            name="to"
            inputMode="numeric"
            defaultValue={filter.to ?? ""}
            className="w-36 border-2 border-ink bg-paper px-2 py-1 font-mono text-[length:var(--text-xs)] text-ink"
          />
        </label>

        <button
          type="submit"
          className="border-2 border-ink bg-accent px-3 py-1.5 font-display text-[length:var(--text-md)] font-semibold text-ink shadow-[var(--shadow-raised)]"
        >
          Filter
        </button>
      </form>

      <table className="w-full">
        <thead>
          <tr className="border-b-2 border-ink text-left">
            {["Your order", "Plan", "Gross", "MDR", "Withheld", "Net", "Refunded", "Route", "Status"].map(
              (heading) => (
                <th
                  key={heading}
                  className="py-2 font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase"
                >
                  {heading}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {data.settlements.map((row) => {
            const balances =
              BigInt(row.gross) - BigInt(row.mdr) - BigInt(row.withheld) === BigInt(row.net);

            return (
              <tr key={row.planId} data-plan={row.planId} className="border-b border-rule align-top">
                <td className="py-2 font-mono text-[length:var(--text-xs)] font-semibold text-ink">
                  {row.externalId ?? <span className="text-faint">not filed</span>}
                </td>
                <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink-soft">
                  {shortId(row.planId)}
                  <div className="text-[length:var(--text-2xs)] text-faint">
                    block {row.blockNumber} · {day(row.timestamp)}
                  </div>
                  <div
                    data-arithmetic={balances ? "balances" : "broken"}
                    className={`text-[length:var(--text-2xs)] ${balances ? "text-muted" : "text-danger"}`}
                  >
                    {usd(row.gross)} − {usd(row.mdr)} − {usd(row.withheld)} ={" "}
                    {balances ? usd(row.net) : `${usd(row.net)} ✗ does not balance`}
                  </div>
                </td>
                <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink">{usd(row.gross)}</td>
                <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink">{usd(row.mdr)}</td>
                <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink-soft">
                  {BigInt(row.withheld) === 0n ? "—" : usd(row.withheld)}
                </td>
                <td className="py-2 font-mono text-[length:var(--text-xs)] font-semibold text-ink">
                  {usd(row.net)}
                </td>
                <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink-soft">
                  {BigInt(row.refundedAmount) === 0n ? "—" : usd(row.refundedAmount)}
                </td>
                <td className="py-2 font-mono text-[length:var(--text-2xs)] text-ink-soft">
                  {row.payoutDomain === null ? "—" : `domain ${row.payoutDomain}`}
                </td>
                <td
                  className={`py-2 font-mono text-[length:var(--text-2xs)] tracking-caps uppercase ${
                    row.payoutStatus === "returned" ? "text-danger" : "text-green"
                  }`}
                >
                  {row.payoutStatus}
                  {row.escrowState === null ? "" : ` · ${row.escrowState}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="mt-4 max-w-3xl font-body text-[length:var(--text-xs)] text-muted">
        <span className="font-mono">Withheld</span> is not a fee. It is your own settlement
        diverted into your own bond while you are unseasoned, and it comes back — the{" "}
        <span className="font-mono">Treasury</span> section below shows how much of your bond
        arrived that way and how much of it is now free to withdraw.
      </p>
    </section>
  );
}
