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
  INSTALLMENT_PLAN_ABI,
  PLAN_FACTORY_ABI,
  CHECKOUT_ROUTER_ABI,
  RECEIVABLE_TOKEN_ABI,
  CREDIT_POOL_ABI,
  MERCHANT_REGISTRY_ABI,
  TIER0_UNDERWRITER_ABI,
  KILL_SWITCH_ABI,
  PARAMETER_REGISTRY_ABI,
  ORIGINATION_PAUSE_ABI,
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

  it("every plan event is keyed by planId", () => {
    const planEvents = EVENT_SCHEMA.filter((d) => d.contract === "InstallmentPlan");
    for (const d of planEvents) {
      const first = d.fields[0];
      expect(first?.name, `${d.name} is not keyed by planId`).toBe("planId");
      expect(first?.indexed, `${d.name}.planId is not indexed`).toBe(true);
    }
  });

  it("the redemption queue does not identify holders", () => {
    const queued = EVENT_SCHEMA.find((d) => d.name === "RedemptionQueued");
    expect(queued).toBeDefined();
    // Queue depth is public; queue membership is not.
    expect(queued!.fields.some((f) => f.type === "address")).toBe(false);
  });

  it("Passport emits commitments, never records or subjects", () => {
    const passport = EVENT_SCHEMA.filter((d) => d.contract === "Passport");
    expect(passport.length).toBeGreaterThan(0);
    for (const d of passport) {
      expect(d.fields.some((f) => f.type === "address")).toBe(false);
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

  it("has no colliding topics", () => {
    const topics = EVENT_SCHEMA.map(eventTopic);
    expect(new Set(topics).size).toBe(topics.length);
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
    expect([...CREDIT_POOL_ABI]).toEqual(abiForContract("CreditPool"));
    expect([...MERCHANT_REGISTRY_ABI]).toEqual(abiForContract("MerchantRegistry"));
    expect([...TIER0_UNDERWRITER_ABI]).toEqual(abiForContract("Tier0Underwriter"));
    expect([...KILL_SWITCH_ABI]).toEqual(abiForContract("FirstPaymentDefaultSwitch"));
    expect([...PARAMETER_REGISTRY_ABI]).toEqual(abiForContract("ParameterRegistry"));
    expect([...ORIGINATION_PAUSE_ABI]).toEqual(abiForContract("OriginationPause"));
  });

  it("cover every contract the indexer subscribes to", () => {
    expect(abiForContract("PlanFactory").length).toBeGreaterThan(0);
    expect(abiForContract("InstallmentPlan").length).toBeGreaterThan(0);
    expect(abiForContract("NoSuchContract")).toEqual([]);
  });
});
