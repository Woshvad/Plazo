import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {keccak256, toHex} from "viem";

import {
  activeNegatives,
  commitment,
  commitRecord,
  explainLimit,
  hashRecord,
  MARK_RING,
  NEGATIVE_MARK_TTL,
  score,
  TIER,
  type PassportRecord,
} from "../src/index.js";

/**
 * The fourth parity corpus.
 *
 * `contracts/test/PassportParity.t.sol` generates it from the Solidity implementation;
 * this recomputes every row in TypeScript and asserts they agree. If they diverge, CI
 * fails — which is the only way PASS-06's "identical repayment histories produce
 * identical scores" is checkable by the borrower it protects rather than believable on
 * Plazo's word.
 */

interface Row {
  completions: string;
  marks: string[];
  active: string;
  tier: number;
}

interface Corpus {
  version: number;
  now: string;
  ttl: string;
  markRing: number;
  rows: Row[];
}

const corpusPath = fileURLToPath(new URL("../../../contracts/corpus/passport.json", import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;

describe("passport parity", () => {
  it("has a corpus to check against", () => {
    expect(corpus.rows.length).toBeGreaterThan(50);
    expect(corpus.markRing).toBe(MARK_RING);
  });

  it("agrees with Solidity on the negative-mark ageing window", () => {
    expect(BigInt(corpus.ttl)).toBe(NEGATIVE_MARK_TTL);
  });

  it("counts the same marks as active", () => {
    const now = BigInt(corpus.now);
    const ttl = BigInt(corpus.ttl);

    for (const [i, row] of corpus.rows.entries()) {
      const marks = row.marks.map(BigInt);
      expect(activeNegatives(marks, now, ttl), `row ${i}`).toBe(Number(row.active));
    }
  });

  it("scores every row identically", () => {
    for (const [i, row] of corpus.rows.entries()) {
      expect(score(Number(row.completions), Number(row.active)), `row ${i}`).toBe(row.tier);
    }
  });

  /**
   * The perturbation test. A corpus that agrees proves the two implementations match; it
   * does not prove the comparison would notice if they stopped.
   *
   * The failure modelled here is the one a recalibration actually invites: someone
   * decides two marks is harsh and moves the threshold in one implementation. It is a
   * one-character change, it looks like a policy tweak, and it silently gives every
   * two-mark borrower a better tier than the chain will honour.
   */
  it("would notice if the threshold moved in one implementation only", () => {
    const drifted = (completions: number, active: number) => {
      if (active >= 3) return TIER.Impaired;
      if (active === 1) return completions >= 4 ? TIER.Established : TIER.Building;
      if (completions >= 5) return TIER.Trusted;
      if (completions >= 2) return TIER.Established;
      return TIER.Building;
    };

    const disagreements = corpus.rows.filter(
      (row) => drifted(Number(row.completions), Number(row.active)) !== row.tier,
    );

    expect(disagreements.length).toBeGreaterThan(0);
  });
});

describe("the record commitment", () => {
  const record: PassportRecord = {
    borrower: "0x00000000000000000000000000000000000c0ffe",
    schemaId: keccak256(toHex("plazo.passport.v1")),
    schemaVersion: 1,
    events: [
      {kind: "plan.repaid", at: 1_800_000_000n, detail: keccak256(toHex("plan-a"))},
      {kind: "plan.delinquent", at: 1_800_100_000n, detail: keccak256(toHex("plan-b"))},
    ],
  };

  it("is deterministic", () => {
    expect(hashRecord(record)).toBe(hashRecord({...record, events: [...record.events]}));
  });

  /**
   * Order is part of the history. Sorting the events before hashing would make two
   * different histories collide, and a commitment that collides is not one.
   */
  it("depends on the order of the events", () => {
    const reversed: PassportRecord = {...record, events: [...record.events].reverse()};
    expect(hashRecord(reversed)).not.toBe(hashRecord(record));
  });

  it("changes when the schema version changes", () => {
    expect(hashRecord({...record, schemaVersion: 2})).not.toBe(hashRecord(record));
  });

  /**
   * PASS-07's erasure, from the borrower's side. Rotating the salt does not delete
   * anything — it makes every previously published commitment a hash of nothing anyone
   * can check.
   */
  it("is unlinkable across a salt rotation", () => {
    const before = commitRecord(record, 1, keccak256(toHex("salt-one")));
    const after = commitRecord(record, 2, keccak256(toHex("salt-two")));
    expect(before).not.toBe(after);
  });

  it("binds the version, so an earlier commitment does not verify", () => {
    const hash = hashRecord(record);
    const salt = keccak256(toHex("salt"));
    expect(commitment(1, salt, hash)).not.toBe(commitment(2, salt, hash));
  });
});

describe("explaining a limit", () => {
  const base = {
    completions: 3,
    activeNegatives: 0,
    curveLimit: 195_000_000n,
    identityCap: 200_000_000n,
    signerCap: 200_000_000n,
    throttled: 195_000_000n,
    bookHeadroom: 500_000_000n,
    hasActivePlan: false,
  };

  it("names the growth that produced the limit", () => {
    const explanation = explainLimit(base);
    expect(explanation.limit).toBe(195_000_000n);
    expect(explanation.steps[0]?.kind).toBe("growth");
    expect(explanation.steps[0]?.label).toContain("3 plans");
  });

  /** Whichever cap the final figure came from is the reason, and it is the last step. */
  it("names the cap that actually bound", () => {
    const explanation = explainLimit({...base, bookHeadroom: 40_000_000n});
    expect(explanation.limit).toBe(40_000_000n);
    expect(explanation.steps.at(-1)?.kind).toBe("book-share");
  });

  it("says so when the answer is an active plan rather than a number", () => {
    const explanation = explainLimit({...base, hasActivePlan: true});
    expect(explanation.limit).toBe(0n);
    expect(explanation.steps).toHaveLength(1);
    expect(explanation.steps[0]?.kind).toBe("active-plan");
  });

  it("reports the tier alongside the arithmetic", () => {
    expect(explainLimit(base).tier).toBe(TIER.Established);
    expect(explainLimit({...base, activeNegatives: 2}).tier).toBe(TIER.Impaired);
  });
});
