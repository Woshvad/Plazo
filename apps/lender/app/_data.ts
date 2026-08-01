/**
 * The lender app's numbers.
 *
 * Reads the indexer's API (`PLAZO_INDEXER_URL`), falling back to a built-in sample that
 * is the same shape. `live: false` reaches the UI and the banner is unconditional — a
 * demo indistinguishable from production is how a screenshot ends up in a deck
 * describing a book that does not exist.
 */

export interface BookState {
  live: boolean;
  epoch: string;
  totalAssets: string;
  reserve: string;
  senior: {assets: string; shares: string; nav: string};
  junior: {assets: string; shares: string; nav: string};
  subordinationBps: number;
  reserveBps: number;
  /** Cash available now, and the share of assets it represents. */
  buffer: {cash: string; deployed: string; floorBps: number};
  originationOpen: boolean;
  provisioned: string;
  liquidityFeeBps: number;
  liquidityFeeThresholdBps: number;
  seniorTargetApyBps: number;
}

export interface Receivable {
  planId: string;
  merchant: string;
  principal: string;
  outstanding: string;
  state: string;
  provisioned: string;
  daysPastDue: number;
}

export interface QueueTicket {
  tranche: "Senior" | "Junior";
  index: number;
  shares: string;
  ahead: string;
  filled: string;
  requestedAt: string;
}

const BASE = process.env["PLAZO_INDEXER_URL"];

async function get<T>(path: string, fallback: T): Promise<T> {
  if (!BASE) return fallback;
  const response = await fetch(`${BASE}${path}`, {cache: "no-store"});
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return {...(await response.json()), live: true} as T;
}

const SAMPLE_BOOK: BookState = {
  live: false,
  epoch: "14",
  totalAssets: "126317000000",
  reserve: "6316000000",
  senior: {assets: "100000000000", shares: "100000000000000", nav: "1000000000000000000"},
  junior: {assets: "20001000000", shares: "20001000000000", nav: "1000000000000000000"},
  subordinationBps: 1583,
  reserveBps: 500,
  buffer: {cash: "18400000000", deployed: "0", floorBps: 1000},
  originationOpen: true,
  provisioned: "412000000",
  liquidityFeeBps: 0,
  liquidityFeeThresholdBps: 1000,
  seniorTargetApyBps: 800,
};

const SAMPLE_RECEIVABLES: Receivable[] = [
  {
    planId: "0x8f2c19a4b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873a5e1c0b64f2a9d38e77",
    merchant: "0x00000000000000000000000000000000000acced",
    principal: "100000000",
    outstanding: "50000000",
    state: "Active",
    provisioned: "0",
    daysPastDue: 0,
  },
  {
    planId: "0x3a71c8e02f9d465b1e7a04c93f28d6b5079e14a3c8b60d92f5e37a1b48c609dd",
    merchant: "0x00000000000000000000000000000000000acced",
    principal: "824000000",
    outstanding: "824000000",
    state: "Delinquent",
    provisioned: "412000000",
    daysPastDue: 11,
  },
];

const SAMPLE_QUEUE: QueueTicket[] = [
  {
    tranche: "Senior",
    index: 0,
    shares: "5000000000000",
    ahead: "0",
    filled: "5000000000000",
    requestedAt: new Date(Date.UTC(2026, 6, 30)).toISOString(),
  },
];

export const book = () => get("/lender/book", SAMPLE_BOOK);
export const receivables = () => get<Receivable[]>("/lender/receivables", SAMPLE_RECEIVABLES);
export const queue = () => get<QueueTicket[]>("/lender/queue", SAMPLE_QUEUE);

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/** 6-decimal USDC. Never through a float — see the borrower app's note. */
export function usd(value: string, decimals = 2): string {
  const units = BigInt(value);
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n) / (decimals === 2 ? 10_000n : 1n);
  return `$${whole.toLocaleString("en-US")}.${frac.toString().padStart(decimals, "0")}`;
}

export function pct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/** Share price, 1e18-scaled, as a dollar figure per share unit. */
export function price(nav: string): string {
  const units = BigInt(nav);
  const whole = units / 10n ** 18n;
  const frac = (units % 10n ** 18n) / 10n ** 14n;
  return `${whole}.${frac.toString().padStart(4, "0")}`;
}

export function shortId(id: string): string {
  return `${id.slice(0, 10)}…${id.slice(-4)}`;
}
