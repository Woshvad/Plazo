/**
 * Where the borrower app gets its numbers.
 *
 * One function, one env var. `PLAZO_SERVICING_URL` points at `services/servicing`;
 * unset, the app renders a built-in sample and says so on every screen.
 *
 * The sample is not a mock in the usual sense — it is the exact shape the API returns,
 * so a screen that renders correctly against it renders correctly against the service.
 * What it is *not* allowed to be is invisible: `live: false` reaches the UI and the
 * banner is unconditional, because a demo indistinguishable from production is how a
 * screenshot ends up in a deck describing a book that does not exist.
 */

export interface Summary {
  live: boolean;
  balance: {collectable: string; elsewhere: string; at: string};
  plans: {planId: string; state: string; outstanding: string; nextDueAt: string | null}[];
  upcoming: {planId: string; index: number; amount: string; dueAt: string}[];
  attention: boolean;
  topUp: {amount: string; by: string; source: "gateway" | "external"; covers: number} | null;
}

export interface Standing {
  live: boolean;
  tier: string;
  completions: number;
  activeNegatives: number;
  negativesEver: number;
  limit: string;
  steps: {kind: string; label: string; limit: string}[];
  consents: {reader: string; schemaId: string; validUntil: string}[];
}

const BASE = process.env["PLAZO_SERVICING_URL"];

async function get<T>(path: string, borrower: string, fallback: T): Promise<T> {
  if (!BASE) return fallback;

  const response = await fetch(`${BASE}${path}`, {
    headers: {"x-plazo-borrower": borrower},
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return {...(await response.json()), live: true} as T;
}

/**
 * The signed-in borrower.
 *
 * A header today, a session in Phase 6. It is an env var rather than a hardcoded
 * address so a local run can point at a real wallet without an edit.
 */
export const BORROWER =
  process.env["PLAZO_BORROWER"] ?? "0x00000000000000000000000000000000000b0110";

const now = Date.UTC(2026, 7, 1, 12, 0, 0);
const day = 24 * 60 * 60 * 1000;

const SAMPLE_SUMMARY: Summary = {
  live: false,
  balance: {
    collectable: "31500000",
    elsewhere: "120000000",
    at: new Date(now).toISOString(),
  },
  plans: [
    {
      planId: "0x8f2c19a4b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873a5e1c0b64f2a9d38e77",
      state: "Active",
      outstanding: "50000000",
      nextDueAt: new Date(now + 2 * day).toISOString(),
    },
  ],
  upcoming: [
    {
      planId: "0x8f2c19a4b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873a5e1c0b64f2a9d38e77",
      index: 2,
      amount: "25000000",
      dueAt: new Date(now + 2 * day).toISOString(),
    },
    {
      planId: "0x8f2c19a4b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873a5e1c0b64f2a9d38e77",
      index: 3,
      amount: "25000000",
      dueAt: new Date(now + 16 * day).toISOString(),
    },
  ],
  attention: true,
  topUp: {
    amount: "18500000",
    by: new Date(now + 2 * day).toISOString(),
    source: "gateway",
    covers: 1,
  },
};

const SAMPLE_STANDING: Standing = {
  live: false,
  tier: "Building",
  completions: 1,
  activeNegatives: 0,
  negativesEver: 0,
  // Steps are monotone decreasing, because `explainLimit` only records a cap that
  // actually bound — which is what makes "the last line is the one that bound" a true
  // statement rather than a caption. A sample listing a cap above the running limit
  // would show the borrower a reason that was not the reason.
  limit: "80000000",
  steps: [
    {kind: "growth", label: "1 plan completed cleanly", limit: "125000000"},
    {kind: "book-share", label: "Share of the funding book Tier 0 may hold", limit: "80000000"},
  ],
  consents: [],
};

export function summary(): Promise<Summary> {
  return get("/me/summary", BORROWER, SAMPLE_SUMMARY);
}

export function standing(): Promise<Standing> {
  return get("/me/standing", BORROWER, SAMPLE_STANDING);
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 6-decimal USDC as a dollar figure.
 *
 * Never `Number(value) / 1e6`. Arc's USDC is 18-decimal natively and 6-decimal over
 * ERC-20 on one balance, and a float somewhere in that conversion is how the last two
 * digits of a payment quietly disappear.
 */
export function usd(value: string): string {
  const units = BigInt(value);
  const whole = units / 1_000_000n;
  const cents = (units % 1_000_000n) / 10_000n;
  return `$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

export function when(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {month: "short", day: "numeric"});
}

export function shortId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
