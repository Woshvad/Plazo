import {describe, expect, it} from "vitest";

import {
  assertKeyClassMatchesEnvironment,
  FxConfigError,
  keyClassOf,
  readFxConfig,
  requireHttps,
} from "../src/config.js";
import {
  ErrorEnvelope,
  Quote,
  rateToE18,
  Tenor,
  Trade,
  TradeList,
  TypedData,
} from "../src/schemas.js";
import {
  StableFxClient,
  StableFxError,
  isOutageShaped,
  type FetchLike,
} from "../src/stablefx.js";
import {
  ERROR_ENVELOPE,
  MALFORMED_TRADABLE_QUOTE,
  QUOTE_WITH_UNKNOWN_FIELD,
  REFERENCE_QUOTE,
  REFERENCE_QUOTE_REVERSE,
  TRADABLE_QUOTE,
  TRADABLE_QUOTE_WITHOUT_TYPED_DATA,
  TRADABLE_TYPED_DATA,
  TRADE_BREACHED,
  TRADE_BREACHING,
  TRADE_LIST,
  TRADE_PENDING,
  TRADE_SETTLED,
} from "./fixtures/stablefx.js";

/** A `fetch` that answers one recorded body, and records what it was asked. */
function recorded(body: unknown, status = 200): {fetch: FetchLike; calls: Array<{url: string; init?: RequestInit}>} {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  const fetchLike: FetchLike = async (url, init) => {
    calls.push(init === undefined ? {url} : {url, init});
    return new Response(JSON.stringify(body), {
      status,
      headers: {"Content-Type": "application/json"},
    });
  };
  return {fetch: fetchLike, calls};
}

function client(fetchLike: FetchLike): StableFxClient {
  return new StableFxClient({
    baseUrl: "https://api-sandbox.circle.com",
    apiKey: "TEST_API_KEY:fixture:fixture",
    fetch: fetchLike,
  });
}

describe("the recorded fixtures parse", () => {
  it("parses every quote fixture the OpenAPI examples produced", () => {
    expect(Quote.parse(TRADABLE_QUOTE).id).toBe(TRADABLE_QUOTE.id);
    expect(Quote.parse(REFERENCE_QUOTE).type).toBe("reference");
    expect(Quote.parse(REFERENCE_QUOTE_REVERSE).rate).toBe("1.08472");
  });

  it("parses a trade in each of pending, settled, breaching and breached", () => {
    expect(Trade.parse(TRADE_PENDING).status).toBe("pending");
    expect(Trade.parse(TRADE_SETTLED).status).toBe("settled");
    expect(Trade.parse(TRADE_BREACHING).status).toBe("breaching");
    expect(Trade.parse(TRADE_BREACHED).status).toBe("breached");
  });

  it("parses a page of trades and the error envelope", () => {
    expect(TradeList.parse(TRADE_LIST).data).toHaveLength(2);
    expect(ErrorEnvelope.parse(ERROR_ENVELOPE).code).toBe(500);
  });

  it("keeps the whole Permit2 payload, domain included", () => {
    const parsed = TypedData.parse(TRADABLE_TYPED_DATA);
    expect(parsed.domain.verifyingContract).toBe(TRADABLE_TYPED_DATA.domain.verifyingContract);
    expect(parsed.primaryType).toBe("PermitTransferFrom");
  });
});

describe("the malformed fixture fails loudly, and names the field", () => {
  /**
   * E-04's requirement, asserted rather than asserted-about. A deliberate-failure check
   * in the SUMMARY makes `verifyingContract` optional and shows this test turning green
   * when it should be red — which is the only way to know the requirement is load-bearing
   * rather than decorative.
   */
  it("refuses a typedData.domain with no verifyingContract", () => {
    const result = Quote.safeParse(MALFORMED_TRADABLE_QUOTE);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("verifyingContract");
  });

  it("refuses a tradable quote carrying no typedData at all", () => {
    const result = Quote.safeParse(TRADABLE_QUOTE_WITHOUT_TYPED_DATA);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("typedData");
  });
});

describe("an unexpected field is stripped, never passed through", () => {
  it("parses an additive upstream change without exposing the new field", () => {
    const parsed = Quote.parse(QUOTE_WITH_UNKNOWN_FIELD);
    expect(parsed.id).toBe(QUOTE_WITH_UNKNOWN_FIELD.id);
    expect(Object.keys(parsed)).not.toContain("settlementAdvanceEligible");
    expect((parsed as Record<string, unknown>)["settlementAdvanceEligible"]).toBeUndefined();
  });
});

describe("E-02 — the tenor enum has exactly three members", () => {
  /**
   * The assertion that keeps E-02 true if someone later hand-edits a fixture. There is
   * no value-date tenor on this venue, so a Pay-in-4 strip cannot be settled on its own
   * due dates and the pool's warehouse is mandatory rather than optional.
   */
  it("accepts instant, hourly and daily and refuses a forward tenor", () => {
    expect(Tenor.parse("instant")).toBe("instant");
    expect(Tenor.parse("hourly")).toBe("hourly");
    expect(Tenor.parse("daily")).toBe("daily");
    expect(Tenor.safeParse("forward").success).toBe(false);
    expect(Tenor.options).toHaveLength(3);
  });
});

describe("rateToE18 converts without a float in the path", () => {
  it("scales exactly and truncates rather than rounding up", () => {
    expect(rateToE18("1")).toBe(10n ** 18n);
    expect(rateToE18("0.92184")).toBe(921_840_000_000_000_000n);
    // Nineteen places in; the nineteenth is dropped, never carried.
    expect(rateToE18("0.9999999999999999999")).toBe(999_999_999_999_999_999n);
  });

  it("refuses anything that is not an unsigned decimal string", () => {
    expect(() => rateToE18("-1")).toThrow();
    expect(() => rateToE18("1e18")).toThrow();
  });
});

describe("the client parses before it returns", () => {
  it("returns a parsed quote and sends a bearer credential", async () => {
    const {fetch, calls} = recorded(TRADABLE_QUOTE);
    const quote = await client(fetch).createQuote({
      from: {currency: "USD", amount: "407.00"},
      to: {currency: "EUR"},
      tenor: "instant",
      type: "tradable",
      recipientAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(quote.rate).toBe("0.92184");
    expect(calls[0]?.url).toBe("https://api-sandbox.circle.com/v1/exchange/stablefx/quotes");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer TEST_API_KEY:fixture:fixture");
    // Rule 2: a 30x from an API host is a misconfiguration or a redirected credential.
    expect(calls[0]?.init?.redirect).toBe("error");
  });

  it("throws rather than returning a quote whose domain lost its verifying contract", async () => {
    const {fetch} = recorded(MALFORMED_TRADABLE_QUOTE);
    await expect(
      client(fetch).createQuote({
        from: {currency: "USD", amount: "407.00"},
        to: {currency: "EUR"},
        tenor: "instant",
        type: "tradable",
      }),
    ).rejects.toThrow(StableFxError);
  });

  it("reads a trade by id rather than trusting a webhook", async () => {
    const {fetch, calls} = recorded(TRADE_BREACHING);
    const trade = await client(fetch).getTrade(TRADE_BREACHING.id);
    expect(trade.status).toBe("breaching");
    expect(calls[0]?.url).toContain("/v1/exchange/stablefx/trades/");
  });

  it("lists trades and encodes its query", async () => {
    const {fetch, calls} = recorded(TRADE_LIST);
    const page = await client(fetch).listTrades({status: "pending", pageSize: 2});
    expect(page.data).toHaveLength(2);
    expect(calls[0]?.url).toContain("status=pending");
    expect(calls[0]?.url).toContain("pageSize=2");
  });

  it("classifies a 5xx as outage-shaped and a 400 as not", async () => {
    const server = recorded(ERROR_ENVELOPE, 503);
    const refusal = recorded(ERROR_ENVELOPE, 400);

    const outage = await client(server.fetch)
      .getTrade("trd_x")
      .catch((error: unknown) => error);
    const declined = await client(refusal.fetch)
      .getTrade("trd_x")
      .catch((error: unknown) => error);

    expect(isOutageShaped(outage)).toBe(true);
    expect(isOutageShaped(declined)).toBe(false);
  });
});

describe("Pitfall 8 — the key's own prefix chooses a world", () => {
  it("derives the class from the key alone", () => {
    expect(keyClassOf("TEST_API_KEY:a:b")).toBe("TEST");
    expect(keyClassOf("LIVE_API_KEY:a:b")).toBe("LIVE");
    expect(() => keyClassOf("plazo_live_abc_def")).toThrow(FxConfigError);
  });

  it("refuses a LIVE key in a sandbox deployment, naming both sides", () => {
    expect(() => assertKeyClassMatchesEnvironment("LIVE_API_KEY:a:b", "sandbox")).toThrow(/LIVE.*sandbox|sandbox.*LIVE/s);
    expect(() => assertKeyClassMatchesEnvironment("TEST_API_KEY:a:b", "live")).toThrow(/TEST/);
    expect(assertKeyClassMatchesEnvironment("TEST_API_KEY:a:b", "sandbox")).toBe("TEST");
  });

  it("fails closed at config read rather than trading on the wrong network", () => {
    expect(() =>
      readFxConfig({PLAZO_ENVIRONMENT: "sandbox", PLAZO_STABLEFX_API_KEY: "LIVE_API_KEY:a:b"}),
    ).toThrow(FxConfigError);

    const config = readFxConfig({PLAZO_ENVIRONMENT: "sandbox"});
    expect(config.apiKey).toBeUndefined();
    expect(config.keyClass).toBeUndefined();
    expect(config.baseUrl).toBe("https://api-sandbox.circle.com");
  });

  it("refuses a cleartext base url", () => {
    expect(() => requireHttps("http://api-sandbox.circle.com")).toThrow(FxConfigError);
    expect(requireHttps("https://api.circle.com/")).toBe("https://api.circle.com");
  });
});
