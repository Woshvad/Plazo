/**
 * The at-rest codec round-trips exactly, and it does so without a database.
 *
 * `PgSessionStore`'s database round trip is proven in plan 06-02b, where a live
 * Postgres exists. What can be proven here is the half that actually loses money if it
 * is wrong: the bigint↔decimal-string conversion. `typecheck` cannot catch a codec that
 * compiles and drops a field, because `StoredSession` is derived from `CheckoutSession`
 * structurally and a missing optional would still satisfy it.
 *
 * The values below are deliberately larger than `Number.MAX_SAFE_INTEGER`. A codec that
 * went through a float would pass on 100 USDC and fail here, which is the only place the
 * bug would ever be caught before it reached a plan.
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

import {openSession, recordAcceptance, recordAuthorization, type CheckoutSession} from "../src/session.js";
import {fromStoredSession, toStoredSession} from "../src/store/pg-session.js";

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
const planAddress = predictPlanAddress({deployer: FACTORY, implementation: IMPLEMENTATION, planId});
const authorizations = buildStrip(terms, planId);

const NOW = 1_799_000_000;
const sig = (i: number): Hex => `0x${String(i).repeat(130)}` as Hex;

function fresh(cartTotal = 100_000_000n, availableLimit = 200_000_000n): CheckoutSession {
  return openSession({
    sessionId: keccak256(toHex("session-1")),
    terms,
    detail,
    planId,
    planAddress,
    availableLimit,
    cartTotal,
    now: NOW,
  });
}

/** Serialise, deserialise, and require the result to be the record we started with. */
function roundTrip(session: CheckoutSession): CheckoutSession {
  // Through real JSON, not just the object, because jsonb is what the column holds and
  // `JSON.stringify` is where a stray bigint would throw rather than silently coerce.
  const stored = JSON.parse(JSON.stringify(toStoredSession(session))) as ReturnType<typeof toStoredSession>;
  return fromStoredSession(stored);
}

describe("a checkout session survives the trip to jsonb and back", () => {
  it("returns a record equal to the one it was given", () => {
    const session = fresh();
    expect(roundTrip(session)).toEqual(session);
  });

  it("keeps every 256-bit field a bigint, not a string and not a float", () => {
    const restored = roundTrip(fresh());
    expect(typeof restored.terms.principal).toBe("bigint");
    expect(typeof restored.quote.mdr).toBe("bigint");
    expect(typeof restored.detail.lateFeeFlat).toBe("bigint");
  });

  /**
   * The reason the codec may not go through `Number`.
   *
   * `Number.MAX_SAFE_INTEGER` is 9_007_199_254_740_991. At 6-decimal USDC that is about
   * $9.007bn — reachable by a chain id, a due date in a distant jurisdiction, or a
   * limit expressed in the wrong scale long before it is reachable by a cart. A float
   * would return a neighbouring value here and the assertion would read as an
   * off-by-one rather than as a lost dollar.
   */
  it("preserves a value past the safe-integer boundary exactly", () => {
    const enormous = 9_007_199_254_740_993n;
    const session = fresh();
    const stretched: CheckoutSession = {
      ...session,
      terms: {...session.terms, firstDueDate: enormous},
      quote: {...session.quote, availableLimit: enormous},
    };
    const restored = roundTrip(stretched);
    expect(restored.terms.firstDueDate).toBe(enormous);
    expect(restored.quote.availableLimit).toBe(enormous);
  });

  it("carries the signatures a resuming borrower must not be asked for again", () => {
    let session = fresh();
    session = recordAuthorization(session, 0, sig(0), authorizations[0]!, NOW);
    session = recordAuthorization(session, 2, sig(2), authorizations[2]!, NOW);
    session = recordAcceptance(session, sig(9), NOW);

    const restored = roundTrip(session);
    expect(restored.signatures.strip[0]).toBe(sig(0));
    expect(restored.signatures.strip[2]).toBe(sig(2));
    expect(restored.signatures.strip[1]).toBeUndefined();
    expect(restored.signatures.acceptance).toBe(sig(9));
    expect(restored.state).toBe("signing");
  });

  /**
   * The fallback offer is optional, and an optional field is where a codec drops data.
   * A cart over the limit carries a `fallback`; a cart under it must not carry an
   * explicit `undefined`, because jsonb would store the null and the restored record
   * would no longer equal the original.
   */
  it("round-trips the fallback offer, and omits it when there is none", () => {
    const over = fresh(300_000_000n, 200_000_000n);
    expect(over.quote.fallback).toBeDefined();
    expect(roundTrip(over)).toEqual(over);

    const under = fresh();
    expect(under.quote.fallback).toBeUndefined();
    expect("fallback" in toStoredSession(under).quote).toBe(false);
  });
});
