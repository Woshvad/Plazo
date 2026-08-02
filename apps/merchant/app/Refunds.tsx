import {
  day,
  previewFor,
  scheduleAfter,
  shortId,
  usd,
  type Installment,
  type RefundCandidate,
  type RefundPreview,
  type Refunds as RefundsPayload,
} from "./_data";

/**
 * MERCH-03's screen: what a refund will do, before it is done.
 *
 * **The whole point is that the effect is visible rather than inferred.** D9 suppresses
 * the schedule from the **end**, so a partial refund retires the last installments and
 * the borrower's *next* due date does not move. That is a surprising property and it is a
 * good one — a merchant refunding half an order does not want to have accidentally
 * rescheduled a payment their customer has already budgeted for. Nobody believes it from
 * a sentence, so the before and after schedules are rendered side by side and the reader
 * can see that rows 1 and 2 are byte-identical while row 3 is gone (T-06-12-07).
 *
 * **The four numbers are `RefundEscrow.refundPreview`'s, read and not recomputed.**
 * `appliedPrincipal`, `toBorrower`, `firstSuppressedIndex` and `mdrRebate` come from the
 * contract, which is itself a thin read of the plan's public state through D9's
 * arithmetic. Its own docstring argues for keeping it thin rather than clever, and
 * reimplementing the suppression walk in TypeScript would produce a fourth copy of it —
 * the one that drifts, because it is the one with no chain to disagree with.
 *
 * **Void is offered as its own action.** `voidAmountFor(planId)` returns the plan's
 * original principal, and passing it retires all outstanding principal, returns whatever
 * the borrower has already paid, suppresses the whole tail and lands the plan in
 * `Refunded`. That is a void arithmetically, with no new state and no borrower
 * transaction — so it is labelled as what it is, a full-value refund before fulfilment,
 * rather than hidden behind "refund the full amount".
 *
 * **Confirmation is disabled unless there is a preview.** A zero amount, or an amount
 * this deployment cannot preview, gives a disabled button and a reason. A merchant must
 * not be able to send a refund whose effect nobody showed them, which is the repudiation
 * this screen exists to close.
 */
export function Refunds({
  data,
  planId,
  amount,
}: {
  data: RefundsPayload;
  planId?: string | undefined;
  amount?: string | undefined;
}) {
  const selected =
    data.candidates.find((candidate) => candidate.planId === planId) ?? data.candidates[0];

  return (
    <section className="mb-5 border-2 border-ink bg-white p-5 shadow-[var(--shadow-card)]">
      <h2 className="mb-3 font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
        Refunds — what it does before you do it
      </h2>

      {selected === undefined ? (
        <p className="font-body text-[length:var(--text-sm)] text-muted">
          No plan on this book is refundable. `voidAmountFor` reverts on a plan that has
          already settled, and a plan that cannot be voided cannot be refunded — so a book of
          finished plans is an empty screen rather than a list of disabled buttons.
        </p>
      ) : (
        <Candidate candidate={selected} amount={amount} live={data.live} />
      )}
    </section>
  );
}

function Candidate({
  candidate,
  amount,
  live,
}: {
  candidate: RefundCandidate;
  amount: string | undefined;
  live: boolean;
}) {
  const chosen = amount ?? "";
  const preview = previewFor(candidate, chosen);
  const zero = chosen !== "" && /^\d+$/.test(chosen) && BigInt(chosen) === 0n;

  return (
    <div data-plan={candidate.planId}>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-rule pb-3 font-mono text-[length:var(--text-xs)]">
        <span className="font-semibold text-ink">{candidate.externalId ?? shortId(candidate.planId)}</span>
        <span className="text-ink-soft">principal {usd(candidate.principal)}</span>
        <span className="text-ink-soft">outstanding {usd(candidate.outstandingPrincipal)}</span>
      </div>

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <input type="hidden" name="plan" value={candidate.planId} />
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase">
            Refund amount (6-decimal USDC)
          </span>
          <input
            name="amount"
            inputMode="numeric"
            defaultValue={chosen}
            className="w-56 border-2 border-ink bg-paper px-2 py-1 font-mono text-[length:var(--text-xs)] text-ink"
          />
        </label>
        <button
          type="submit"
          className="border-2 border-ink bg-paper-raised px-3 py-1.5 font-display text-[length:var(--text-md)] font-semibold text-ink shadow-[var(--shadow-raised)]"
        >
          Preview
        </button>

        <button
          type="submit"
          name="amount"
          value={candidate.voidAmount}
          data-action="void"
          className="border-2 border-ink bg-paper-raised px-3 py-1.5 font-display text-[length:var(--text-md)] font-semibold text-ink shadow-[var(--shadow-raised)]"
        >
          Preview void — {usd(candidate.voidAmount)}
        </button>

        <span className="max-w-sm font-body text-[length:var(--text-2xs)] text-faint">
          A void is a full-value refund before fulfilment: it retires everything still owed
          and returns what the borrower has already paid.
        </span>
      </form>

      {preview === null ? (
        <NoPreview zero={zero} chosen={chosen} candidate={candidate} live={live} />
      ) : (
        <Preview candidate={candidate} preview={preview} />
      )}
    </div>
  );
}

/**
 * Why there is nothing to show, said precisely enough to act on.
 *
 * The three reasons are different and a merchant needs to be able to tell them apart. "You
 * typed nothing" is a prompt; "zero does nothing" is arithmetic; and "this deployment
 * cannot answer for that amount" is a **configuration** statement that used to say
 * `RefundEscrow` was undeployed and no longer can — 06-13 deployed it. On a live
 * deployment the only way to reach the third branch is an amount the chain was not asked
 * about, which happens when the read failed, so the copy says which of the two worlds the
 * reader is in.
 */
function NoPreview({
  zero,
  chosen,
  candidate,
  live,
}: {
  zero: boolean;
  chosen: string;
  candidate: RefundCandidate;
  live: boolean;
}) {
  const answerable = candidate.previews.map((p) => usd(p.amount)).join(", ");
  const reason = zero
    ? "A zero refund does nothing. There is nothing to preview and nothing to confirm."
    : chosen === ""
      ? "Enter an amount, or preview the void, to see what it would do."
      : live
        ? `RefundEscrow was not asked about ${usd(chosen)} for this plan on this page load. Previews are contract reads and this page requested ${answerable}. Submit the amount again to ask for it.`
        : `This deployment cannot preview ${usd(chosen)}. refundPreview is a contract read and no RefundEscrow address is configured here, so only the amounts the sample carries can be answered — ${answerable}.`;

  return (
    <div className="border-2 border-rule-strong bg-paper-raised p-3">
      <p className="max-w-3xl font-body text-[length:var(--text-xs)] text-muted">{reason}</p>
      <button
        type="button"
        disabled
        data-confirm="refund"
        className="mt-3 border-2 border-rule-strong bg-paper px-3 py-1.5 font-display text-[length:var(--text-md)] font-semibold text-faint"
      >
        Confirm refund
      </button>
    </div>
  );
}

function Preview({candidate, preview}: {candidate: RefundCandidate; preview: RefundPreview}) {
  const after = scheduleAfter(candidate.schedule, preview);

  return (
    <div className="border-2 border-rule-strong bg-paper-raised p-3">
      {preview.isVoid ? (
        <div
          data-void="true"
          className="mb-3 inline-block border-2 border-ink bg-accent px-2 py-0.5 font-display text-[length:var(--text-xs)] font-bold tracking-caps text-ink uppercase"
        >
          Void — full-value refund before fulfilment
        </div>
      ) : null}

      <dl className="mb-4 grid grid-cols-[14rem_1fr] gap-x-4 gap-y-1 font-mono text-[length:var(--text-xs)]">
        <Term label="Principal retired" />
        <dd className="text-ink">{usd(preview.appliedPrincipal)}</dd>

        <Term label="Returned to the borrower" />
        <dd className="text-ink">{usd(preview.toBorrower)}</dd>

        <Term label="First suppressed installment" />
        <dd className="text-ink">
          {preview.firstSuppressedIndex === null
            ? "none — this refund suppresses nothing"
            : `#${preview.firstSuppressedIndex + 1} onwards`}
        </dd>

        <Term label="MDR rebated to you" />
        <dd className="text-ink">{usd(preview.mdrRebate)}</dd>
      </dl>

      <p className="mb-3 max-w-3xl font-body text-[length:var(--text-xs)] text-muted">
        The rebate is apportioned against what is <em>still owed</em>, not against the original
        principal. Fee earned on principal the borrower actually repaid stays earned, because
        that part of the sale happened.
      </p>

      <div className="grid grid-cols-2 gap-5">
        <Schedule which="before" rows={candidate.schedule} />
        <Schedule which="after" rows={after} />
      </div>

      <p className="mt-3 max-w-3xl font-body text-[length:var(--text-xs)] text-muted">
        Suppression runs from the <strong>end</strong> of the schedule. Every due date before
        the first suppressed installment is unchanged, so your customer&rsquo;s next payment
        does not move.
      </p>

      <button
        type="button"
        data-confirm="refund"
        className="mt-3 border-2 border-ink bg-accent px-3 py-1.5 font-display text-[length:var(--text-md)] font-semibold text-ink shadow-[var(--shadow-raised)]"
      >
        Confirm refund of {usd(preview.amount)}
      </button>
    </div>
  );
}

function Term({label}: {label: string}) {
  return <dt className="tracking-caps text-muted uppercase">{label}</dt>;
}

function Schedule({which, rows}: {which: "before" | "after"; rows: readonly Installment[]}) {
  return (
    <div data-schedule={which}>
      <div className="border-b-2 border-ink pb-1 font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase">
        {which}
      </div>
      {rows.map((row) => (
        <div
          key={row.index}
          data-index={row.index}
          data-status={row.status}
          data-due={row.dueAt}
          className="flex items-baseline justify-between border-b border-rule py-1.5 last:border-b-0"
        >
          <span className="font-mono text-[length:var(--text-2xs)] text-ink-soft">
            #{row.index + 1} · {day(row.dueAt)}
          </span>
          <span
            className={`font-mono text-[length:var(--text-xs)] ${
              row.status === "suppressed" ? "text-faint line-through" : "text-ink"
            }`}
          >
            {usd(row.amount)}
          </span>
        </div>
      ))}
    </div>
  );
}
