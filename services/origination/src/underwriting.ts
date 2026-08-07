/**
 * The underwriting engine — OPS-03.
 *
 * It decides a limit and signs it. That is the whole surface, and keeping it that
 * small is the point: everything else about a credit decision stays off the chain,
 * and everything the chain needs is a number with a signature over it.
 *
 * ## What this service can and cannot do
 *
 * It cannot extend credit. The router takes the minimum of this figure, a hard
 * on-chain ceiling, the Tier-0 cap, the kill-switch throttle and the book-share
 * headroom, so an attestation can only ever *lower* what the chain would already
 * have allowed. That is deliberate and it is the answer to "what happens when the
 * signing key leaks": the holder can decline business and nothing else.
 *
 * It can decline. A compromised key that issues zeroes is a denial of service, and
 * the mitigation is operational — rotate the key, which is a role revocation rather
 * than a redeployment because the router checks a role rather than an address.
 *
 * ## The chain is the source of the limit, not this service
 *
 * `capFor` is a public view. This service reads it and signs what it read, rather
 * than maintaining its own model of a borrower's standing — a model that drifts from
 * the chain produces attestations that fail at origination, in front of a buyer, for
 * reasons the buyer cannot be told.
 */
import {
  bandOf,
  IdentityClass,
  limitAttestationTypedData,
  pseudonymousId,
  type LimitAttestation,
  type SignerClass,
} from "@plazo/plan-core";
import type {Address, Hex} from "viem";

import {NO_TIER1, type Tier1Decision, type Tier1Reader} from "./tier1.js";

/**
 * Reads the chain. Implemented over viem in production; a function here so the
 * decision logic is testable without a node.
 */
export interface ChainReader {
  /** `Tier0Underwriter.capFor`, or a partner's equivalent. */
  capFor(personId: Hex, identity: IdentityClass, signerClass: SignerClass): Promise<bigint>;
  /** `CheckoutRouter.maxPrincipalFor` — the cap *and* every other binding constraint. */
  maxPrincipalFor(args: {
    personId: Hex;
    identity: IdentityClass;
    signerClass: SignerClass;
    merchant: Address;
    token: Address;
  }): Promise<bigint>;
}

/** Signs the attestation. A KMS in production, a local key in tests. */
export interface AttestationSigner {
  readonly address: Address;
  signTypedData(payload: ReturnType<typeof limitAttestationTypedData>): Promise<Hex>;
}

export interface UnderwriterConfig {
  chainId: number;
  router: Address;
  reader: ChainReader;
  signer: AttestationSigner;
  /**
   * Seconds. Must be at or under the registry's `ATTESTATION_MAX_TTL`, which the
   * router enforces — an attestation valid for longer is refused on arrival.
   */
  ttlSeconds?: number;
  /**
   * UW-04's inflow scorer, injected.
   *
   * Defaults to `NO_TIER1`, which proposes zero. An unconfigured credit input has to
   * decline rather than throw or guess: the inflow backfill has never completed on this
   * chain, so "Tier 1 has nothing to say" is the ordinary case and it must not be able
   * to turn into a plausible number by accident. `ServicingDeps.merchants` is the
   * precedent (DEC-64/DEC-77).
   */
  tier1?: Tier1Reader;
}

/**
 * Ten minutes, under the fifteen the registry allows.
 *
 * The margin is deliberate. An attestation issued at exactly the ceiling fails if the
 * borrower takes a minute to press sign, and "your credit approval expired while you
 * were reading it" is not a message any checkout should be able to produce.
 */
export const DEFAULT_ATTESTATION_TTL = 10 * 60;

export interface DecisionRequest {
  sessionId: Hex;
  planId: Hex;
  borrower: Address;
  merchant: Address;
  token: Address;
  signerClass: SignerClass;
  /** Present when an operator has attested this borrower's wallets together. */
  attestedPersonId?: Hex;
  now?: number;
}

export interface Decision {
  attestation: LimitAttestation;
  signature: Hex;
  attestor: Address;
  /** What reaches the log. Never the figure. */
  band: number;
  /** The largest principal that would actually originate, all constraints applied. */
  maxPrincipal: bigint;
  /**
   * What Tier 1 proposed, and why.
   *
   * **It is not folded into `attestation.limit`, and it must not be.** This service
   * cannot raise anyone's credit — the router takes the minimum of the attestation and
   * every onchain cap — so an operator-side uplift would be a number that never binds
   * and a claim the chain would silently refuse. The place a Tier-1 figure becomes
   * binding is `TieredUnderwriter.capFor` on chain (plan 07-07), which reads
   * `PayrollSweeper.isOptedIn` for itself. What this field is for is the borrower's own
   * answer to "why is my limit what it is" (UW-08) and the operator's ability to see
   * the scorer's distribution before it is wired to anything.
   */
  tier1: Tier1Decision;
}

export class Underwriter {
  private readonly ttl: number;
  private readonly tier1: Tier1Reader;

  constructor(private readonly config: UnderwriterConfig) {
    this.ttl = config.ttlSeconds ?? DEFAULT_ATTESTATION_TTL;
    this.tier1 = config.tier1 ?? NO_TIER1;
  }

  /**
   * The aggregation key for a borrower.
   *
   * An attested commitment when the operator has one, and the domain-separated
   * derivation of the wallet otherwise. The pseudonymous form is computable by
   * anyone, which is exactly why it never reaches an event.
   */
  personIdFor(borrower: Address, attested?: Hex): {personId: Hex; identity: IdentityClass} {
    return attested
      ? {personId: attested, identity: IdentityClass.Identified}
      : {personId: pseudonymousId(borrower), identity: IdentityClass.Pseudonymous};
  }

  async decide(request: DecisionRequest): Promise<Decision> {
    const now = request.now ?? Math.floor(Date.now() / 1000);
    const {personId, identity} = this.personIdFor(request.borrower, request.attestedPersonId);

    // Two reads rather than one. `capFor` is the underwriting answer; `maxPrincipalFor`
    // is what the router will actually accept once merchant concentration, velocity
    // and the pause plane are folded in. The attestation carries the first because it
    // is a statement about the borrower; the quote uses the second because it is a
    // statement about this purchase.
    const [limit, maxPrincipal, tier1] = await Promise.all([
      this.config.reader.capFor(personId, identity, request.signerClass),
      this.config.reader.maxPrincipalFor({
        personId,
        identity,
        signerClass: request.signerClass,
        merchant: request.merchant,
        token: request.token,
      }),
      this.tier1.proposeFor({borrower: request.borrower, personId, identity}),
    ]);

    const attestation: LimitAttestation = {
      sessionId: request.sessionId,
      planId: request.planId,
      borrower: request.borrower,
      personId,
      identityClass: identity,
      limit,
      validUntil: BigInt(now + this.ttl),
    };

    const signature = await this.config.signer.signTypedData(
      limitAttestationTypedData(this.config.chainId, this.config.router, attestation),
    );

    return {
      attestation,
      signature,
      attestor: this.config.signer.address,
      band: bandOf(limit),
      maxPrincipal,
      tier1,
    };
  }
}

/**
 * An anomaly detector over the band stream.
 *
 * CHKT-05 asks for a compromised signing key to be *detectable*, and this is what
 * makes that a procedure rather than an aspiration. A key that starts issuing
 * top-band attestations shows up as a distribution shift long before anyone notices
 * a loss, and it does so without any borrower's limit appearing anywhere.
 *
 * Intentionally simple. A model would be better at this and would also be a thing
 * nobody can explain during an incident.
 */
export function bandDistributionShift(
  baseline: readonly number[],
  recent: readonly number[],
): {shifted: boolean; baselineMean: number; recentMean: number} {
  const mean = (xs: readonly number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

  const baselineMean = mean(baseline);
  const recentMean = mean(recent);

  // A whole band of drift in the average is a large move on a seven-bucket scale, and
  // it is the smallest move worth waking someone for.
  return {shifted: recent.length > 0 && recentMean - baselineMean >= 1, baselineMean, recentMean};
}
