/**
 * Webhook signing, delivery, the log, and replay — against real Postgres.
 *
 * The load-bearing assertion in this file is the independent verifier: `verify()` proving
 * that `sign()` is self-consistent proves nothing a merchant cares about, because a
 * merchant runs somebody else's library. So `standardVerify` below is written from the
 * Standard Webhooks specification and knows nothing about `webhooks.ts`. If the two ever
 * disagree, the merchant's off-the-shelf verifier is the one that is right.
 */
import {createHmac, timingSafeEqual} from "node:crypto";

import {eq} from "drizzle-orm";
import {beforeAll, afterAll, describe, expect, it} from "vitest";

import {webhookDelivery, webhookEndpoint} from "../src/db/schema.js";
import {
  deliver,
  DISABLE_AFTER_MS,
  getDelivery,
  jobKey,
  listDeliveries,
  MAX_ATTEMPTS,
  newSigningSecret,
  nextAttemptDelayMs,
  noteEndpointFailure,
  registerEndpoint,
  replay,
  RESPONSE_BODY_CAP_BYTES,
  rotateSigningSecret,
  sign,
  truncateBody,
  verify,
  type EndpointRow,
} from "../src/webhooks.js";
import {openTestDatabase, type TestDatabase} from "./db.fixture.js";

let fixture: TestDatabase;

beforeAll(async () => {
  fixture = await openTestDatabase();
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

/**
 * An independent Standard Webhooks verifier, written from the specification.
 *
 * Deliberately does not import `sign` or `verify`. This is what a merchant's library
 * does: base64-decode the secret after the `whsec_` prefix, HMAC-SHA256 over
 * `${id}.${timestamp}.${body}`, base64 the digest, compare against any `v1,`-prefixed
 * entry in the space-separated header, and reject a timestamp outside five minutes.
 */
function standardVerify(
  secret: string,
  headers: Record<string, string>,
  body: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const id = headers["webhook-id"]!;
  const ts = Number(headers["webhook-timestamp"]!);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) return false;

  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const digest = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");

  return headers["webhook-signature"]!
    .split(" ")
    .filter((part) => part.startsWith("v1,"))
    .map((part) => Buffer.from(part.slice(3), "base64"))
    .some((got) => {
      const want = Buffer.from(digest, "base64");
      return got.length === want.length && timingSafeEqual(got, want);
    });
}

/** A fetch stub that records what it was handed and answers however the test needs. */
function recorder(responder: (n: number) => Response) {
  const calls: {
    url: string;
    headers: Record<string, string>;
    body: string;
    redirect: RequestInit["redirect"];
  }[] = [];
  const fetchImpl = (async (url: URL | string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({url: url.toString(), headers, body: init.body as string, redirect: init.redirect});
    return responder(calls.length);
  }) as unknown as typeof fetch;
  return {calls, fetchImpl};
}

const ok = () => new Response("{}", {status: 200});
const publicDns = async () => ["93.184.216.34"];

let nextMerchant = 0;
const merchantId = (): string =>
  `00000000-0000-4000-8000-${(++nextMerchant).toString(16).padStart(12, "0")}`;

async function endpoint(url = "https://hooks.example.com/plazo"): Promise<{
  row: EndpointRow;
  secret: string;
}> {
  const {endpoint: row, secret} = await registerEndpoint(
    {db: fixture.db, resolve: publicDns},
    {merchantId: merchantId(), url},
  );
  return {row, secret};
}

describe("signing, to a published specification", () => {
  it("produces v1,<base64 hmac over id.ts.body>", () => {
    const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
    const signature = sign(secret, "msg_1", 1_785_000_000, '{"a":1}');

    expect(signature.startsWith("v1,")).toBe(true);
    expect(
      standardVerify(
        secret,
        {
          "webhook-id": "msg_1",
          "webhook-timestamp": "1785000000",
          "webhook-signature": signature,
        },
        '{"a":1}',
        1_785_000_000,
      ),
    ).toBe(true);
  });

  /**
   * The assertion this whole scheme exists for: a merchant's own verifier, which has
   * never seen this codebase, accepts a real delivery's real headers.
   */
  it("a real delivery's headers verify against the independent implementation", async () => {
    const {row, secret} = await endpoint();
    const {calls, fetchImpl} = recorder(ok);

    await deliver({db: fixture.db, fetchImpl, resolve: publicDns}, row, {
      event: "settlement.completed",
      planId: "0xabc",
      blockNumber: "54714174",
      logIndex: 3,
      data: {net: "40000000"},
    });

    const call = calls[0]!;
    expect(standardVerify(secret, call.headers, call.body)).toBe(true);
  });

  it("refuses a body altered after signing", async () => {
    const {row, secret} = await endpoint();
    const {calls, fetchImpl} = recorder(ok);

    await deliver({db: fixture.db, fetchImpl, resolve: publicDns}, row, {
      event: "settlement.completed",
      data: {},
    });

    const call = calls[0]!;
    expect(standardVerify(secret, call.headers, call.body + " ")).toBe(false);
  });

  it("sends every valid secret's signature, space-separated, during a rotation", async () => {
    const {row, secret: first} = await endpoint();
    const {secret: second, secrets} = await rotateSigningSecret({db: fixture.db}, row.id);
    const {calls, fetchImpl} = recorder(ok);

    await deliver(
      {db: fixture.db, fetchImpl, resolve: publicDns},
      {...row, signingSecrets: secrets},
      {event: "key.rotated", data: {}},
    );

    const call = calls[0]!;
    expect(call.headers["webhook-signature"]!.split(" ")).toHaveLength(2);
    // Both a merchant who has moved and one who has not can verify it. That is the
    // difference between a rotation and an outage.
    expect(standardVerify(first, call.headers, call.body)).toBe(true);
    expect(standardVerify(second, call.headers, call.body)).toBe(true);
  });
});

describe("the replay window", () => {
  const secret = "whsec_" + Buffer.alloc(32, 3).toString("base64");
  const now = 1_785_000_000;
  const body = '{"event":"x"}';

  it("accepts a timestamp four minutes old", () => {
    const ts = now - 240;
    expect(verify([secret], "msg_1", ts, body, sign(secret, "msg_1", ts, body), now)).toBe(true);
  });

  it("refuses a timestamp six minutes old", () => {
    const ts = now - 360;
    expect(verify([secret], "msg_1", ts, body, sign(secret, "msg_1", ts, body), now)).toBe(false);
  });

  /** Future skew too: a timestamp forged ahead stays valid for as long as the skew. */
  it("refuses a timestamp six minutes in the future", () => {
    const ts = now + 360;
    expect(verify([secret], "msg_1", ts, body, sign(secret, "msg_1", ts, body), now)).toBe(false);
  });

  it("accepts either signature in a space-separated header", () => {
    const other = newSigningSecret();
    const header = `${sign(other, "msg_1", now, body)} ${sign(secret, "msg_1", now, body)}`;
    expect(verify([secret], "msg_1", now, body, header, now)).toBe(true);
  });

  it("refuses a signature made with a secret that is not valid", () => {
    const header = sign(newSigningSecret(), "msg_1", now, body);
    expect(verify([secret], "msg_1", now, body, header, now)).toBe(false);
  });
});

describe("delivery", () => {
  it("records the attempt, the status and the latency", async () => {
    const {row} = await endpoint();
    const {fetchImpl} = recorder(() => new Response("thanks", {status: 202}));

    const outcome = await deliver({db: fixture.db, fetchImpl, resolve: publicDns}, row, {
      event: "settlement.completed",
      data: {},
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(202);

    const stored = await getDelivery(fixture.db, row.merchantId, outcome.deliveryId);
    expect(stored!.responseStatus).toBe(202);
    expect(stored!.responseBodyTruncated).toBe("thanks");
    expect(stored!.webhookId).toBe(outcome.webhookId);
  });

  /**
   * A log of successes cannot show a dead endpoint, which is the only thing a merchant
   * ever opens it for.
   */
  it("records a failure as a row, and hands back the next rung of the ladder", async () => {
    const {row} = await endpoint();
    const {fetchImpl} = recorder(() => new Response("nope", {status: 500}));

    const outcome = await deliver({db: fixture.db, fetchImpl, resolve: publicDns}, row, {
      event: "settlement.completed",
      data: {},
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.retryInMs).toBeGreaterThan(0);
    expect(await getDelivery(fixture.db, row.merchantId, outcome.deliveryId)).toBeTruthy();
  });

  it("records a refused destination as a row rather than throwing it away", async () => {
    const {row} = await endpoint();
    const {calls, fetchImpl} = recorder(ok);

    const outcome = await deliver(
      {db: fixture.db, fetchImpl, resolve: async () => ["169.254.169.254"]},
      row,
      {event: "settlement.completed", data: {}},
    );

    expect(calls).toHaveLength(0); // the request never went out
    expect(outcome.status).toBeNull();
    expect(outcome.error).toContain("169.254.169.254");
    expect(await getDelivery(fixture.db, row.merchantId, outcome.deliveryId)).toBeTruthy();
  });

  /**
   * The destination is checked on the **send**, not at registration. A registration-time
   * answer is a cached answer, and a cached answer is a DNS rebinding attack that passes
   * registration and fails at delivery.
   */
  it("re-resolves on every send, so a rebound name is refused after registration", async () => {
    let answer = ["93.184.216.34"];
    const deps = {db: fixture.db, resolve: async () => answer};

    const {endpoint: row} = await registerEndpoint(deps, {
      merchantId: merchantId(),
      url: "https://hooks.example.com/plazo",
    });

    const {calls, fetchImpl} = recorder(ok);
    const first = await deliver({...deps, fetchImpl}, row, {event: "a", data: {}});
    expect(first.ok).toBe(true);

    answer = ["169.254.169.254"];
    const second = await deliver({...deps, fetchImpl}, row, {event: "a", data: {}});

    expect(second.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("does not follow a redirect, and asks the runtime not to either", async () => {
    const {row} = await endpoint();
    const {calls, fetchImpl} = recorder(
      () => new Response(null, {status: 302, headers: {location: "http://169.254.169.254/"}}),
    );

    const outcome = await deliver({db: fixture.db, fetchImpl, resolve: publicDns}, row, {
      event: "a",
      data: {},
    });

    // Both halves: the runtime is told not to follow, and the 3xx that comes back is
    // treated as the failure rather than as a response.
    expect(calls[0]!.redirect).toBe("manual");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/redirect/);
  });

  it("carries the chain coordinates, because ordering is not promised", async () => {
    const {row} = await endpoint();
    const {calls, fetchImpl} = recorder(ok);

    await deliver({db: fixture.db, fetchImpl, resolve: publicDns}, row, {
      event: "payout.dispatched",
      planId: "0xdead",
      blockNumber: "54714174",
      logIndex: 7,
      data: {},
    });

    const sent = JSON.parse(calls[0]!.body) as {blockNumber: string; logIndex: number};
    expect(sent.blockNumber).toBe("54714174");
    expect(sent.logIndex).toBe(7);
  });
});

/**
 * A merchant's 500-page HTML error must not eat the table. The cap is enforced by the
 * writer, not by a column type, because it is a storage policy that will be tuned.
 */
describe("response body truncation", () => {
  it("stores a 6 KB response body truncated to 4 KB", async () => {
    const {row} = await endpoint();
    const huge = "x".repeat(6 * 1024);
    const {fetchImpl} = recorder(() => new Response(huge, {status: 500}));

    const outcome = await deliver({db: fixture.db, fetchImpl, resolve: publicDns}, row, {
      event: "a",
      data: {},
    });

    const stored = await getDelivery(fixture.db, row.merchantId, outcome.deliveryId);
    expect(Buffer.byteLength(stored!.responseBodyTruncated!, "utf8")).toBe(RESPONSE_BODY_CAP_BYTES);
    expect(stored!.responseBodyTruncated!.length).toBeLessThan(huge.length);
  });

  it("counts bytes, not code points, so a multibyte body is capped in the right unit", () => {
    const emoji = "😀".repeat(4000);
    expect(Buffer.byteLength(truncateBody(emoji), "utf8")).toBeLessThanOrEqual(RESPONSE_BODY_CAP_BYTES);
  });

  it("leaves a short body alone", () => {
    expect(truncateBody("ok")).toBe("ok");
  });
});

/**
 * Pitfall 8, and the single most common bug in this feature. A receiver deduping on
 * `webhook-id` — which is what they are told to do — silently drops a replay that reuses
 * the original id, and the merchant reports "replay does nothing".
 */
describe("replay", () => {
  it("sends a NEW webhook-id with the stored body verbatim, and links to the original", async () => {
    const {row, secret} = await endpoint();
    const {calls, fetchImpl} = recorder(ok);
    const deps = {db: fixture.db, fetchImpl, resolve: publicDns};

    const first = await deliver(deps, row, {event: "settlement.completed", data: {net: "1"}});
    const again = await replay(deps, first.deliveryId, row.merchantId);

    expect(again.webhookId).not.toBe(first.webhookId);
    expect(again.replayOf).toBe(first.deliveryId);
    expect(again.deliveryId).not.toBe(first.deliveryId);

    // Verbatim, byte for byte — a re-serialised event would be a different message with
    // the same name.
    expect(calls[1]!.body).toBe(calls[0]!.body);
    expect(calls[1]!.headers["webhook-id"]).not.toBe(calls[0]!.headers["webhook-id"]);

    // And it still verifies, because the id and timestamp are inside the signature.
    expect(standardVerify(secret, calls[1]!.headers, calls[1]!.body)).toBe(true);
  });

  it("keeps the original row, because the first failure is the evidence", async () => {
    const {row} = await endpoint();
    const {fetchImpl} = recorder((n) => new Response("", {status: n === 1 ? 500 : 200}));
    const deps = {db: fixture.db, fetchImpl, resolve: publicDns};

    const first = await deliver(deps, row, {event: "a", data: {}});
    await replay(deps, first.deliveryId, row.merchantId);

    const original = await getDelivery(fixture.db, row.merchantId, first.deliveryId);
    expect(original!.responseStatus).toBe(500);
    expect(await listDeliveries(fixture.db, row.merchantId)).toHaveLength(2);
  });

  it("refuses to replay another merchant's delivery", async () => {
    const {row} = await endpoint();
    const {fetchImpl} = recorder(ok);
    const deps = {db: fixture.db, fetchImpl, resolve: publicDns};

    const first = await deliver(deps, row, {event: "a", data: {}});
    await expect(replay(deps, first.deliveryId, merchantId())).rejects.toThrow(/no webhook delivery/);
  });
});

describe("the retry ladder and endpoint health", () => {
  it("gives up after seven attempts", () => {
    expect(nextAttemptDelayMs(MAX_ATTEMPTS)).toBeNull();
    expect(nextAttemptDelayMs(MAX_ATTEMPTS - 1)).toBeGreaterThan(0);
  });

  it("starts immediately and reaches a day", () => {
    expect(nextAttemptDelayMs(0, () => 0.5)).toBe(0);
    expect(nextAttemptDelayMs(6, () => 0.5)).toBe(86_400_000);
  });

  /**
   * Without jitter, every merchant whose endpoint failed in one incident retries in the
   * same millisecond, and the retry storm is what keeps the endpoint down.
   */
  it("jitters, so a fleet of failures does not retry in lockstep", () => {
    expect(nextAttemptDelayMs(1, () => 0)).toBe(24_000);
    expect(nextAttemptDelayMs(1, () => 1)).toBe(36_000);
  });

  it("marks an endpoint degraded, then disabled after 72 hours of failing", async () => {
    const {row} = await endpoint();
    const firstFailure = new Date("2026-08-01T00:00:00Z");

    const degraded = await noteEndpointFailure(
      {db: fixture.db, now: () => new Date(firstFailure.getTime() + 60_000)},
      row.id,
      firstFailure,
    );
    expect(degraded).toBe("degraded");

    const disabled = await noteEndpointFailure(
      {db: fixture.db, now: () => new Date(firstFailure.getTime() + DISABLE_AFTER_MS)},
      row.id,
      firstFailure,
    );
    expect(disabled).toBe("disabled");

    const [stored] = await fixture.db
      .select()
      .from(webhookEndpoint)
      .where(eq(webhookEndpoint.id, row.id));
    expect(stored!.status).toBe("disabled");
    expect(stored!.disabledAt).toBeInstanceOf(Date);
  });

  it("keys a job by event, plan, block and log index so a duplicate crank is a no-op", () => {
    expect(jobKey("payout.dispatched", "0xabc", 54_714_174n, 3)).toBe(
      "payout.dispatched:0xabc:54714174:3",
    );
    expect(jobKey("a", "0x1", 1n, 0)).toBe(jobKey("a", "0x1", "1", "0"));
  });
});

describe("registration", () => {
  it("refuses a private destination at registration, as a courtesy", async () => {
    await expect(
      registerEndpoint({db: fixture.db}, {merchantId: merchantId(), url: "https://127.0.0.1/x"}),
    ).rejects.toMatchObject({code: "loopback"});
  });

  it("scopes the delivery log to the merchant who owns it", async () => {
    const {row} = await endpoint();
    const {fetchImpl} = recorder(ok);
    await deliver({db: fixture.db, fetchImpl, resolve: publicDns}, row, {event: "a", data: {}});

    expect(await listDeliveries(fixture.db, row.merchantId)).toHaveLength(1);
    expect(await listDeliveries(fixture.db, merchantId())).toHaveLength(0);
  });

  it("stores the secret on the endpoint and nowhere near a delivery row", async () => {
    const {row, secret} = await endpoint();
    const {fetchImpl} = recorder(ok);
    const outcome = await deliver({db: fixture.db, fetchImpl, resolve: publicDns}, row, {
      event: "a",
      data: {},
    });

    const [stored] = await fixture.db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.id, outcome.deliveryId));
    expect(JSON.stringify(stored)).not.toContain(secret.slice("whsec_".length));
  });
});
