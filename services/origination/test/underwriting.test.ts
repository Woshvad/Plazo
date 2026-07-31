/**
 * OPS-03 and OPS-05 — the underwriting engine and the compliance stream.
 *
 * The load-bearing assertion in this file is the one about what a stolen signing key
 * can do, and the answer has to be "nothing that raises a limit". That is enforced
 * on-chain rather than here, so what is checked here is the half this service owns:
 * that it signs what the chain said rather than what it believed, that the
 * attestation it issues is short-lived and session-bound, and that the band it emits
 * is the only thing about the decision that becomes public.
 */
import {describe, expect, it} from "vitest";
import {privateKeyToAccount} from "viem/accounts";
import {hashTypedData, keccak256, recoverTypedDataAddress, toHex, type Address, type Hex} from "viem";

import {
  bandOf,
  IdentityClass,
  limitAttestationTypedData,
  pseudonymousId,
  SignerClass,
} from "@plazo/plan-core";

import {
  bandDistributionShift,
  DEFAULT_ATTESTATION_TTL,
  Underwriter,
  type ChainReader,
} from "../src/underwriting.js";
import {
  ComplianceReconciler,
  ComplianceStatus,
  midStripDenials,
  type ComplianceReader,
  type ComplianceWriter,
  type ScreeningUpdate,
} from "../src/compliance.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const account = privateKeyToAccount(KEY);

const ROUTER = "0x00000000000000000000000000000000000c0ffe" as Address;
const BORROWER = "0x00000000000000000000000000000000000b0110" as Address;
const MERCHANT = "0x00000000000000000000000000000000000acced" as Address;
const TOKEN = "0x3600000000000000000000000000000000000000" as Address;
const CHAIN_ID = 5042002;

const SESSION = keccak256(toHex("session-1"));
const PLAN = keccak256(toHex("plan-1"));
const NOW = 1_800_000_000;

function reader(cap: bigint, max = cap): ChainReader {
  return {
    async capFor() {
      return cap;
    },
    async maxPrincipalFor() {
      return max;
    },
  };
}

const signer = {
  address: account.address,
  async signTypedData(payload: ReturnType<typeof limitAttestationTypedData>): Promise<Hex> {
    return account.signTypedData(payload as never);
  },
};

function underwriter(cap: bigint, max = cap): Underwriter {
  return new Underwriter({chainId: CHAIN_ID, router: ROUTER, reader: reader(cap, max), signer});
}

const request = {
  sessionId: SESSION,
  planId: PLAN,
  borrower: BORROWER,
  merchant: MERCHANT,
  token: TOKEN,
  signerClass: SignerClass.EOA,
  now: NOW,
};

describe("the underwriting engine", () => {
  it("signs the limit the chain reported, not one of its own", async () => {
    const decision = await underwriter(150_000_000n).decide(request);
    expect(decision.attestation.limit).toBe(150_000_000n);
  });

  it("produces a signature the router will recover to the attesting key", async () => {
    const decision = await underwriter(150_000_000n).decide(request);

    const payload = limitAttestationTypedData(CHAIN_ID, ROUTER, decision.attestation);
    const recovered = await recoverTypedDataAddress({
      domain: payload.domain,
      types: payload.types,
      primaryType: payload.primaryType,
      message: payload.message,
      signature: decision.signature,
    });

    expect(recovered).toBe(account.address);
    expect(decision.attestor).toBe(account.address);
  });

  /**
   * Session-bound and plan-bound. An attestation issued for a $200 purchase at one
   * merchant cannot originate a different plan, because the plan id already binds
   * borrower, merchant, principal, schedule and terms hash.
   */
  it("binds the attestation to the session and the plan", async () => {
    const decision = await underwriter(150_000_000n).decide(request);
    expect(decision.attestation.sessionId).toBe(SESSION);
    expect(decision.attestation.planId).toBe(PLAN);
    expect(decision.attestation.borrower).toBe(BORROWER);
  });

  /**
   * Ten minutes, under the registry's fifteen. The margin is deliberate: an
   * attestation issued at exactly the ceiling fails if the borrower takes a minute to
   * press sign, and "your credit approval expired while you were reading it" is not a
   * message any checkout should be able to produce.
   */
  it("issues a short-lived attestation with headroom under the on-chain ceiling", async () => {
    const decision = await underwriter(150_000_000n).decide(request);
    expect(decision.attestation.validUntil).toBe(BigInt(NOW + DEFAULT_ATTESTATION_TTL));
    expect(DEFAULT_ATTESTATION_TTL).toBeLessThan(15 * 60);
  });

  it("derives a pseudonymous person id when no identity is attested", async () => {
    const decision = await underwriter(150_000_000n).decide(request);
    expect(decision.attestation.personId).toBe(pseudonymousId(BORROWER));
    expect(decision.attestation.identityClass).toBe(IdentityClass.Pseudonymous);
  });

  it("uses an attested commitment when the operator has one", async () => {
    const attested = keccak256(toHex("a person"));
    const decision = await underwriter(900_000_000n).decide({...request, attestedPersonId: attested});

    expect(decision.attestation.personId).toBe(attested);
    expect(decision.attestation.identityClass).toBe(IdentityClass.Identified);
  });

  /**
   * The two reads answer different questions and both are needed. `capFor` is about
   * the borrower; `maxPrincipalFor` folds in merchant concentration, velocity and the
   * pause plane, and is what the quote has to size a fallback against.
   */
  it("reports what will actually originate, not only the borrower's cap", async () => {
    const decision = await underwriter(150_000_000n, 80_000_000n).decide(request);
    expect(decision.attestation.limit).toBe(150_000_000n);
    expect(decision.maxPrincipal).toBe(80_000_000n);
  });

  it("reports only a band, and the band is the one the chain computes", async () => {
    const decision = await underwriter(150_000_000n).decide(request);
    expect(decision.band).toBe(bandOf(150_000_000n));
    expect(decision.band).toBe(1);
  });

  it("signs a different digest for a different session", async () => {
    const u = underwriter(150_000_000n);
    const a = await u.decide(request);
    const b = await u.decide({...request, sessionId: keccak256(toHex("session-2"))});

    expect(hashTypedData(limitAttestationTypedData(CHAIN_ID, ROUTER, a.attestation) as never)).not.toBe(
      hashTypedData(limitAttestationTypedData(CHAIN_ID, ROUTER, b.attestation) as never),
    );
  });
});

describe("band anomaly detection", () => {
  /**
   * CHKT-05's detectability half. A key that starts issuing top-band attestations
   * shows up as a distribution shift long before anyone notices a loss, and it does
   * so without any borrower's limit appearing anywhere.
   */
  it("notices a key that starts issuing high bands", () => {
    const shift = bandDistributionShift([0, 1, 1, 0, 1, 1], [5, 6, 5, 6]);
    expect(shift.shifted).toBe(true);
    expect(shift.recentMean).toBeGreaterThan(shift.baselineMean);
  });

  it("does not fire on normal variation", () => {
    expect(bandDistributionShift([0, 1, 1, 2], [1, 1, 0, 2]).shifted).toBe(false);
  });

  it("does not fire on an empty window", () => {
    expect(bandDistributionShift([0, 1, 1], []).shifted).toBe(false);
  });
});

describe("compliance is a stream, not a lookup", () => {
  class FakeChain implements ComplianceReader, ComplianceWriter {
    readonly status = new Map<string, ComplianceStatus>();
    readonly at = new Map<string, number>();
    readonly writes: {accounts: Address[]; statuses: ComplianceStatus[]}[] = [];

    async statusOf(account: Address): Promise<ComplianceStatus> {
      return this.status.get(account.toLowerCase()) ?? ComplianceStatus.Unknown;
    }
    async screenedAt(account: Address): Promise<number> {
      return this.at.get(account.toLowerCase()) ?? 0;
    }
    async screenBatch(accounts: Address[], statuses: ComplianceStatus[]): Promise<Hex> {
      this.writes.push({accounts, statuses});
      accounts.forEach((a, i) => {
        this.status.set(a.toLowerCase(), statuses[i]!);
        this.at.set(a.toLowerCase(), NOW);
      });
      return keccak256(toHex(`write-${this.writes.length}`));
    }
  }

  const address = (n: number): Address =>
    `0x${n.toString(16).padStart(40, "0")}`.toLowerCase() as Address;

  const update = (n: number, status: ComplianceStatus): ScreeningUpdate => ({
    account: address(n),
    status,
    decidedAt: NOW,
  });

  it("writes only what changed", async () => {
    const chain = new FakeChain();
    chain.status.set(address(1).toLowerCase(), ComplianceStatus.Clear);
    chain.at.set(address(1).toLowerCase(), NOW - 60);

    const reconciler = new ComplianceReconciler({reader: chain, writer: chain});
    const result = await reconciler.reconcile(
      [update(1, ComplianceStatus.Clear), update(2, ComplianceStatus.Clear)],
      NOW,
    );

    expect(result.skipped).toEqual([address(1)]);
    expect(result.changed).toEqual([address(2)]);
    expect(chain.writes).toHaveLength(1);
    expect(chain.writes[0]!.accounts).toEqual([address(2)]);
  });

  /**
   * A `Clear` that has aged past the refresh window is rewritten even though nothing
   * changed. The router enforces a seven-day freshness bound, and a borrower who
   * silently ages out of eligibility while the feed reports nothing new is a support
   * ticket nobody can diagnose.
   */
  it("refreshes a screen that has gone stale even when nothing changed", async () => {
    const chain = new FakeChain();
    chain.status.set(address(1).toLowerCase(), ComplianceStatus.Clear);
    chain.at.set(address(1).toLowerCase(), NOW - 6 * 24 * 60 * 60);

    const reconciler = new ComplianceReconciler({reader: chain, writer: chain});
    const result = await reconciler.reconcile([update(1, ComplianceStatus.Clear)], NOW);

    expect(result.refreshed).toEqual([address(1)]);
    expect(result.changed).toEqual([]);
    expect(chain.writes).toHaveLength(1);
  });

  /**
   * A feed update is hundreds of addresses. A hundred transactions is a hundred
   * chances to apply half an update, and half an applied sanctions list is worse than
   * none — it is a list someone will trust.
   */
  it("batches a large update", async () => {
    const chain = new FakeChain();
    const reconciler = new ComplianceReconciler({reader: chain, writer: chain, batchSize: 50});

    const updates = Array.from({length: 120}, (_, i) => update(i + 1, ComplianceStatus.Clear));
    const result = await reconciler.reconcile(updates, NOW);

    expect(result.changed).toHaveLength(120);
    expect(chain.writes).toHaveLength(3);
    expect(chain.writes.map((w) => w.accounts.length)).toEqual([50, 50, 20]);
  });

  it("revokes a status as readily as it grants one", async () => {
    const chain = new FakeChain();
    chain.status.set(address(1).toLowerCase(), ComplianceStatus.Clear);
    chain.at.set(address(1).toLowerCase(), NOW - 60);

    const reconciler = new ComplianceReconciler({reader: chain, writer: chain});
    await reconciler.reconcile([update(1, ComplianceStatus.Denied)], NOW);

    expect(await chain.statusOf(address(1))).toBe(ComplianceStatus.Denied);
  });

  /**
   * The mid-strip case. Nothing is done to the plan — it has no owner and no pause,
   * and freezing a borrower's ability to repay because of a compliance flag would be
   * manufacturing a default on their behalf. What this produces is the operator's
   * work queue.
   */
  it("surfaces live plans belonging to a newly denied borrower", () => {
    const plans = new Map([[address(1).toLowerCase(), [PLAN]]]);
    const queue = midStripDenials(
      [update(1, ComplianceStatus.Denied), update(2, ComplianceStatus.Denied)],
      plans,
    );

    expect(queue).toEqual([{borrower: address(1), plans: [PLAN]}]);
  });
});
