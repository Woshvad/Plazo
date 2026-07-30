/**
 * The Solidity ⇄ TypeScript differential gate for the strip.
 *
 * Phase 1 proved parity for `planId`, the nonces and the clone address. Everything
 * checked here is what a borrower's wallet has to build before any of that becomes
 * useful: the terms commitment, the schedule, the face values, the authorization
 * windows and the acceptance digest.
 *
 * The corpus is regenerated from Solidity in the same CI job that runs this file, so
 * the two sides cannot drift apart between commits — a stale fixture would let one
 * implementation change while the test kept passing against the old output of the
 * other.
 */
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import {hashTypedData, type Address, type Hex} from "viem";

import {
  acceptanceDomain,
  buildAcceptance,
  buildStrip,
  collectBounty,
  dueDates,
  GRACE_WINDOW,
  hashTermsDetail,
  installmentAmounts,
  markEscrowFor,
  PLAN_ACCEPTANCE_TYPES,
  predictPlanAddress,
  derivePlanId,
  scheduleJitter,
  type PlanTerms,
  type SignerClass,
  type TermsDetail,
} from "../src/index.js";

interface CorpusRow {
  factory: Address;
  implementation: Address;
  borrower: Address;
  merchant: Address;
  token: Address;
  principal: string;
  installmentCount: string;
  firstDueDate: string;
  interval: string;
  originationNonce: string;
  jurisdiction: Hex;
  lineItemsHash: Hex;
  mdrBps: string;
  lateFeeFlat: string;
  signerClass: number;
  settlementRecipient: Address;
  fxRouter: Address;
  termsHash: Hex;
  planId: Hex;
  planAddress: Address;
  jitter: string;
  markEscrow: string;
  validUntil: string;
  acceptanceDigest: Hex;
  dueDates: string[];
  amounts: string[];
  nonces: Hex[];
  bountiesAtGraceEnd: string[];
}

interface Corpus {
  version: number;
  chainId: number;
  rows: CorpusRow[];
}

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(join(here, "../../../contracts/corpus/plan-strip.json"), "utf8"),
) as Corpus;

function termsOf(row: CorpusRow): PlanTerms {
  return {
    chainId: BigInt(corpus.chainId),
    factory: row.factory,
    implementation: row.implementation,
    borrower: row.borrower,
    merchant: row.merchant,
    token: row.token,
    principal: BigInt(row.principal),
    installmentCount: BigInt(row.installmentCount),
    firstDueDate: BigInt(row.firstDueDate),
    interval: BigInt(row.interval),
    originationNonce: BigInt(row.originationNonce),
    termsHash: row.termsHash,
  };
}

function detailOf(row: CorpusRow): TermsDetail {
  return {
    jurisdiction: row.jurisdiction,
    lineItemsHash: row.lineItemsHash,
    mdrBps: BigInt(row.mdrBps),
    lateFeeFlat: BigInt(row.lateFeeFlat),
    signerClass: row.signerClass as SignerClass,
    settlementRecipient: row.settlementRecipient,
    fxRouter: row.fxRouter,
  };
}

describe("strip parity", () => {
  it("has a corpus wide enough to catch encoding drift", () => {
    expect(corpus.rows.length).toBeGreaterThanOrEqual(64);
    // Uneven divisions, contract signers and every installment count from 2 to 12
    // have to be in here, or the parity claim only covers the happy shape.
    expect(corpus.rows.some((r) => BigInt(r.principal) % BigInt(r.installmentCount) !== 0n)).toBe(
      true,
    );
    expect(corpus.rows.some((r) => r.signerClass === 1)).toBe(true);
    expect(new Set(corpus.rows.map((r) => r.installmentCount)).size).toBeGreaterThan(5);
  });

  it.each(corpus.rows.map((row, i) => [i, row] as const))(
    "row %i derives identically in both implementations",
    (_i, row) => {
      const terms = termsOf(row);

      // Everything that can move value — jurisdiction, recipient, router, fee — is
      // inside this hash, which is inside planId, which is inside every nonce and
      // the payee address.
      expect(hashTermsDetail(detailOf(row))).toBe(row.termsHash);
      expect(derivePlanId(terms)).toBe(row.planId);
      expect(
        predictPlanAddress({
          deployer: terms.factory,
          implementation: terms.implementation,
          planId: row.planId,
        }),
      ).toBe(row.planAddress);

      expect(scheduleJitter(row.planId)).toBe(BigInt(row.jitter));
      expect(markEscrowFor(terms.installmentCount)).toBe(BigInt(row.markEscrow));

      expect(dueDates(row.planId, terms)).toEqual(row.dueDates.map(BigInt));
      expect(installmentAmounts(terms)).toEqual(row.amounts.map(BigInt));

      const strip = buildStrip(terms, row.planId);
      expect(strip.map((c) => c.nonce)).toEqual(row.nonces);
      expect(strip.map((c) => c.value)).toEqual(row.amounts.map(BigInt));
      expect(strip.every((c) => c.to === row.planAddress)).toBe(true);

      // The token's window is strict at both ends. `validAfter` sits one second
      // before the due date so an installment due at T is collectible at T — and so
      // the down payment can be taken in the transaction that originates the plan.
      strip.forEach((check, index) => {
        expect(check.validAfter).toBe(BigInt(row.dueDates[index]!) - 1n);
        expect(check.validBefore).toBeGreaterThan(BigInt(row.dueDates[index]!));
      });

      expect(strip.map((c) => collectBounty(c.value, GRACE_WINDOW))).toEqual(
        row.bountiesAtGraceEnd.map(BigInt),
      );

      const acceptance = buildAcceptance(terms, BigInt(row.validUntil), row.planId);
      expect(
        hashTypedData({
          domain: acceptanceDomain(corpus.chainId, row.planAddress),
          types: PLAN_ACCEPTANCE_TYPES,
          primaryType: "PlanAcceptance",
          message: acceptance,
        }),
      ).toBe(row.acceptanceDigest);
    },
  );
});

describe("the gate is load-bearing", () => {
  const row = corpus.rows[0]!;

  it("a changed field in the terms commitment changes the plan identity", () => {
    const detail = detailOf(row);
    const moved = hashTermsDetail({...detail, settlementRecipient: row.borrower});
    expect(moved).not.toBe(row.termsHash);
    expect(derivePlanId({...termsOf(row), termsHash: moved})).not.toBe(row.planId);
  });

  it("a one-second shift in the schedule changes every authorization", () => {
    const terms = termsOf(row);
    const shifted = {...terms, firstDueDate: terms.firstDueDate + 1n};
    const before = buildStrip(terms, row.planId);
    const after = buildStrip(shifted, row.planId);
    expect(after.map((c) => c.validAfter)).not.toEqual(before.map((c) => c.validAfter));
  });

  it("the acceptance is bound to the plan address, not merely to the plan id", () => {
    const acceptance = buildAcceptance(termsOf(row), BigInt(row.validUntil), row.planId);
    const elsewhere = hashTypedData({
      domain: acceptanceDomain(corpus.chainId, row.borrower),
      types: PLAN_ACCEPTANCE_TYPES,
      primaryType: "PlanAcceptance",
      message: acceptance,
    });
    expect(elsewhere).not.toBe(row.acceptanceDigest);
  });
});
