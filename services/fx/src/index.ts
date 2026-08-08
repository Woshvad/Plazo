/**
 * `@plazo/fx` — the FX quoting service. OPS-06, FX-03, FX-04 and the service half of FX-05.
 *
 * Proprietary. This is the operator's, not the protocol's, and it holds a bearer key that
 * can move value at a venue — so `services/` stays CLOSED in `tools/check-boundaries.mjs`
 * and nothing under `packages/` or `contracts/` may import it (C11).
 *
 * ## The one sentence this service exists to keep honest
 *
 * **StableFX cannot settle a dated strip.** `POST /v1/exchange/stablefx/quotes` takes a
 * required `tenor` whose enum is exactly `instant | hourly | daily` — no value date, no
 * multi-leg quote, no forward. A Pay-in-4 strip settles at 14/28/42/56 days. So one RFQ
 * prices the whole notional once at checkout, and the EURC `TranchedCreditPool` carries
 * the open position to each due date. **The warehouse is mandatory, not an implementation
 * detail, and the EURC book *is* the warehouse** (E-02, B-5). The net-hedging half of
 * FX-03's sentence is stubbed behind `FxVenue` and **cannot execute**: access is
 * KYB/AML-gated and not held, and there would be no forward to hedge into even with a key.
 *
 * ## What is complete and what is not
 *
 * Complete: the client, its schemas, the venue seam, the mid signer, the breaker, and
 * every test, all of them runnable today with no key (E-03). Not complete: execution.
 * `resolveFxVenue()` returns a venue that **refuses**, and says so in the banner.
 */
import {readFxConfig, type FxConfig} from "./config.js";
import {corridorOf} from "./mid.js";
import {resolveFxVenue} from "./venue.js";
import type {Hex} from "viem";
import type {FxVenue} from "./venue.js";

export * from "./config.js";
export * from "./schemas.js";
export * from "./stablefx.js";
export * from "./venue.js";
export * from "./mid.js";
export * from "./api.js";
export * from "./breaker.js";

/** What came up when this process started, and the lines that said so. */
export interface FxComposition {
  readonly config: FxConfig;
  readonly venue: FxVenue;
  /** `corridorOf(EURC)` — the one corridor a trip can pause. */
  readonly corridor: Hex;
  /** Whether the corridor poll can actually write a pause. */
  readonly canPause: boolean;
  readonly banner: readonly string[];
}

/**
 * The composition root.
 *
 * Two banner lines, both unconditional, in the same spirit as `resolveSessionStore`'s: an
 * operator must never have to infer whether the venue in front of them is real or whether
 * a trip would reach the chain. "The breaker is armed" and "the breaker has nowhere to
 * write" look identical from a poll that found nothing wrong, and the difference only
 * surfaces during the incident the breaker exists for.
 *
 * `canPause` is deliberately a separate fact from the venue's. A configured venue with no
 * `PLAZO_ORIGINATION_PAUSE_ADDRESS` is a breaker that can detect and cannot act — which is
 * a worse state than having neither, because it looks armed.
 */
export function composeFxService(
  config: FxConfig = readFxConfig(),
  log: (line: string) => void = (line) => {
    // eslint-disable-next-line no-console
    console.log(line);
  },
): FxComposition {
  const resolved = resolveFxVenue({config, log});
  const corridor = corridorOf(config.eurc);
  const canPause = config.originationPause !== undefined;

  const pauseLine = canPause
    ? `[plazo:fx] breaker: armed — a trip pauses corridor ${corridor} and nothing else. ` +
      `Restarting is the admin's, never this service's.`
    : `[plazo:fx] breaker: detecting only — PLAZO_ORIGINATION_PAUSE_ADDRESS is unset, so a trip ` +
      `has nowhere to write. It will page and it will not stop new credit.`;
  log(pauseLine);

  return {config, venue: resolved.venue, corridor, canPause, banner: [resolved.banner, pauseLine]};
}
