import {describe, expect, it} from "vitest";
import {parseAbi} from "viem";

import {
  ABI,
  abiForContract,
  computeSchemaHash,
  EVENT_SCHEMA,
  eventSignature,
  eventTopic,
  humanReadableAbi,
  type EventDefinition,
  INSTALLMENT_PLAN_ABI,
  PLAN_FACTORY_ABI,
  CHECKOUT_ROUTER_ABI,
  RECEIVABLE_TOKEN_ABI,
  TRANCHED_CREDIT_POOL_ABI,
  PLAZO_PASSPORT_ABI,
  ATTESTATION_SCHEMA_REGISTRY_ABI,
  RELAYER_GATE_ABI,
  POOL_REGISTRY_ABI,
  MERCHANT_REGISTRY_ABI,
  PAYOUT_ROUTER_ABI,
  REFUND_ESCROW_ABI,
  SETTLEMENT_ESCROW_ABI,
  TIER0_UNDERWRITER_ABI,
  KILL_SWITCH_ABI,
  PARAMETER_REGISTRY_ABI,
  ORIGINATION_PAUSE_ABI,
  PRIOR_SCHEMA_HASHES,
  SCHEMA_HASH,
  SCHEMA_VERSION,
} from "../src/schema.js";
import {
  CHAIN_SCHEMA,
  chargeOffRateBps,
  checkSchemaSeparation,
  firstPaymentDefaultBps,
  OPERATOR_SCHEMA,
  type CohortSnapshot,
} from "../src/storage.js";

describe("the schema is frozen", () => {
  it("matches the committed hash", () => {
    expect(
      computeSchemaHash(),
      "The event schema changed.\n\n" +
        "This is not a merge conflict to resolve by pasting in the new value. An\n" +
        "indexer, four surfaces and every historical row are now describing something\n" +
        `else. Bump SCHEMA_VERSION (currently ${SCHEMA_VERSION}), write the migration,\n` +
        "then update SCHEMA_HASH.",
    ).toBe(SCHEMA_HASH);
  });

  it("is a real hash, not a placeholder", () => {
    expect(SCHEMA_HASH).not.toBe(`0x${"00".repeat(32)}`);
  });

  /**
   * The replay contract, asserted by value rather than by count.
   *
   * Neither v3 nor v4 was additive: v3 rewrote six pool entries that named contracts
   * nobody built, and v4 retired two merchant entries that nothing ever emitted. A
   * consumer replaying history therefore has to decode each block range with the
   * definitions that range was written under, and these three hashes are how it knows
   * which is which.
   *
   * Dropping one would not break a build. It would break a replay, silently, on a
   * range nobody is currently looking at — which is precisely the class of failure a
   * committed hash exists to convert into a red test.
   */
  it("retains every prior hash, newest first", () => {
    expect(PRIOR_SCHEMA_HASHES).toEqual([
      // v3 — Phases 4 and 5: the capital plane and the Passport.
      "0x5805e5cae7e607b0a68c13886383207e5053bebe5de18c59be7561c1cc6212a9",
      // v2 — Phase 3: the origination plane.
      "0x4407b0ce57e557bf9f9c1232ddca2ee5edab6c4465b0d67e568a84a267f4295e",
      // v1 — Phases 1 and 2: the plan and the check strip.
      "0x84a83a60587bb9269844f7ec68d3ca09fd1e50a18d7dad7dad3e4e251af3663d",
    ]);
    expect(PRIOR_SCHEMA_HASHES).toHaveLength(SCHEMA_VERSION - 1);
  });

  it("does not carry the current hash in the prior list", () => {
    expect(PRIOR_SCHEMA_HASHES).not.toContain(SCHEMA_HASH);
  });
});

describe("privacy is enforced by the schema, not by policy", () => {
  /**
   * The load-bearing test. Plan events keyed by wallet would let anyone index the
   * log stream into a permanent, public, uncorrectable purchase history — a worse
   * exposure than the Passport record it feeds, and no erasure request can reach it.
   */
  it("no plan event indexes a borrower", () => {
    const offenders: string[] = [];
    for (const definition of EVENT_SCHEMA) {
      for (const f of definition.fields) {
        if (!f.indexed) continue;
        if (/borrower|buyer|payer|consumer|customer|wallet/i.test(f.name)) {
          offenders.push(`${definition.contract}.${definition.name}.${f.name}`);
        }
      }
    }
    expect(offenders, `indexed borrower-identifying fields: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no plan event carries a borrower address at all", () => {
    const planEvents = EVENT_SCHEMA.filter(
      (d) => d.contract === "InstallmentPlan" || d.contract === "PlanFactory",
    );
    const offenders = planEvents.flatMap((d) =>
      d.fields
        .filter((f) => /borrower|buyer|payer|consumer|customer/i.test(f.name))
        .map((f) => `${d.name}.${f.name}`),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * The v3 addition, and the tighter of the two rules. A credit-record stream keyed by
   * wallet is a permanent, public, enumerable credit file — the same exposure PASS-09
   * keys plan events by `planId` to avoid, except this one *is* the record. Every
   * Passport event is keyed by `keccak256(prefix | salt | borrower)` instead, and the
   * salt is readable only by the borrower and the operator.
   *
   * The first draft of `PlazoPassport` indexed the borrower directly. This test is what
   * that cost.
   */
  it("no Passport event carries a wallet address for the subject", () => {
    const passportEvents = EVENT_SCHEMA.filter((d) => d.contract === "PlazoPassport");
    expect(passportEvents.length).toBeGreaterThan(0);

    for (const definition of passportEvents) {
      // `SaltRotated` names both the old and the new key, in that order, and it is
      // the only event that may — it is the one place a borrower can prove continuity
      // across an erasure to a counterparty they choose.
      const subject = definition.fields[0];
      const expected = definition.name === "SaltRotated" ? "previousSubject" : "subject";
      expect(subject?.name, `${definition.name} is not keyed by a subject`).toBe(expected);
      expect(subject?.type).toBe("bytes32");
      expect(subject?.indexed).toBe(true);

      const wallets = definition.fields.filter(
        (f) => f.type === "address" && f.name !== "reader",
      );
      expect(wallets, `${definition.name} carries a wallet`).toEqual([]);
    }
  });

  it("every plan event is keyed by planId", () => {
    const planEvents = EVENT_SCHEMA.filter((d) => d.contract === "InstallmentPlan");
    for (const d of planEvents) {
      const first = d.fields[0];
      expect(first?.name, `${d.name} is not keyed by planId`).toBe("planId");
      expect(first?.indexed, `${d.name}.planId is not indexed`).toBe(true);
    }
  });

  /**
   * **Reversed in v3, deliberately.** v1 said the redemption queue must carry no holder
   * address, on the reasoning that queue depth is public and queue membership is not.
   * POOL-02 then made the tranche shares transfer-restricted ERC-20s, and an ERC-20's
   * holder set is public in every `Transfer` — so withholding the holder here would
   * protect nothing and would stop a lender seeing their own position without an archive
   * query. What replaces the rule is the tighter one below: the Passport, which is the
   * stream that would actually be worth harvesting, carries no wallet at all.
   */
  it("the redemption queue names its holder, because the share token already does", () => {
    const queued = EVENT_SCHEMA.find((d) => d.name === "RedeemRequested");
    expect(queued).toBeDefined();
    expect(queued!.fields.some((f) => f.name === "holder")).toBe(true);
  });

  /**
   * The only address a Passport event may name is a `reader` — a business counterparty
   * who has been handed a consent grant and needs to enumerate the ones they hold. It is
   * not the data subject, and it is not derived from one.
   */
  /**
   * The v4 addition. The merchant plane sits one hop from a purchase — a settlement is
   * an order, a refund is a return, a shipment attestation is a delivery — so a wallet
   * here would rebuild the same diary the plan events are keyed by `planId` to avoid,
   * on the side where the counterparty is the one who would harvest it.
   *
   * `merchant`, `recipient`, `by` and `from` are the four addresses permitted, and all
   * four are business counterparties: the merchant, their registered payout route, the
   * governance account that denied a domain, and whoever funded the rebate reserve.
   */
  it("no merchant-plane event carries a borrower", () => {
    const merchantPlane = EVENT_SCHEMA.filter((d) =>
      ["PayoutRouter", "RefundEscrow", "SettlementEscrow", "MerchantRegistry"].includes(d.contract),
    );
    expect(merchantPlane.length).toBeGreaterThan(0);

    const permitted = new Set(["merchant", "recipient", "by", "from", "attestor", "token"]);
    for (const d of merchantPlane) {
      const addresses = d.fields.filter((f) => f.type === "address").map((f) => f.name);
      for (const name of addresses) {
        expect(permitted.has(name), `${d.contract}.${d.name} carries an address named ${name}`).toBe(
          true,
        );
      }
      expect(
        d.fields.filter((f) => /borrower|buyer|payer|consumer|customer|wallet/i.test(f.name)),
        `${d.contract}.${d.name} names a borrower`,
      ).toEqual([]);
    }
  });

  /**
   * A tracking number is a delivery address by proxy, and a dispute reference
   * dereferences to a borrower's file. Both are `bytes32` commitments for that reason
   * and not for gas — the same salted-subject discipline the Passport events set,
   * applied to the two fields on this plane that would otherwise carry a pointer into
   * somebody's life.
   */
  it.each([
    ["ShipmentAttested", "carrierRef"],
    ["DisputeOpened", "evidenceRef"],
  ])("keeps %s.%s a commitment, never a string", (event, fieldName) => {
    const definition = EVENT_SCHEMA.find((d) => d.name === event);
    expect(definition, `${event} is missing from the schema`).toBeDefined();
    const found = definition!.fields.find((f) => f.name === fieldName);
    expect(found?.type).toBe("bytes32");
    // Unindexed as well: a commitment nobody can invert is still a correlation key.
    expect(found?.indexed).toBe(false);
  });

  it("Passport emits commitments, and the only address is a reader", () => {
    const passport = EVENT_SCHEMA.filter((d) => d.contract === "PlazoPassport");
    expect(passport.length).toBeGreaterThan(0);
    for (const d of passport) {
      const addresses = d.fields.filter((f) => f.type === "address").map((f) => f.name);
      expect(addresses.every((name) => name === "reader"), `${d.name}: ${addresses}`).toBe(true);
    }
  });
});

describe("the schema is well formed", () => {
  it("has no duplicate event names within a contract", () => {
    const seen = new Set<string>();
    for (const d of EVENT_SCHEMA) {
      const key = `${d.contract}.${d.name}`;
      expect(seen.has(key), `duplicate: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  /**
   * **Relaxed in v4, and the relaxation is the tighter rule.**
   *
   * Two contracts may now emit one topic: `RefundEscrow.RefundCredited` deliberately
   * carries `InstallmentPlan.RefundCredited`'s signature, because D-04 forbids the
   * escrow reimplementing the credit and the only honest thing it can announce is the
   * delta the plan booked — from its own address, for a merchant's refund history.
   *
   * A shared topic is only dangerous if the two definitions disagree about the fields
   * behind it, because that is what makes a decoder produce a wrong answer instead of
   * no answer. So the rule is no longer "no duplicates"; it is "a shared topic implies
   * an identical field list", which is what a decoder actually needs and what the old
   * rule was a blunt proxy for.
   */
  it("never gives one topic two different field lists", () => {
    const byTopic = new Map<string, EventDefinition[]>();
    for (const d of EVENT_SCHEMA) {
      const topic = eventTopic(d);
      byTopic.set(topic, [...(byTopic.get(topic) ?? []), d]);
    }

    for (const [topic, definitions] of byTopic) {
      const shapes = new Set(definitions.map((d) => humanReadableAbi(d)));
      expect(
        shapes.size,
        `${topic} is emitted as ${[...shapes].join(" and ")}`,
      ).toBe(1);
    }
  });

  it("gives no single contract two events with one topic", () => {
    const seen = new Set<string>();
    for (const d of EVENT_SCHEMA) {
      const key = `${d.contract}:${eventTopic(d)}`;
      expect(seen.has(key), `${d.contract} emits two events on ${eventTopic(d)}`).toBe(false);
      seen.add(key);
    }
  });

  it("respects the EVM's three-indexed-field limit", () => {
    for (const d of EVENT_SCHEMA) {
      const indexed = d.fields.filter((f) => f.indexed).length;
      expect(indexed, `${d.name} indexes ${indexed} fields`).toBeLessThanOrEqual(3);
    }
  });

  it("parses as a valid ABI", () => {
    expect(() => parseAbi(ABI as string[])).not.toThrow();
    expect(parseAbi(ABI as string[])).toHaveLength(EVENT_SCHEMA.length);
  });

  it("every event states why it exists", () => {
    for (const d of EVENT_SCHEMA) {
      expect(d.purpose.length, `${d.name} has no purpose`).toBeGreaterThan(20);
    }
  });

  it("produces canonical signatures", () => {
    const cleared = EVENT_SCHEMA.find((d) => d.name === "CheckCleared")!;
    expect(eventSignature(cleared)).toBe("CheckCleared(bytes32,uint256,uint256,address)");
    expect(humanReadableAbi(cleared)).toBe(
      "event CheckCleared(bytes32 indexed planId, uint256 indexed index, uint256 amount, address keeper)",
    );
  });

  it("distinguishes bounce reasons rather than collapsing them", () => {
    // A blocklisted borrower is a compliance event; a paused token is an
    // infrastructure event; only insufficient funds is a credit event. They carry
    // opposite Passport and provisioning treatments.
    const bounced = EVENT_SCHEMA.find((d) => d.name === "CheckBounced")!;
    expect(bounced.fields.some((f) => f.name === "reason")).toBe(true);
  });
});

/**
 * v4 reconciled two placeholders rather than appending beside them.
 *
 * Both were written before their contracts existed and neither was ever emitted, which
 * is exactly what made them safe to correct. The risk a bump like this carries is that
 * somebody later "restores" the old entry to fix a broken import — so the absence is
 * asserted, not merely achieved.
 */
describe("the v4 reconciliation", () => {
  it("retired MerchantSettled rather than renaming it", () => {
    expect(EVENT_SCHEMA.find((d) => d.name === "MerchantSettled")).toBeUndefined();
  });

  it("retired RefundEscrowed", () => {
    expect(EVENT_SCHEMA.find((d) => d.name === "RefundEscrowed")).toBeUndefined();
  });

  /**
   * What replaces `MerchantSettled`: the settlement fact stayed on the contract that
   * computed it, and the payout adapter reports money movement without naming a plan.
   */
  it("leaves the plan-level settlement fact on CheckoutRouter", () => {
    const completed = EVENT_SCHEMA.find(
      (d) => d.contract === "CheckoutRouter" && d.name === "OriginationCompleted",
    );
    expect(completed).toBeDefined();
    expect(completed!.fields.map((f) => f.name)).toEqual([
      "planId",
      "merchant",
      "principal",
      "mdr",
      "withheld",
    ]);
  });

  it("keeps the payout adapter ignorant of plans", () => {
    for (const d of EVENT_SCHEMA.filter((x) => x.contract === "PayoutRouter")) {
      expect(d.fields.some((f) => f.name === "planId"), `${d.name} names a plan`).toBe(false);
    }
  });

  /**
   * DEC-36. `dispatch()` is permissionless, so the queue key decides where a stranger
   * can send a merchant's money. Two keys would let them choose the chain; the burn is
   * irreversible and an address a merchant controls on Arc is not necessarily one they
   * control on Arbitrum.
   */
  it("carries the destination domain on both queue events", () => {
    for (const name of ["PayoutQueued", "PayoutDispatched"]) {
      const d = EVENT_SCHEMA.find((x) => x.name === name)!;
      expect(d.fields.map((f) => f.name)).toEqual(["token", "recipient", "domain", "amount"]);
    }
  });

  /**
   * DEC-31 / finding 28. A CCTP v2 burn emits a zero nonce; the real `eventNonce` comes
   * back from Iris at attestation. A `nonce` field here would be permanently zero and
   * an indexed column built on it would be permanently null, so the join to Circle's
   * ledger is the transaction hash and is off-chain by construction.
   */
  it("gives PayoutDispatched no nonce to be wrong about", () => {
    const dispatched = EVENT_SCHEMA.find((d) => d.name === "PayoutDispatched")!;
    expect(dispatched.fields.some((f) => /nonce/i.test(f.name))).toBe(false);
  });

  /**
   * The non-attestation return is the one objective, operator-free ground for a
   * dispute. Folded into the generic `EscrowReturned` it would be indistinguishable
   * from a cancellation, and `RefundEscrow.disputeEligible` would have nothing to read.
   */
  it("keeps the non-attestation return distinguishable from any other return", () => {
    const generic = EVENT_SCHEMA.find((d) => d.name === "EscrowReturned");
    const narrow = EVENT_SCHEMA.find((d) => d.name === "SettlementReturnedForNonAttestation");
    expect(generic).toBeDefined();
    expect(narrow).toBeDefined();
    expect(eventTopic(generic!)).not.toBe(eventTopic(narrow!));
  });
});

describe("chain and operator state stay separated", () => {
  it("accepts a clean chain schema", () => {
    expect(
      checkSchemaSeparation([
        {schema: CHAIN_SCHEMA, table: "plan", column: "plan_id"},
        {schema: CHAIN_SCHEMA, table: "plan", column: "state"},
        {schema: CHAIN_SCHEMA, table: "check_cleared", column: "keeper"},
      ]),
    ).toEqual([]);
  });

  it.each([
    "email",
    "phone_number",
    "borrower_ssn",
    "legal_name",
    "date_of_birth",
    "address_line_1",
    "ip_address",
    "kyc_status",
    // camelCase too — an ORM-generated column is just as permanent.
    "borrowerEmail",
    "dateOfBirth",
    "nationalId",
  ])("rejects %s in the chain schema", (column) => {
    const violations = checkSchemaSeparation([{schema: CHAIN_SCHEMA, table: "plan", column}]);
    expect(violations).toHaveLength(1);
  });

  it("permits the same columns in the operator schema", () => {
    expect(
      checkSchemaSeparation([
        {schema: OPERATOR_SCHEMA, table: "borrower", column: "email"},
        {schema: OPERATOR_SCHEMA, table: "borrower", column: "legal_name"},
      ]),
    ).toEqual([]);
  });
});

describe("cohort snapshots", () => {
  const snapshot = (over: Partial<CohortSnapshot> = {}): CohortSnapshot => ({
    cohort: "2026-08",
    takenAtBlock: 54_000_000n,
    takenAt: new Date("2026-08-01T00:00:00Z"),
    plansOriginated: 1_000,
    plansRepaid: 900,
    plansDelinquent: 60,
    plansChargedOff: 40,
    principalOriginated: 100_000_000_000n,
    principalOutstanding: 5_000_000_000n,
    principalChargedOff: 4_000_000_000n,
    firstPaymentDefaults: 25,
    newWalletDefaults: 20,
    seasonedWalletDefaults: 5,
    ...over,
  });

  it("computes a charge-off rate", () => {
    expect(chargeOffRateBps(snapshot())).toBe(400); // 4.00%
  });

  it("computes a first-payment-default rate", () => {
    expect(firstPaymentDefaultBps(snapshot())).toBe(250); // 2.50%
  });

  it("does not divide by zero on an empty cohort", () => {
    expect(chargeOffRateBps(snapshot({principalOriginated: 0n}))).toBe(0);
    expect(firstPaymentDefaultBps(snapshot({plansOriginated: 0}))).toBe(0);
  });

  it("separates new-wallet from seasoned-wallet defaults", () => {
    // Kept apart so the kill switch cannot be griefed by an attacker minting fresh
    // wallets: synthetic-identity fraud presents as credit default and would
    // otherwise poison the switch's only input.
    const s = snapshot();
    expect(s.newWalletDefaults + s.seasonedWalletDefaults).toBeLessThanOrEqual(s.plansOriginated);
  });
});

describe("const-typed ABI views", () => {
  /**
   * The literals exist so consumers keep compile-time inference — Ponder's event
   * names, wagmi's hooks, abitype's argument tuples all collapse to `Abi` without
   * them. This is what keeps that convenience from quietly becoming a second,
   * divergent definition of what the chain emits.
   */
  it("match the schema they duplicate", () => {
    expect([...PLAN_FACTORY_ABI]).toEqual(abiForContract("PlanFactory"));
    expect([...INSTALLMENT_PLAN_ABI]).toEqual(abiForContract("InstallmentPlan"));
    expect([...CHECKOUT_ROUTER_ABI]).toEqual(abiForContract("CheckoutRouter"));
    expect([...RECEIVABLE_TOKEN_ABI]).toEqual(abiForContract("ReceivableToken"));
    expect([...TRANCHED_CREDIT_POOL_ABI]).toEqual(abiForContract("TranchedCreditPool"));
    expect([...PLAZO_PASSPORT_ABI]).toEqual(abiForContract("PlazoPassport"));
    expect([...ATTESTATION_SCHEMA_REGISTRY_ABI]).toEqual(abiForContract("AttestationSchemaRegistry"));
    expect([...RELAYER_GATE_ABI]).toEqual(abiForContract("RelayerGate"));
    expect([...POOL_REGISTRY_ABI]).toEqual(abiForContract("PoolRegistry"));
    expect([...MERCHANT_REGISTRY_ABI]).toEqual(abiForContract("MerchantRegistry"));
    expect([...PAYOUT_ROUTER_ABI]).toEqual(abiForContract("PayoutRouter"));
    expect([...REFUND_ESCROW_ABI]).toEqual(abiForContract("RefundEscrow"));
    expect([...SETTLEMENT_ESCROW_ABI]).toEqual(abiForContract("SettlementEscrow"));
    expect([...TIER0_UNDERWRITER_ABI]).toEqual(abiForContract("Tier0Underwriter"));
    expect([...KILL_SWITCH_ABI]).toEqual(abiForContract("FirstPaymentDefaultSwitch"));
    expect([...PARAMETER_REGISTRY_ABI]).toEqual(abiForContract("ParameterRegistry"));
    expect([...ORIGINATION_PAUSE_ABI]).toEqual(abiForContract("OriginationPause"));
  });

  it("cover every merchant-plane contract Phase 6 built", () => {
    expect(abiForContract("PayoutRouter")).toHaveLength(4);
    expect(abiForContract("RefundEscrow")).toHaveLength(8);
    expect(abiForContract("SettlementEscrow")).toHaveLength(5);
  });

  it("cover every contract the indexer subscribes to", () => {
    expect(abiForContract("PlanFactory").length).toBeGreaterThan(0);
    expect(abiForContract("InstallmentPlan").length).toBeGreaterThan(0);
    expect(abiForContract("NoSuchContract")).toEqual([]);
  });
});
