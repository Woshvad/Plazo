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
export * from "./config.js";
export * from "./schemas.js";
export * from "./stablefx.js";
