import {ARC_TESTNET_CHAIN_ID, formatUsdc6, usdc6} from "@plazo/plan-core";

/**
 * The design system, rendered.
 *
 * Not a storybook and not decoration. Phase 1's criterion is that the comp's tokens
 * render from a single `@theme` inside a running app shell, and this is the thing
 * that has to be looked at to know they do. Every value on this page comes from a
 * token; `tools/check-design-tokens.mjs` fails the build if one does not.
 *
 * The four product surfaces are built from this chassis, not beside it.
 */

const NAV = ["Checkout", "My plans", "Merchant", "Yield"] as const;

function Header() {
  return (
    <header className="sticky top-0 z-40 flex items-center gap-5 border-b-2 border-ink bg-paper px-6 py-2.5">
      <div className="font-display text-[length:var(--text-2xl)] font-bold tracking-tight">
        PLAZO<span className="text-green">.</span>
      </div>
      <nav className="flex gap-0.5">
        {NAV.map((item, i) => (
          <span
            key={item}
            className="flex flex-col items-stretch gap-[3px] px-2.5 pt-2 pb-[5px] font-display text-[length:var(--text-md)] font-semibold"
          >
            {item}
            {i === 0 ? <span className="block h-[3px] bg-accent" /> : null}
          </span>
        ))}
      </nav>
      <div className="ml-auto font-mono text-[length:var(--text-xs)] text-muted">
        on Arc — finality &lt;1s
      </div>
    </header>
  );
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <section className="mb-12">
      <h2 className="mb-4 font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

const SWATCHES = [
  {name: "paper", className: "bg-paper", note: "surface"},
  {name: "paper-raised", className: "bg-paper-raised", note: "raised surface"},
  {name: "ink", className: "bg-ink", note: "text, borders"},
  {name: "ink-soft", className: "bg-ink-soft", note: "secondary text"},
  {name: "muted", className: "bg-muted", note: "labels, meta"},
  {name: "rule", className: "bg-rule", note: "hairlines"},
  {name: "green", className: "bg-green", note: "cleared, on-time"},
  {name: "danger", className: "bg-danger", note: "bounced, delinquent"},
  {name: "accent", className: "bg-accent", note: "focus, attention"},
] as const;

const SHADOWS = [
  {name: "raised", style: "shadow-[var(--shadow-raised)]"},
  {name: "card", style: "shadow-[var(--shadow-card)]"},
  {name: "float", style: "shadow-[var(--shadow-float)]"},
  {name: "hero", style: "shadow-[var(--shadow-hero)]"},
] as const;

/** A realistic Pay-in-4 strip at the confirmed $75 minimum ticket. */
const SCHEDULE = [
  {label: "Today", amount: usdc6(18_750_000n), status: "cleared"},
  {label: "In 2 weeks", amount: usdc6(18_750_000n), status: "scheduled"},
  {label: "In 4 weeks", amount: usdc6(18_750_000n), status: "scheduled"},
  {label: "In 6 weeks", amount: usdc6(18_750_000n), status: "scheduled"},
] as const;

export default function Page() {
  return (
    <div className="min-h-screen bg-paper pb-20">
      <Header />

      <main className="mx-auto max-w-4xl px-6 pt-10">
        <p className="mb-2 font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
          Design system · chain {ARC_TESTNET_CHAIN_ID}
        </p>
        <h1 className="mb-10 font-display text-[length:var(--text-5xl)] font-bold tracking-tight">
          Every surface is built from this.
        </h1>

        <Section title="Colour">
          <div className="grid grid-cols-3 gap-3">
            {SWATCHES.map((s) => (
              <div key={s.name} className="border-2 border-ink bg-white">
                <div className={`h-14 border-b-2 border-ink ${s.className}`} />
                <div className="p-2">
                  <div className="font-mono text-[length:var(--text-xs)]">{s.name}</div>
                  <div className="font-mono text-[length:var(--text-2xs)] text-muted">{s.note}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Type">
          <div className="space-y-3 border-2 border-ink bg-white p-5">
            <p className="font-display text-[length:var(--text-5xl)] font-bold tracking-tight">
              Space Grotesk — display
            </p>
            <p className="font-body text-[length:var(--text-base)]">
              Instrument Sans — body. A borrower signs once and the money moves on schedule
              without anyone ever holding their funds.
            </p>
            <p className="font-mono text-[length:var(--text-base)]">
              IBM Plex Mono — 0123456789 · every amount, date, address and plan id
            </p>
          </div>
        </Section>

        <Section title="Elevation">
          <div className="flex flex-wrap gap-6 pb-3">
            {SHADOWS.map((s) => (
              <div
                key={s.name}
                className={`flex h-20 w-32 items-center justify-center border-2 border-ink bg-white font-mono text-[length:var(--text-xs)] ${s.style}`}
              >
                {s.name}
              </div>
            ))}
          </div>
          <p className="font-mono text-[length:var(--text-2xs)] text-muted">
            Hard offsets, no blur. Depth is displacement, the way a print block sits on paper.
          </p>
        </Section>

        <Section title="A plan, in the system">
          <div className="border-2 border-ink bg-white shadow-[var(--shadow-card)]">
            <div className="flex items-baseline justify-between border-b-2 border-ink px-5 py-4">
              <div>
                <div className="font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase">
                  Pay in 4 · 0% on time
                </div>
                <div className="font-display text-[length:var(--text-4xl)] font-bold tracking-tight">
                  ${formatUsdc6(usdc6(75_000_000n))}
                </div>
              </div>
              <span className="rounded-pill border-2 border-green px-3 py-1 font-mono text-[length:var(--text-2xs)] tracking-caps text-green uppercase">
                Active
              </span>
            </div>

            <ul>
              {SCHEDULE.map((row, i) => (
                <li
                  key={row.label}
                  className={`flex items-center justify-between px-5 py-3 ${
                    i < SCHEDULE.length - 1 ? "border-b border-rule" : ""
                  }`}
                >
                  <span className="font-mono text-[length:var(--text-base)] text-ink-soft">
                    {row.label}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-mono text-[length:var(--text-base)]">
                      ${formatUsdc6(row.amount)}
                    </span>
                    <span
                      className={`font-mono text-[length:var(--text-2xs)] tracking-caps uppercase ${
                        row.status === "cleared" ? "text-green" : "text-muted"
                      }`}
                    >
                      {row.status}
                    </span>
                  </span>
                </li>
              ))}
            </ul>

            <div className="border-t-2 border-ink px-5 py-3 font-mono text-[length:var(--text-2xs)] text-muted">
              Funds stay in your wallet until each due date.
            </div>
          </div>
        </Section>

        <Section title="Actions">
          <div className="flex flex-wrap items-center gap-3">
            <button className="border-2 border-ink bg-accent px-5 py-2.5 font-display text-[length:var(--text-md)] font-semibold shadow-[var(--shadow-raised)]">
              Confirm and sign
            </button>
            <button className="border-2 border-ink bg-white px-5 py-2.5 font-display text-[length:var(--text-md)] font-semibold">
              Pay in full
            </button>
            <button className="border-2 border-danger bg-white px-5 py-2.5 font-display text-[length:var(--text-md)] font-semibold text-danger">
              Cancel plan
            </button>
          </div>
        </Section>
      </main>
    </div>
  );
}
