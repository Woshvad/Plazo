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
import {afterAll, beforeAll, describe, expect, it} from "vitest";
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
import {fromStoredSession, PgSessionStore, toStoredSession} from "../src/store/pg-session.js";
import {openTestDatabase, type TestDatabase} from "./db.fixture.js";

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

/**
 * And now the half that needed a database.
 *
 * The codec suite above is a false positive on everything that lives outside the process:
 * whether the committed DDL applies, whether `jsonb` gives back the object it was handed,
 * and whether `put`'s `onConflictDoUpdate` updates rather than appends. 06-02a said so
 * plainly and left the claim unproven; this is the plan that retires it.
 */
describe("a checkout session survives a real Postgres", () => {
  let fixture: TestDatabase;

  beforeAll(async () => {
    fixture = await openTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
  });

  /**
   * The restart. Written on one connection, read on another, with no object in common —
   * which is what a redeploy leaves behind and what an in-memory store cannot survive.
   */
  it("round-trips through the database on a fresh client, bigints intact", async () => {
    const session = fresh();
    await new PgSessionStore(fixture.db).put(session);

    const restored = await new PgSessionStore(fixture.connect()).get(session.sessionId);

    expect(restored).toEqual(session);
    expect(typeof restored?.terms.principal).toBe("bigint");
    expect(restored?.terms.principal).toBe(session.terms.principal);
    expect(restored?.quote.mdr).toBe(session.quote.mdr);
  });

  /**
   * The assertion a float implementation fails and a `numeric` column would round.
   *
   * Past `Number.MAX_SAFE_INTEGER`, which at 6-decimal USDC is about $9.007bn — reachable
   * by a chain id or a due date long before it is reachable by a cart.
   */
  it("preserves a value past the safe-integer boundary through jsonb", async () => {
    const enormous = 9_007_199_254_740_993n;
    const base = fresh();
    const stretched: CheckoutSession = {
      ...base,
      sessionId: keccak256(toHex("session-enormous")),
      terms: {...base.terms, firstDueDate: enormous},
      quote: {...base.quote, availableLimit: enormous},
    };

    const store = new PgSessionStore(fixture.db);
    await store.put(stretched);

    const restored = await new PgSessionStore(fixture.connect()).get(stretched.sessionId);
    expect(restored?.terms.firstDueDate).toBe(enormous);
    expect(restored?.quote.availableLimit).toBe(enormous);
  });

  /**
   * `recordAuthorization` returns a **new** record rather than mutating one, so `put` is
   * write-whole-row. The failure this catches is a store that inserted instead of upserting:
   * the session would still read back correctly on `get` — the row it found would just be
   * one of two — and the table would grow a row per signature until a primary key finally
   * complained. Counting rows is the only assertion that sees it.
   */
  it("overwrites the row on a transition rather than appending one", async () => {
    const store = new PgSessionStore(fixture.db);
    const opened = {...fresh(), sessionId: keccak256(toHex("session-transitions"))};
    await store.put(opened);

    let session = recordAuthorization(opened, 0, sig(0), authorizations[0]!, NOW);
    await store.put(session);
    session = recordAuthorization(session, 1, sig(1), authorizations[1]!, NOW);
    await store.put(session);

    const rows = await fixture
      .raw()`select count(*)::int as n from operator.checkout_session where session_id = ${opened.sessionId}`;
    expect(rows[0]?.["n"]).toBe(1);

    const restored = await new PgSessionStore(fixture.connect()).get(opened.sessionId);
    expect(restored?.signatures.strip[0]).toBe(sig(0));
    expect(restored?.signatures.strip[1]).toBe(sig(1));
    expect(restored?.state).toBe("signing");
  });

  /**
   * The denormalised columns exist so a dashboard never parses jsonb to draw a list. If
   * they stop tracking the payload they are worse than absent: a sweeper reading
   * `expires_at` would be reading a value from two transitions ago.
   */
  it("keeps the denormalised columns in step with the payload", async () => {
    const store = new PgSessionStore(fixture.db);
    const opened = {...fresh(), sessionId: keccak256(toHex("session-columns"))};
    await store.put(opened);
    await store.put(recordAuthorization(opened, 0, sig(0), authorizations[0]!, NOW));

    const rows = await fixture
      .raw()`select merchant, state, plan_id, expires_at from operator.checkout_session where session_id = ${opened.sessionId}`;

    expect(rows[0]?.["merchant"]).toBe(MERCHANT);
    expect(rows[0]?.["state"]).toBe("signing");
    expect(rows[0]?.["plan_id"]).toBe(planId);
    expect((rows[0]?.["expires_at"] as Date).getTime()).toBe(opened.expiresAt * 1000);
  });
});
