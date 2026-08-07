/**
 * Tier 1 — a limit derived from verified onchain inflow history. UW-04.
 *
 * ## Tier 1 can only ever propose
 *
 * `CheckoutRouter._sizeCheck` takes `min(attested, LIMIT_HARD_CEILING, tierCap,
 * merchantRoom, corridorRoom)`. Every figure this file produces passes through that
 * minimum, so the worst a wrong scorer can do is **decline credit the chain would have
 * extended**. It cannot raise anyone's limit past a cap, and it cannot originate
 * anything. That asymmetry is what makes it safe to score off an attacker-chosen data
 * set at all, and it is the reason every exclusion below is allowed to be blunt.
 *
 * ## The payroll benefit is a limit multiple and there is no rate anywhere in this file
 *
 * E-09. Pay-in-4 is 0%-on-time; there is no rate to discount, so UW-05's
 * salary-deduction benefit is expressed as a higher limit multiple
 * (`plazo.tier1.payrollBonusBps`) applied to the same verified income. The
 * interest-rate reading of "better pricing" is **unavailable on this product line** and
 * becomes available in Phase 8, when Flex ships something there is a rate to move. The
 * decision object carries no such field and a grep gate asserts it.
 *
 * ## Why this is a pure function over injected rows
 *
 * Ninety days of Arc is roughly 15.1 million blocks against a 10,000-block `eth_getLogs`
 * cap on an endpoint that sheds a quarter of what it is asked. A scan inside a quote
 * request times out and looks like a code bug (Pitfall 6). So the history is folded
 * continuously into `operator.inflow_summary` / `operator.inflow_counterparty` and read
 * here as rows. No database client, no chain client, no fetch — which is also what makes
 * the four exclusions testable against a synthetic fixture, and a synthetic fixture is
 * the only honest validation available: **Arc testnet has essentially no organic inflow
 * history and this repo's own wallets were funded by aggregating faucet drips.** Nothing
 * here has ever observed real payroll and nothing here claims to have.
 *
 * ## The thresholds are registry rows, not constants
 *
 * Every number in `Tier1Params` comes from `ParameterRegistry`, seeded by plan 07-02
 * with a compiled band that governance can narrow and cannot widen. The keys are named
 * in `TIER1_PARAMETER_KEYS` so a reader can find the row rather than guess at it. The
 * one exception is the dispersion ceiling, and it says so where it lives.
 */
import {IdentityClass, type Usdc6} from "@plazo/plan-core";
import type {Hex} from "viem";

/**
 * The registry rows this scorer reads. It compiles no threshold of its own.
 *
 * `ParameterRegistry.get()` reverts on an undefined key, so a row that exists in the
 * library and on no deployed registry stops every origination (Pitfall 1). These six
 * were seeded by plan 07-02 on a dedicated instance; the caller reads them and passes
 * them in, because a scorer that read the chain would not be a pure function and could
 * not be tested against a fixture.
 */
export const TIER1_PARAMETER_KEYS = {
  incomeMultipleBps: "plazo.tier1.incomeMultipleBps",
  pseudonymousCap: "plazo.tier1.pseudonymousCap",
  payrollBonusBps: "plazo.tier1.payrollBonusBps",
  inflowLookback: "plazo.tier1.inflowLookback",
  minMonths: "plazo.tier1.inflowMinMonths",
  minCounterparties: "plazo.tier1.inflowMinCounterparties",
} as const;

const BPS = 10_000n;

/**
 * The dispersion ceiling, in basis points of the coefficient of variation.
 *
 * 4,000 bps — a standard deviation of 40% of the mean month.
 *
 * **Written down, with its reasoning, because a threshold nobody wrote down is a
 * threshold that gets moved.** A salaried stream has a coefficient of variation near
 * zero. A stream where one month is three times another sits above 0.5. Forty percent
 * admits ordinary variation — a short month, a bonus, an invoice paid a week late —
 * and refuses a stream whose "income" is one large payment wearing a cadence. It is
 * the control that lets the central figure be the **mean** rather than the minimum:
 * within a stream this even, the mean is the representative month, and using the
 * minimum instead would price the volatility twice and let one quiet month set a
 * borrower's whole limit.
 *
 * It is a constant here and not a registry row because `ParameterKeys` has no key for
 * it and this plan adds none — the six rows above are the phase's Tier-1 surface. That
 * is a real limitation rather than a design choice: it means governance can narrow the
 * income multiple and the counterparty floor but not this. Worth a row when the next
 * plan touches `ParameterKeys`.
 */
export const DISPERSION_CEILING_BPS = 4_000n;

/**
 * One inflow, already folded and already narrowed.
 *
 * `valueMinor` is 6-decimal and arrives narrowed **once**, at indexing time, from the
 * 18-decimal EIP-7708 log through `toMinor6`. Nothing in this file re-narrows anything:
 * a second narrowing is a second place to make the 10^12 error, and E-08's whole defence
 * is that there is exactly one.
 */
export interface InflowRow {
  /** The payer's chain address. */
  counterparty: Hex;
  /** 6-decimal minor units. Never a bare bigint at a boundary. */
  valueMinor: Usdc6;
  /** `YYYY-MM`. Cadence is counted in distinct values of this. */
  monthBucket: string;
  /** How many times the subject has paid *this* counterparty. Non-zero excludes the row. */
  sentToCount: number;
  /** Refunds, keeper bounties, faucet drips, the subject's own top-ups. */
  isProtocolAddress: boolean;
}

export interface Tier1Params {
  incomeMultipleBps: bigint;
  pseudonymousCap: Usdc6;
  payrollBonusBps: bigint;
  minMonths: number;
  minCounterparties: number;
  /** Defaults to `DISPERSION_CEILING_BPS`. Injectable so a test can drive the refusal. */
  dispersionCeilingBps?: bigint;
}

export interface Tier1Score {
  /** The representative month, in 6-decimal minor units. Zero when any gate refuses. */
  verifiedMonthlyMinor: Usdc6;
  /** Distinct month buckets among surviving rows. */
  months: number;
  /** Distinct counterparties among surviving rows. */
  counterparties: number;
  /** Coefficient of variation across month totals, in basis points. */
  dispersionBps: bigint;
  excluded: {roundTrip: number; protocol: number};
  /** Why the figure is what it is — populated on every path, including the zeroes. */
  reason: string;
}

export interface Tier1Decision {
  limitMinor: Usdc6;
  /**
   * Required on every path, including every zero.
   *
   * UW-08 says a borrower can see exactly which events produced their current limit,
   * and a bare zero is not an answer to that. A decision that declines has to be able
   * to say which of the four exclusions declined it.
   */
  reason: string;
  inputs: {
    verifiedMonthlyMinor: bigint;
    months: number;
    counterparties: number;
    dispersionBps: bigint;
    incomeMultipleBps: bigint;
    payrollOptedIn: boolean;
    payrollBonusBps: bigint;
    identity: IdentityClass;
    pseudonymousCap: bigint;
    /** True when the pseudonymous ceiling was the binding constraint. */
    capBound: boolean;
    excluded: {roundTrip: number; protocol: number};
  };
}

/** Integer square root, so the dispersion figure never touches a float. */
function isqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let low = 1n;
  let high = value;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (mid * mid <= value) low = mid;
    else high = mid - 1n;
  }
  return low;
}

/**
 * The four exclusions, each a named step.
 *
 * A9 is the risk they close: under-designed sybil resistance turns Tier 1 into a
 * self-serve limit printer, and DEC-02 already put real pool capital behind Tier 0.
 * Each one has a test that fails when it is removed, because an exclusion nobody has
 * watched refuse is an exclusion nobody knows is wired.
 */
export function scoreInflows(rows: readonly InflowRow[], params: Tier1Params): Tier1Score {
  const zero = 0n as Usdc6;

  // ── 1. Round-tripping ──────────────────────────────────────────────────────
  //
  // Discard every row from a counterparty the subject has ever sent to. A borrower
  // with two wallets can otherwise cycle one hundred dollars between them all day and
  // manufacture unlimited income; the payments are real, the money is theirs, and no
  // amount of cadence analysis can tell that apart from a salary. What tells it apart
  // is the return leg, and `sentToCount` is counted at write time so this costs a
  // field read rather than a scan at quote time.
  const afterRoundTrip = rows.filter((row) => row.sentToCount === 0);
  const roundTrip = rows.length - afterRoundTrip.length;

  // ── 2. Protocol flow ───────────────────────────────────────────────────────
  //
  // `InstallmentPlan` refunds, keeper bounties, faucet drips and the subject's own
  // top-ups from another chain. All of them are inbound and none of them is income —
  // a refund in particular is the borrower's own money coming back, and counting it
  // would let a borrower raise their limit by returning a purchase.
  const surviving = afterRoundTrip.filter((row) => !row.isProtocolAddress);
  const protocol = afterRoundTrip.length - surviving.length;

  const excluded = {roundTrip, protocol};

  const buckets = new Map<string, bigint>();
  const payers = new Set<string>();
  for (const row of surviving) {
    buckets.set(row.monthBucket, (buckets.get(row.monthBucket) ?? 0n) + (row.valueMinor as bigint));
    payers.add(row.counterparty.toLowerCase());
  }

  const months = buckets.size;
  const counterparties = payers.size;

  // ── 3. Cadence and diversity ───────────────────────────────────────────────
  //
  // `plazo.tier1.inflowMinMonths` and `plazo.tier1.inflowMinCounterparties`. A single
  // counterparty paying an identical amount at an irregular cadence is a wash, not a
  // salary, and one month of history is a screenshot rather than a record.
  if (months < params.minMonths) {
    return {
      verifiedMonthlyMinor: zero,
      months,
      counterparties,
      dispersionBps: 0n,
      excluded,
      reason:
        `Verified income is zero: ${months} month(s) of inflow history against a floor of ` +
        `${params.minMonths}. ${roundTrip} row(s) were excluded as round-tripped payments and ` +
        `${protocol} as protocol flow.`,
    };
  }

  if (counterparties < params.minCounterparties) {
    return {
      verifiedMonthlyMinor: zero,
      months,
      counterparties,
      dispersionBps: 0n,
      excluded,
      reason:
        `Verified income is zero: ${counterparties} distinct counterparty/counterparties against ` +
        `a floor of ${params.minCounterparties}. A single payer at an irregular cadence is not a ` +
        `salary. ${roundTrip} row(s) were excluded as round-tripped payments and ${protocol} as ` +
        `protocol flow.`,
    };
  }

  const totals = [...buckets.values()];
  const sum = totals.reduce((a, b) => a + b, 0n);
  const mean = sum / BigInt(totals.length);

  if (mean === 0n) {
    return {
      verifiedMonthlyMinor: zero,
      months,
      counterparties,
      dispersionBps: 0n,
      excluded,
      reason:
        `Verified income is zero: ${months} qualifying month(s) totalling nothing. ` +
        `${roundTrip} row(s) were excluded as round-tripped payments and ${protocol} as protocol flow.`,
    };
  }

  // ── 4. Dispersion ──────────────────────────────────────────────────────────
  //
  // Coefficient of variation across the month totals, in basis points, computed in
  // integers throughout. See `DISPERSION_CEILING_BPS` for the number and the argument.
  const variance =
    totals.reduce((acc, total) => acc + (total - mean) * (total - mean), 0n) /
    BigInt(totals.length);
  const dispersionBps = (isqrt(variance) * BPS) / mean;
  const ceiling = params.dispersionCeilingBps ?? DISPERSION_CEILING_BPS;

  if (dispersionBps > ceiling) {
    return {
      verifiedMonthlyMinor: zero,
      months,
      counterparties,
      dispersionBps,
      excluded,
      reason:
        `Verified income is zero: monthly inflows vary by ${dispersionBps} bps of the mean, ` +
        `above the ${ceiling} bps ceiling. A stream this uneven is one large payment wearing a ` +
        `cadence rather than a recurring income.`,
    };
  }

  return {
    verifiedMonthlyMinor: mean as Usdc6,
    months,
    counterparties,
    dispersionBps,
    excluded,
    reason:
      `Verified income of ${mean} minor units per month, from ${counterparties} counterparties ` +
      `across ${months} months, varying by ${dispersionBps} bps. ${roundTrip} row(s) were ` +
      `excluded as round-tripped payments and ${protocol} as protocol flow.`,
  };
}

export interface Tier1LimitInputs {
  score: Tier1Score;
  identity: IdentityClass;
  params: Tier1Params;
  /** `PayrollSweeper.isOptedIn(planId, borrower)`, read as an onchain fact. */
  payrollOptedIn: boolean;
}

/**
 * Turn a verified income into a proposed limit, and cap it by identity.
 *
 * `verifiedMonthlyMinor × plazo.tier1.incomeMultipleBps ÷ 10,000`, uplifted by
 * `plazo.tier1.payrollBonusBps` when the borrower has opted into salary deduction, and
 * then **capped at `plazo.tier1.pseudonymousCap` for a wallet the operator has not
 * attested**.
 *
 * That cap is the answer to T-07-06-04. Its compiled band tops out at
 * `TIER0_IDENTIFIED_CAP`'s seeded default of 1,000 USDC — governance cannot widen it
 * past the identity-linked ceiling — so a pseudonymous wallet with a fabricated inflow
 * history can never outrank a person an operator actually attested. Fabricating history
 * is cheap; being attested is not, and the ordering has to reflect that.
 *
 * The uplift is applied **before** the cap on purpose: an opted-in pseudonymous borrower
 * gets the same ceiling as any other pseudonymous borrower, because the bonus is a
 * reward for a repayment mechanism and not a substitute for identity.
 */
export function tier1LimitFor(inputs: Tier1LimitInputs): Tier1Decision {
  const {score, identity, params, payrollOptedIn} = inputs;
  const verified = score.verifiedMonthlyMinor as bigint;

  const base = (verified * params.incomeMultipleBps) / BPS;
  const uplifted = payrollOptedIn ? (base * (BPS + params.payrollBonusBps)) / BPS : base;

  const cap = params.pseudonymousCap as bigint;
  const capBound = identity === IdentityClass.Pseudonymous && uplifted > cap;
  const limit = capBound ? cap : uplifted;

  const shared = {
    verifiedMonthlyMinor: verified,
    months: score.months,
    counterparties: score.counterparties,
    dispersionBps: score.dispersionBps,
    incomeMultipleBps: params.incomeMultipleBps,
    payrollOptedIn,
    payrollBonusBps: params.payrollBonusBps,
    identity,
    pseudonymousCap: cap,
    capBound,
    excluded: score.excluded,
  };

  if (verified === 0n) {
    // The zero paths carry the scorer's own explanation verbatim. A decision that says
    // only "0" is the thing UW-08 exists to forbid.
    return {limitMinor: 0n as Usdc6, reason: score.reason, inputs: shared};
  }

  const bonusText = payrollOptedIn
    ? ` Salary deduction is opted in, so the multiple is uplifted by ${params.payrollBonusBps} bps — ` +
      `a higher limit, not a discount, because this product carries nothing to discount.`
    : "";

  const capText = capBound
    ? ` Capped at ${cap} because this wallet is pseudonymous; the uplifted figure was ${uplifted}.`
    : "";

  return {
    limitMinor: limit as Usdc6,
    reason:
      `Proposed ${limit} minor units from ${verified} of verified monthly income at ` +
      `${params.incomeMultipleBps} bps.${bonusText}${capText} Every onchain cap still binds: the ` +
      `router takes the minimum of this figure and every other constraint, so this can only ` +
      `lower what the chain would have allowed.`,
    inputs: shared,
  };
}

/**
 * The seam `Underwriter.decide` reads Tier 1 through.
 *
 * Shaped after `ServicingDeps.merchants` (DEC-64/DEC-77): an unconfigured dependency is
 * injected as something that declines rather than as something that throws or, worse,
 * something that returns a plausible default.
 */
export interface Tier1Reader {
  /** The proposed Tier-1 limit for this borrower, or zero. */
  proposeFor(args: {
    borrower: Hex;
    personId: Hex;
    identity: IdentityClass;
  }): Promise<Tier1Decision>;
}

/**
 * The default. It proposes **zero**, and the zero is the whole point.
 *
 * The inflow backfill has never completed — 390 blocks of a 194,092-block range in nine
 * minutes with 641 shed responses, measured 2026-08-02, and the prescribed escape became
 * token-gated the same day. An unconfigured or un-backfilled Tier 1 must therefore be
 * indistinguishable from a borrower with no history *in its effect*, and distinguishable
 * in its `reason`, which is exactly what this returns. A default that guessed a
 * plausible limit would extend credit on the strength of an indexer that never ran.
 */
export const NO_TIER1: Tier1Reader = {
  async proposeFor({identity}) {
    return {
      limitMinor: 0n as Usdc6,
      reason:
        "Tier 1 is not configured on this deployment, so it proposes nothing. This is not a " +
        "statement about the borrower: no inflow history was read at all.",
      inputs: {
        verifiedMonthlyMinor: 0n,
        months: 0,
        counterparties: 0,
        dispersionBps: 0n,
        incomeMultipleBps: 0n,
        payrollOptedIn: false,
        payrollBonusBps: 0n,
        identity,
        pseudonymousCap: 0n,
        capBound: false,
        excluded: {roundTrip: 0, protocol: 0},
      },
    };
  },
};
