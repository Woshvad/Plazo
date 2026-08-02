/**
 * The servicing API: what the borrower app and the operator console read.
 *
 * Hono, for the reason the origination service gives — Ponder embeds it, so the read API
 * and the operator APIs share one runtime and one set of idioms instead of being two
 * services that happen to live in the same repository.
 *
 * The split down the middle is the point. `/me/*` answers a borrower about themselves
 * and takes their address from an authenticated session; `/ops/*` answers an operator
 * and requires a capability plus a reason, and every call on that side lands in the
 * audit log. Nothing on the borrower side can be reached with an operator credential and
 * nothing on the operator side can be reached without one.
 *
 * Authentication is a header here, as in the origination service, and is Phase 6's
 * MERCH-05 to finish properly. It is marked rather than hidden so it cannot be mistaken
 * for done.
 */

import {Hono} from "hono";
import type {Address, Hex} from "viem";

import {
  needsAttention,
  shortfalls,
  sizeTopUp,
  type BalanceSnapshot,
  type UpcomingInstallment,
} from "./balance.js";
import {
  ladderFor,
  missedNotices,
  type DeliveryLog,
  type LadderInput,
} from "./ladder.js";
import {
  can,
  NotAuthorized,
  resendNotice,
  setParameter,
  tripPause,
  waiveFee,
  type Capability,
  type AuditLog,
  type ConsoleDeps,
  type Operator,
  type PlanView,
} from "./console.js";
import {keeperShare, type CollectionRecord} from "./relayer.js";

export interface ServicingDeps {
  readonly deliveries: DeliveryLog;
  readonly audit: AuditLog;
  readonly now: () => Date;

  /** The relayer gate's address, so COLL-10 can tell its cranks from everyone else's. */
  readonly gate: Address;

  balanceOf(borrower: Address): Promise<BalanceSnapshot>;
  upcomingFor(borrower: Address): Promise<UpcomingInstallment[]>;
  plansOf(borrower: Address): Promise<PlanView[]>;
  scheduleOf(planId: Hex): Promise<LadderInput>;
  collectionsSince(from: Date): Promise<CollectionRecord[]>;

  operatorFor(token: string): Promise<Operator | null>;

  settleWaiver(planId: Hex, amount: bigint): Promise<void>;
  sendParameter(key: string, value: bigint): Promise<void>;
  sendPause(corridor: string): Promise<void>;
  resend(noticeKey: string): Promise<void>;
}

const BORROWER_HEADER = "x-plazo-borrower";
const OPERATOR_HEADER = "x-plazo-operator";

/** JSON cannot carry a bigint, and a silent `Number()` is how money loses its last digits. */
function money(value: bigint): string {
  return value.toString();
}

export function createServicingApi(deps: ServicingDeps) {
  const app = new Hono();
  const consoleDeps: ConsoleDeps = {log: deps.audit, now: deps.now};

  // ─── The borrower's own view (APP-02, XCH-03, XCH-04) ───────────────────

  /**
   * Everything the borrower's home screen needs, in one call.
   *
   * The two balances are separate fields and always will be. DEC-19: a check debits the
   * Arc balance, so a combined figure would be a number that predicts nothing about
   * whether the next payment clears — which is the only question this screen answers.
   */
  app.get("/me/summary", async (c) => {
    const borrower = c.req.header(BORROWER_HEADER) as Address | undefined;
    if (!borrower) return c.json({error: "unauthenticated"}, 401);

    const [balance, upcoming, plans] = await Promise.all([
      deps.balanceOf(borrower),
      deps.upcomingFor(borrower),
      deps.plansOf(borrower),
    ]);

    const topUp = sizeTopUp(balance, upcoming);

    return c.json({
      balance: {
        collectable: money(balance.collectable),
        elsewhere: money(balance.elsewhere),
        at: balance.at.toISOString(),
      },
      plans: plans.map((p) => ({
        planId: p.planId,
        state: p.state,
        outstanding: money(p.outstanding),
        nextDueAt: p.nextDueAt?.toISOString() ?? null,
      })),
      upcoming: upcoming.map((i) => ({
        planId: i.planId,
        index: i.index,
        amount: money(i.amount),
        dueAt: i.dueAt.toISOString(),
      })),
      attention: needsAttention(balance, upcoming),
      topUp: topUp
        ? {
            amount: money(topUp.amount),
            by: topUp.by.toISOString(),
            source: topUp.source,
            covers: topUp.shortfalls.length,
          }
        : null,
    });
  });

  /** The shortfall breakdown, for the screen that explains the top-up figure. */
  app.get("/me/shortfalls", async (c) => {
    const borrower = c.req.header(BORROWER_HEADER) as Address | undefined;
    if (!borrower) return c.json({error: "unauthenticated"}, 401);

    const [balance, upcoming] = await Promise.all([
      deps.balanceOf(borrower),
      deps.upcomingFor(borrower),
    ]);

    return c.json({
      shortfalls: shortfalls(balance, upcoming).map((s) => ({
        planId: s.planId,
        index: s.index,
        dueAt: s.dueAt.toISOString(),
        amount: money(s.amount),
        missing: money(s.missing),
        coveredByElsewhere: s.coveredByElsewhere,
      })),
    });
  });

  /** A borrower's own delivery log. NOTIF-02 is not only for the operator. */
  app.get("/me/notices/:planId", async (c) => {
    const borrower = c.req.header(BORROWER_HEADER) as Address | undefined;
    if (!borrower) return c.json({error: "unauthenticated"}, 401);

    const planId = c.req.param("planId") as Hex;
    const plans = await deps.plansOf(borrower);
    if (!plans.some((p) => p.planId === planId)) return c.json({error: "not found"}, 404);

    return c.json({
      deliveries: (await deps.deliveries.for(planId)).map((d) => ({
        kind: d.kind,
        channel: d.channel,
        outcome: d.outcome,
        at: d.at.toISOString(),
      })),
    });
  });

  // ─── The operator console (NOTIF-04, OPS-07) ────────────────────────────

  async function operator(c: {req: {header(name: string): string | undefined}}) {
    const token = c.req.header(OPERATOR_HEADER);
    if (!token) return null;
    return deps.operatorFor(token);
  }

  function guard(op: Operator | null, capability: Capability) {
    if (!op) return {error: "unauthenticated", status: 401 as const};
    if (!can(op, capability)) return {error: "forbidden", status: 403 as const};
    return null;
  }

  app.get("/ops/plans/:planId", async (c) => {
    const op = await operator(c);
    const denied = guard(op, "plan.read");
    if (denied) return c.json({error: denied.error}, denied.status);

    const planId = c.req.param("planId") as Hex;
    const schedule = await deps.scheduleOf(planId);
    const ladder = ladderFor(schedule);

    return c.json({
      planId,
      schedule: schedule.installments.map((i) => ({
        index: i.index,
        dueAt: i.dueAt.toISOString(),
      })),
      deliveries: (await deps.deliveries.for(planId)).length,
      /**
       * The gap between what the ladder said should be sent and what the log says was.
       * The operator's own failure, surfaced without anyone having to ask for it.
       */
      missed: (await missedNotices(ladder, deps.deliveries, deps.now())).map((n) => n.key),
    });
  });

  app.post("/ops/plans/:planId/waive", async (c) => {
    const op = await operator(c);
    const denied = guard(op, "fee.waive");
    if (denied) return c.json({error: denied.error}, denied.status);

    const body = (await c.req.json()) as {amount: string; reason: string};
    try {
      const waiver = await waiveFee(
        consoleDeps,
        op!,
        {planId: c.req.param("planId") as Hex, amount: BigInt(body.amount), reason: body.reason},
        deps.settleWaiver,
      );
      return c.json({planId: waiver.planId, amount: money(waiver.amount), by: waiver.by});
    } catch (error) {
      if (error instanceof NotAuthorized) return c.json({error: "forbidden"}, 403);
      return c.json({error: (error as Error).message}, 400);
    }
  });

  app.post("/ops/plans/:planId/resend", async (c) => {
    const op = await operator(c);
    const denied = guard(op, "notice.resend");
    if (denied) return c.json({error: denied.error}, denied.status);

    const body = (await c.req.json()) as {noticeKey: string; reason: string};
    await resendNotice(
      consoleDeps,
      op!,
      {planId: c.req.param("planId") as Hex, noticeKey: body.noticeKey, reason: body.reason},
      deps.resend,
    );
    return c.json({ok: true});
  });

  app.post("/ops/parameters/:key", async (c) => {
    const op = await operator(c);
    const denied = guard(op, "parameter.set");
    if (denied) return c.json({error: denied.error}, denied.status);

    const body = (await c.req.json()) as {from: string; to: string; reason: string};
    const change = await setParameter(
      consoleDeps,
      op!,
      {key: c.req.param("key"), from: BigInt(body.from), to: BigInt(body.to), reason: body.reason},
      deps.sendParameter,
    );
    return c.json({key: change.key, to: money(change.to), by: change.by});
  });

  app.post("/ops/pause/:corridor", async (c) => {
    const op = await operator(c);
    const denied = guard(op, "pause.trip");
    if (denied) return c.json({error: denied.error}, denied.status);

    const body = (await c.req.json()) as {reason: string};
    await tripPause(consoleDeps, op!, {corridor: c.req.param("corridor"), reason: body.reason}, deps.sendPause);
    return c.json({ok: true});
  });

  /**
   * The audit log, and its own verification.
   *
   * Serving `verify()` alongside the entries is the difference between a log and
   * evidence: the reader does not have to trust that nothing was removed, they can see
   * the chain hold — or see exactly which sequence number it stops holding at.
   */
  app.get("/ops/audit", async (c) => {
    const op = await operator(c);
    const denied = guard(op, "audit.read");
    if (denied) return c.json({error: denied.error}, denied.status);

    return c.json({
      head: await deps.audit.head(),
      integrity: await deps.audit.verify(),
      entries: (await deps.audit.all()).map((e) => ({
        seq: e.seq,
        at: e.at.toISOString(),
        operator: e.operator,
        capability: e.capability,
        subject: e.subject,
        reason: e.reason,
        hash: e.hash,
      })),
    });
  });

  /**
   * COLL-10, served rather than asserted.
   *
   * "Permissionless collection" is the load-bearing claim in the whole design and the
   * easiest one to ship as a slogan. This is the number that would embarrass it.
   */
  app.get("/ops/keeper-share", async (c) => {
    const op = await operator(c);
    const denied = guard(op, "plan.read");
    if (denied) return c.json({error: denied.error}, denied.status);

    const days = Number(c.req.query("days") ?? "30");
    const from = new Date(deps.now().getTime() - days * 24 * 60 * 60 * 1000);
    const share = keeperShare(await deps.collectionsSince(from), deps.gate);

    return c.json({windowDays: days, ...share});
  });

  return app;
}
