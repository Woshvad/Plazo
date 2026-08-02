/**
 * The two-service data layer.
 *
 * Four properties are worth asserting here and the rest is scaffolding:
 *
 * 1. **Unconfigured means sampled, and sampled reaches the UI.** Every payload is
 *    `live: false` with a reason, and no network call is attempted — a dashboard that
 *    quietly hit an unconfigured host would fail slowly rather than say so.
 * 2. **The sample shape is the live shape.** Asserted twice: once at the type level, where
 *    the sample constants are already declared as the payload type so drift is a build
 *    error, and once at runtime by comparing key sets against a stubbed live response.
 * 3. **Money round-trips through `bigint` exactly.** The wrong answer is well-formed and
 *    silent.
 * 4. **A failing fetch throws.** Degrading to a sample on a 500 would put unlabelled
 *    fixture money on a screen that says it is live, which is the one failure the whole
 *    `live` flag exists to prevent.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {
  PAYOUT_STATUSES,
  SOURCE_ENV,
  attestations,
  dataUrl,
  deliveries,
  endpoints,
  escrows,
  keys,
  previewFor,
  refunds,
  scheduleAfter,
  settlements,
  treasury,
  until,
  usd,
  type Settlement,
  type Settlements,
} from "../app/_data";

const MERCHANT = "0x00000000000000000000000000000000000acced";

const LIVE_SETTLEMENT: Settlement = {
  planId: "0xaa2c19a4b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873a5e1c0b64f2a9d38e01",
  externalId: "ORD-99001",
  gross: "9007199254740993000000",
  mdr: "5040000",
  withheld: "12096000",
  net: "9007199254740975864000",
  refundedAmount: "0",
  payoutDomain: 26,
  payoutStatus: "settled",
  escrowState: null,
  txHash: "0xbb1d0f2a9b7e35d016c4a9f2e83b7d5a1c6e04f9b2d873a5e1c0b64f2a9d38e10",
  dispatchTxHash: null,
  blockNumber: "54714201",
  timestamp: 1_754_060_400,
};

/**
 * A stubbed `fetch` that records what it was called with.
 *
 * The parameters are declared even though the body ignores them: `vi.fn(async () => …)`
 * types `mock.calls` as an empty tuple, and the assertions below are entirely about the
 * URL and the headers this app sends.
 */
function stubFetch(body: unknown, status = 200) {
  const spy = vi.fn(async (_input: string | URL, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const ENV_KEYS = [
  "PLAZO_INDEXER_URL",
  "PLAZO_SERVICING_URL",
  "PLAZO_ORIGINATION_URL",
  "PLAZO_MERCHANT_ADDRESS",
  "PLAZO_MERCHANT_API_KEY",
];

beforeEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

// ─────────────────────────────────────────────────────────────────────────────

describe("with nothing configured", () => {
  it("labels every payload as a sample and says why", async () => {
    const payloads = [
      await settlements(),
      await attestations(["0xdead"]),
      await deliveries(),
      await keys(),
      await endpoints(),
      await escrows(),
      await refunds(),
      await treasury(),
    ];

    for (const payload of payloads) {
      expect(payload.live).toBe(false);
      expect(payload.sampled.length).toBeGreaterThan(0);
    }
  });

  it("names the environment variable that would make each service payload live", async () => {
    expect((await settlements()).sampled).toContain("PLAZO_INDEXER_URL");
    expect((await deliveries()).sampled).toContain("PLAZO_SERVICING_URL");
    expect((await keys()).sampled).toContain("PLAZO_ORIGINATION_URL");
  });

  it("does not pretend a chain-sourced payload has an env var behind it", async () => {
    const book = await treasury();
    expect(book.source).toBe("chain");
    // There is no single `PLAZO_*_URL` that turns these on: they are contract reads and
    // what they need is an address per contract. The reason says so and points at the file
    // that lists them, rather than naming a variable that does not exist.
    expect(SOURCE_ENV[book.source]).toBeNull();
    expect(book.sampled).toMatch(/contract addresses/);
    expect(book.sampled).toContain("_chain.ts");
  });

  it("reaches no network at all", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await Promise.all([settlements(), deliveries(), keys(), escrows(), refunds(), treasury()]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("stays sampled when the indexer is configured but the merchant address is not", async () => {
    process.env["PLAZO_INDEXER_URL"] = "https://indexer.example";
    const spy = stubFetch({settlements: []});
    const book = await settlements();
    expect(book.live).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the sample shape and the live shape", () => {
  it("carries the same fields on a settlement row, field for field", async () => {
    const sampled = await settlements();

    process.env["PLAZO_INDEXER_URL"] = "https://indexer.example";
    process.env["PLAZO_MERCHANT_ADDRESS"] = MERCHANT;
    stubFetch({settlements: [LIVE_SETTLEMENT]});
    const live = await settlements();

    const sampleRow = sampled.settlements[0];
    const liveRow = live.settlements[0];
    expect(sampleRow).toBeDefined();
    expect(liveRow).toBeDefined();
    expect(Object.keys(sampleRow as object).sort()).toEqual(Object.keys(liveRow as object).sort());
  });

  it("is assignable to the live payload type, so the two cannot drift", async () => {
    // The compiler is the assertion. `settlements()` returns `Settlements` on both
    // branches, so a sample that grew or lost a field would fail `tsc --noEmit` before
    // this file ran. Binding it to the type here states the intent for a reader.
    const sampled: Settlements = await settlements();
    expect(sampled.settlements.length).toBeGreaterThan(0);
  });

  it("only ever offers filter statuses the indexer accepts", () => {
    expect([...PAYOUT_STATUSES]).toEqual(["settled", "queued", "dispatched", "escrowed", "returned"]);
  });
});

describe("against a stubbed service", () => {
  beforeEach(() => {
    process.env["PLAZO_INDEXER_URL"] = "https://indexer.example";
    process.env["PLAZO_MERCHANT_ADDRESS"] = MERCHANT;
  });

  it("marks the payload live and round-trips money to bigint exactly", async () => {
    stubFetch({settlements: [LIVE_SETTLEMENT]});
    const book = await settlements();

    expect(book.live).toBe(true);
    expect(book.sampled).toBe("");
    const row = book.settlements[0];
    expect(row).toBeDefined();
    // Past `Number.MAX_SAFE_INTEGER` by design: a float would return a neighbour.
    expect(BigInt(row?.gross ?? "0")).toBe(9_007_199_254_740_993_000_000n);
    expect(BigInt(row?.gross ?? "0") - BigInt(row?.mdr ?? "0") - BigInt(row?.withheld ?? "0")).toBe(
      BigInt(row?.net ?? "0"),
    );
  });

  it("addresses the merchant from configuration and passes the filters through", async () => {
    const spy = stubFetch({settlements: []});
    await settlements({status: "dispatched", from: "54714174", to: "54908266"});

    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain(`/v1/merchants/${MERCHANT}/settlements`);
    expect(url).toContain("status=dispatched");
    expect(url).toContain("from=54714174");
    expect(url).toContain("to=54908266");
  });

  it("sends the key as a bearer header and never as a query parameter", async () => {
    process.env["PLAZO_MERCHANT_API_KEY"] = "plazo_sandbox_3f9c2a71b04e8d55_s3cr3t_value";
    const spy = stubFetch({settlements: []});
    await settlements();

    const [url, init] = spy.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("s3cr3t");
    expect(String(url)).not.toMatch(/[?&](api_?key|key|token)=/i);
    expect((init as RequestInit | undefined)?.headers).toEqual({
      authorization: "Bearer plazo_sandbox_3f9c2a71b04e8d55_s3cr3t_value",
    });
  });

  it("refuses to send the key to a cleartext origin rather than leaking it", async () => {
    process.env["PLAZO_INDEXER_URL"] = "http://indexer.example";
    process.env["PLAZO_MERCHANT_API_KEY"] = "plazo_sandbox_3f9c2a71b04e8d55_s3cr3t_value";
    const spy = stubFetch({settlements: []});

    await expect(settlements()).rejects.toThrow(/cleartext/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("still allows a loopback operator API, which is how this is developed", async () => {
    process.env["PLAZO_INDEXER_URL"] = "http://localhost:42069";
    process.env["PLAZO_MERCHANT_API_KEY"] = "plazo_sandbox_3f9c2a71b04e8d55_s3cr3t_value";
    stubFetch({settlements: []});
    await expect(settlements()).resolves.toMatchObject({live: true});
  });

  it("surfaces a failing fetch as an error rather than as a silent sample", async () => {
    stubFetch({error: "boom"}, 500);
    await expect(settlements()).rejects.toThrow(/returned 500/);
  });

  it("surfaces a 404 on the settlements route too, rather than degrading", async () => {
    stubFetch({error: "not-found"}, 404);
    await expect(settlements()).rejects.toThrow(/returned 404/);
  });
});

describe("attestations", () => {
  beforeEach(() => {
    process.env["PLAZO_SERVICING_URL"] = "https://servicing.example";
  });

  it("treats a 404 as 'not attested yet' rather than as a failure", async () => {
    stubFetch({error: "not-found"}, 404);
    const result = await attestations(["0xdead"]);
    expect(result.live).toBe(true);
    expect(result.attestations).toHaveLength(0);
  });

  it("still throws on a real failure", async () => {
    stubFetch({error: "boom"}, 503);
    await expect(attestations(["0xdead"])).rejects.toThrow(/returned 503/);
  });

  it("identifies a burn by transaction hash and never by a nonce (DEC-31)", async () => {
    const sampled = await attestations([]);
    for (const row of sampled.attestations) {
      expect(row.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(Object.keys(row)).not.toContain("nonce");
      expect(Object.keys(row)).not.toContain("eventNonce");
    }
  });
});

describe("the refund preview is a lookup, not a second waterfall", () => {
  it("answers for an amount it knows and refuses one it does not", async () => {
    const candidate = (await refunds()).candidates[0];
    expect(candidate).toBeDefined();
    expect(previewFor(candidate!, "206000000")).not.toBeNull();
    expect(previewFor(candidate!, "1")).toBeNull();
    expect(previewFor(candidate!, undefined)).toBeNull();
  });

  it("suppresses the tail and moves nothing before it", async () => {
    const candidate = (await refunds()).candidates[0]!;
    const preview = previewFor(candidate, "206000000")!;
    const after = scheduleAfter(candidate.schedule, preview);

    expect(preview.firstSuppressedIndex).toBe(candidate.schedule.length - 1);
    for (const before of candidate.schedule) {
      const row = after.find((r) => r.index === before.index)!;
      expect(row.dueAt).toBe(before.dueAt);
      expect(row.amount).toBe(before.amount);
      expect(row.status).toBe(before.index >= preview.firstSuppressedIndex! ? "suppressed" : before.status);
    }
  });

  it("leaves the schedule untouched when a preview suppresses nothing", async () => {
    const candidate = (await refunds()).candidates[0]!;
    const preview = {...previewFor(candidate, "206000000")!, firstSuppressedIndex: null};
    expect(scheduleAfter(candidate.schedule, preview)).toEqual(candidate.schedule);
  });
});

describe("leaf formatting", () => {
  it("formats 6-decimal USDC without a float", () => {
    expect(usd("126000000")).toBe("$126.00");
    expect(usd("9007199254740993000000")).toBe("$9,007,199,254,740,993.00");
    expect(usd("1")).toBe("$0.00");
    expect(usd("1", 6)).toBe("$0.000001");
  });

  it("rounds a duration to the unit a merchant would say out loud", () => {
    expect(until(1800)).toBe("30m");
    expect(until(7200)).toBe("2h");
    expect(until(-7 * 24 * 3600)).toBe("7d");
  });

  it("builds a data URL the browser can save with no script", () => {
    expect(dataUrl("0xabc")).toBe("data:text/plain;charset=utf-8,0xabc");
    expect(dataUrl("a b&c")).toBe("data:text/plain;charset=utf-8,a%20b%26c");
  });
});
