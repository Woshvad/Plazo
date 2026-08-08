/**
 * The StableFX taker client — OPS-06's half that talks to the venue.
 *
 * Hand-written against the public OpenAPI document rather than generated, and complete
 * rather than stubbed. **E-03**: the spec is fetchable without a key, so the five
 * endpoints this service needs, their request shapes, their response schemas and their
 * tests are all writable today. Only *execution* waits on KYB/AML access. The client is
 * therefore not a placeholder — it is finished code that has never been given a socket.
 *
 * ## What this client is not
 *
 * It is not a hedging desk. **E-02**: `tenor` is `instant | hourly | daily` and nothing
 * else, so there is no forward leg to sell and no way to settle a Pay-in-4 strip on its
 * own due dates. One RFQ prices the whole notional once at checkout; the EURC pool
 * carries the position to each installment. Nothing in this file should be read as
 * implying otherwise, and `FxVenue`'s net-hedging path is stubbed and cannot execute.
 *
 * ## Five rules, all of them structural
 *
 * 1. **Bearer only, https only.** `config.requireHttps` refuses the base URL otherwise.
 * 2. **Redirects are an error, never followed.** A 30x from an API host is either a
 *    misconfiguration or someone moving the bearer key somewhere it was not issued for.
 *    `fetch`'s default is to follow; that default is wrong for a credential this strong.
 * 3. **Every response is `.parse`d before it is returned.** A `rate` that reaches
 *    `signMid` becomes a signed attestation, so validation happens before signing and
 *    not after (V5, T-07-08-03).
 * 4. **The key never appears in a message, a log or an error.** Only its class does.
 * 5. **Timeouts are mandatory.** A hung quote is not a slow quote — to the breaker it is
 *    `Outage`, and a request with no deadline can never become one.
 */
import {ErrorEnvelope, Quote, Trade, TradeList, type QuoteType, type Tenor} from "./schemas.js";

/** Where the taker paths live under the host. One place, so a typo is one typo. */
export const STABLEFX_QUOTES_PATH = "/v1/exchange/stablefx/quotes";
export const STABLEFX_TRADES_PATH = "/v1/exchange/stablefx/trades";

/** Ten seconds. Long enough for an RFQ, short enough that a hang becomes `Outage`. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** A failed call, carrying enough for the breaker to tell an outage from a refusal. */
export class StableFxError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code:
      | "http-error"
      | "network"
      | "timeout"
      | "redirect"
      | "malformed-response",
    readonly body?: ErrorEnvelope | undefined,
  ) {
    super(message);
    this.name = "StableFxError";
  }
}

/** Whether a failure is the venue being unreachable rather than the venue saying no. */
export function isOutageShaped(error: unknown): boolean {
  if (!(error instanceof StableFxError)) return false;
  if (error.code === "network" || error.code === "timeout") return true;
  return error.status !== undefined && error.status >= 500;
}

/**
 * The transport seam.
 *
 * `fetch` is injected rather than reached for, so every test in this package runs
 * against recorded fixtures with no network and no key — which is the whole of E-03's
 * dividend. The signature is `globalThis.fetch`'s, so the production wiring is the
 * default and needs no adapter.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface StableFxHttpOptions {
  /** Already forced through `requireHttps`. Origin only, no path. */
  readonly baseUrl: string;
  /** The taker credential. Held in memory, never logged, never in an error message. */
  readonly apiKey: string;
  readonly fetch?: FetchLike | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * One request, one parse, one typed failure.
 *
 * Everything that could go wrong with a third-party call is normalised here so that the
 * five endpoint functions below contain nothing but their path and their schema.
 */
export class StableFxHttp {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly doFetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: StableFxHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : {"Content-Type": "application/json"}),
        },
        // Never followed. See rule 2 in the header.
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new StableFxError(`StableFX ${method} ${path} timed out after ${this.timeoutMs}ms`, undefined, "timeout");
      }
      if (/redirect/i.test(cause instanceof Error ? cause.message : "")) {
        throw new StableFxError(`StableFX ${method} ${path} answered a redirect, which is never followed`, undefined, "redirect");
      }
      throw new StableFxError(`StableFX ${method} ${path} could not be reached`, undefined, "network");
    }

    const text = await response.text();
    let json: unknown = undefined;
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (!response.ok) {
      const envelope = ErrorEnvelope.safeParse(json);
      throw new StableFxError(
        `StableFX ${method} ${path} answered ${response.status}`,
        response.status,
        "http-error",
        envelope.success ? envelope.data : undefined,
      );
    }

    return json;
  }
}

/** One side of a requested pair. Exactly one side carries `amount` (spec, verbatim). */
export interface QuoteSide {
  readonly currency: string;
  readonly amount?: string | undefined;
}

/** `POST /v1/exchange/stablefx/quotes`, field names verbatim from the spec. */
export interface CreateQuoteInput {
  readonly from: QuoteSide;
  readonly to: QuoteSide;
  /** Required by the venue. See `Tenor` — this is E-02's whole surface. */
  readonly tenor: Tenor;
  readonly type: QuoteType;
  /** Required for a `tradable` quote; meaningless for a `reference` one. */
  readonly recipientAddress?: string | undefined;
}

/**
 * Ask for a rate.
 *
 * Returns the parsed quote, including — for a tradable one — the `typedData` block whose
 * domain carries the Permit2 verifying contract. That block is passed onward verbatim and
 * is never reassembled locally (E-04).
 */
export async function createQuote(http: StableFxHttp, input: CreateQuoteInput): Promise<Quote> {
  const raw = await http.request("POST", STABLEFX_QUOTES_PATH, input);
  return parseOrThrow(Quote, raw, `${STABLEFX_QUOTES_PATH} response`);
}

/**
 * Accept a tradable quote, producing a trade.
 *
 * The `signature` is over the quote's **own** `typedData`, produced by whoever holds the
 * taker account's key. This client carries it; it does not build the payload it signs.
 */
export async function acceptQuote(
  http: StableFxHttp,
  quoteId: string,
  signature: string,
): Promise<Trade> {
  const path = `${STABLEFX_QUOTES_PATH}/${encodeURIComponent(quoteId)}/accept`;
  const raw = await http.request("POST", path, {signature});
  return parseOrThrow(Trade, raw, `${path} response`);
}

/**
 * Read one trade's current state.
 *
 * **C10.** This is the source of truth for a trade, and a webhook is not. Circle offers
 * webhook subscriptions and they may wake a poll; they may never *be* the state. A credit
 * system whose collection loop depends on a vendor delivering an HTTP callback has put a
 * third party on its critical path for no gain — Ponder is the pattern this repeats.
 */
export async function getTrade(http: StableFxHttp, tradeId: string): Promise<Trade> {
  const path = `${STABLEFX_TRADES_PATH}/${encodeURIComponent(tradeId)}`;
  const raw = await http.request("GET", path);
  return parseOrThrow(Trade, raw, `${path} response`);
}

export interface ListTradesQuery {
  readonly status?: string | undefined;
  readonly pageSize?: number | undefined;
  readonly pageToken?: string | undefined;
}

/** A page of trades. The breaker reads it to find `breaching` / `breached`. */
export async function listTrades(http: StableFxHttp, query: ListTradesQuery = {}): Promise<TradeList> {
  const search = new URLSearchParams();
  if (query.status !== undefined) search.set("status", query.status);
  if (query.pageSize !== undefined) search.set("pageSize", String(query.pageSize));
  if (query.pageToken !== undefined) search.set("pageToken", query.pageToken);
  const encoded = search.toString();
  const suffix = encoded === "" ? "" : `?${encoded}`;
  const raw = await http.request("GET", `${STABLEFX_TRADES_PATH}${suffix}`);
  return parseOrThrow(TradeList, raw, `${STABLEFX_TRADES_PATH} response`);
}

/**
 * The indicative quote the breaker polls.
 *
 * `type: "reference"` commits the venue to nothing, which is what a liveness probe must
 * do. A health check that struck a tradable obligation on every poll would be a health
 * check with a balance sheet, and the incident it caused would be its own.
 */
export async function referenceQuote(
  http: StableFxHttp,
  from: QuoteSide,
  to: QuoteSide,
  tenor: Tenor = "instant",
): Promise<Quote> {
  return createQuote(http, {from, to, tenor, type: "reference"});
}

/** Minimal shape of a zod schema, so this file needs no zod type gymnastics. */
interface Parser<T> {
  safeParse(value: unknown): {success: true; data: T} | {success: false; error: {message: string}};
}

/**
 * Parse, or fail with the field named.
 *
 * The zod error message carries the path, so "expected a 20-byte hex address at
 * typedData.domain.verifyingContract" is what an operator reads rather than "invalid
 * response". Naming the field is the difference between a five-minute fix and a bisect.
 */
function parseOrThrow<T>(schema: Parser<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new StableFxError(
      `StableFX ${what} did not validate: ${parsed.error.message}`,
      undefined,
      "malformed-response",
    );
  }
  return parsed.data;
}

/**
 * The five endpoints, bound to one transport.
 *
 * A class rather than a bag of functions because the transport, the key and the timeout
 * are one object with one lifetime, and because `FxVenue` wants a single collaborator to
 * hold rather than five closures to keep in step.
 */
export class StableFxClient {
  readonly http: StableFxHttp;

  constructor(options: StableFxHttpOptions) {
    this.http = new StableFxHttp(options);
  }

  createQuote(input: CreateQuoteInput): Promise<Quote> {
    return createQuote(this.http, input);
  }

  acceptQuote(quoteId: string, signature: string): Promise<Trade> {
    return acceptQuote(this.http, quoteId, signature);
  }

  getTrade(tradeId: string): Promise<Trade> {
    return getTrade(this.http, tradeId);
  }

  listTrades(query: ListTradesQuery = {}): Promise<TradeList> {
    return listTrades(this.http, query);
  }

  referenceQuote(from: QuoteSide, to: QuoteSide, tenor: Tenor = "instant"): Promise<Quote> {
    return referenceQuote(this.http, from, to, tenor);
  }
}
