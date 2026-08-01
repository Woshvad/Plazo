/**
 * Plazo Passport — the scoring function, the record encoding, and the commitment.
 *
 * This package exists so that a borrower does not have to take Plazo's word for their
 * own credit standing. Everything in it is pure: give it a record, it gives you the
 * tier and the commitment, and you can check the chain agrees. There is no network
 * call, no API key and no Plazo dependency.
 *
 * The chain holds two things. The *objective* half — how the protocol's own plans
 * ended — is counters, written by a permissionless self-verifying path, and the tier is
 * a pure function of them (PASS-06). The *rich* half never touches the chain at all;
 * the chain holds `keccak256(version ‖ salt ‖ recordHash)` against a published,
 * versioned schema, which is what makes correction and erasure possible on a ledger
 * that cannot forget.
 *
 * `score` here and `PlazoPassport.score` in Solidity are the same function, asserted
 * bit-for-bit across a corpus in `test/parity.test.ts`. If they diverge, CI fails.
 */

import {encodeAbiParameters, keccak256, stringToHex, type Address, type Hex} from "viem";

// ─────────────────────────────────────────────────────────────────────────────
// The coarse tier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five words a counterparty is allowed to hear.
 *
 * Ordinals match the Solidity enum. They are part of the ABI: an indexer reading
 * `OutcomeNoted` and a merchant reading `passportTierOf` both see the number.
 */
export const TIER = {
  Unknown: 0,
  Impaired: 1,
  Building: 2,
  Established: 3,
  Trusted: 4,
} as const;

export type Tier = (typeof TIER)[keyof typeof TIER];

export const TIER_NAME: Record<Tier, string> = {
  [TIER.Unknown]: "Unknown",
  [TIER.Impaired]: "Impaired",
  [TIER.Building]: "Building",
  [TIER.Established]: "Established",
  [TIER.Trusted]: "Trusted",
};

/**
 * How long a negative mark counts for. PASS-03.
 *
 * Twenty-four months, matching `plazo.passport.negativeMarkTtl`. It is a constant here
 * and a registry row on chain, because the chain's copy is the one that binds and this
 * one only has to agree with it — `activeNegatives` takes the TTL as an argument so a
 * caller can pass whatever the registry currently says.
 */
export const NEGATIVE_MARK_TTL = 730n * 24n * 60n * 60n;

/** How many marks a record remembers. Matches `PlazoPassport.MARK_RING`. */
export const MARK_RING = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tier a record's counters produce.
 *
 * PASS-06 in one function: no model, no weights, no discretion. Two borrowers whose
 * plans ended the same way get the same answer, and both of them can check it.
 *
 * A single active mark does not impair — it suppresses growth, which is what one missed
 * payment on an otherwise clean history actually means. Two inside two years is a
 * pattern rather than an accident, and that is where the record says so.
 */
export function score(completions: number | bigint, activeNegatives: number | bigint): Tier {
  const c = BigInt(completions);
  const a = BigInt(activeNegatives);

  if (a >= 2n) return TIER.Impaired;
  if (a === 1n) return c >= 4n ? TIER.Established : TIER.Building;
  if (c >= 5n) return TIER.Trusted;
  if (c >= 2n) return TIER.Established;
  return TIER.Building;
}

/**
 * How many of a record's marks are still inside their life.
 *
 * Ageing is a property of the read, which is what makes PASS-03 true rather than
 * promised: nothing is deleted and no job runs, a mark simply stops being counted.
 */
export function activeNegatives(
  markedAt: readonly bigint[],
  now: bigint,
  ttl: bigint = NEGATIVE_MARK_TTL,
): number {
  const cutoff = now > ttl ? now - ttl : 0n;
  return markedAt.filter((at) => at !== 0n && at >= cutoff).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// The off-chain record and its commitment
// ─────────────────────────────────────────────────────────────────────────────

/** One event in a borrower's record. */
export interface RecordEvent {
  /** A short, stable kind — `plan.repaid`, `identity.attested`, `income.verified`. */
  readonly kind: string;
  /** Unix seconds. */
  readonly at: bigint;
  /**
   * A commitment to whatever the event carries, hashed by the producer.
   *
   * The payload itself never enters this package, and that is deliberate: the record
   * holds PII in the operator's private schema, and a library a borrower runs on their
   * own machine has no business handling it to compute a hash.
   */
  readonly detail: Hex;
}

/** A borrower's record, as the scorer sees it. */
export interface PassportRecord {
  readonly borrower: Address;
  readonly schemaId: Hex;
  readonly schemaVersion: number;
  readonly events: readonly RecordEvent[];
}

const EVENT_TYPEHASH = keccak256(stringToHex("PassportEvent(string kind,uint256 at,bytes32 detail)"));

/**
 * The canonical hash of a record.
 *
 * Events are hashed **in the order given**, not sorted. A record is a history and the
 * order is part of it; sorting would make two different histories collide, and the
 * whole point of a commitment is that it does not.
 */
export function hashRecord(record: PassportRecord): Hex {
  const leaves = record.events.map((event) =>
    keccak256(
      encodeAbiParameters(
        [{type: "bytes32"}, {type: "bytes32"}, {type: "uint256"}, {type: "bytes32"}],
        [
          EVENT_TYPEHASH,
          keccak256(stringToHex(event.kind)),
          event.at,
          event.detail,
        ],
      ),
    ),
  );

  return keccak256(
    encodeAbiParameters(
      [{type: "address"}, {type: "bytes32"}, {type: "uint256"}, {type: "bytes32[]"}],
      [record.borrower, record.schemaId, BigInt(record.schemaVersion), leaves],
    ),
  );
}

/**
 * The commitment the chain holds.
 *
 * `keccak256(version ‖ salt ‖ recordHash)`. The version is inside it so a commitment
 * from an earlier state does not verify against the current one, and the salt is inside
 * it so rotating the salt (PASS-07's erasure) unlinks every commitment ever published
 * without deleting anything from a chain that cannot delete.
 */
export function commitment(version: number | bigint, salt: Hex, recordHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{type: "uint64"}, {type: "bytes32"}, {type: "bytes32"}],
      [BigInt(version), salt, recordHash],
    ),
  );
}

/** Recompute a borrower's commitment from their own record. */
export function commitRecord(record: PassportRecord, version: number | bigint, salt: Hex): Hex {
  return commitment(version, salt, hashRecord(record));
}

// ─────────────────────────────────────────────────────────────────────────────
// Consent (PASS-04)
// ─────────────────────────────────────────────────────────────────────────────

export interface ConsentGrant {
  readonly borrower: Address;
  readonly reader: Address;
  readonly schemaId: Hex;
  readonly validUntil: bigint;
  readonly nonce: bigint;
}

export const CONSENT_TYPES = {
  ConsentGrant: [
    {name: "borrower", type: "address"},
    {name: "reader", type: "address"},
    {name: "schemaId", type: "bytes32"},
    {name: "validUntil", type: "uint256"},
    {name: "nonce", type: "uint256"},
  ],
} as const;

/**
 * The EIP-712 domain for a consent grant.
 *
 * Derived from the chain and the contract every time, never cached. Both fields change
 * on a mainnet that does not exist yet, and a cached separator would silently invalidate
 * every outstanding grant on the day it does.
 */
export function consentDomain(chainId: number, passport: Address) {
  return {
    name: "PlazoPassport",
    version: "1",
    chainId,
    verifyingContract: passport,
  } as const;
}

/** The typed-data payload a borrower signs to let one reader see one schema. */
export function consentTypedData(grant: ConsentGrant, chainId: number, passport: Address) {
  return {
    domain: consentDomain(chainId, passport),
    types: CONSENT_TYPES,
    primaryType: "ConsentGrant",
    message: grant,
  } as const;
}

// ─────────────────────────────────────────────────────────────────────────────
// UW-08 — why the limit is what it is
// ─────────────────────────────────────────────────────────────────────────────

/** One line of the explanation a borrower is owed. */
export interface LimitReason {
  readonly kind: "base" | "growth" | "identity-cap" | "signer-cap" | "throttle" | "book-share" | "active-plan";
  readonly label: string;
  /** What the limit was after this step, in 6-decimal USDC units. */
  readonly limit: bigint;
}

export interface LimitExplanation {
  readonly tier: Tier;
  readonly completions: number;
  readonly activeNegatives: number;
  readonly steps: readonly LimitReason[];
  readonly limit: bigint;
}

/**
 * Turn the underwriter's arithmetic into a list a borrower can read.
 *
 * UW-08 asks that a borrower can see exactly which events produced their limit. The
 * events are onchain and the curve is public, so the honest form of the answer is not a
 * paragraph — it is the sequence of caps, in the order they were applied, with the
 * number after each one. Whichever step the final figure came from is the reason.
 *
 * The caller supplies the figures because they come from the chain; this only shapes
 * them, so that the borrower app and the ops console cannot describe the same decision
 * two different ways.
 */
export function explainLimit(input: {
  completions: number;
  activeNegatives: number;
  curveLimit: bigint;
  identityCap: bigint;
  signerCap: bigint;
  throttled: bigint;
  bookHeadroom: bigint;
  hasActivePlan: boolean;
}): LimitExplanation {
  const steps: LimitReason[] = [];

  if (input.hasActivePlan) {
    steps.push({
      kind: "active-plan",
      label: "One plan at a time until the first one completes",
      limit: 0n,
    });
    return {
      tier: score(input.completions, input.activeNegatives),
      completions: input.completions,
      activeNegatives: input.activeNegatives,
      steps,
      limit: 0n,
    };
  }

  let limit = input.curveLimit;
  steps.push({
    kind: input.completions > 0 ? "growth" : "base",
    label:
      input.completions > 0
        ? `${input.completions} plan${input.completions === 1 ? "" : "s"} completed cleanly`
        : "Starting limit",
    limit,
  });

  const caps: ReadonlyArray<[LimitReason["kind"], string, bigint]> = [
    ["identity-cap", "Cap for this identity class", input.identityCap],
    ["signer-cap", "Reduced cap for a wallet whose signer can change", input.signerCap],
    ["throttle", "Cohort default throttle", input.throttled],
    ["book-share", "Share of the funding book Tier 0 may hold", input.bookHeadroom],
  ];

  for (const [kind, label, cap] of caps) {
    if (cap < limit) {
      limit = cap;
      steps.push({kind, label, limit});
    }
  }

  return {
    tier: score(input.completions, input.activeNegatives),
    completions: input.completions,
    activeNegatives: input.activeNegatives,
    steps,
    limit,
  };
}
