/**
 * CHKT-02 — a checkout abandoned mid-strip resumes from the exact index.
 *
 * The requirement exists because of arithmetic. A four-check Pay-in-4 plan needs four
 * typed-data signatures plus an acceptance, no wallet has a batch typed-data signing
 * RPC, and five prompts is already the worst part of this product. Making someone
 * redo three of them because their phone locked is how a checkout loses a sale it had
 * already won.
 */
import {describe, expect, it} from "vitest";
import {keccak256, toHex, type Address, type Hex} from "viem";

import {
  buildStrip,
  derivePlanId,
  hashTermsDetail,
  predictPlanAddress,
  SignerClass,
  type PlanTerms,
  type TermsDetail,
} from "@plazo/plan-core";

import {
  assembleStrip,
  expire,
  hasExpired,
  InMemorySessionStore,
  isReady,
  markOriginated,
  needsAcceptance,
  openSession,
  outstandingAuthorizations,
  recordAcceptance,
  recordAuthorization,
  resumeIndex,
  SessionError,
  type CheckoutSession,
} from "../src/session.js";

const FACTORY = "0x00000000000000000000000000000000000fac70" as Address;
const IMPLEMENTATION = "0x0000000000000000000000000000000000019911" as Address;
const BORROWER = "0x00000000000000000000000000000000000b0110" as Address;
const MERCHANT = "0x00000000000000000000000000000000000acced" as Address;
const TOKEN = "0x3600000000000000000000000000000000000000" as Address;
const POOL = "0x0000000000000000000000000000000000009001" as Address;
const FX = "0x0000000000000000000000000000000000000f10" as Address;

const detail: TermsDetail = {
  jurisdiction: keccak256(toHex("PLAZO.DEFAULT")),
  lineItemsHash: keccak256(toHex("one pair of boots")),
  mdrBps: 400n,
  lateFeeFlat: 7_000_000n,
  signerClass: SignerClass.EOA,
  settlementRecipient: POOL,
  fxRouter: FX,
};

const terms: PlanTerms = {
  chainId: 5042002n,
  factory: FACTORY,
  implementation: IMPLEMENTATION,
  borrower: BORROWER,
  merchant: MERCHANT,
  token: TOKEN,
  principal: 100_000_000n,
  installmentCount: 4n,
  firstDueDate: 1_800_000_000n,
  interval: 1_209_600n,
  originationNonce: 1n,
  termsHash: hashTermsDetail(detail),
};

const planId = derivePlanId(terms);
const planAddress = predictPlanAddress({
  deployer: FACTORY,
  implementation: IMPLEMENTATION,
  planId,
});
const authorizations = buildStrip(terms, planId);

const SESSION_ID = keccak256(toHex("session-1"));
const NOW = 1_799_000_000;

const sig = (i: number): Hex => `0x${String(i).repeat(130)}` as Hex;

function fresh(): CheckoutSession {
  return openSession({
    sessionId: SESSION_ID,
    terms,
    detail,
    planId,
    planAddress,
    availableLimit: 200_000_000n,
    cartTotal: 100_000_000n,
    now: NOW,
  });
}

describe("a session prices the cart before anything is signed", () => {
  it("quotes an approved plan with a real schedule", () => {
    const session = fresh();
    expect(session.state).toBe("quoted");
    expect(session.quote.approved).toBe(true);
    expect(session.quote.principal).toBe(100_000_000n);
    expect(session.quote.installments).toEqual([25_000_000n, 25_000_000n, 25_000_000n, 25_000_000n]);
    expect(session.quote.mdr).toBe(4_000_000n);
    expect(session.quote.merchantNet).toBe(96_000_000n);
  });

  /**
   * CHKT-08. The borrower is over their limit and is offered something, not refused.
   */
  it("offers a smaller-installment fallback rather than a flat decline", () => {
    const session = openSession({
      sessionId: SESSION_ID,
      terms,
      detail,
      planId,
      planAddress,
      availableLimit: 80_000_000n,
      cartTotal: 100_000_000n,
      now: NOW,
    });

    expect(session.quote.approved).toBe(false);
    expect(session.quote.fallback).toBeDefined();
    expect(session.quote.fallback!.financed).toBe(80_000_000n);
    expect(session.quote.fallback!.upfront).toBe(20_000_000n);
    expect(session.quote.fallback!.installments).toEqual([
      20_000_000n,
      20_000_000n,
      20_000_000n,
      20_000_000n,
    ]);
  });

  it("declines without a fallback when nothing financeable is left", () => {
    const session = openSession({
      sessionId: SESSION_ID,
      terms,
      detail,
      planId,
      planAddress,
      availableLimit: 0n,
      cartTotal: 100_000_000n,
      now: NOW,
    });

    expect(session.quote.approved).toBe(false);
    expect(session.quote.fallback).toBeUndefined();
    expect(session.quote.declineReason).toBe("no-credit-available");
  });
});

describe("the strip is a per-authorization state machine", () => {
  it("resumes from the exact index rather than restarting", () => {
    let session = fresh();
    expect(resumeIndex(session)).toBe(0);

    session = recordAuthorization(session, 0, sig(0), authorizations[0]!, NOW);
    session = recordAuthorization(session, 1, sig(1), authorizations[1]!, NOW);

    // The borrower's phone locks here.
    expect(session.state).toBe("signing");
    expect(outstandingAuthorizations(session)).toEqual([2, 3]);
    expect(resumeIndex(session)).toBe(2);
    expect(needsAcceptance(session)).toBe(true);

    // They come back on another device.
    session = recordAuthorization(session, 2, sig(2), authorizations[2]!, NOW);
    session = recordAuthorization(session, 3, sig(3), authorizations[3]!, NOW);
    expect(outstandingAuthorizations(session)).toEqual([]);
    expect(resumeIndex(session)).toBeNull();

    session = recordAcceptance(session, sig(9), NOW);
    expect(session.state).toBe("ready");
    expect(isReady(session)).toBe(true);
  });

  /**
   * A wallet that presents check 3 before check 2 is unusual and not wrong. A state
   * machine that insisted on order would turn a wallet quirk into a failed checkout.
   */
  it("accepts authorizations out of order", () => {
    let session = fresh();
    session = recordAuthorization(session, 3, sig(3), authorizations[3]!, NOW);
    session = recordAuthorization(session, 1, sig(1), authorizations[1]!, NOW);

    expect(outstandingAuthorizations(session)).toEqual([0, 2]);
    expect(resumeIndex(session)).toBe(0);
  });

  it("refuses a second signature for the same index", () => {
    let session = fresh();
    session = recordAuthorization(session, 0, sig(0), authorizations[0]!, NOW);

    expect(() => recordAuthorization(session, 0, sig(1), authorizations[0]!, NOW)).toThrow(
      SessionError,
    );
  });

  it("refuses an index outside the strip", () => {
    const session = fresh();
    expect(() => recordAuthorization(session, 4, sig(4), authorizations[0]!, NOW)).toThrow(
      /outside a 4-installment strip/,
    );
  });

  /**
   * The payee check. A signature naming a different `to` is either a client bug or an
   * attempt to have the borrower sign a transfer somewhere the protocol does not
   * control, and the difference does not matter — neither should be stored.
   */
  it("refuses an authorization payable to anything but the plan", () => {
    const session = fresh();
    const redirected = {...authorizations[0]!, to: MERCHANT};

    expect(() => recordAuthorization(session, 0, sig(0), redirected, NOW)).toThrow(/not the plan/);
  });

  it("refuses to assemble an incomplete strip", () => {
    let session = fresh();
    session = recordAuthorization(session, 0, sig(0), authorizations[0]!, NOW);
    expect(() => assembleStrip(session)).toThrow(/incomplete/);
  });

  it("assembles the strip in installment order once complete", () => {
    let session = fresh();
    for (let i = 3; i >= 0; i--) {
      session = recordAuthorization(session, i, sig(i), authorizations[i]!, NOW);
    }
    session = recordAcceptance(session, sig(9), NOW);

    expect(assembleStrip(session)).toEqual([sig(0), sig(1), sig(2), sig(3)]);
  });
});

describe("a session has a life", () => {
  it("cannot be signed after it expires", () => {
    const session = fresh();
    const late = session.expiresAt + 1;

    expect(hasExpired(session, late)).toBe(true);
    expect(() => recordAuthorization(session, 0, sig(0), authorizations[0]!, late)).toThrow(
      /expired/,
    );
  });

  it("cannot be signed once originated", () => {
    const session = markOriginated(fresh(), NOW);
    expect(() => recordAuthorization(session, 0, sig(0), authorizations[0]!, NOW)).toThrow(
      /originated/,
    );
  });

  it("cannot be signed once expired explicitly", () => {
    const session = expire(fresh(), NOW);
    expect(() => recordAcceptance(session, sig(9), NOW)).toThrow(/expired/);
  });

  it("an originated session does not go on expiring", () => {
    const session = markOriginated(fresh(), NOW);
    expect(hasExpired(session, session.expiresAt + 10_000)).toBe(false);
  });
});

describe("the store", () => {
  it("round-trips a session", async () => {
    const store = new InMemorySessionStore();
    const session = fresh();

    await store.put(session);
    expect(await store.get(SESSION_ID)).toEqual(session);
    expect(await store.get(keccak256(toHex("nope")))).toBeUndefined();
    expect(store.size).toBe(1);
  });

  it("overwrites rather than accumulating on update", async () => {
    const store = new InMemorySessionStore();
    const session = fresh();
    await store.put(session);
    await store.put(recordAuthorization(session, 0, sig(0), authorizations[0]!, NOW));

    expect(store.size).toBe(1);
    expect((await store.get(SESSION_ID))!.state).toBe("signing");
  });
});
