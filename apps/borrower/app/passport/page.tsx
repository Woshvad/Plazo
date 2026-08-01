import {Card, Header, Row, SampleBanner, Shell} from "../_chrome";
import {standing, usd, when} from "../_data";

/**
 * The Passport screen. PASS-02, PASS-03, PASS-07, UW-08.
 *
 * The requirement everything here answers to is UW-08: a borrower can see exactly which
 * events produced their current limit. The honest form of that answer is not a
 * paragraph and not a score — it is the sequence of caps in the order the chain applies
 * them, with the number after each one. Whichever step the final figure came from is the
 * reason they were declined, and it is right there.
 *
 * What is deliberately absent is a score out of a thousand. There is no model in the base
 * layer (PASS-06): the tier is a pure function of two integers, published in
 * `packages/passport` and asserted against the contract across a corpus. A borrower can
 * recompute it. That is worth more than a number that looks precise.
 */
export const dynamic = "force-dynamic";

const TIER_NOTE: Record<string, string> = {
  Unknown: "No record yet. Your first plan starts one.",
  Building: "Building. Each plan you complete cleanly raises your limit by a quarter.",
  Established: "Established. Several plans completed without a missed payment.",
  Trusted: "Trusted. A long clean record.",
  Impaired: "Impaired. Two or more missed payments inside the last two years.",
};

export default async function Passport() {
  const data = await standing();

  return (
    <>
      <Header active="passport" />
      <Shell>
        {data.live ? null : <SampleBanner />}

        <div className="mb-6">
          <div className="font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
            Your standing
          </div>
          <div className="font-display text-[length:var(--text-5xl)] leading-none font-bold text-ink">
            {data.tier}
          </div>
          <p className="mt-2 max-w-lg font-body text-[length:var(--text-sm)] text-ink-soft">
            {TIER_NOTE[data.tier] ?? ""}
          </p>
        </div>

        <Card title="What produced your limit">
          <p className="mb-4 font-body text-[length:var(--text-sm)] text-ink-soft">
            Your limit is the smallest of these. The last line is the one that bound.
          </p>
          {data.steps.map((step, i) => (
            <Row
              key={`${step.kind}-${i}`}
              label={step.label}
              value={usd(step.limit)}
              {...(i === data.steps.length - 1 ? {note: "← this one"} : {})}
            />
          ))}
          <div className="mt-4 border-t-2 border-ink pt-3">
            <Row label="Available to spend" value={usd(data.limit)} />
          </div>
        </Card>

        <Card title="The record behind it">
          <Row label="Plans completed cleanly" value={String(data.completions)} />
          <Row
            label="Missed payments still counting"
            value={String(data.activeNegatives)}
            note="marks stop counting after 24 months"
          />
          <Row
            label="Missed payments ever"
            value={String(data.negativesEver)}
            note="kept, but not counted against you forever"
          />
          <p className="mt-4 font-body text-[length:var(--text-xs)] text-muted">
            Nothing else about you is on the chain. Your identity, your income and anything a
            partner has verified live in Plazo&rsquo;s private records; the chain holds only a
            hash of them, and you can recompute it yourself with the open-source{" "}
            <span className="font-mono">@plazo/passport</span> library to check we have not
            changed it.
          </p>
        </Card>

        <Card title="Who can see more than your tier">
          {data.consents.length === 0 ? (
            <p className="font-body text-[length:var(--text-sm)] text-muted">
              Nobody. Anyone who wants more than the single word above has to ask you to sign
              for it, and you can withdraw that at any time.
            </p>
          ) : (
            data.consents.map((consent) => (
              <Row
                key={`${consent.reader}-${consent.schemaId}`}
                label={consent.reader}
                value={`until ${when(consent.validUntil)}`}
                note="revoke"
              />
            ))
          )}
        </Card>

        <Card title="If something here is wrong">
          <p className="mb-3 font-body text-[length:var(--text-sm)] text-ink-soft">
            You can dispute any part of this record. The request goes on the chain as your own
            transaction, so it exists whether or not anyone acts on it — and if a correction
            removes something, the old record stops being readable by anyone, including us.
          </p>
          <button
            type="button"
            className="border-2 border-ink bg-white px-4 py-2 font-display text-[length:var(--text-md)] font-semibold text-ink shadow-[var(--shadow-raised)]"
          >
            Dispute this record
          </button>
        </Card>
      </Shell>
    </>
  );
}
