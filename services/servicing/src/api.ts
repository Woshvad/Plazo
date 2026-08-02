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
 * ## Three planes, three credentials, and one of them is now real
 *
 * `/v1/*` is the **merchant** plane — webhooks and payout attestations — and it is behind
 * a verified API key. The merchant on the context comes from the key and from nothing
 * else; no route on this side reads a merchant from a body, a header or a path segment
 * (MERCH-05, D-18, T-06-06-05).
 *
 * `/me/*` and `/ops/*` are the borrower and operator planes, and they still take an
 * identity from a header. That is **not** MERCH-05 — a merchant key says nothing about
 * which borrower is asking or which member of staff is acting — and it is recorded here
 * plainly rather than covered by the merchant work having landed. A borrower session and
 * an operator credential are each their own requirement and neither is built.
 */

import {Hono} from "hono";
import type {Address, Hex} from "viem";

import type {DeliveryView, EndpointRow, ReplayResult} from "./webhooks.js";
import {SsrfError} from "./ssrf.js";

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

  /**
   * How a presented API key becomes a merchant. Defaults to refusing every key.
   *
   * Deny-by-default rather than optional-and-open: a process that has not wired its
   * merchant plane serves 401s, which is visible, instead of serving a merchant plane
   * with no authentication, which is not. The seam is injected because the key tables
   * belong to `@plazo/origination` and a dependency from this service to that one would
   * be a cycle in the operator plane.
   */
  readonly merchants?: MerchantAuth | undefined;
  /** Webhook registration, the delivery log, and replay. Absent means the routes 503. */
  readonly webhooks?: WebhookConsole | undefined;
  /** What the Iris poller has heard back, per plan. Absent means the route 503s. */
  readonly attestations?: AttestationConsole | undefined;
}

/**
 * The merchant-facing attestation read.
 *
 * Takes the merchant, not just the plan, because the `planId → merchant` join lives in
 * `merchant_external_ref` on the origination side and this service cannot reach it. The
 * wiring that owns both halves supplies the scoped read; the route only ever asks for
 * "this merchant's plan".
 */
export interface AttestationConsole {
  for(
    merchantId: string,
    planId: string,
  ): Promise<{
    planId: string;
    destinationDomain: number;
    txHash: string;
    message: string | null;
    attestation: string | null;
    status: string;
    attempts: number;
    polledAt: Date | null;
  } | null>;
}

/**
 * A merchant, as this service needs them.
 *
 * Deliberately smaller than the origination service's record: this side needs to know
 * whose rows these are and nothing else. Carrying the settlement address here too would
 * be a second copy of an identity with no reader.
 */
export interface MerchantIdentity {
  readonly merchantId: string;
  readonly keyId: string;
  readonly environment: string;
}

export interface MerchantAuth {
  /** Resolve a presented key, or return null. Never throws for a bad key. */
  verify(presented: string): Promise<MerchantIdentity | null>;
}

/** Refuses everything. The default, so an unwired process is shut rather than open. */
export const denyAllMerchants: MerchantAuth = {verify: async () => null};

/** The merchant-facing webhook surface, as the routes depend on it. */
export interface WebhookConsole {
  register(merchantId: string, url: string): Promise<{endpoint: EndpointRow; secret: string}>;
  deliveries(merchantId: string, limit: number): Promise<DeliveryView[]>;
  delivery(merchantId: string, deliveryId: string): Promise<DeliveryView | null>;
  replay(merchantId: string, deliveryId: string): Promise<ReplayResult>;
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
  // ─── The merchant plane (MERCH-05, D-18) ────────────────────────────────

  /**
   * The merchant identity, from the key and from nowhere else.
   *
   * Returns a response on refusal rather than throwing, so a route reads as
   * `const merchant = await merchantOf(c); if ("status" in merchant) return …`. There is
   * no path through this function that produces an identity from anything the caller
   * supplied except the key itself.
   */
  async function merchantOf(c: {
    req: {header(name: string): string | undefined; query(name: string): string | undefined};
  }): Promise<MerchantIdentity | {error: string; status: 400 | 401}> {
    for (const name of ["api_key", "apiKey", "key", "token"]) {
      if (c.req.query(name) !== undefined) {
        // A key that has been in a url is in an access log and a referrer. Refusing is
        // the only answer that tells the merchant to rotate it.
        return {error: "key-in-query", status: 400};
      }
    }

    const header = c.req.header("authorization");
    const [scheme, presented] = (header ?? "").split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !presented) {
      return {error: "unauthenticated", status: 401};
    }

    const merchant = await (deps.merchants ?? denyAllMerchants).verify(presented);
    return merchant ?? {error: "unauthenticated", status: 401};
  }

  const isRefusal = (
    value: MerchantIdentity | {error: string; status: 400 | 401},
  ): value is {error: string; status: 400 | 401} => "error" in value;

  function hooks(): WebhookConsole | null {
    return deps.webhooks ?? null;
  }

  const serialiseDelivery = (d: DeliveryView) => ({
    id: d.id,
    event: d.event,
    webhookId: d.webhookId,
    endpointId: d.endpointId,
    attempt: d.attempt,
    responseStatus: d.responseStatus,
    latencyMs: d.latencyMs,
    sentAt: d.sentAt.toISOString(),
    replayOf: d.replayOf,
  });

  /**
   * Register a destination. The signing secret is readable exactly once, here.
   *
   * The URL is validated now as a courtesy and again on every send, which is the check
   * that matters — a registration-time answer is a cached answer, and a cached answer is
   * a DNS rebinding attack (T-06-06-02).
   */
  app.post("/v1/webhooks/endpoints", async (c) => {
    const merchant = await merchantOf(c);
    if (isRefusal(merchant)) return c.json({error: merchant.error}, merchant.status);

    const webhooks = hooks();
    if (!webhooks) return c.json({error: "webhooks-not-configured"}, 503);

    const body = (await c.req.json().catch(() => ({}))) as {url?: unknown};
    if (typeof body.url !== "string" || body.url.length === 0) {
      return c.json({error: "invalid", message: "url is required"}, 400);
    }

    try {
      const {endpoint, secret} = await webhooks.register(merchant.merchantId, body.url);
      return c.json(
        {
          endpoint: {id: endpoint.id, url: endpoint.url, status: endpoint.status},
          /** The only time this is readable. Rotate to get another. */
          secret,
          /** Documented because the merchant enforces it, not Plazo. */
          replayWindowSeconds: 300,
        },
        201,
      );
    } catch (error) {
      if (error instanceof SsrfError) {
        return c.json({error: error.code, message: error.message}, 400);
      }
      throw error;
    }
  });

  /** The delivery log, newest first. Failures included, which is the point of it. */
  app.get("/v1/webhooks/deliveries", async (c) => {
    const merchant = await merchantOf(c);
    if (isRefusal(merchant)) return c.json({error: merchant.error}, merchant.status);

    const webhooks = hooks();
    if (!webhooks) return c.json({error: "webhooks-not-configured"}, 503);

    const limit = Number(c.req.query("limit") ?? "100");
    const rows = await webhooks.deliveries(merchant.merchantId, Number.isFinite(limit) ? limit : 100);
    return c.json({deliveries: rows.map(serialiseDelivery)});
  });

  /** One delivery, with the bodies. MERCH-05's "inspect". */
  app.get("/v1/webhooks/deliveries/:id", async (c) => {
    const merchant = await merchantOf(c);
    if (isRefusal(merchant)) return c.json({error: merchant.error}, merchant.status);

    const webhooks = hooks();
    if (!webhooks) return c.json({error: "webhooks-not-configured"}, 503);

    const row = await webhooks.delivery(merchant.merchantId, c.req.param("id"));
    if (!row) return c.json({error: "not-found"}, 404);

    return c.json({
      ...serialiseDelivery(row),
      requestBody: row.requestBody,
      responseBodyTruncated: row.responseBodyTruncated ?? null,
    });
  });

  /**
   * MERCH-05's "replay". A new `webhook-id`, the same body.
   *
   * The response says the new id out loud, because the merchant's own deduplication is
   * what makes the distinction matter and they need to be able to see it (Pitfall 8).
   */
  app.post("/v1/webhooks/deliveries/:id/replay", async (c) => {
    const merchant = await merchantOf(c);
    if (isRefusal(merchant)) return c.json({error: merchant.error}, merchant.status);

    const webhooks = hooks();
    if (!webhooks) return c.json({error: "webhooks-not-configured"}, 503);

    try {
      const result = await webhooks.replay(merchant.merchantId, c.req.param("id"));
      return c.json({
        deliveryId: result.deliveryId,
        webhookId: result.webhookId,
        replayOf: result.replayOf,
        status: result.status,
        ok: result.ok,
      });
    } catch (error) {
      if (error instanceof SsrfError) return c.json({error: error.code, message: error.message}, 400);
      return c.json({error: "not-found", message: (error as Error).message}, 404);
    }
  });

  /**
   * The attestation for a dispatched payout. XCH-02 and D-12.
   *
   * Returns the message and the attestation so the merchant can call `receiveMessage` on
   * the destination chain themselves. Plazo holds no gas token on any chain but Arc, so
   * the last mile is theirs by design rather than by omission — and it is permissionless,
   * so anybody holding these two values can complete the mint, including a merchant who
   * never asks this service anything and reads Iris directly from the public burn hash.
   */
  app.get("/v1/payouts/:planId/attestation", async (c) => {
    const merchant = await merchantOf(c);
    if (isRefusal(merchant)) return c.json({error: merchant.error}, merchant.status);

    const attestations = deps.attestations;
    if (!attestations) return c.json({error: "attestations-not-configured"}, 503);

    const row = await attestations.for(merchant.merchantId, c.req.param("planId"));
    if (!row) return c.json({error: "not-found"}, 404);

    return c.json({
      planId: row.planId,
      domain: row.destinationDomain,
      txHash: row.txHash,
      status: row.status,
      message: row.message,
      attestation: row.attestation,
      /** Polls so far. A large number on a pending row is a stuck settlement, not a slow one. */
      attempts: row.attempts,
      polledAt: row.polledAt?.toISOString() ?? null,
    });
  });

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
