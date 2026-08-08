/**
 * The offchain quoting seam — OPS-06's "abstracts the RFQ venue behind the router
 * interface", and the place where this service's honesty about its own access is kept.
 *
 * ## The default refuses, and that is the design
 *
 * DEC-63 said an authentication store that forgets is not a weaker store, it is a
 * different system. The same reasoning applies here with more force, because the subject
 * is money rather than a session: **a venue that degrades to a plausible rate is far worse
 * than one that refuses.** A refusal stops an origination and pages somebody. A fabricated
 * rate becomes the price of a real loan — a borrower signs a strip denominated in euros
 * they were quoted by nobody, and the pool books a position against a number this service
 * invented. Nothing downstream can tell the two apart, because a made-up rate looks
 * exactly like a real one.
 *
 * So `StubVenue` is the **shipped default**, every one of its methods throws, and a grep
 * gate plus a deliberate-failure check both assert that no path in this file can produce a
 * number. `resolveFxVenue` says which venue came up in the startup banner
 * **unconditionally**, in the same spirit as `resolveSessionStore`: an operator must never
 * have to infer whether the thing in front of them is real.
 *
 * ## The Permit2 domain is passed through, never rebuilt
 *
 * **E-04.** Plan 07-01's finding 33: two live FxEscrow proxies, same owner, different
 * implementations, and neither of them answers `PERMIT2()`. There is no correct address to
 * compile, so this file compiles none. A tradable quote's `typedData` is carried out of
 * the response exactly as it arrived and handed to the signer whole. `venue.test.ts`
 * asserts deep equality against the recorded fixture, so a local rebuild that happened to
 * produce the same address today would still fail — which is the point, because the day it
 * stops producing the same address is the day every outstanding signature dies quietly.
 *
 * ## What is not here, and cannot be
 *
 * Net-hedging. FX-03's sentence has two halves and only the first is deliverable:
 * StableFX's tenor enum offers no forward to hedge a 56-day strip into (E-02), and access
 * is KYB/AML-gated and not held (E-03). The warehouse is the EURC book itself (B-5). This
 * seam is where a hedge *would* execute; it currently refuses, and saying so plainly is
 * better than shipping a method that looks like it trades.
 */
import {readFxConfig, requireHttps, type FxConfig} from "./config.js";
import {StableFxClient, type QuoteSide} from "./stablefx.js";
import type {Quote, QuoteType, Tenor, TypedData} from "./schemas.js";

/** A currency pair as the venue names it — ISO codes, not token addresses. */
export interface FxPair {
  readonly from: string;
  readonly to: string;
}

/** What a venue answers with. Never a bare number, and never partially filled in. */
export interface FxQuote {
  /** Which venue produced this. Carried so a log line can never be ambiguous. */
  readonly venue: string;
  readonly pair: FxPair;
  /** The rate as a validated decimal string. Converted to 1e18 only at signing time. */
  readonly rate: string;
  readonly quoteId: string;
  readonly expiresAt: string;
  readonly type: QuoteType;
  /**
   * The venue's own signing payload, **verbatim**.
   *
   * Present on a tradable quote and absent on a reference one. Whatever domain the venue
   * named is the domain the caller signs against; this service neither inspects nor
   * reassembles it (E-04).
   */
  readonly typedData?: TypedData | undefined;
}

/** The seam. Three implementations, one of which ships. */
export interface FxVenue {
  readonly name: string;
  quote(pair: FxPair, amountIn: string, type: QuoteType): Promise<FxQuote>;
  supports(pair: FxPair): boolean;
}

/**
 * Thrown by every method of a venue that has no way to answer.
 *
 * It names the missing credential **and the access track**, because "not configured" sends
 * an operator to a config file when the actual answer is that Circle requires completed
 * KYB/AML and an email to a sales contact. A refusal that misdirects the reader costs more
 * than one that says nothing.
 */
export class FxVenueNotConfigured extends Error {
  constructor(
    readonly venue: string,
    readonly missing: string,
    readonly accessTrack: string,
  ) {
    super(`${venue} cannot quote: ${missing} is not held. ${accessTrack}`);
    this.name = "FxVenueNotConfigured";
  }
}

const STABLEFX_ACCESS_TRACK =
  "StableFX access is KYB/AML-gated: a Circle representative issues the key after onboarding. " +
  "It is an access-acquisition item on the third-party track, not a configuration change.";

/** The only corridor Phase 7 builds. DEC-06 keeps every other one as configuration. */
export const EURC_CORRIDOR: FxPair = Object.freeze({from: "USD", to: "EUR"});

function samePair(a: FxPair, b: FxPair): boolean {
  return a.from === b.from && a.to === b.to;
}

/** USD↔EUR either way round. StableFX supports this pair and no other today. */
export function isSupportedPair(pair: FxPair): boolean {
  return samePair(pair, EURC_CORRIDOR) || samePair(pair, {from: "EUR", to: "USD"});
}

/**
 * The real one. Wraps `StableFxClient` and adds nothing to what it returns.
 *
 * `quote` with `type: "tradable"` yields the rate **and the venue's own signing payload**,
 * carried through untouched. Nothing here narrows, normalises or re-derives that payload —
 * the moment this file started improving it, the improvement would be the bug.
 */
export class StableFxVenue implements FxVenue {
  readonly name = "StableFxVenue";

  constructor(
    private readonly client: StableFxClient,
    private readonly tenor: Tenor = "instant",
  ) {}

  supports(pair: FxPair): boolean {
    return isSupportedPair(pair);
  }

  async quote(pair: FxPair, amountIn: string, type: QuoteType): Promise<FxQuote> {
    const from: QuoteSide = {currency: pair.from, amount: amountIn};
    const to: QuoteSide = {currency: pair.to};
    const answered: Quote = await this.client.createQuote({
      from,
      to,
      tenor: this.tenor,
      type,
    });

    return {
      venue: this.name,
      pair,
      rate: answered.rate,
      quoteId: answered.id,
      expiresAt: answered.expiresAt,
      type: answered.type,
      typedData: answered.typedData,
    };
  }
}

/**
 * The onchain venue, read-only.
 *
 * **Finding 34 is the shipped state:** seven AMM candidates were probed on Arc testnet and
 * **zero hold bytecode**. There is no router to point this at, so it is constructed with
 * no address and reports itself unavailable — the same configuration `AmmVenue.sol` ships
 * with, for the same measured reason. When a venue appears, the fill it produces must be
 * re-measured before this path is trusted; an adapter that compiles is not an adapter that
 * has traded.
 */
export class AmmQuoteVenue implements FxVenue {
  readonly name = "AmmQuoteVenue";

  constructor(private readonly router: string | undefined) {}

  /** No router, no pair. Reported rather than discovered at call time. */
  supports(_pair: FxPair): boolean {
    return this.router !== undefined;
  }

  async quote(_pair: FxPair, _amountIn: string, _type: QuoteType): Promise<FxQuote> {
    throw new FxVenueNotConfigured(
      this.name,
      "an AMM router address",
      "Finding 34: seven candidates were probed on Arc testnet and none holds bytecode. " +
        "There is no venue to configure yet.",
    );
  }
}

/**
 * The shipped default. It refuses, and it refuses on every method.
 *
 * There is no rate in this class, no cached last-known value, and no path that produces a
 * number under any input. That is asserted three ways: by reading it, by a grep gate over
 * this file, and by a deliberate-failure check that makes this method answer and shows the
 * test going red.
 */
export class StubVenue implements FxVenue {
  readonly name = "StubVenue";

  supports(_pair: FxPair): boolean {
    return false;
  }

  async quote(_pair: FxPair, _amountIn: string, _type: QuoteType): Promise<FxQuote> {
    throw new FxVenueNotConfigured(this.name, "PLAZO_STABLEFX_API_KEY", STABLEFX_ACCESS_TRACK);
  }
}

/** What came up, and the line that says so. */
export interface ResolvedVenue {
  readonly venue: FxVenue;
  readonly banner: string;
}

export interface ResolveFxVenueOptions {
  readonly config?: FxConfig | undefined;
  /** Injected so a test can read the banner instead of a console. */
  readonly log?: ((line: string) => void) | undefined;
}

/**
 * Which venue this process is actually running on, said out loud.
 *
 * The switch is the presence of `PLAZO_STABLEFX_API_KEY` **and** its class matching
 * `PLAZO_ENVIRONMENT` — `readFxConfig` throws on a mismatch before this is reached, which
 * is Pitfall 8: a `LIVE` key in a sandbox deployment does not fail, it trades on the wrong
 * network, so the refusal has to come from the key's own shape rather than from a later
 * error.
 *
 * The banner prints on both branches. "The venue is stubbed" and "the venue is live" look
 * identical from a request that was refused for some other reason, and the difference only
 * surfaces after somebody has spent an afternoon on it.
 */
export function resolveFxVenue(options: ResolveFxVenueOptions = {}): ResolvedVenue {
  const config = options.config ?? readFxConfig();
  const write = options.log ?? ((line: string) => {
    // eslint-disable-next-line no-console
    console.log(line);
  });

  if (config.apiKey === undefined) {
    const banner =
      `[plazo:fx] venue: StubVenue — no PLAZO_STABLEFX_API_KEY, so every quote is refused. ` +
      `A venue that guessed a rate would be pricing a real loan with an invented number.`;
    write(banner);
    return {venue: new StubVenue(), banner};
  }

  const client = new StableFxClient({
    baseUrl: requireHttps(config.baseUrl),
    apiKey: config.apiKey,
  });
  const banner =
    `[plazo:fx] venue: StableFxVenue — ${String(config.keyClass)} key on the ` +
    `'${config.environment}' environment, quoting ${EURC_CORRIDOR.from}/${EURC_CORRIDOR.to}. ` +
    `One RFQ prices the whole notional; the EURC book carries it to each due date.`;
  write(banner);
  return {venue: new StableFxVenue(client), banner};
}
