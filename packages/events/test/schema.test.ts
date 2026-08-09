import {existsSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

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
  FX_DEVIATION_GUARD_ABI,
  MERCHANT_CURRENCY_REGISTRY_ABI,
  PLEDGE_VAULT_ABI,
  TIERED_UNDERWRITER_ABI,
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
   * None of v3, v4 or v5 was additive: v3 rewrote six pool entries that named contracts
   * nobody built, v4 retired two merchant entries that nothing ever emitted, and v5
   * stopped `TranchedCreditPool` being a singleton so that a pool row keyed by `epoch`
   * alone — correct through the whole v4 range — is wrong from v5 on. A consumer
   * replaying history therefore has to decode each block range with the definitions
   * that range was written under, and these four hashes are how it knows which is
   * which.
   *
   * Dropping one would not break a build. It would break a replay, silently, on a
   * range nobody is currently looking at — which is precisely the class of failure a
   * committed hash exists to convert into a red test.
   */
  it("retains every prior hash, newest first", () => {
    expect(PRIOR_SCHEMA_HASHES).toEqual([
      // v4 — Phase 6: the merchant plane.
      "0x732d16a75801f32d51c3f8b0e2f76b427a599da63d1efee9e8cf23df32e10a42",
      // v3 — Phases 4 and 5: the capital plane and the Passport.
      "0x5805e5cae7e607b0a68c13886383207e5053bebe5de18c59be7561c1cc6212a9",
      // v2 — Phase 3: the origination plane.
      "0x4407b0ce57e557bf9f9c1232ddca2ee5edab6c4465b0d67e568a84a267f4295e",
      // v1 — Phases 1 and 2: the plan and the check strip.
      "0x84a83a60587bb9269844f7ec68d3ca09fd1e50a18d7dad7dad3e4e251af3663d",
    ]);
    expect(PRIOR_SCHEMA_HASHES).toHaveLength(4);
    expect(PRIOR_SCHEMA_HASHES).toHaveLength(SCHEMA_VERSION - 1);
  });

  it("does not carry the current hash in the prior list", () => {
    expect(PRIOR_SCHEMA_HASHES).not.toContain(SCHEMA_HASH);
  });

  /**
   * The bump is only real if the hash moved.
   *
   * A version number incremented beside an unchanged hash is the failure this whole
   * mechanism exists to catch from the other direction: it would tell a replaying
   * consumer that two ranges need different definitions when they do not, and the next
   * person to notice would "fix" it by deleting an entry.
   */
  it("gives v5 a hash that differs from v4's", () => {
    const v4 = "0x732d16a75801f32d51c3f8b0e2f76b427a599da63d1efee9e8cf23df32e10a42";
    expect(SCHEMA_HASH).not.toBe(v4);
    expect(PRIOR_SCHEMA_HASHES[0]).toBe(v4);
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

  /**
   * The v5 addition, and the rule it states is narrower and sharper than "no wallets".
   *
   * Phase 7's contracts emit wallets. `PledgeVault` names a pledger on six events and
   * `PayrollSweeper` names a borrower on three, and neither contract can be changed
   * from this package. What the schema controls is which of them it *lists*, because a
   * listed event is one the indexer materialises into a public queryable table.
   *
   * The line drawn is not "which addresses are data subjects" — a pledger is very often
   * the borrower, and `TieredUnderwriter.bindPlan` passes the borrower straight through
   * as the pledger on the only production path. It is **whether the event joins an
   * address to a `planId`**. An address alone is a capital position that
   * `pledgedValueOf` already discloses. An address beside a `planId` is a credit file
   * the moment it is indexed, and `PledgeSeized` is a default record keyed by wallet.
   *
   * So: no v5 definition may carry both an address and a `planId`.
   */
  it("no Phase 7 definition joins a wallet to a planId", () => {
    const phase7 = EVENT_SCHEMA.filter((d) =>
      ["FxDeviationGuard", "PledgeVault", "PayrollSweeper", "TieredUnderwriter", "MerchantCurrencyRegistry"].includes(
        d.contract,
      ),
    );
    expect(phase7.length).toBeGreaterThan(0);

    for (const d of phase7) {
      const namesAPlan = d.fields.some((f) => /planId/i.test(f.name));
      const addresses = d.fields.filter((f) => f.type === "address").map((f) => f.name);
      if (namesAPlan) {
        expect(
          addresses,
          `${d.contract}.${d.name} joins ${addresses.join(", ")} to a planId — that is a credit file once indexed`,
        ).toEqual([]);
      }
    }
  });

  /**
   * The mechanical half of the same rule, over every v5 definition rather than only the
   * ones that name a plan. No person id, no borrower-shaped field name, and no `string`.
   *
   * `string` is on the list because it is the only ABI type in this file that can carry
   * a cleartext pointer into somebody's life — a tracking number, a dispute note, a
   * reason. `carrierRef` and `evidenceRef` are `bytes32` for exactly that reason, and
   * every new plane inherits the constraint rather than re-deciding it.
   */
  it("no v5 definition carries a person id, a borrower or a string", () => {
    const v5 = EVENT_SCHEMA.filter((d) =>
      [
        "FxDeviationGuard",
        "PledgeVault",
        "PayrollSweeper",
        "TieredUnderwriter",
        "MerchantCurrencyRegistry",
      ].includes(d.contract) || (d.contract === "CheckoutRouter" && d.name === "CorridorSet"),
    );
    expect(v5.length).toBeGreaterThan(0);

    for (const d of v5) {
      const offenders = d.fields.filter((f) =>
        /person|borrower|buyer|payer|consumer|customer|wallet|email|phone/i.test(f.name),
      );
      expect(offenders.map((f) => f.name), `${d.contract}.${d.name}`).toEqual([]);
      expect(
        d.fields.filter((f) => f.type === "string").map((f) => f.name),
        `${d.contract}.${d.name} carries a string`,
      ).toEqual([]);
    }
  });

  /**
   * UW-07's boundary, asserted by value rather than by absence.
   *
   * The requirement is that only the resulting limit and the tier reach the chain. An
   * assertion that the event *lacks* a person id would pass against an event that also
   * lacked the tier, so the field list is pinned exactly.
   */
  it("lets only the tier and the amount cross the TieredUnderwriter boundary", () => {
    const d = EVENT_SCHEMA.find((x) => x.name === "TieredOrigination");
    expect(d).toBeDefined();
    expect(d!.fields.map((f) => f.name)).toEqual(["planId", "tier", "principal"]);
    expect(d!.fields.map((f) => f.type)).toEqual(["bytes32", "uint8", "uint256"]);
    expect(d!.fields.filter((f) => f.indexed).map((f) => f.name)).toEqual(["planId"]);
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

  it("match the schema they duplicate, for the v5 additions", () => {
    expect([...FX_DEVIATION_GUARD_ABI]).toEqual(abiForContract("FxDeviationGuard"));
    expect([...MERCHANT_CURRENCY_REGISTRY_ABI]).toEqual(abiForContract("MerchantCurrencyRegistry"));
    expect([...PLEDGE_VAULT_ABI]).toEqual(abiForContract("PledgeVault"));
    expect([...TIERED_UNDERWRITER_ABI]).toEqual(abiForContract("TieredUnderwriter"));
  });
});

/**
 * Completeness, read off the compiler's own output rather than off a list in this file.
 *
 * A hand-written expected set is a second copy of the schema, and a second copy is the
 * thing that drifts. So the expected set is the `abi` array Foundry writes into
 * `contracts/out`, which `forge build` regenerates — the artefact DEC-73 and finding 30
 * are about, where a stale copy is what let a definition disagree with a contract.
 *
 * Two properties, and both are needed.
 *
 * **Nothing is forgotten.** Every event a Phase 7 contract emits is either defined here
 * or named in `DELIBERATELY_UNLISTED` with the header explaining why. Adding an event to
 * one of these contracts fails this test until somebody decides which it is, which is the
 * point: an omission should cost a decision rather than happen by default.
 *
 * **Nothing drifts.** For every event that *is* defined, the full signature — types,
 * order and every `indexed` flag — must equal the artefact's. A definition that dropped an
 * `indexed` would still produce the right `topic0` and would decode into the wrong fields,
 * which is the failure mode a `topic0`-only check cannot see.
 *
 * The plan for this work specified `packages/abi` as the source. That package has no
 * generated content in this tree (`packages/abi/generated/` is gitignored and empty), so
 * the artefact Foundry actually writes is used instead; it is the input that package would
 * be generated *from*, so the property is the same one and the dependency is shorter.
 */
describe("every Phase 7 event is accounted for", () => {
  const CONTRACTS_OUT = fileURLToPath(new URL("../../../contracts/out/", import.meta.url));

  /**
   * OpenZeppelin's `AccessControl`, inherited by four of these contracts. Filtered by
   * name because the artefact records no provenance — and filtered by an explicit list
   * rather than a pattern so that a Plazo event colliding with one of these names is a
   * conversation rather than a silent exemption.
   */
  const INHERITED = new Set(["RoleAdminChanged", "RoleGranted", "RoleRevoked"]);

  /**
   * On chain, and deliberately not in the schema. The header argues each one; this list
   * is what stops the argument being quietly re-decided by omission.
   *
   * The six privacy exclusions all join a wallet to a `planId`. `PartnerSet` is the
   * constancy case, on the `SettlementEscrow.RouterSet` reasoning.
   */
  const DELIBERATELY_UNLISTED: Record<string, string[]> = {
    PledgeVault: ["PledgeBound", "PledgeUnbound", "PledgeSeized"],
    PayrollSweeper: ["SweepOptedIn", "SweepOptedOut", "Swept"],
    TieredUnderwriter: ["PartnerSet"],
  };

  const PHASE_7_CONTRACTS = [
    "FxDeviationGuard",
    "PledgeVault",
    "PayrollSweeper",
    "TieredUnderwriter",
    "MerchantCurrencyRegistry",
    "CheckoutRouter",
  ];

  interface AbiEvent {
    type: string;
    name: string;
    inputs: {name: string; type: string; indexed?: boolean}[];
  }

  const emittedBy = (contract: string): AbiEvent[] => {
    const path = `${CONTRACTS_OUT}${contract}.sol/${contract}.json`;
    if (!existsSync(path)) {
      throw new Error(
        `No Foundry artefact at ${path}.\n\n` +
          "This test reads what the contracts actually emit rather than a list somebody\n" +
          "maintained by hand, so it needs a build. Run `forge build --root contracts`.\n" +
          "It is not skipped when the artefact is missing: a skip is a pass, and the\n" +
          "failure this test exists to catch is a definition that silently disagrees\n" +
          "with a contract.",
      );
    }
    const artefact = JSON.parse(readFileSync(path, "utf8")) as {abi: AbiEvent[]};
    return artefact.abi.filter((entry) => entry.type === "event" && !INHERITED.has(entry.name));
  };

  const signatureOf = (event: AbiEvent): string =>
    `event ${event.name}(${event.inputs
      .map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`)
      .join(", ")})`;

  it.each(PHASE_7_CONTRACTS)("leaves no event of %s undecided", (contract) => {
    const emitted = emittedBy(contract).map((e) => e.name);
    expect(emitted.length, `${contract} emits nothing — wrong artefact?`).toBeGreaterThan(0);

    const defined = EVENT_SCHEMA.filter((d) => d.contract === contract).map((d) => d.name);
    const excused = DELIBERATELY_UNLISTED[contract] ?? [];

    const undecided = emitted.filter((name) => !defined.includes(name) && !excused.includes(name));
    expect(
      undecided,
      `${contract} emits ${undecided.join(", ")} — add a definition, or add it to ` +
        "DELIBERATELY_UNLISTED and say why in the schema header. An event with neither is " +
        "a stream the indexer will silently never see.",
    ).toEqual([]);

    // The exclusion list may not name an event that does not exist: a stale entry there
    // would excuse a future event that happened to reuse the name.
    for (const name of excused) {
      expect(emitted, `${contract}.${name} is excused but not emitted`).toContain(name);
      expect(defined, `${contract}.${name} is both excused and defined`).not.toContain(name);
    }
  });

  it.each(PHASE_7_CONTRACTS)("defines %s's events exactly as it emits them", (contract) => {
    const emitted = new Map(emittedBy(contract).map((e) => [e.name, signatureOf(e)]));
    const defined = EVENT_SCHEMA.filter((d) => d.contract === contract);

    for (const d of defined) {
      expect(
        humanReadableAbi(d),
        `${contract}.${d.name} disagrees with the compiled artefact`,
      ).toBe(emitted.get(d.name));
    }
  });

  /**
   * The exclusions are a privacy decision, so the property that justifies them is
   * asserted rather than trusted: every event left out of the schema on privacy grounds
   * really does join an address to a `planId`.
   *
   * Without this, "deliberately unlisted" is an assertion about intent. With it, it is a
   * claim about the ABI that fails if somebody adds a harmless event to the list to make
   * a red test go away.
   */
  it("excludes only events that join a wallet to a planId, or the wiring call", () => {
    for (const [contract, names] of Object.entries(DELIBERATELY_UNLISTED)) {
      const emitted = new Map(emittedBy(contract).map((e) => [e.name, e]));
      for (const name of names) {
        if (contract === "TieredUnderwriter" && name === "PartnerSet") continue; // the constancy case
        const event = emitted.get(name)!;
        expect(
          event.inputs.some((i) => /planId/i.test(i.name)),
          `${contract}.${name} is excluded on privacy grounds but names no plan`,
        ).toBe(true);
        expect(
          event.inputs.some((i) => i.type === "address"),
          `${contract}.${name} is excluded on privacy grounds but carries no address`,
        ).toBe(true);
      }
    }
  });
});
