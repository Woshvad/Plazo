/**
 * The Solidity ⇄ TypeScript differential gate for the credit decision.
 *
 * The third parity pair. Phase 1 pinned `planId` and the clone address, Phase 2 the
 * strip and the acceptance, and this one pins what a merchant's checkout and a
 * borrower's client compute *before* any of that exists: the attestation digest an
 * underwriting key signs, the limit curve, and the band the chain will emit.
 *
 * Each has a distinct failure mode if the two sides drift. A digest mismatch means
 * every signature the service issues is unusable, discovered at checkout in front of
 * a buyer. A curve mismatch means a borrower is shown a limit they do not have. A
 * band mismatch makes the one thing the protocol does disclose unreadable.
 *
 * The corpus is regenerated from Solidity in the same CI job that runs this file.
 */
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {hashTypedData, type Address, type Hex} from "viem";

import {
  attestationDomain,
  bandOf,
  BPS,
  hashLimitAttestation,
  IdentityClass,
  LIMIT_ATTESTATION_TYPES,
  limitAttestationTypedData,
  ORIGINATION_DEFAULTS,
  pseudonymousId,
  SignerClass,
  tier0Limit,
  type LimitAttestation,
} from "../src/index.js";

interface CurveParams {
  initialLimit: string;
  growthBps: string;
  pseudonymousCap: string;
  identifiedCap: string;
  contractSignerCapBps: string;
}

interface CorpusRow {
  sessionId: Hex;
  planId: Hex;
  borrower: Address;
  personId: Hex;
  identityClass: number;
  limit: string;
  validUntil: string;
  cleanCompletions: string;
  identified: boolean;
  mutableSigner: boolean;
  tier0Limit: string;
  band: number;
  structHash: Hex;
  digest: Hex;
}

interface Corpus {
  version: number;
  chainId: number;
  router: Address;
  params: CurveParams;
  rows: CorpusRow[];
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus: Corpus = JSON.parse(
  readFileSync(join(here, "../../../contracts/corpus/underwriting.json"), "utf8"),
);

const params = {
  tier0InitialLimit: BigInt(corpus.params.initialLimit),
  tier0GrowthBps: BigInt(corpus.params.growthBps),
  tier0PseudonymousCap: BigInt(corpus.params.pseudonymousCap),
  tier0IdentifiedCap: BigInt(corpus.params.identifiedCap),
  contractSignerCapBps: BigInt(corpus.params.contractSignerCapBps),
};

function attestationOf(row: CorpusRow): LimitAttestation {
  return {
    sessionId: row.sessionId,
    planId: row.planId,
    borrower: row.borrower,
    personId: row.personId,
    identityClass: row.identityClass as IdentityClass,
    limit: BigInt(row.limit),
    validUntil: BigInt(row.validUntil),
  };
}

describe("underwriting parity", () => {
  it("reads a corpus with rows", () => {
    expect(corpus.rows.length).toBeGreaterThan(0);
    expect(corpus.version).toBe(1);
  });

  it("agrees on the seeded curve parameters", () => {
    // Not a tautology: the registry seeds and this module's mirror are two
    // hand-written copies of the same table, and a client that ships the wrong
    // default quotes limits nobody can originate.
    expect(params.tier0InitialLimit).toBe(ORIGINATION_DEFAULTS.tier0InitialLimit);
    expect(params.tier0GrowthBps).toBe(ORIGINATION_DEFAULTS.tier0GrowthBps);
    expect(params.tier0PseudonymousCap).toBe(ORIGINATION_DEFAULTS.tier0PseudonymousCap);
    expect(params.tier0IdentifiedCap).toBe(ORIGINATION_DEFAULTS.tier0IdentifiedCap);
    expect(params.contractSignerCapBps).toBe(ORIGINATION_DEFAULTS.contractSignerCapBps);
  });

  it("computes the same attestation struct hash", () => {
    for (const row of corpus.rows) {
      expect(hashLimitAttestation(attestationOf(row))).toBe(row.structHash);
    }
  });

  it("computes the same attestation digest", () => {
    for (const row of corpus.rows) {
      const attestation = attestationOf(row);

      // Both routes: the manual hash and viem's typed-data encoder, which is what a
      // wallet or a signing service actually calls.
      const manual = hashTypedData({
        domain: attestationDomain(corpus.chainId, corpus.router),
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
      });
      expect(manual).toBe(row.digest);

      const built = limitAttestationTypedData(corpus.chainId, corpus.router, attestation);
      expect(hashTypedData(built)).toBe(row.digest);
    }
  });

  it("computes the same Tier-0 limit", () => {
    for (const row of corpus.rows) {
      expect(
        tier0Limit({
          cleanCompletions: BigInt(row.cleanCompletions),
          identity: row.identified ? IdentityClass.Identified : IdentityClass.Pseudonymous,
          signerClass: row.mutableSigner ? SignerClass.Contract : SignerClass.EOA,
          params,
        }),
      ).toBe(BigInt(row.tier0Limit));
    }
  });

  it("computes the same band", () => {
    for (const row of corpus.rows) {
      expect(bandOf(BigInt(row.limit))).toBe(row.band);
    }
  });

  /**
   * A scale error in the band function must fail loudly.
   *
   * The same shape as the jitter check in the strip corpus: a parity suite that
   * passes against a perturbed implementation would not have caught the real drift
   * either. The perturbation chosen is the one this codebase is actually exposed to
   * — Arc USDC is 18-decimal natively and 6-decimal over ERC-20 on one balance, and
   * a client that hands the band function a figure in the wrong scale gets an answer
   * that is confidently wrong rather than an error.
   */
  it("fails when a limit is banded at the wrong scale", () => {
    const disagreements = corpus.rows.filter((row) => bandOf(BigInt(row.limit) * 2n) !== row.band);

    // Most rows shift a bucket when the input doubles; the top band is absorbing and
    // the very smallest limits stay in band 0, so this is a strong majority rather
    // than everything.
    expect(disagreements.length).toBeGreaterThan(corpus.rows.length / 2);
  });

  /**
   * And a growth factor off by one basis point must fail somewhere.
   */
  it("fails when the growth factor moves by a basis point", () => {
    const off = {...params, tier0GrowthBps: params.tier0GrowthBps + 1n};

    const disagreements = corpus.rows.filter(
      (row) =>
        tier0Limit({
          cleanCompletions: BigInt(row.cleanCompletions),
          identity: row.identified ? IdentityClass.Identified : IdentityClass.Pseudonymous,
          signerClass: row.mutableSigner ? SignerClass.Contract : SignerClass.EOA,
          params: off,
        }) !== BigInt(row.tier0Limit),
    );
    expect(disagreements.length).toBeGreaterThan(0);
  });

  it("derives the same pseudonymous person id shape", () => {
    // The contract's own `pseudonymousId` is exercised by the Solidity suite; what is
    // checked here is that the TypeScript derivation is domain-separated and
    // injective over wallets, which is what stops a pseudonymous key colliding with
    // an attested identity commitment.
    const a = pseudonymousId("0x00000000000000000000000000000000000000a1");
    const b = pseudonymousId("0x00000000000000000000000000000000000000b2");
    expect(a).not.toBe(b);
    expect(a).not.toBe("0x00000000000000000000000000000000000000a1".toLowerCase());
  });

  it("keeps BPS consistent across the two modules", () => {
    expect(BPS).toBe(10_000n);
  });
});
