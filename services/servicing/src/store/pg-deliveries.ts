/**
 * `DeliveryLog` over Postgres. NOTIF-02.
 *
 * A substitution, not a rewrite: `ladder.ts` owns what a notice is, when it should go and
 * what "already sent" means, and none of that moves here. What moves is where the record
 * lives — which matters because the log's whole purpose is to answer "we notified you" a
 * month later, and a log that dies with the process cannot answer anything a month later.
 *
 * ## Append-only, and it means the same thing here as in the audit log
 *
 * There is no update and no delete. A retry is a second row, a replay is a second row, and
 * a failed send is a row rather than a discard. A log containing only successes cannot tell
 * an operator that a borrower's address has been bouncing for three months, which is one of
 * the two things it exists for.
 *
 * ## Ordering, and what it does not claim
 *
 * Reads order by `(sent_at, id)`. That is deterministic but not causal: one `dispatch` pass
 * stamps every row it writes with the same `now`, so rows from a single pass come back in
 * `id` order, which is `gen_random_uuid()` order, which is nothing.
 *
 * This is deliberate rather than a shortfall. Those sends happened in a loop over one
 * borrower's contacts at one logical instant and there is no order between them to record.
 * A `bigserial` would have invented one that reads as more precise than the data — and it
 * cannot live in this schema in any case, because `tablesFilter` does not scope sequences
 * and the other service's push would offer to drop it. `drizzle.config.ts` carries the
 * measurement.
 */
import {and, asc, eq} from "drizzle-orm";

import {noticeDelivery} from "../db/schema.js";
import type {Channel, DeliveryLog, DeliveryOutcome, DeliveryRecord, NoticeKind} from "../ladder.js";
import type {Db} from "../db/client.js";
import type {Hex} from "viem";

function toRecord(row: typeof noticeDelivery.$inferSelect): DeliveryRecord {
  return {
    key: row.noticeKey,
    kind: row.kind as NoticeKind,
    planId: row.planId as Hex,
    channel: row.channel as Channel,
    recipient: row.recipient,
    outcome: row.outcome as DeliveryOutcome,
    at: row.sentAt,
    // Absent rather than explicitly null: `detail` is optional on `DeliveryRecord` and
    // under `exactOptionalPropertyTypes` an explicit `undefined` is a different type from
    // an absent key.
    ...(row.detail === null ? {} : {detail: row.detail}),
  };
}

export class PgDeliveryLog implements DeliveryLog {
  constructor(private readonly database: Db) {}

  async all(): Promise<readonly DeliveryRecord[]> {
    const rows = await this.database.select().from(noticeDelivery).orderBy(asc(noticeDelivery.sentAt), asc(noticeDelivery.id));
    return rows.map(toRecord);
  }

  async for(planId: Hex): Promise<readonly DeliveryRecord[]> {
    const rows = await this.database
      .select()
      .from(noticeDelivery)
      .where(eq(noticeDelivery.planId, planId))
      .orderBy(asc(noticeDelivery.sentAt), asc(noticeDelivery.id));

    return rows.map(toRecord);
  }

  /**
   * Whether this exact notice already went out successfully.
   *
   * Scoped to `outcome = 'sent'`, so a failed attempt does not suppress the retry. That is
   * the same rule the in-memory implementation applies — it only adds to `#seen` on a send
   * — and getting it wrong here would mean a borrower whose mail server hiccuped once never
   * hears about a payment again.
   */
  async wasSent(key: string): Promise<boolean> {
    const rows = await this.database
      .select({id: noticeDelivery.id})
      .from(noticeDelivery)
      .where(and(eq(noticeDelivery.noticeKey, key), eq(noticeDelivery.outcome, "sent")))
      .limit(1);

    return rows.length > 0;
  }

  async record(record: DeliveryRecord): Promise<void> {
    await this.database.insert(noticeDelivery).values({
      noticeKey: record.key,
      planId: record.planId,
      kind: record.kind,
      channel: record.channel,
      recipient: record.recipient,
      outcome: record.outcome,
      detail: record.detail ?? null,
      sentAt: record.at,
    });
  }

  async failures(): Promise<readonly DeliveryRecord[]> {
    const rows = await this.database
      .select()
      .from(noticeDelivery)
      .where(eq(noticeDelivery.outcome, "failed"))
      .orderBy(asc(noticeDelivery.sentAt), asc(noticeDelivery.id));

    return rows.map(toRecord);
  }
}
