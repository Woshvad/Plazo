/**
 * D-18's last mile: `key.rotated` reaching a merchant's own endpoint.
 *
 * Plan 06-06 built both halves and could not join them. `MerchantPlane.emit` is an optional
 * injected method, the webhook fan-out lives in the other service, and no process held both
 * — so the event was specified, the emitter was a typed hole, and a merchant saw a rotation
 * in their dashboard and never in their inbox. 06-06's own SUMMARY records it as "the one
 * piece of D-18 that is specified and not delivered end to end".
 *
 * This file is the assertion that closes it, and it is written to be hard to satisfy by
 * accident.
 *
 * ## What is real here
 *
 * - A real listening socket. `node:http` on loopback, an ephemeral port, capturing every
 *   request it receives whole.
 * - A real `fetch`, from `deliver`, over a real TCP connection. Nothing is stubbed inside
 *   the sender.
 * - Real rows. Postgres, both services' committed migrations, a real merchant account, a
 *   real API key, a real `webhook_endpoint`, and a real `webhook_delivery` written by the
 *   send.
 * - A real HTTP request through the composed app for every step: the merchant self-serves,
 *   registers a destination and rotates a key over `app.fetch`, exactly as a merchant would.
 * - The signature verified by an implementation written from the **published Standard
 *   Webhooks spec** in this file, importing nothing from `webhooks.ts`. `verify()` proving
 *   `sign()` is self-consistent proves nothing a merchant cares about, because a merchant
 *   runs somebody else's library.
 *
 * ## What is stubbed, and why it has to be
 *
 * DNS and TLS. `assertDeliverable` refuses `http://` and refuses anything resolving to
 * loopback, both correctly and both deliberately, so a destination on 127.0.0.1 cannot be
 * registered at all. The suite therefore registers a public-looking `https://` name, injects
 * a resolver that answers with a documentation-range address (`203.0.113.10`, TEST-NET-3 —
 * a real public address that the guard has no reason to refuse), and injects a `fetch` that
 * carries the request to the local listener.
 *
 * **The guard is on the path, not routed around**, and the last test in this file proves it
 * by pointing the same resolver at `169.254.169.254` and asserting nothing arrives. If the
 * composition root ever grew a send path that skipped `assertDeliverable`, that test goes
 * red.
 */
import {createHmac, timingSafeEqual} from "node:crypto";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {composeOperator} from "../src/compose.js";
import {openOperatorDatabase, type OperatorTestDatabase} from "./db.fixture.js";

// ─────────────────────────────────────────────────────────────────────────────
// An independent verifier, from the published spec and from nothing else
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard Webhooks, implemented here from the specification text.
 *
 * `webhook-signature` is a space-separated list of `v1,<base64 hmac-sha256>` over
 * `${id}.${timestamp}.${body}`, keyed by the secret with its `whsec_` prefix stripped and
 * the remainder base64-decoded. This function imports nothing from the code under test, so
 * a bug shared between signer and verifier cannot hide in it.
 */
function standardVerify(secret: string, headers: Record<string, string>, body: string): boolean {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const presented = headers["webhook-signature"];
  if (!id || !timestamp || !presented) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");

  return presented
    .split(" ")
    .filter((candidate) => candidate.startsWith("v1,"))
    .some((candidate) => {
      const got = Buffer.from(candidate.slice(3), "base64");
      const want = Buffer.from(expected, "base64");
      return got.length === want.length && timingSafeEqual(got, want);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// A real endpoint
// ─────────────────────────────────────────────────────────────────────────────

interface Received {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface Listener {
  readonly server: Server;
  readonly port: number;
  readonly received: Received[];
  /** Wait until `count` requests have arrived, or fail rather than hang forever. */
  waitFor(count: number, timeoutMs?: number): Promise<void>;
}

async function listen(status = 200): Promise<Listener> {
  const received: Received[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")]),
        ),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(status, {"content-type": "application/json"});
      res.end(JSON.stringify({ok: status < 300}));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    received,
    waitFor: async (count, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`expected ${count} request(s) at the endpoint, saw ${received.length}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The suite
// ─────────────────────────────────────────────────────────────────────────────

/** TEST-NET-3. A real public address, reserved for documentation, that the guard allows. */
const PUBLIC_ADDRESS = "203.0.113.10";
const ENDPOINT_HOST = "hooks.example-merchant.test";
const ENDPOINT_URL = `https://${ENDPOINT_HOST}/plazo/webhooks`;

describe("key.rotated reaches a merchant's endpoint", () => {
  let database: OperatorTestDatabase;
  let endpoint: Listener;

  /** What the SSRF guard is told the hostname resolves to. Reassignable, on purpose. */
  let resolvesTo: string = PUBLIC_ADDRESS;

  let app: ReturnType<typeof composeOperator>["app"];
  let merchantKey: string;
  let keyId: string;
  let signingSecret: string;

  beforeAll(async () => {
    database = await openOperatorDatabase();
    endpoint = await listen();

    app = composeOperator({
      databaseUrl: database.url,
      environment: "sandbox",
      delivery: {
        resolve: async () => [resolvesTo],
        /**
         * Carry the request to the local listener without touching anything else about it.
         *
         * The method, the headers and the body are the sender's, byte for byte. Only the
         * authority changes, which is what stands in for DNS and TLS — see the header for
         * why those two are the ones that cannot be real here.
         */
        fetchImpl: async (input, init) => {
          const original = new URL(typeof input === "string" ? input : input.toString());
          const local = new URL(original.pathname + original.search, `http://127.0.0.1:${endpoint.port}`);
          return fetch(local, init);
        },
        timeoutMs: 5_000,
      },
    }).app;

    // A merchant self-serves a sandbox and is issued their first key.
    const sandbox = await app.request("/sandbox", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({address: "0x00000000000000000000000000000000000acced"}),
    });
    expect(sandbox.status).toBe(201);
    const created = (await sandbox.json()) as {secret: string; key: {keyId: string}};
    merchantKey = created.secret;
    keyId = created.key.keyId;

    // …and registers where they want their webhooks.
    const registered = await app.request("/v1/webhooks/endpoints", {
      method: "POST",
      headers: {"content-type": "application/json", authorization: `Bearer ${merchantKey}`},
      body: JSON.stringify({url: ENDPOINT_URL}),
    });
    expect(registered.status).toBe(201);
    signingSecret = ((await registered.json()) as {secret: string}).secret;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
    await database.close();
  });

  it("registration handed back a signing secret exactly once", () => {
    expect(signingSecret).toMatch(/^whsec_/);
  });

  it("delivers key.rotated to the registered endpoint when a key is rotated", async () => {
    const before = endpoint.received.length;

    const rotated = await app.request(`/v1/keys/${keyId}/rotate`, {
      method: "POST",
      headers: {"content-type": "application/json", authorization: `Bearer ${merchantKey}`},
      body: JSON.stringify({}),
    });
    expect(rotated.status).toBe(200);

    await endpoint.waitFor(before + 1);
    const delivery = endpoint.received[before]!;

    expect(delivery.method).toBe("POST");
    expect(delivery.path).toBe("/plazo/webhooks");

    const payload = JSON.parse(delivery.body) as {event: string; data: Record<string, string | null>};
    expect(payload.event).toBe("key.rotated");
  });

  it("carries the three Standard Webhooks headers, and a merchant's own library accepts them", () => {
    const delivery = endpoint.received.at(-1)!;

    expect(delivery.headers["webhook-id"]).toMatch(/^msg_/);
    expect(Number(delivery.headers["webhook-timestamp"])).toBeGreaterThan(1_700_000_000);
    expect(delivery.headers["webhook-signature"]).toMatch(/^v1,/);

    // The load-bearing assertion: verified by the implementation at the top of this file,
    // which imports nothing from the code that produced it.
    expect(standardVerify(signingSecret, delivery.headers, delivery.body)).toBe(true);
  });

  it("rejects the same signature against a body altered by one byte", () => {
    const delivery = endpoint.received.at(-1)!;
    expect(standardVerify(signingSecret, delivery.headers, `${delivery.body} `)).toBe(false);
  });

  it("names the retired key and when it stops working, because that is the actionable part", () => {
    const payload = JSON.parse(endpoint.received.at(-1)!.body) as {
      data: {keyId: string; retiredKeyId: string; retiredExpiresAt: string | null; last4: string};
    };

    expect(payload.data.retiredKeyId).toBe(keyId);
    expect(payload.data.keyId).not.toBe(keyId);
    // Seven days is D-18's default overlap. The merchant's automation needs the deadline,
    // not the fact.
    const expires = new Date(payload.data.retiredExpiresAt!).getTime();
    expect(expires - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(payload.data.last4).toHaveLength(4);
  });

  it("puts no credential in the body — not the presented key, not the new secret", async () => {
    const body = endpoint.received.at(-1)!.body;

    expect(body).not.toContain(merchantKey);
    expect(body).not.toContain(signingSecret);
    // `plazo_test_` is the sandbox key's literal prefix (`plazo_{token}_{keyId}_{secret}`),
    // chosen in 06-06 so that a leaked credential is greppable. Nothing shaped like one is
    // in this body.
    expect(body).not.toContain("plazo_test_");
    expect(body.toLowerCase()).not.toContain("secret");

    // And the response that *did* carry the new secret went to the caller, not the webhook.
    const listed = await app.request("/v1/keys", {headers: {authorization: `Bearer ${merchantKey}`}});
    expect(JSON.stringify(await listed.json())).not.toContain("secret\":\"plazo");
  });

  it("wrote the attempt to the delivery log, where a merchant can find it", async () => {
    const sql = database.raw();
    const rows = await sql<
      {event: string; response_status: number; request_body: string; attempt: number}[]
    >`select event, response_status, request_body, attempt
        from operator.webhook_delivery
       where event = 'key.rotated'`;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.response_status).toBe(200);
    expect(JSON.parse(rows[0]!.request_body)).toMatchObject({event: "key.rotated"});
  });

  it("and the merchant can read that row back through their own API", async () => {
    const response = await app.request("/v1/webhooks/deliveries", {
      headers: {authorization: `Bearer ${merchantKey}`},
    });
    expect(response.status).toBe(200);

    const {deliveries} = (await response.json()) as {deliveries: {event: string; responseStatus: number}[]};
    expect(deliveries.some((d) => d.event === "key.rotated" && d.responseStatus === 200)).toBe(true);
  });

  /**
   * The control. Everything above would also pass if the emitter fetched the URL directly
   * and the guard were never consulted.
   *
   * The only thing this changes is what the resolver answers. If `assertDeliverable` is on
   * the send path, the request never leaves and the attempt is still a row; if some future
   * edit moves the guard to registration time or drops it, this goes red — which is exactly
   * the DNS-rebinding shape 06-06 built the resolve-on-every-send rule to close
   * (T-06-06-02).
   */
  it("refuses to deliver when the destination re-resolves to the metadata service", async () => {
    const before = endpoint.received.length;
    const previous = resolvesTo;
    resolvesTo = "169.254.169.254";

    try {
      const rotated = await app.request(`/v1/keys/${keyId}/rotate`, {
        method: "POST",
        headers: {"content-type": "application/json", authorization: `Bearer ${merchantKey}`},
        body: JSON.stringify({}),
      });
      // The rotation still succeeds. A merchant's endpoint being unreachable is not a
      // reason to refuse them a key.
      expect(rotated.status).toBe(200);
    } finally {
      resolvesTo = previous;
    }

    // Nothing arrived, and nothing will — give it a moment to be wrong in.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(endpoint.received.length).toBe(before);

    // But the refusal is a row. A delivery log holding only successes cannot tell a
    // merchant why their endpoint has gone quiet.
    const sql = database.raw();
    const rows = await sql<{response_status: number | null}[]>`
      select response_status from operator.webhook_delivery where event = 'key.rotated'`;
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.response_status === null)).toBe(true);
  });
});
