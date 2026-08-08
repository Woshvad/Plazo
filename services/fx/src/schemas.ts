/**
 * Every StableFX response field this service reads, as a zod schema.
 *
 * Transcribed from the **public** OpenAPI document — `developers.circle.com/openapi/stablefx.yaml`,
 * 3,659 lines, 19 endpoints, fetched 2026-08-02 and read in `07-RESEARCH.md`. The spec
 * needs no key; only *execution* does (E-03). That is why the client, these schemas and
 * their tests all exist and all run today, and it is a real reduction in what stays
 * unknown when access lands: the day a key arrives, what is untested is the network,
 * not the code.
 *
 * ## Why validation happens before signing, not after
 *
 * V5. A `rate` that reaches `signMid` becomes a **signed attestation** the chain will
 * accept as this operator's word. A malformed, hostile or merely surprising value that
 * slips through here is not a rendering bug — it is a signature over a number nobody
 * checked. So every response is parsed at the client boundary and `signMid` takes only
 * parsed values.
 *
 * ## Unknown keys are stripped, not passed through
 *
 * `z.object` drops what it was not told about, so an added upstream field cannot arrive
 * in a typed result nothing declared. That is deliberately *not* `strictObject`: Circle
 * may add fields to a live API, and a taker client that hard-failed on an additive
 * change would be an outage manufactured out of someone else's release note. Dropping
 * is the correct middle — new fields are invisible until this file names them.
 */
import {z} from "zod";

/** A 20-byte hex address, the only address shape this service will hold. */
export const EvmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address");

/** An ISO-8601 instant. Compared, never parsed into a locale. */
export const Instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, "expected an ISO-8601 instant");

/**
 * Money crosses as a decimal **string**, never as a number.
 *
 * The same rule `services/origination` applies to its own API, for the same reason: an
 * IEEE double cannot hold a euro amount exactly, and the place that discovers it is a
 * reconciliation two months later.
 */
export const DecimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "money and rates cross as unsigned decimal strings");

/**
 * The tenor enum, and the single fact this entire service is shaped around.
 *
 * **E-02.** `POST /v1/exchange/stablefx/quotes` takes a REQUIRED `tenor`, and its enum
 * is exactly these three members. There is no value-date tenor, no multi-leg quote and
 * no way to ask for settlement on a future date. A Pay-in-4 strip settles at 14, 28, 42
 * and 56 days.
 *
 * The consequence, stated once, here, where the next reader meets it first:
 * **StableFX cannot price or settle a dated strip on the installment dates.** What it
 * can do is return one locked rate for the whole notional at checkout, which is what
 * FX-03 asks for. The exposure to each due date is therefore carried by the pool —
 * **the warehouse is mandatory, not an implementation detail**, and under E-01's
 * two-pool design the EURC `TranchedCreditPool` *is* that warehouse (B-5).
 *
 * A fourth member appearing in a hand-edited fixture would silently reintroduce the
 * belief that a schedule can be priced here. `test/schemas.test.ts` asserts it cannot.
 */
export const Tenor = z.enum(["instant", "hourly", "daily"]);
export type Tenor = z.infer<typeof Tenor>;

/**
 * `tradable` commits the venue to the rate and carries the Permit2 payload;
 * `reference` is indicative and commits nothing. The breaker polls the second kind,
 * because a health check that created a tradable obligation every minute would be a
 * health check with a balance sheet.
 */
export const QuoteType = z.enum(["tradable", "reference"]);
export type QuoteType = z.infer<typeof QuoteType>;

/** One side of a quote. Exactly one side carries `amount` on the request. */
export const Money = z.object({
  currency: z.string().min(3).max(8),
  amount: DecimalString.optional(),
});
export type Money = z.infer<typeof Money>;

/**
 * The venue's own trade lifecycle, including the two states the breaker keys on.
 *
 * `breaching` and `breached` are the venue saying, in its own vocabulary, that a trade
 * has left the terms it was struck under. Signal 4 of six: it needs no belief about
 * what a euro should be worth, because it is not a price at all — it is a counterparty
 * reporting its own distress.
 */
export const TradeStatus = z.enum([
  "pending",
  "processing",
  "settled",
  "failed",
  "cancelled",
  "expired",
  "breaching",
  "breached",
]);
export type TradeStatus = z.infer<typeof TradeStatus>;

/** The two states that trip `VenueDistress`. Read by the breaker, declared here. */
export const DISTRESS_STATUSES: readonly TradeStatus[] = Object.freeze(["breaching", "breached"]);

/**
 * The EIP-712 domain, with `verifyingContract` **required**.
 *
 * **E-04, and the load-bearing line of this file.** Plan 07-01's finding 33 probed both
 * live FxEscrow proxies: same owner, same 130-byte proxy, **different implementations**,
 * and *neither answers `PERMIT2()`*. There is therefore no correct address to compile,
 * and the resolution is not to pick one. The Permit2 domain arrives inside this object
 * and is used exactly as it arrives.
 *
 * Required rather than optional so that a response missing it **fails loudly at the
 * boundary**. Optional would be worse than useless: it would let a caller reach for a
 * locally rebuilt domain on the absent path, which is precisely the mistake CLAUDE.md
 * already forbids for USDC's `DOMAIN_SEPARATOR` — a separator embeds `chainId` and the
 * contract, both of which move, and every outstanding signature fails silently when
 * they do. A deliberate-failure check in the SUMMARY proves this field is load-bearing.
 */
export const TypedDataDomain = z.object({
  name: z.string(),
  version: z.string(),
  chainId: z.number().int().nonnegative(),
  verifyingContract: EvmAddress,
  salt: z.string().optional(),
});
export type TypedDataDomain = z.infer<typeof TypedDataDomain>;

export const TypedDataField = z.object({name: z.string(), type: z.string()});

/** The whole Permit2 payload, passed to the signer verbatim and never reassembled. */
export const TypedData = z.object({
  domain: TypedDataDomain,
  types: z.record(z.string(), z.array(TypedDataField)),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});
export type TypedData = z.infer<typeof TypedData>;

/**
 * A quote, tradable or indicative.
 *
 * `typedData` is optional on the type and **required in practice for a tradable quote**,
 * which the refinement below enforces. Modelling it as unconditionally required would
 * reject every reference quote the breaker polls; modelling it as merely optional would
 * let a tradable quote with no Permit2 payload reach a signer that then has nothing to
 * sign and improvises. The conditional is the honest shape.
 */
export const Quote = z
  .object({
    id: z.string().min(1),
    rate: DecimalString,
    from: Money,
    to: Money,
    tenor: Tenor,
    type: QuoteType,
    createdAt: Instant,
    expiresAt: Instant,
    fee: Money.optional(),
    collateral: Money.optional(),
    typedData: TypedData.optional(),
  })
  .refine((q) => q.type !== "tradable" || q.typedData !== undefined, {
    message: "a tradable quote must carry typedData; there is nothing to sign without it",
    path: ["typedData"],
  });
export type Quote = z.infer<typeof Quote>;

/** A trade, as `GET /trades/{tradeId}` returns it. Polled, never taken from a webhook. */
export const Trade = z.object({
  id: z.string().min(1),
  quoteId: z.string().min(1),
  status: TradeStatus,
  rate: DecimalString,
  from: Money,
  to: Money,
  createdAt: Instant,
  updatedAt: Instant.optional(),
  settledAt: Instant.optional(),
  transactionHash: z.string().optional(),
});
export type Trade = z.infer<typeof Trade>;

/** `GET /trades` — a page of them. */
export const TradeList = z.object({
  data: z.array(Trade),
  nextPageToken: z.string().optional(),
});
export type TradeList = z.infer<typeof TradeList>;

/**
 * The error envelope.
 *
 * Parsed like everything else, because an error body is still a third-party string
 * being put in front of an operator. A `code` that is merely `unknown` is preferable to
 * one this service invented on the caller's behalf.
 */
export const ErrorEnvelope = z.object({
  code: z.union([z.number().int(), z.string()]).optional(),
  message: z.string().optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/**
 * A decimal rate string to 1e18 fixed point, exactly, with no float in the path.
 *
 * `FxMidAttestation.Mid.midE18` is 1e18-scaled because a rate is a ratio, not a balance
 * (its own header says so). `Number(rate) * 1e18` would round, and the rounding would be
 * inside a signed commitment — so the conversion is string surgery on the two halves and
 * `BigInt` arithmetic throughout.
 *
 * Extra precision beyond eighteen places is **truncated, never rounded up**: the mid is
 * a floor a fill must beat, and rounding it up would make the guard refuse a fill that
 * was in fact good enough.
 */
export function rateToE18(rate: string): bigint {
  const parsed = DecimalString.parse(rate);
  const [whole = "0", fraction = ""] = parsed.split(".");
  const padded = (fraction + "0".repeat(18)).slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(padded === "" ? "0" : padded);
}
