/**
 * The credit decision, as it crosses into the protocol.
 *
 * Underwriting itself runs off-chain and has to: the inputs are a borrower's history
 * and, later, a partner's scorecard, and neither belongs in a public log. What
 * crosses the boundary is a number and a signature over it — and this module is both
 * halves of that boundary, so a merchant can verify a quote they were given and a
 * borrower can reproduce the limit they were offered without asking anyone.
 *
 * Mirrors `contracts/src/libraries/LimitAttestation.sol`,
 * `contracts/src/Tier0Underwriter.sol` and `CheckoutRouter.bandOf`. A differential
 * corpus generated from Solidity asserts every value here matches bit for bit.
 */
import {encodeAbiParameters, keccak256, parseAbiParameters, toHex, type Address, type Hex} from "viem";

import {BPS, ONE_USDC} from "./params.js";
import {SignerClass} from "./strip.js";

// ─── Identity ─────────────────────────────────────────────────────────────────

/**
 * How a borrower's identity reaches underwriting.
 *
 * `Pseudonymous` is one wallet, one person. `Identified` means an operator attested
 * that two wallets are the same borrower; the `personId` is a commitment and never
 * an identifier, so the chain learns that two wallets are one person and nothing
 * about which person.
 */
export const IdentityClass = {Pseudonymous: 0, Identified: 1} as const;
export type IdentityClass = (typeof IdentityClass)[keyof typeof IdentityClass];

/**
 * The aggregation key for a wallet with no attested identity.
 *
 * Domain-separated, because a collision with an attested commitment would let a
 * borrower who cannot be identified inherit the standing of one who can.
 */
export function pseudonymousId(wallet: Address): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("string, address"), ["PLAZO.PSEUDONYMOUS", wallet]),
  );
}

// ─── The attestation ──────────────────────────────────────────────────────────

export interface LimitAttestation {
  /**
   * The checkout session this decision belongs to.
   *
   * A borrower who abandons after two authorizations and comes back resumes under
   * the same decision rather than being re-underwritten at a price that moved.
   */
  sessionId: Hex;
  /** The exact plan this decision authorises. */
  planId: Hex;
  borrower: Address;
  personId: Hex;
  identityClass: IdentityClass;
  /** 6-decimal USDC. */
  limit: bigint;
  validUntil: bigint;
}

export const LIMIT_ATTESTATION_TYPE_STRING =
  "LimitAttestation(bytes32 sessionId,bytes32 planId,address borrower,bytes32 personId,uint8 identityClass,uint256 limit,uint256 validUntil)";

export const LIMIT_ATTESTATION_TYPEHASH: Hex = keccak256(toHex(LIMIT_ATTESTATION_TYPE_STRING));

export const LIMIT_ATTESTATION_TYPES = {
  LimitAttestation: [
    {name: "sessionId", type: "bytes32"},
    {name: "planId", type: "bytes32"},
    {name: "borrower", type: "address"},
    {name: "personId", type: "bytes32"},
    {name: "identityClass", type: "uint8"},
    {name: "limit", type: "uint256"},
    {name: "validUntil", type: "uint256"},
  ],
} as const;

/**
 * The domain an attestation is verified under.
 *
 * `verifyingContract` is the **router**, not the plan. An attestation is a statement
 * to the origination path, and the plan it authorises may never exist. Derived
 * rather than stored, like every other separator in this protocol: it embeds
 * `chainId`, and a baked-in value is silently wrong the day the config flips.
 */
export function attestationDomain(chainId: bigint | number, router: Address) {
  return {name: "Plazo", version: "1", chainId: Number(chainId), verifyingContract: router} as const;
}

const ATTESTATION_PARAMETERS = parseAbiParameters(
  "bytes32, bytes32, bytes32, address, bytes32, uint8, uint256, uint256",
);

export function hashLimitAttestation(attestation: LimitAttestation): Hex {
  return keccak256(
    encodeAbiParameters(ATTESTATION_PARAMETERS, [
      LIMIT_ATTESTATION_TYPEHASH,
      attestation.sessionId,
      attestation.planId,
      attestation.borrower,
      attestation.personId,
      attestation.identityClass,
      attestation.limit,
      attestation.validUntil,
    ]),
  );
}

/** The EIP-712 payload the underwriting key signs. */
export function limitAttestationTypedData(
  chainId: bigint | number,
  router: Address,
  attestation: LimitAttestation,
) {
  return {
    domain: attestationDomain(chainId, router),
    types: LIMIT_ATTESTATION_TYPES,
    primaryType: "LimitAttestation",
    message: {
      sessionId: attestation.sessionId,
      planId: attestation.planId,
      borrower: attestation.borrower,
      personId: attestation.personId,
      identityClass: attestation.identityClass,
      limit: attestation.limit,
      validUntil: attestation.validUntil,
    },
  } as const;
}

/**
 * Which band a limit falls in.
 *
 * The chain emits this, never the figure. Coarse and deliberately uneven: the
 * buckets are wide where Tier 0 actually operates, so an operator can spot an
 * anomalous distribution from a compromised signing key and an LP can see the book's
 * shape, while nobody can reconstruct a borrower's exact credit line from a public
 * log. Anyone who could narrow a limit from these could already have guessed it from
 * the tier.
 */
export function bandOf(limit: bigint): number {
  if (limit < 100n * ONE_USDC) return 0;
  if (limit < 250n * ONE_USDC) return 1;
  if (limit < 500n * ONE_USDC) return 2;
  if (limit < 1_000n * ONE_USDC) return 3;
  if (limit < 2_500n * ONE_USDC) return 4;
  if (limit < 5_000n * ONE_USDC) return 5;
  return 6;
}

// ─── The Tier-0 curve ─────────────────────────────────────────────────────────

/**
 * The origination-time parameter set, mirrored from `ParameterRegistry`'s seeds.
 *
 * These are the values a fresh deployment starts with. They move — that is the whole
 * point of the registry — so anything quoting a real limit reads the chain. What
 * this is for is the borrower-facing explanation: UW-08 asks that a borrower can see
 * exactly which events produced their limit, and an answer they cannot reproduce is
 * not an answer.
 */
export const ORIGINATION_DEFAULTS = {
  minTicket: 75n * ONE_USDC,
  maxTicket: 2_000n * ONE_USDC,
  mdrBps: 400n,
  tier0InitialLimit: 100n * ONE_USDC,
  tier0GrowthBps: 12_500n,
  tier0PseudonymousCap: 200n * ONE_USDC,
  tier0IdentifiedCap: 1_000n * ONE_USDC,
  contractSignerCapBps: 5_000n,
  limitHardCeiling: 5_000n * ONE_USDC,
  attestationMaxTtl: 900n,
} as const;

export interface Tier0Inputs {
  cleanCompletions: bigint | number;
  identity: IdentityClass;
  signerClass: SignerClass;
  /** Zero when the borrower already holds an open plan. */
  activePlans?: bigint | number;
  /** 10,000 unless the first-payment-default switch is throttling. */
  throttleBps?: bigint;
  /** What the book can still carry in Tier-0 paper. */
  bookHeadroom?: bigint;
  params?: Partial<typeof ORIGINATION_DEFAULTS>;
}

/**
 * The Tier-0 limit, evaluated the way the contract evaluates it.
 *
 * Iterative rather than a closed form, matching Solidity exactly — the closed form
 * needs fixed-point exponentiation, and a borrower cannot check that by hand.
 */
export function tier0Limit(inputs: Tier0Inputs): bigint {
  const p = {...ORIGINATION_DEFAULTS, ...inputs.params};

  if (BigInt(inputs.activePlans ?? 0) > 0n) return 0n;

  const ceiling = p.tier0IdentifiedCap;
  let limit = p.tier0InitialLimit;

  const steps = Math.min(Number(inputs.cleanCompletions), 64);
  for (let i = 0; i < steps; i++) {
    limit = (limit * p.tier0GrowthBps) / BPS;
    if (limit >= ceiling) {
      limit = ceiling;
      break;
    }
  }

  const identityCap =
    inputs.identity === IdentityClass.Identified ? p.tier0IdentifiedCap : p.tier0PseudonymousCap;
  if (limit > identityCap) limit = identityCap;

  if (inputs.signerClass === SignerClass.Contract) {
    limit = (limit * p.contractSignerCapBps) / BPS;
  }

  limit = (limit * (inputs.throttleBps ?? BPS)) / BPS;

  const headroom = inputs.bookHeadroom;
  if (headroom !== undefined && limit > headroom) limit = headroom;

  return limit;
}

// ─── Quotes and the fallback ladder ───────────────────────────────────────────

export interface QuoteRequest {
  /** What the cart comes to, 6-decimal. */
  cartTotal: bigint;
  installmentCount: bigint;
  /** The largest principal the chain would currently accept. */
  availableLimit: bigint;
  mdrBps?: bigint;
  minTicket?: bigint;
  maxTicket?: bigint;
}

/**
 * A smaller-installment alternative for a borrower over their limit.
 *
 * CHKT-08. A flat decline is the worst available answer to "you are $12 over": the
 * merchant loses the sale, the borrower is told they failed a test nobody explained,
 * and the protocol learns nothing. Financing what the limit allows and taking the
 * remainder at checkout keeps all three parties whole, and it is the only fallback
 * shape Pay-in-4 admits — the schedule is four payments by definition, so what has
 * to move is the principal.
 */
export interface FallbackOffer {
  /** Paid at checkout, outside the plan. */
  upfront: bigint;
  /** What the plan finances. */
  financed: bigint;
  installments: bigint[];
}

export interface Quote {
  approved: boolean;
  /** What the plan would finance. Equals `cartTotal` when approved outright. */
  principal: bigint;
  installments: bigint[];
  mdr: bigint;
  /** What the merchant receives, before any vesting withholding. */
  merchantNet: bigint;
  availableLimit: bigint;
  /** Present only when the cart exceeds the limit and something smaller still works. */
  fallback?: FallbackOffer;
  /** Why the answer is no, when there is not even a fallback. */
  declineReason?: "below-minimum-ticket" | "above-maximum-ticket" | "no-credit-available";
}

function splitInstallments(principal: bigint, count: bigint): bigint[] {
  const base = principal / count;
  const remainder = principal % count;
  return Array.from({length: Number(count)}, (_, i) => (i === 0 ? base + remainder : base));
}

/**
 * Price a cart against a limit.
 *
 * The arithmetic is here rather than in the service so a merchant can check what
 * they were quoted, and so the fallback is sized against the same number the router
 * will enforce. A fallback computed from a service's model of the chain rather than
 * from the chain is a promise the checkout may not be able to keep.
 */
export function buildQuote(request: QuoteRequest): Quote {
  const mdrBps = request.mdrBps ?? ORIGINATION_DEFAULTS.mdrBps;
  const minTicket = request.minTicket ?? ORIGINATION_DEFAULTS.minTicket;
  const maxTicket = request.maxTicket ?? ORIGINATION_DEFAULTS.maxTicket;

  const price = (principal: bigint) => {
    const mdr = (principal * mdrBps) / BPS;
    return {
      principal,
      mdr,
      merchantNet: principal - mdr,
      installments: splitInstallments(principal, request.installmentCount),
    };
  };

  if (request.cartTotal < minTicket) {
    return {
      approved: false,
      ...price(0n),
      availableLimit: request.availableLimit,
      declineReason: "below-minimum-ticket",
    };
  }

  const financeable =
    request.cartTotal < request.availableLimit ? request.cartTotal : request.availableLimit;
  const capped = financeable > maxTicket ? maxTicket : financeable;

  if (capped >= request.cartTotal) {
    return {approved: true, ...price(request.cartTotal), availableLimit: request.availableLimit};
  }

  // Over the limit. Offer what fits, if what fits is worth financing.
  if (capped < minTicket) {
    return {
      approved: false,
      ...price(0n),
      availableLimit: request.availableLimit,
      declineReason: capped === 0n ? "no-credit-available" : "below-minimum-ticket",
    };
  }

  return {
    approved: false,
    ...price(capped),
    availableLimit: request.availableLimit,
    fallback: {
      upfront: request.cartTotal - capped,
      financed: capped,
      installments: splitInstallments(capped, request.installmentCount),
    },
  };
}
