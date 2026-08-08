/**
 * Recorded StableFX responses, transcribed from the public OpenAPI examples.
 *
 * **E-03's dividend, made concrete.** The spec at
 * `developers.circle.com/openapi/stablefx.yaml` is public and needs no key, so these are
 * real response shapes rather than invented ones — and because they are here, every test
 * in this package runs with no key, no network and no KYB. The day access lands, what is
 * untested is the socket, not the code.
 *
 * Two things about these fixtures are deliberate and load-bearing:
 *
 * 1. **`typedData.domain.verifyingContract` is present on the tradable quote and is a
 *    Permit2 address the venue chose, not one this repository knows.** It is a syntactic
 *    placeholder in a fixture; in production it arrives in the response and is used as it
 *    arrives (E-04). No FxEscrow address from `CLAUDE.md` or from Arc's reference appears
 *    anywhere here — finding 33 proved both are live with different implementations and
 *    neither answers `PERMIT2()`, so there is no correct one to write down.
 * 2. **`MALFORMED_TRADABLE_QUOTE` is missing exactly that field and nothing else.** It is
 *    the fixture that proves the requirement is real rather than decorative.
 */

/** The Permit2 domain address as it arrives from the venue. A fixture value, nothing more. */
const RESPONSE_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** Where a tradable fill would land. A fixture value. */
const RECIPIENT = "0x1111111111111111111111111111111111111111";

/**
 * The Permit2 payload as StableFX returns it.
 *
 * Passed to the signer verbatim. `venue.test.ts` asserts deep equality against this
 * object after a round trip through the client, so any local rebuild of the domain —
 * even one producing an identical address today — fails the test.
 */
export const TRADABLE_TYPED_DATA = {
  domain: {
    name: "Permit2",
    version: "1",
    chainId: 5042002,
    verifyingContract: RESPONSE_PERMIT2,
  },
  types: {
    PermitTransferFrom: [
      {name: "permitted", type: "TokenPermissions"},
      {name: "spender", type: "address"},
      {name: "nonce", type: "uint256"},
      {name: "deadline", type: "uint256"},
    ],
    TokenPermissions: [
      {name: "token", type: "address"},
      {name: "amount", type: "uint256"},
    ],
  },
  primaryType: "PermitTransferFrom",
  message: {
    permitted: {token: "0x3600000000000000000000000000000000000000", amount: "407000000"},
    spender: RECIPIENT,
    nonce: "184467440737095516",
    deadline: "1785312000",
  },
} as const;

/** A committed quote: one rate for the whole notional, settled now, never on a due date. */
export const TRADABLE_QUOTE = {
  id: "qte_01JZ8W7Q2N3K4M5P6R7S8T9V0W",
  rate: "0.92184",
  from: {currency: "USD", amount: "407.00"},
  to: {currency: "EUR", amount: "375.19"},
  tenor: "instant",
  type: "tradable",
  createdAt: "2026-08-02T11:04:07Z",
  expiresAt: "2026-08-02T11:04:37Z",
  fee: {currency: "USD", amount: "0.41"},
  typedData: TRADABLE_TYPED_DATA,
} as const;

/** The indicative quote the breaker polls. No `typedData`, because nothing is committed. */
export const REFERENCE_QUOTE = {
  id: "qte_01JZ8W8B4C5D6E7F8G9H0J1K2L",
  rate: "0.92190",
  from: {currency: "USD", amount: "407.00"},
  to: {currency: "EUR"},
  tenor: "instant",
  type: "reference",
  createdAt: "2026-08-02T11:05:00Z",
  expiresAt: "2026-08-02T11:05:30Z",
} as const;

/** The reverse leg of the round-trip probe. Same notional, opposite direction. */
export const REFERENCE_QUOTE_REVERSE = {
  id: "qte_01JZ8W8C5D6E7F8G9H0J1K2L3M",
  rate: "1.08472",
  from: {currency: "EUR", amount: "375.19"},
  to: {currency: "USD"},
  tenor: "instant",
  type: "reference",
  createdAt: "2026-08-02T11:05:01Z",
  expiresAt: "2026-08-02T11:05:31Z",
} as const;

export const TRADE_PENDING = {
  id: "trd_01JZ8W9M1N2P3Q4R5S6T7U8V9W",
  quoteId: TRADABLE_QUOTE.id,
  status: "pending",
  rate: "0.92184",
  from: {currency: "USD", amount: "407.00"},
  to: {currency: "EUR", amount: "375.19"},
  createdAt: "2026-08-02T11:04:40Z",
} as const;

export const TRADE_SETTLED = {
  ...TRADE_PENDING,
  id: "trd_01JZ8WA2B3C4D5E6F7G8H9J0K1",
  status: "settled",
  settledAt: "2026-08-02T11:04:41Z",
  transactionHash: "0x9f2c1c3a5f7f4e2b8d6c0a1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d",
} as const;

/** The venue saying, in its own vocabulary, that a trade has left its terms. */
export const TRADE_BREACHING = {
  ...TRADE_PENDING,
  id: "trd_01JZ8WB3C4D5E6F7G8H9J0K1L2",
  status: "breaching",
  updatedAt: "2026-08-02T11:06:00Z",
} as const;

export const TRADE_BREACHED = {
  ...TRADE_PENDING,
  id: "trd_01JZ8WC4D5E6F7G8H9J0K1L2M3",
  status: "breached",
  updatedAt: "2026-08-02T11:07:00Z",
} as const;

export const TRADE_LIST = {
  data: [TRADE_PENDING, TRADE_SETTLED],
} as const;

/**
 * The one fixture that must fail.
 *
 * A tradable quote whose `typedData.domain` has **no `verifyingContract`**. Everything
 * else about it is well-formed, which is the point: the failure has to be attributable to
 * that one absence and to nothing else. If this parses, the E-04 discipline is decorative
 * and a caller is one convenience away from rebuilding the domain locally.
 */
export const MALFORMED_TRADABLE_QUOTE = {
  ...TRADABLE_QUOTE,
  id: "qte_01JZ8WD5E6F7G8H9J0K1L2M3N4",
  typedData: {
    ...TRADABLE_TYPED_DATA,
    domain: {name: "Permit2", version: "1", chainId: 5042002},
  },
} as const;

/** A tradable quote with no `typedData` at all — nothing to sign, so nothing to accept. */
export const TRADABLE_QUOTE_WITHOUT_TYPED_DATA = {
  id: "qte_01JZ8WE6F7G8H9J0K1L2M3N4P5",
  rate: "0.92184",
  from: {currency: "USD", amount: "407.00"},
  to: {currency: "EUR", amount: "375.19"},
  tenor: "instant",
  type: "tradable",
  createdAt: "2026-08-02T11:04:07Z",
  expiresAt: "2026-08-02T11:04:37Z",
} as const;

/**
 * A quote carrying a field nothing here declares.
 *
 * The assertion is that it parses (Circle may add fields; a taker that hard-failed on an
 * additive change would manufacture its own outage) **and** that the added field is not
 * on the typed result. Stripped, not trusted.
 */
export const QUOTE_WITH_UNKNOWN_FIELD = {
  ...REFERENCE_QUOTE,
  id: "qte_01JZ8WF7G8H9J0K1L2M3N4P5Q6",
  settlementAdvanceEligible: true,
} as const;

/** The venue's error envelope, as a 5xx returns it. */
export const ERROR_ENVELOPE = {
  code: 500,
  message: "internal error",
} as const;
