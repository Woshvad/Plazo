/**
 * UW-04 — the four exclusions that stop Tier 1 being a self-serve limit printer.
 *
 * The fixture is synthetic, deliberately and unavoidably. Arc testnet has essentially
 * no organic inflow history, and this repo's own wallets were funded by aggregating
 * faucet drips — so there is no borrower on this chain with ninety days of payroll to
 * score, and a test that pretended otherwise would be asserting against data nobody
 * has. What *is* validated live is the other half: that the EIP-7708 stream parses at
 * 18 decimals and that narrowing it reproduces the ERC-20 stream exactly
 * (`pnpm --filter @plazo/arc-verify inflow`). Decimal correctness against the chain,
 * scoring against a fixture; neither claims to be the other.
 *
 * Every exclusion below has been watched failing. Removing the round-trip filter turns
 * the wash test red with a non-zero limit; removing the pseudonymous cap turns the
 * identity test red. Both are recorded in the plan's SUMMARY with their output.
 */
import {describe, expect, it} from "vitest";
import type {Hex} from "viem";

import {IdentityClass} from "@plazo/plan-core";

import {
  DISPERSION_CEILING_BPS,
  NO_TIER1,
  scoreInflows,
  tier1LimitFor,
  TIER1_PARAMETER_KEYS,
  type InflowRow,
  type Tier1Params,
} from "../src/tier1.js";

/**
 * The registry's seeded defaults, transcribed from `ParameterRegistry`'s `_define`
 * calls rather than invented — 2500 bps, a 500 USDC pseudonymous cap, a 2500 bps
 * payroll bonus, three months and two counterparties.
 */
const PARAMS: Tier1Params = {
  incomeMultipleBps: 2_500n,
  pseudonymousCap: 500_000_000n as Tier1Params["pseudonymousCap"],
  payrollBonusBps: 2_500n,
  minMonths: 3,
  minCounterparties: 2,
};

const EMPLOYER = "0x00000000000000000000000000000000000e4b10" as Hex;
const CLIENT = "0x00000000000000000000000000000000000c1e47" as Hex;
const MARKETPLACE = "0x000000000000000000000000000000000000a4ce" as Hex;
const OWN_SECOND_WALLET = "0x00000000000000000000000000000000000a1a53" as Hex;
const PLAN_REFUND = "0x00000000000000000000000000000000000ef00d" as Hex;

function row(overrides: Partial<InflowRow> & Pick<InflowRow, "counterparty" | "monthBucket">): InflowRow {
  return {
    valueMinor: 1_000_000_000n as InflowRow["valueMinor"],
    sentToCount: 0,
    isProtocolAddress: false,
    ...overrides,
  };
}

/**
 * Three payers, four months, even amounts — the stream that should produce a limit.
 *
 * The size is chosen so the identified limit lands **above** `pseudonymousCap`: three
 * payers x 800 USDC x four months is 2,400 USDC a month, which at 2,500 bps proposes
 * 600 USDC against a 500 USDC pseudonymous ceiling. A smaller stream would pass the
 * identity test without the cap ever binding, which is a test that agrees with an
 * implementation that has no cap at all.
 */
function healthyStream(): InflowRow[] {
  const months = ["2026-04", "2026-05", "2026-06", "2026-07"];
  const payers = [EMPLOYER, CLIENT, MARKETPLACE];
  return months.flatMap((monthBucket) =>
    payers.map((counterparty) => row({counterparty, monthBucket, valueMinor: 800_000_000n as never})),
  );
}

describe("scoreInflows — the four exclusions", () => {
  it("round-tripped self-payments produce zero verified income", () => {
    // Ten inflows across six months from two counterparties the borrower has also sent
    // to. Every cadence and diversity floor is cleared; the money is real and it is the
    // borrower's own, cycled between wallets they control. Without the exclusion this
    // is an unbounded limit for the price of gas.
    const months = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
    const rows: InflowRow[] = [
      ...months.map((monthBucket) =>
        row({counterparty: OWN_SECOND_WALLET, monthBucket, sentToCount: 7}),
      ),
      ...months.map((monthBucket) =>
        row({counterparty: MARKETPLACE, monthBucket, sentToCount: 3}),
      ),
    ];

    const score = scoreInflows(rows, PARAMS);
    const decision = tier1LimitFor({
      score,
      identity: IdentityClass.Identified,
      params: PARAMS,
      payrollOptedIn: false,
    });

    // The **limit** is asserted first, deliberately. Removing the exclusion and
    // watching a counter read 0 instead of 10 says the filter is gone; watching the
    // limit read 250,000,000 instead of 0 says what the missing filter costs. A
    // deliberate-failure check is only worth running if its message is the consequence.
    expect(decision.limitMinor).toBe(0n);
    expect(score.verifiedMonthlyMinor).toBe(0n);
    expect(decision.reason).toMatch(/round-tripped/);

    expect(rows).toHaveLength(10);
    expect(score.excluded.roundTrip).toBe(10);
    expect(score.months).toBe(0);
    expect(score.counterparties).toBe(0);
  });

  it("a single counterparty at an irregular cadence produces zero verified income", () => {
    // One payer, four inflows, three month buckets. The month floor is met; the
    // counterparty floor is not, and a single payer is exactly the shape a borrower
    // can fabricate with one extra wallet they have never received from.
    const rows: InflowRow[] = [
      row({counterparty: EMPLOYER, monthBucket: "2026-05"}),
      row({counterparty: EMPLOYER, monthBucket: "2026-06"}),
      row({counterparty: EMPLOYER, monthBucket: "2026-07"}),
      row({counterparty: EMPLOYER, monthBucket: "2026-07"}),
    ];

    const score = scoreInflows(rows, PARAMS);

    expect(score.months).toBe(3);
    expect(score.counterparties).toBe(1);
    expect(score.verifiedMonthlyMinor).toBe(0n);
    expect(score.reason).toMatch(/floor of 2/);
  });

  it("protocol inflows are excluded", () => {
    // A refund is the borrower's own money coming back and a bounty is a payment for
    // work the protocol asked for. Counting either would let a borrower raise their
    // limit by returning a purchase.
    const rows: InflowRow[] = [
      ...healthyStream(),
      row({counterparty: PLAN_REFUND, monthBucket: "2026-04", isProtocolAddress: true, valueMinor: 90_000_000_000n as never}),
      row({counterparty: PLAN_REFUND, monthBucket: "2026-05", isProtocolAddress: true, valueMinor: 90_000_000_000n as never}),
    ];

    const withProtocol = scoreInflows(rows, PARAMS);
    const without = scoreInflows(healthyStream(), PARAMS);

    expect(withProtocol.excluded.protocol).toBe(2);
    expect(withProtocol.verifiedMonthlyMinor).toBe(without.verifiedMonthlyMinor);
  });

  it("a lumpy stream is refused by the dispersion ceiling", () => {
    // Three payers and four months, so cadence and diversity both clear — and one month
    // carrying twelve times another. That is one large payment wearing a cadence.
    const rows: InflowRow[] = [
      row({counterparty: EMPLOYER, monthBucket: "2026-04", valueMinor: 10_000_000n as never}),
      row({counterparty: CLIENT, monthBucket: "2026-05", valueMinor: 10_000_000n as never}),
      row({counterparty: MARKETPLACE, monthBucket: "2026-06", valueMinor: 10_000_000n as never}),
      row({counterparty: EMPLOYER, monthBucket: "2026-07", valueMinor: 1_200_000_000n as never}),
    ];

    const score = scoreInflows(rows, PARAMS);

    expect(score.months).toBe(4);
    expect(score.counterparties).toBe(3);
    expect(score.dispersionBps).toBeGreaterThan(DISPERSION_CEILING_BPS);
    expect(score.verifiedMonthlyMinor).toBe(0n);
    expect(score.reason).toMatch(/bps ceiling/);
  });

  it("a diverse cadenced stream produces a limit", () => {
    const score = scoreInflows(healthyStream(), PARAMS);

    // Three payers x 400 USDC x four identical months: 1,200 USDC a month, zero variance.
    expect(score.months).toBe(4);
    expect(score.counterparties).toBe(3);
    expect(score.dispersionBps).toBe(0n);
    expect(score.verifiedMonthlyMinor).toBe(2_400_000_000n);

    const decision = tier1LimitFor({
      score,
      identity: IdentityClass.Identified,
      params: PARAMS,
      payrollOptedIn: false,
    });

    expect(decision.limitMinor).toBe((2_400_000_000n * PARAMS.incomeMultipleBps) / 10_000n);
    expect(decision.limitMinor).toBe(600_000_000n);
  });
});

describe("tier1LimitFor — identity, payroll and the reason", () => {
  it("a pseudonymous limit is capped below the identified Tier-0 cap", () => {
    const score = scoreInflows(healthyStream(), PARAMS);

    const identified = tier1LimitFor({
      score,
      identity: IdentityClass.Identified,
      params: PARAMS,
      payrollOptedIn: false,
    });
    const pseudonymous = tier1LimitFor({
      score,
      identity: IdentityClass.Pseudonymous,
      params: PARAMS,
      payrollOptedIn: false,
    });

    // The same stream, the same arithmetic, two identity classes. The cap binds on one
    // and not the other, and the ordering is the property: a wallet with a fabricated
    // history cannot outrank a person the operator attested.
    expect(pseudonymous.limitMinor).toBe(PARAMS.pseudonymousCap as bigint);
    expect(identified.limitMinor).toBeGreaterThan(pseudonymous.limitMinor);
    expect(pseudonymous.inputs.capBound).toBe(true);
    expect(identified.inputs.capBound).toBe(false);
    // `TIER1_PSEUDONYMOUS_CAP`'s compiled band tops out at `TIER0_IDENTIFIED_CAP`'s
    // seeded default of 1,000 USDC, so no governance action can lift this above the
    // identity-linked ceiling.
    expect(pseudonymous.limitMinor).toBeLessThanOrEqual(1_000_000_000n);
  });

  it("an opted-in borrower receives the payroll bonus and no rate changes", () => {
    const score = scoreInflows(healthyStream(), PARAMS);
    const base = tier1LimitFor({
      score,
      identity: IdentityClass.Identified,
      params: PARAMS,
      payrollOptedIn: false,
    });
    const opted = tier1LimitFor({
      score,
      identity: IdentityClass.Identified,
      params: PARAMS,
      payrollOptedIn: true,
    });

    // The benefit is a limit multiple, up by exactly `payrollBonusBps`.
    expect(base.limitMinor).toBe(600_000_000n);
    expect(opted.limitMinor).toBe((base.limitMinor * (10_000n + PARAMS.payrollBonusBps)) / 10_000n);
    expect(opted.limitMinor).toBe(750_000_000n);

    // E-09 as an assertion rather than a comment: Pay-in-4 is 0%-on-time and there is
    // no rate to discount, so the decision object must not carry one — not on the
    // object, not in `inputs`, not under any casing.
    const keys = [...Object.keys(opted), ...Object.keys(opted.inputs)].map((k) => k.toLowerCase());
    for (const forbidden of ["apr", "rate", "interest", "yield", "discount"]) {
      expect(keys.some((key) => key.includes(forbidden))).toBe(false);
    }
  });

  it("every decision carries a reason, including the zero decisions", () => {
    const zeroPaths = [
      // Below the month floor.
      scoreInflows([row({counterparty: EMPLOYER, monthBucket: "2026-07"})], PARAMS),
      // Below the counterparty floor.
      scoreInflows(
        ["2026-05", "2026-06", "2026-07"].map((monthBucket) =>
          row({counterparty: EMPLOYER, monthBucket}),
        ),
        PARAMS,
      ),
      // Every row round-tripped.
      scoreInflows(
        ["2026-05", "2026-06", "2026-07"].map((monthBucket) =>
          row({counterparty: OWN_SECOND_WALLET, monthBucket, sentToCount: 1}),
        ),
        PARAMS,
      ),
      // Qualifying months totalling nothing.
      scoreInflows(
        ["2026-05", "2026-06", "2026-07"].flatMap((monthBucket) => [
          row({counterparty: EMPLOYER, monthBucket, valueMinor: 0n as never}),
          row({counterparty: CLIENT, monthBucket, valueMinor: 0n as never}),
        ]),
        PARAMS,
      ),
    ];

    for (const score of zeroPaths) {
      expect(score.verifiedMonthlyMinor).toBe(0n);
      expect(score.reason.length).toBeGreaterThan(20);

      for (const identity of [IdentityClass.Identified, IdentityClass.Pseudonymous]) {
        for (const payrollOptedIn of [false, true]) {
          const decision = tier1LimitFor({score, identity, params: PARAMS, payrollOptedIn});
          expect(decision.limitMinor).toBe(0n);
          // A bare zero is not an answer to "why is my limit what it is" (UW-08).
          expect(decision.reason).toMatch(/Verified income is zero/);
        }
      }
    }

    // And the non-zero path carries one too.
    const healthy = tier1LimitFor({
      score: scoreInflows(healthyStream(), PARAMS),
      identity: IdentityClass.Identified,
      params: PARAMS,
      payrollOptedIn: false,
    });
    expect(healthy.reason).toMatch(/Every onchain cap still binds/);
  });

  it("the unconfigured seam proposes zero and says so", async () => {
    const decision = await NO_TIER1.proposeFor({
      borrower: EMPLOYER,
      personId: EMPLOYER,
      identity: IdentityClass.Identified,
    });

    // The backfill has never completed on this chain, so this is the ordinary case and
    // it must be distinguishable from a borrower who genuinely has no income.
    expect(decision.limitMinor).toBe(0n);
    expect(decision.reason).toMatch(/not a statement about the borrower/i);
  });

  it("reads its thresholds from registry rows rather than compiling them", () => {
    // The scorer holds no threshold of its own except the dispersion ceiling, which
    // says so where it lives. These are the six keys plan 07-02 seeded.
    expect(Object.values(TIER1_PARAMETER_KEYS)).toEqual([
      "plazo.tier1.incomeMultipleBps",
      "plazo.tier1.pseudonymousCap",
      "plazo.tier1.payrollBonusBps",
      "plazo.tier1.inflowLookback",
      "plazo.tier1.inflowMinMonths",
      "plazo.tier1.inflowMinCounterparties",
    ]);
  });
});
