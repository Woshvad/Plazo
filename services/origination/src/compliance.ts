/**
 * Compliance as an event stream — OPS-05.
 *
 * The requirement is that a borrower who becomes sanctioned *mid-strip* is detected.
 * A screen performed once at checkout cannot do that, and a system that screens once
 * and then relies on the token's blocklist has outsourced its compliance posture to
 * whoever maintains the token.
 *
 * So screening is a stream in both directions. Upstream — Circle's Compliance Engine
 * when it arrives, a sanctions feed until then — pushes status changes in; this
 * service reconciles them onto `AllowlistCompliance` so the router reads a fresh
 * answer; and every change emits, so the chain is the record of when the protocol
 * knew.
 *
 * ## Why the reconciler is idempotent and batched
 *
 * A feed update is hundreds of addresses. A hundred transactions is a hundred chances
 * to apply half an update, and half an applied sanctions list is worse than none —
 * it is a list someone will trust.
 *
 * ## What happens to a borrower who turns mid-strip
 *
 * Nothing automatic, and that is correct. The plan has no owner and no pause; a
 * blocklisted borrower's `collect()` produces a typed `Blocked` bounce rather than an
 * insufficient-funds one, which carries a different Passport and provisioning
 * treatment. What this service does is stop *new* originations and raise the event
 * the operator's queue acts on. Freezing an existing borrower's ability to repay
 * would be manufacturing a default out of a compliance flag.
 */
import type {Address, Hex} from "viem";

export const ComplianceStatus = {Unknown: 0, Clear: 1, Denied: 2} as const;
export type ComplianceStatus = (typeof ComplianceStatus)[keyof typeof ComplianceStatus];

export interface ScreeningUpdate {
  account: Address;
  status: ComplianceStatus;
  /** When the upstream feed decided this. Unix seconds. */
  decidedAt: number;
  /** Free-form upstream reference. Never stored onchain. */
  reference?: string;
}

export interface ComplianceRecord {
  account: Address;
  status: ComplianceStatus;
  screenedAt: number;
}

/** Writes to `AllowlistCompliance`. A viem wallet client in production. */
export interface ComplianceWriter {
  screenBatch(accounts: Address[], statuses: ComplianceStatus[]): Promise<Hex>;
}

/** Reads current onchain status, so the reconciler only writes what changed. */
export interface ComplianceReader {
  statusOf(account: Address): Promise<ComplianceStatus>;
  screenedAt(account: Address): Promise<number>;
}

export interface ReconcilerConfig {
  reader: ComplianceReader;
  writer: ComplianceWriter;
  /**
   * How stale an onchain screen may be before it is refreshed even without a status
   * change. Must be under the router's `SCREEN_FRESHNESS`, or an unchanged borrower
   * ages out of eligibility while the feed sits happily reporting nothing new.
   */
  refreshAfterSeconds?: number;
  /** Addresses per transaction. */
  batchSize?: number;
}

/** Five days, under the router's seven. The margin absorbs a missed daily run. */
export const DEFAULT_REFRESH_AFTER = 5 * 24 * 60 * 60;
export const DEFAULT_BATCH_SIZE = 200;

export interface ReconcileResult {
  /** Accounts whose onchain status changed. */
  changed: Address[];
  /** Accounts refreshed only because their screen had gone stale. */
  refreshed: Address[];
  /** Accounts that were already correct and recent. */
  skipped: Address[];
  transactions: Hex[];
}

export class ComplianceReconciler {
  private readonly refreshAfter: number;
  private readonly batchSize: number;

  constructor(private readonly config: ReconcilerConfig) {
    this.refreshAfter = config.refreshAfterSeconds ?? DEFAULT_REFRESH_AFTER;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /**
   * Apply a feed update to the chain.
   *
   * Reads before writing so an unchanged, recent account costs nothing. On a feed of
   * hundreds where a handful moved, that is the difference between a daily cron and a
   * daily gas bill.
   */
  async reconcile(
    updates: readonly ScreeningUpdate[],
    now = Math.floor(Date.now() / 1000),
  ): Promise<ReconcileResult> {
    const changed: Address[] = [];
    const refreshed: Address[] = [];
    const skipped: Address[] = [];
    const pending: {account: Address; status: ComplianceStatus}[] = [];

    for (const update of updates) {
      const [onchain, screenedAt] = await Promise.all([
        this.config.reader.statusOf(update.account),
        this.config.reader.screenedAt(update.account),
      ]);

      if (onchain !== update.status) {
        changed.push(update.account);
        pending.push({account: update.account, status: update.status});
        continue;
      }

      if (now - screenedAt >= this.refreshAfter) {
        refreshed.push(update.account);
        pending.push({account: update.account, status: update.status});
        continue;
      }

      skipped.push(update.account);
    }

    const transactions: Hex[] = [];
    for (let i = 0; i < pending.length; i += this.batchSize) {
      const slice = pending.slice(i, i + this.batchSize);
      transactions.push(
        await this.config.writer.screenBatch(
          slice.map((p) => p.account),
          slice.map((p) => p.status),
        ),
      );
    }

    return {changed, refreshed, skipped, transactions};
  }
}

/**
 * Borrowers with a live plan who have just been denied.
 *
 * The mid-strip case. Nothing is done to their plan — it has no owner and no pause,
 * and a borrower who cannot repay because of a compliance flag is a borrower the
 * protocol has defaulted on their behalf. What this produces is the operator's work
 * queue: a list of plans that now need a human, and the chain already carries the
 * evidence of when the status changed.
 */
export function midStripDenials(
  updates: readonly ScreeningUpdate[],
  livePlansByBorrower: ReadonlyMap<string, readonly Hex[]>,
): {borrower: Address; plans: readonly Hex[]}[] {
  return updates
    .filter((u) => u.status === ComplianceStatus.Denied)
    .map((u) => ({borrower: u.account, plans: livePlansByBorrower.get(u.account.toLowerCase()) ?? []}))
    .filter((entry) => entry.plans.length > 0);
}
