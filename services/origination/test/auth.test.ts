/**
 * The middleware, the token bucket, and the routes that hang off them.
 *
 * The claim under test is the one the old header comment admitted was false: that a
 * merchant identity comes from a verified key and from nothing else. So the assertions
 * are mostly about refusals — no header, wrong scheme, a key in a url, another merchant's
 * key id — because an authorization layer is defined by what it will not do.
 *
 * The bucket runs against real Postgres. An in-memory rate limiter would agree with any
 * implementation, including one that resets on every process, which is the exact defect
 * the Postgres bucket exists to avoid.
 */
import {beforeAll, afterAll, describe, expect, it} from "vitest";

import {createApi, type MerchantPlane} from "../src/api.js";
import {createSandboxMerchant, KeyError, verifyKey, type IssuedKey} from "../src/keys.js";
import {consume, tokenBucket, unlimited} from "../src/ratelimit.js";
import {openTestDatabase, type TestDatabase} from "./db.fixture.js";
import {InMemorySessionStore} from "../src/session.js";

let fixture: TestDatabase;

beforeAll(async () => {
  fixture = await openTestDatabase();
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

let nextAddress = 0;
const address = (): `0x${string}` => `0x${(++nextAddress).toString(16).padStart(40, "0")}` as `0x${string}`;

/**
 * The plane, wired to real keys but with a `prepare` that does no underwriting.
 *
 * The routes under test here are the authentication ones; the quote path has its own
 * suite and does not need to be re-proved through a middleware.
 */
function plane(): MerchantPlane {
  return {
    verify: (presented) => verifyKey(fixture.db, presented, {environment: "sandbox"}),
    issue: async () => {
      throw new Error("not exercised");
    },
    list: async () => [],
    rotate: async () => {
      throw new Error("not exercised");
    },
    revoke: async () => {
      throw new Error("not exercised");
    },
    selfServeSandbox: (addr) => createSandboxMerchant(fixture.db, addr),
    linkExternalRef: async () => undefined,
  };
}

function api(overrides: Partial<MerchantPlane> = {}, limiter = unlimited) {
  return createApi({
    sessions: new InMemorySessionStore(),
    prepare: async () => {
      throw new Error("not exercised");
    },
    merchants: {...plane(), ...overrides},
    limiter,
    signupLimiter: limiter,
  });
}

async function sandboxKey(): Promise<IssuedKey> {
  return (await createSandboxMerchant(fixture.db, address())).issued;
}

describe("requireKey", () => {
  it("refuses a request with no Authorization header", async () => {
    const response = await api().request("/v1/keys");
    expect(response.status).toBe(401);
  });

  it("refuses a credential that is not a Bearer one", async () => {
    const {key} = await sandboxKey();
    const response = await api().request("/v1/keys", {headers: {authorization: `Basic ${key}`}});
    expect(response.status).toBe(401);
  });

  /**
   * A key in a query string is already in an access log, a `Referer` and browser history.
   * Accepting it hides the leak; ignoring it presents as a confusing 401. Refusing it
   * with an instruction to rotate is the only answer that helps.
   */
  it("refuses a key presented as a query parameter, and says to rotate it", async () => {
    const {key} = await sandboxKey();
    const response = await api().request(`/v1/keys?api_key=${key}`, {
      headers: {authorization: `Bearer ${key}`},
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {error: string; message: string};
    expect(body.error).toBe("key-in-query");
    expect(body.message).toMatch(/rotate/);
  });

  it("puts the merchant on the context so a route never reads one from a request", async () => {
    const created = await createSandboxMerchant(fixture.db, address());
    const listed: string[] = [];

    const response = await api({
      list: async (merchantId) => {
        listed.push(merchantId);
        return [];
      },
    }).request("/v1/keys", {headers: {authorization: `Bearer ${created.issued.key}`}});

    expect(response.status).toBe(200);
    expect(listed).toEqual([created.merchantId]);
  });

  it("maps a malformed key to 400 and a rejected one to 401", async () => {
    const app = api();
    expect((await app.request("/v1/keys", {headers: {authorization: "Bearer nonsense"}})).status).toBe(400);
    expect(
      (await app.request("/v1/keys", {headers: {authorization: "Bearer plazo_test_nope_nope"}})).status,
    ).toBe(401);
  });

  it("leaves the sandbox door open, because it is where the first key comes from", async () => {
    const response = await api().request("/sandbox", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({address: address()}),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {secret: string; key: {last4: string}};
    expect(body.secret.startsWith("plazo_test_")).toBe(true);
    expect(body.secret.endsWith(body.key.last4)).toBe(true);
  });

  it("validates the sandbox body rather than trusting it", async () => {
    const response = await api().request("/sandbox", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({address: "not-an-address"}),
    });
    expect(response.status).toBe(400);
  });

  it("surfaces a KeyError from the plane rather than a 500", async () => {
    const response = await api({
      verify: async () => {
        throw new KeyError("api key was revoked", "revoked");
      },
    }).request("/v1/keys", {headers: {authorization: "Bearer plazo_test_abc_def"}});

    expect(response.status).toBe(401);
    expect((await response.json()) as {error: string}).toMatchObject({error: "revoked"});
  });
});

describe("the Postgres token bucket", () => {
  const policy = {limit: 3, windowMs: 60_000};

  it("spends tokens and then refuses, in one window", async () => {
    const key = `k-${address()}`;
    const now = new Date("2026-08-02T12:00:00Z");

    const first = await consume(fixture.db, key, policy, now);
    expect(first).toMatchObject({allowed: true, remaining: 2});
    expect((await consume(fixture.db, key, policy, now)).remaining).toBe(1);
    expect((await consume(fixture.db, key, policy, now)).remaining).toBe(0);

    const refused = await consume(fixture.db, key, policy, now);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
  });

  /**
   * The count never comes into JavaScript and goes back out again, so two callers racing
   * cannot both see "one token left". Twenty concurrent calls against a limit of three
   * must let exactly three through.
   */
  it("does not let a race spend the same token twice", async () => {
    const key = `race-${address()}`;
    const now = new Date("2026-08-02T13:00:00Z");

    const results = await Promise.all(
      Array.from({length: 20}, () => consume(fixture.db, key, policy, now)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(policy.limit);
  });

  it("refills when the window rolls over", async () => {
    const key = `roll-${address()}`;
    const first = new Date("2026-08-02T14:00:00Z");
    for (let i = 0; i < policy.limit; i++) await consume(fixture.db, key, policy, first);
    expect((await consume(fixture.db, key, policy, first)).allowed).toBe(false);

    const next = new Date(first.getTime() + policy.windowMs);
    expect((await consume(fixture.db, key, policy, next)).allowed).toBe(true);
  });

  it("refuses the request rather than throwing, and says when to retry", async () => {
    const key = `retry-${address()}`;
    const now = new Date("2026-08-02T15:00:00Z");
    for (let i = 0; i < policy.limit; i++) await consume(fixture.db, key, policy, now);

    const refused = await consume(fixture.db, key, policy, now);
    expect(refused.resetAt.getTime()).toBe(
      Math.floor(now.getTime() / policy.windowMs) * policy.windowMs + policy.windowMs,
    );
  });

  it("answers a 429 through the middleware, with a retry-after", async () => {
    const created = await createSandboxMerchant(fixture.db, address());
    const limiter = tokenBucket(fixture.db, {limit: 1, windowMs: 60_000});
    const app = api({}, limiter);
    const headers = {authorization: `Bearer ${created.issued.key}`};

    expect((await app.request("/v1/keys", {headers})).status).toBe(200);

    const refused = await app.request("/v1/keys", {headers});
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();
  });
});
