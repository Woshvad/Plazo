/**
 * The operator console. OPS-07 and NOTIF-04.
 *
 * Two audiences on one chassis. Support looks up a plan, waives a fee and resends a
 * notice; risk moves a parameter and trips a pause. Both need the same two things — a
 * check that they are allowed, and a record that they did it — and both are served by
 * `services/servicing`, which refuses an action without a capability and refuses one
 * without a reason.
 *
 * Three things are deliberately absent from this screen, and their absence is the design.
 *
 * **There is no button that touches a live plan.** No collect, no mark, no pause on
 * repayment, no edit to a schedule. A plan copies its terms in at initialisation and
 * never reads a registry again, precisely so nothing can re-price a deal the borrower
 * signed — and a console that could reach into one would be exactly that, pointed the
 * friendly way. The fee waiver settles by *paying* the plan, not by editing it.
 *
 * **There is no "clear pause" for most roles.** Stopping is an emergency and anyone
 * senior enough to notice should be able to do it; starting again is a decision. The
 * onchain `OriginationPause` enforces the asymmetry regardless of what this screen shows.
 *
 * **There is nothing an operator can do that does not appear in the audit log**, and the
 * log's own integrity check is on the screen next to it. Serving `verify()` alongside
 * the entries is the difference between a log and evidence: a reader does not have to
 * trust that nothing was removed, they can watch the hash chain hold.
 */
export const dynamic = "force-dynamic";

const CAPABILITIES = [
  {role: "support", items: ["plan.read", "plan.note", "notice.resend", "fee.waive", "audit.read"]},
  {role: "risk", items: ["plan.read", "killswitch.read", "parameter.set", "pause.trip", "audit.read"]},
  {role: "admin", items: ["everything above", "pause.clear"]},
  {role: "readonly", items: ["plan.read", "killswitch.read", "audit.read"]},
] as const;

const SAMPLE_AUDIT = [
  {
    seq: 2,
    at: "2026-08-01T09:14:22Z",
    operator: "rae",
    capability: "parameter.set",
    subject: "plazo.pool.liquidityFeeThresholdBps",
    reason: "cohort redemption data since epoch 9 supports a tighter threshold",
  },
  {
    seq: 1,
    at: "2026-07-31T16:02:11Z",
    operator: "sam",
    capability: "fee.waive",
    subject: "0x8f2c19a4…8e77",
    reason: "borrower's bank held the transfer for two days; first miss on a clean record",
  },
  {
    seq: 0,
    at: "2026-07-31T11:47:03Z",
    operator: "sam",
    capability: "notice.resend",
    subject: "0x3a71c8e0…09dd",
    reason: "delivery log shows three bounces to the address on file",
  },
] as const;

export default function Console() {
  return (
    <>
      <header className="sticky top-0 z-40 flex items-center gap-5 border-b-2 border-ink bg-paper px-6 py-2.5">
        <div className="font-display text-[length:var(--text-2xl)] font-bold tracking-tight">
          PLAZO<span className="text-green">.</span>
        </div>
        <nav className="flex gap-0.5">
          <span className="flex flex-col items-stretch gap-[3px] px-2.5 pt-2 pb-[5px] font-display text-[length:var(--text-md)] font-semibold">
            Operations
            <span className="block h-[3px] bg-accent" />
          </span>
        </nav>
        <div className="ml-auto font-mono text-[length:var(--text-xs)] text-muted">
          signed in as sam · support
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-5 border-2 border-rule-strong bg-paper-raised px-4 py-2 font-mono text-[length:var(--text-xs)] text-muted">
          SAMPLE DATA — set PLAZO_SERVICING_URL to reach a live console.
        </div>

        <Panel title="Find a plan">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="plan id, borrower address or merchant"
              className="flex-1 border-2 border-ink bg-white px-3 py-2 font-mono text-[length:var(--text-sm)] text-ink placeholder:text-faint"
            />
            <button
              type="button"
              className="border-2 border-ink bg-white px-4 py-2 font-display text-[length:var(--text-md)] font-semibold text-ink shadow-[var(--shadow-raised)]"
            >
              Look up
            </button>
          </div>
          <p className="mt-3 font-body text-[length:var(--text-xs)] text-muted">
            A plan view shows its schedule, every collection attempt with its typed bounce
            reason, and the gap between the reminders that should have gone out and the ones
            the delivery log says did. That gap is the operator&rsquo;s own failure, surfaced
            without anyone having to ask for it.
          </p>
        </Panel>

        <div className="grid grid-cols-2 gap-5">
          <Panel title="What each role may do">
            {CAPABILITIES.map((row) => (
              <div key={row.role} className="border-b border-rule py-2 last:border-b-0">
                <div className="font-mono text-[length:var(--text-xs)] tracking-caps text-ink uppercase">
                  {row.role}
                </div>
                <div className="font-body text-[length:var(--text-xs)] text-muted">
                  {row.items.join(" · ")}
                </div>
              </div>
            ))}
            <p className="mt-3 font-body text-[length:var(--text-xs)] text-muted">
              A grid rather than a hierarchy. An admin does not inherit support&rsquo;s
              capabilities and support does not inherit risk&rsquo;s — a role graph you have to
              reason about is one nobody audits.
            </p>
          </Panel>

          <Panel title="Waive a fee">
            <p className="mb-3 font-body text-[length:var(--text-sm)] text-ink-soft">
              A waiver is a credit Plazo owes, settled by paying the plan on the
              borrower&rsquo;s behalf. It does not edit the plan, because governance able to
              lower a fee is governance able to raise one.
            </p>
            <input
              type="text"
              placeholder="reason — this is the record"
              className="mb-2 w-full border-2 border-ink bg-white px-3 py-2 font-body text-[length:var(--text-sm)] text-ink placeholder:text-faint"
            />
            <button
              type="button"
              className="w-full border-2 border-ink bg-accent px-4 py-2 font-display text-[length:var(--text-md)] font-semibold text-ink shadow-[var(--shadow-raised)]"
            >
              Waive and record
            </button>
            <p className="mt-3 font-body text-[length:var(--text-xs)] text-muted">
              &ldquo;Waived the late fee&rdquo; tells a regulator nothing. The reason field is
              mandatory at the type level, which is the only way it gets filled in.
            </p>
          </Panel>
        </div>

        <Panel title="Audit log">
          <div className="mb-3 flex items-baseline justify-between border-b-2 border-ink pb-2">
            <span className="font-mono text-[length:var(--text-xs)] text-green">
              chain verified — 3 entries, no gaps
            </span>
            <span className="font-mono text-[length:var(--text-2xs)] text-faint">
              head 0x7c1f…a20b
            </span>
          </div>
          {SAMPLE_AUDIT.map((entry) => (
            <div key={entry.seq} className="border-b border-rule py-3 last:border-b-0">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[length:var(--text-xs)] tracking-caps text-ink uppercase">
                  {entry.capability}
                </span>
                <span className="font-mono text-[length:var(--text-2xs)] text-faint">
                  #{entry.seq} · {entry.operator} ·{" "}
                  {new Date(entry.at).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              <div className="font-mono text-[length:var(--text-xs)] text-ink-soft">
                {entry.subject}
              </div>
              <div className="font-body text-[length:var(--text-sm)] text-ink">{entry.reason}</div>
            </div>
          ))}
          <p className="mt-3 font-body text-[length:var(--text-xs)] text-muted">
            Every entry commits to the one before it. Removing or altering any of them breaks
            every hash after it, and the check above says which sequence number the story stops
            adding up at — so the question is not whether to trust the operator.
          </p>
        </Panel>
      </main>
    </>
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
