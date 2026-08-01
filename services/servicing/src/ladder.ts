/**
 * The reminder ladder, and the log that proves it was sent.
 *
 * NOTIF-01, NOTIF-02 and NOTIF-03.
 *
 * The ladder is a pure function of a plan's schedule and its state, which matters more
 * than it sounds: a notification system whose schedule lives in a job queue can only be
 * audited by reading the queue, and a queue is not evidence. Here the *intended* sends
 * are derivable from the chain by anybody, and the delivery log records which of them
 * actually happened. The gap between the two is the operator's failure, and it is
 * visible rather than inferred.
 *
 * Nothing here is load-bearing for collection. A borrower who never receives a reminder
 * still has a plan a keeper will crank on schedule; what they lose is the chance to fix
 * it first, which is the entire point of sending one.
 */

import type {Address, Hex} from "viem";

export type NoticeKind =
  /** Ahead of a due date, so a shortfall can still be fixed. */
  | "upcoming"
  /** The balance will not cover what is due. NOTIF-05's output. */
  | "shortfall"
  /** A check cleared. NOTIF-03. */
  | "receipt"
  /** A pull failed and the grace clock is running. */
  | "bounced"
  /** Grace expired and a late fee accrued. */
  | "delinquent"
  /** The plan is finished. */
  | "completed";

export type Channel = "email" | "sms" | "push" | "webhook";

export interface Notice {
  readonly kind: NoticeKind;
  readonly planId: Hex;
  readonly installmentIndex: number | null;
  /** When this notice should go out. */
  readonly sendAt: Date;
  /**
   * A stable key for the notice. Sending is idempotent on it.
   *
   * `${planId}:${index}:${kind}` — the same shape as the keeper's job key, and for the
   * same reason: a scheduler that retries must not produce a second message, and a
   * borrower who is reminded twice about one payment stops reading the reminders.
   */
  readonly key: string;
}

export interface LadderInput {
  readonly planId: Hex;
  readonly installments: readonly {index: number; dueAt: Date}[];
}

/**
 * How far ahead of a due date each reminder goes.
 *
 * Three days, then one day, then the morning of. The first is far enough out to move
 * money from another chain; the last is close enough to be the thing the borrower acts
 * on. A fourth would not add information — it would add the reason people mute the
 * sender.
 */
export const LEAD_TIMES_MS = [
  3 * 24 * 60 * 60 * 1000,
  1 * 24 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
] as const;

/**
 * Every notice a healthy plan should produce, in send order.
 *
 * Pure and total: give it a schedule and it gives you the ladder, with no reference to
 * what has already been sent. Reconciling against the delivery log is a separate step,
 * on purpose — one function decides what *should* happen and another records what did,
 * and neither can quietly become the other.
 */
export function ladderFor(plan: LadderInput): Notice[] {
  const notices: Notice[] = [];

  for (const installment of plan.installments) {
    for (const lead of LEAD_TIMES_MS) {
      notices.push({
        kind: "upcoming",
        planId: plan.planId,
        installmentIndex: installment.index,
        sendAt: new Date(installment.dueAt.getTime() - lead),
        key: `${plan.planId}:${installment.index}:upcoming:${lead}`,
      });
    }
  }

  return notices.sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
}

/** The notice a bounce produces, sent immediately. */
export function bounceNotice(planId: Hex, index: number, at: Date): Notice {
  return {
    kind: "bounced",
    planId,
    installmentIndex: index,
    sendAt: at,
    key: `${planId}:${index}:bounced`,
  };
}

/** The notice a cleared installment produces. NOTIF-03's receipt. */
export function receiptNotice(planId: Hex, index: number, at: Date): Notice {
  return {
    kind: "receipt",
    planId,
    installmentIndex: index,
    sendAt: at,
    key: `${planId}:${index}:receipt`,
  };
}

export function delinquentNotice(planId: Hex, index: number, at: Date): Notice {
  return {
    kind: "delinquent",
    planId,
    installmentIndex: index,
    sendAt: at,
    key: `${planId}:${index}:delinquent`,
  };
}

export function shortfallNotice(planId: Hex, index: number, at: Date): Notice {
  return {
    kind: "shortfall",
    planId,
    installmentIndex: index,
    sendAt: at,
    key: `${planId}:${index}:shortfall`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The delivery log (NOTIF-02)
// ─────────────────────────────────────────────────────────────────────────────

export type DeliveryOutcome = "sent" | "failed" | "suppressed";

export interface DeliveryRecord {
  readonly key: string;
  readonly kind: NoticeKind;
  readonly planId: Hex;
  readonly channel: Channel;
  readonly recipient: string;
  readonly outcome: DeliveryOutcome;
  readonly at: Date;
  readonly detail?: string;
}

/**
 * An append-only record of every send attempt.
 *
 * Append-only is the requirement, not a design flourish. A delivery log an operator can
 * edit is a log that says whatever the operator needed it to say on the day somebody
 * asked — and "we notified you" is exactly the claim a borrower will dispute, in exactly
 * the jurisdictions where the answer decides whether a fee stands.
 *
 * Failures are recorded, not discarded. A log containing only successes cannot tell you
 * that a borrower's address has been bouncing for three months.
 */
export class DeliveryLog {
  readonly #records: DeliveryRecord[] = [];
  readonly #seen = new Set<string>();

  /** Every attempt, in the order it happened. */
  all(): readonly DeliveryRecord[] {
    return this.#records;
  }

  for(planId: Hex): readonly DeliveryRecord[] {
    return this.#records.filter((r) => r.planId === planId);
  }

  /** Whether this exact notice has already gone out successfully. */
  wasSent(key: string): boolean {
    return this.#seen.has(key);
  }

  record(record: DeliveryRecord): void {
    this.#records.push(record);
    if (record.outcome === "sent") this.#seen.add(record.key);
  }

  /** Attempts that never reached anybody. What an operator has to act on. */
  failures(): readonly DeliveryRecord[] {
    return this.#records.filter((r) => r.outcome === "failed");
  }
}

export interface Transport {
  send(notice: Notice, recipient: string, channel: Channel): Promise<void>;
}

export interface Contact {
  readonly channel: Channel;
  readonly address: string;
}

/**
 * Send the notices that are due, once each, recording every attempt.
 *
 * Idempotent on the notice key, so a scheduler that fires twice, a retry after a crash
 * and a replayed queue all produce one message. A borrower reminded twice about one
 * payment learns to ignore the sender, which costs exactly the times it mattered.
 */
export async function dispatch(
  notices: readonly Notice[],
  contacts: readonly Contact[],
  transport: Transport,
  log: DeliveryLog,
  now: Date,
): Promise<number> {
  let sent = 0;

  for (const notice of notices) {
    if (notice.sendAt > now) continue;
    if (log.wasSent(notice.key)) continue;

    for (const contact of contacts) {
      try {
        await transport.send(notice, contact.address, contact.channel);
        log.record({
          key: notice.key,
          kind: notice.kind,
          planId: notice.planId,
          channel: contact.channel,
          recipient: contact.address,
          outcome: "sent",
          at: now,
        });
        sent += 1;
      } catch (error) {
        log.record({
          key: notice.key,
          kind: notice.kind,
          planId: notice.planId,
          channel: contact.channel,
          recipient: contact.address,
          outcome: "failed",
          at: now,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return sent;
}

/**
 * Which notices a plan should have received by now and did not.
 *
 * The audit the log exists for. It compares the ladder — derivable from the chain by
 * anybody — against what was actually delivered, so "we sent it" is checkable rather
 * than assertable.
 */
export function missedNotices(
  ladder: readonly Notice[],
  log: DeliveryLog,
  now: Date,
): Notice[] {
  return ladder.filter((n) => n.sendAt <= now && !log.wasSent(n.key));
}

export interface BorrowerContacts {
  readonly borrower: Address;
  readonly contacts: readonly Contact[];
}
