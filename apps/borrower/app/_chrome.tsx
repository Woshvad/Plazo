/**
 * The borrower app's chrome.
 *
 * Every value is a design token. `tools/check-design-tokens.mjs` fails the build on a
 * literal colour, font or size, which is what keeps four surfaces from drifting into
 * four slightly different greens.
 */
import Link from "next/link";

export function Header({active}: {active: "plans" | "passport"}) {
  const tabs = [
    {key: "plans", label: "My plans", href: "/"},
    {key: "passport", label: "Passport", href: "/passport"},
  ] as const;

  return (
    <header className="sticky top-0 z-40 flex items-center gap-5 border-b-2 border-ink bg-paper px-6 py-2.5">
      <Link href="/" className="font-display text-[length:var(--text-2xl)] font-bold tracking-tight">
        PLAZO<span className="text-green">.</span>
      </Link>
      <nav className="flex gap-0.5">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            className="flex flex-col items-stretch gap-[3px] px-2.5 pt-2 pb-[5px] font-display text-[length:var(--text-md)] font-semibold"
          >
            {tab.label}
            {tab.key === active ? <span className="block h-[3px] bg-accent" /> : null}
          </Link>
        ))}
      </nav>
      <div className="ml-auto font-mono text-[length:var(--text-xs)] text-muted">
        on Arc — finality &lt;1s
      </div>
    </header>
  );
}

export function Shell({children}: {children: React.ReactNode}) {
  return <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>;
}

export function Card({
  title,
  children,
  tone = "plain",
}: {
  title?: string;
  children: React.ReactNode;
  tone?: "plain" | "attention";
}) {
  return (
    <section
      className={`mb-5 border-2 p-5 shadow-[var(--shadow-card)] ${
        tone === "attention" ? "border-danger bg-accent-wash" : "border-ink bg-white"
      }`}
    >
      {title ? (
        <h2 className="mb-3 font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

export function Row({label, value, note}: {label: string; value: string; note?: string}) {
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

const STATUS_TONE: Record<string, string> = {
  Cleared: "text-green",
  Pending: "text-muted",
  Bounced: "text-danger",
  Missed: "text-danger",
  Expired: "text-danger",
  Refunded: "text-muted",
};

export function Status({value}: {value: string}) {
  return (
    <span
      className={`font-mono text-[length:var(--text-xs)] tracking-caps uppercase ${
        STATUS_TONE[value] ?? "text-ink-soft"
      }`}
    >
      {value}
    </span>
  );
}

/**
 * Shown whenever the app is rendering the built-in sample rather than a live service.
 *
 * A demo that looks identical to production is how a screenshot ends up in a deck
 * describing a book that does not exist.
 */
export function SampleBanner() {
  return (
    <div className="mb-5 border-2 border-rule-strong bg-paper-raised px-4 py-2 font-mono text-[length:var(--text-xs)] text-muted">
      SAMPLE DATA — set PLAZO_SERVICING_URL to read a live book.
    </div>
  );
}
