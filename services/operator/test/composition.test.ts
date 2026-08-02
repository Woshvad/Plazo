/**
 * The three seams, before and after.
 *
 * 06-06 left `ServicingDeps.merchants` defaulting to `denyAllMerchants` and `.webhooks` /
 * `.attestations` absent, so those routes answered **401** and **503**. Those defaults are
 * still there and are still correct — an unwired process should be shut, not open — which
 * means "the composition root wired them" is only a claim if the unwired shape is asserted
 * beside the wired one.
 *
 * So this file does both. Every route it proves works on the composed app, it first proves
 * refuses on a bare `createServicingApi({...nothing})`. A 200 that would also have been a
 * 200 before the wiring is not evidence of wiring.
 */
import {beforeAll, afterAll, describe, expect, it} from "vitest";

import {createServicingApi} from "@plazo/servicing";

import {composeOperator, merchantAuthFrom, NotComposed} from "../src/compose.js";
import {openOperatorDatabase, type OperatorTestDatabase} from "./db.fixture.js";

const PLAN_ID = "0x3a71c8e02f9d465b1e7a04c93f28d6b5079e14a3c8b60d92f5e37a1b48c609dd";
const OTHER_PLAN_ID = "0x91c0b64f2a9d38e778f2c19a4b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873ff";

/**
 * The unwired shape, exactly as it stands with no composition root.
 *
 * `merchants` is a parameter so the two defaults can be told apart. With it absent the
 * routes 401 on `denyAllMerchants`; with an authenticator supplied but `.webhooks` and
 * `.attestations` still missing, they 503. Both are 06-06's documented behaviour and both
 * are what the composed app has to stop doing.
 */
function unwiredServicing(merchants?: {verify: (presented: string) => Promise<unknown>}) {
  const refuse = () => {
    throw new Error("this suite never reaches a borrower-plane dependency");
  };
  return createServicingApi({
    deliveries: {for: async () => [], record: refuse, wasSent: async () => false} as never,
    audit: {} as never,
    now: () => new Date(),
    gate: "0x0000000000000000000000000000000000000000",
    ...(merchants ? {merchants: merchants as never} : {}),
    balanceOf: refuse as never,
    upcomingFor: refuse as never,
    plansOf: refuse as never,
    scheduleOf: refuse as never,
    collectionsSince: refuse as never,
    operatorFor: refuse as never,
    settleWaiver: refuse as never,
    sendParameter: refuse as never,
    sendPause: refuse as never,
    resend: refuse as never,
  });
}

/** An authenticator that says yes, so the *next* default is the one being observed. */
const ALWAYS = {
  verify: async () => ({merchantId: "00000000-0000-4000-8000-000000000000", keyId: "k", environment: "sandbox"}),
};

describe("the operator composition root", () => {
  let database: OperatorTestDatabase;
  let app: ReturnType<typeof composeOperator>["app"];
  let key: string;
  let otherKey: string;
  let merchantId: string;

  beforeAll(async () => {
    database = await openOperatorDatabase();
    app = composeOperator({
      databaseUrl: database.url,
      environment: "sandbox",
      /**
       * Registration resolves the hostname and checks every address it gets back — on
       * every call, by design. A `.test` name does not resolve, so without this the guard
       * refuses the registration and the suite would be asserting DNS rather than wiring.
       * `203.0.113.10` is TEST-NET-3: a real public address the guard has no reason to
       * refuse. The guard is still the thing deciding; only its input is supplied.
       */
      delivery: {resolve: async () => ["203.0.113.10"]},
    }).app;

    const open = async (address: string) => {
      const response = await app.request("/sandbox", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({address}),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as {merchantId: string; secret: string};
    };

    const first = await open("0x00000000000000000000000000000000000acced");
    const second = await open("0x00000000000000000000000000000000000beef0");
    key = first.secret;
    merchantId = first.merchantId;
    otherKey = second.secret;

    // The attestation route reads two tables that only exist together in this process:
    // `payout_attestation` (servicing's) and `merchant_external_ref` (origination's).
    const sql = database.raw();
    await sql`insert into operator.payout_attestation
                (plan_id, destination_domain, tx_hash, message, attestation, status, attempts)
              values (${PLAN_ID}, 6, '0xb90e14a3', '0xdeadbeef', '0xfeed', 'complete', 3),
                     (${OTHER_PLAN_ID}, 6, '0x0af9b2d8', null, null, 'pending', 11)`;
    await sql`insert into operator.merchant_external_ref (plan_id, merchant_id, external_id)
              values (${PLAN_ID}, ${merchantId}::uuid, 'A-10433')`;
  });

  afterAll(async () => {
    await database.close();
  });

  const auth = (presented: string) => ({authorization: `Bearer ${presented}`});

  // ── Seam 1: ServicingDeps.merchants ─────────────────────────────────────────

  describe("seam 1 — merchants", () => {
    it("answered 401 with nothing wired, for every merchant route", async () => {
      const bare = unwiredServicing();
      for (const path of ["/v1/webhooks/deliveries", `/v1/payouts/${PLAN_ID}/attestation`]) {
        const response = await bare.request(path, {headers: auth("plazo_test_abc_def")});
        expect(response.status, path).toBe(401);
      }
    });

    it("resolves a real key to a real merchant on the composed app", async () => {
      const response = await app.request("/v1/webhooks/deliveries", {headers: auth(key)});
      expect(response.status).toBe(200);
    });

    it("turns a bad key into a 401 and not a 500 — the adapter, doing its job", async () => {
      // `MerchantPlane.verify` throws `KeyError`; `MerchantAuth.verify` is documented never
      // to throw for a bad key. Passing one straight into the other is the obvious wiring
      // and it would turn every expired credential into a 500 with a stack trace.
      for (const bad of ["plazo_test_deadbeef_notasecret", "nonsense", "plazo_live_x_y"]) {
        const response = await app.request("/v1/webhooks/deliveries", {headers: auth(bad)});
        expect([400, 401], bad).toContain(response.status);
      }
    });

    it("rethrows anything that is not a bad key, rather than reporting it as one", async () => {
      const boom = new Error("the database went away");
      const adapter = merchantAuthFrom({
        verify: async () => {
          throw boom;
        },
      } as never);
      await expect(adapter.verify("plazo_test_a_b")).rejects.toThrow("the database went away");
    });

    it("still refuses a key presented in a query string, with the instruction to rotate", async () => {
      const response = await app.request(`/v1/webhooks/deliveries?api_key=${key}`);
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain("rotate");
    });
  });

  // ── Seam 2: ServicingDeps.webhooks ──────────────────────────────────────────

  describe("seam 2 — webhooks", () => {
    it("answered 503 with an authenticator but no console, for every webhook route", async () => {
      const bare = unwiredServicing(ALWAYS);
      const calls: [string, RequestInit][] = [
        ["/v1/webhooks/endpoints", {method: "POST", body: "{}"}],
        ["/v1/webhooks/endpoints", {}],
        ["/v1/webhooks/deliveries", {}],
        ["/v1/webhooks/deliveries/dlv_1", {}],
        ["/v1/webhooks/deliveries/dlv_1/replay", {method: "POST"}],
      ];
      for (const [path, init] of calls) {
        const response = await bare.request(path, {
          ...init,
          headers: {"content-type": "application/json", authorization: "Bearer plazo_test_a_b"},
        });
        expect(response.status, `${init.method ?? "GET"} ${path}`).toBe(503);
      }
    });

    it("answered 503 on the attestation route too", async () => {
      const bare = unwiredServicing(ALWAYS);
      const response = await bare.request(`/v1/payouts/${PLAN_ID}/attestation`, {
        headers: {authorization: "Bearer plazo_test_a_b"},
      });
      expect(response.status).toBe(503);
    });

    it("registers, lists and reads back a destination", async () => {
      const created = await app.request("/v1/webhooks/endpoints", {
        method: "POST",
        headers: {...auth(key), "content-type": "application/json"},
        body: JSON.stringify({url: "https://hooks.example-merchant.test/plazo"}),
      });
      expect(created.status).toBe(201);

      const listed = await app.request("/v1/webhooks/endpoints", {headers: auth(key)});
      expect(listed.status).toBe(200);
      const {endpoints} = (await listed.json()) as {
        endpoints: {url: string; status: string; signingSecretCount: number}[];
      };
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0]!.url).toBe("https://hooks.example-merchant.test/plazo");
      expect(endpoints[0]!.signingSecretCount).toBe(1);
    });

    it("never returns a signing secret from the list route", async () => {
      const listed = await app.request("/v1/webhooks/endpoints", {headers: auth(key)});
      expect(JSON.stringify(await listed.json())).not.toContain("whsec_");
    });

    it("does not show one merchant another merchant's destinations", async () => {
      const listed = await app.request("/v1/webhooks/endpoints", {headers: auth(otherKey)});
      expect((await listed.json()) as {endpoints: unknown[]}).toEqual({endpoints: []});
    });

    it("refuses an SSRF destination at registration too, with the rule that fired", async () => {
      const response = await app.request("/v1/webhooks/endpoints", {
        method: "POST",
        headers: {...auth(key), "content-type": "application/json"},
        body: JSON.stringify({url: "https://169.254.169.254/latest/meta-data/"}),
      });
      expect(response.status).toBe(400);
      expect((await response.json()) as {error: string}).toMatchObject({error: "link-local"});
    });
  });

  // ── Seam 3: ServicingDeps.attestations, and its ownership predicate ──────────

  describe("seam 3 — attestations", () => {
    it("answers with the message and the attestation for a plan this merchant filed", async () => {
      const response = await app.request(`/v1/payouts/${PLAN_ID}/attestation`, {headers: auth(key)});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        planId: PLAN_ID,
        domain: 6,
        status: "complete",
        message: "0xdeadbeef",
        attestation: "0xfeed",
        attempts: 3,
      });
    });

    it("does not confirm another merchant's plan exists — a miss is 404, never 403", async () => {
      const response = await app.request(`/v1/payouts/${PLAN_ID}/attestation`, {
        headers: auth(otherKey),
      });
      expect(response.status).toBe(404);
    });

    it("is a 404 for a plan nobody filed a reference against, even with a real attestation row", async () => {
      // DEC-65's cost, asserted rather than described: ownership is the
      // `merchant_external_ref` join and its absence is a "no", not a "probably".
      const response = await app.request(`/v1/payouts/${OTHER_PLAN_ID}/attestation`, {
        headers: auth(key),
      });
      expect(response.status).toBe(404);
    });
  });

  // ── One process, two services ───────────────────────────────────────────────

  describe("one process, two services", () => {
    it("serves origination and servicing routes off the same origin", async () => {
      const keys = await app.request("/v1/keys", {headers: auth(key)});
      const hooks = await app.request("/v1/webhooks/endpoints", {headers: auth(key)});
      expect(keys.status).toBe(200);
      expect(hooks.status).toBe(200);
    });

    it("has a liveness route that makes no claim about the database", async () => {
      const response = await app.request("/health");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ok: true});
    });

    it("answers 501 and names the owner for a seam this process does not fill", async () => {
      const response = await app.request("/me/summary", {
        headers: {"x-plazo-borrower": "0x00000000000000000000000000000000000acced"},
      });
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({
        error: "not-composed",
        seam: "servicing.balanceOf",
      });
    });

    it("refuses to come up at all without a database", () => {
      expect(() => composeOperator({databaseUrl: ""})).toThrow(/no in-memory mode/);
    });

    it("names its seam and its owner on the error itself, not only in the response", () => {
      const error = new NotComposed("servicing.operatorFor", "OPS-07");
      expect(error.message).toContain("servicing.operatorFor");
      expect(error.message).toContain("OPS-07");
    });
  });

  // ── PLAZO_ENVIRONMENT, which decides which world a deployment serves ────────

  describe("the environment gate", () => {
    it("refuses a sandbox key on a live deployment, on shape", async () => {
      const live = composeOperator({databaseUrl: database.url, environment: "live"}).app;
      const response = await live.request("/v1/keys", {headers: auth(key)});
      expect(response.status).toBe(401);
    });

    it("defaults to sandbox, so a deployment that forgets refuses live keys rather than serving them", () => {
      const previous = process.env["PLAZO_ENVIRONMENT"];
      delete process.env["PLAZO_ENVIRONMENT"];
      try {
        expect(composeOperator({databaseUrl: database.url}).environment).toBe("sandbox");
      } finally {
        if (previous !== undefined) process.env["PLAZO_ENVIRONMENT"] = previous;
      }
    });
  });
});
