import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";
import type {Hex} from "viem";

import {
  CORRIDOR_PAUSE_TOPIC,
  corridorPollJobKey,
  evaluateCorridorHealth,
  loadCorridorThresholds,
  pauseCorridor,
  roundTripDeviationBps,
  runCorridorPoll,
  TRIP_REASONS,
  type CorridorHealthInput,
  type CorridorPauser,
  type CorridorThresholds,
  type ReceiptReader,
  type TripReason,
} from "../src/breaker.js";
import {composeFxService} from "../src/index.js";
import {readFxConfig} from "../src/config.js";
import {corridorOf, FX_PARAMETER_KEYS, type FxParameterReader} from "../src/mid.js";
import {StubVenue, type FxPair, type FxQuote, type FxVenue} from "../src/venue.js";

const CORRIDOR = corridorOf("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a");
const NOW = 1_785_312_000n;

/** Par, 1e18-scaled. Every fixture below is expressed as a move away from this. */
const LAST_MID = 921_840_000_000_000_000n;

const THRESHOLDS: CorridorThresholds = {
  parBandBps: 100n,
  quoteMaxAgeSeconds: 120n,
  roundtripMaxBps: 100n,
  outageFailures: 3,
};

/** A corridor with nothing wrong with it. Every trip test is one edit away from this. */
function healthyInput(overrides: Partial<CorridorHealthInput> = {}): CorridorHealthInput {
  return {
    corridor: CORRIDOR,
    now: NOW,
    lastAcceptedMidE18: LAST_MID,
    legAB: {rate: "0.92184", at: NOW - 5n},
    // 1 / 0.92184 = 1.084782…; a healthy round trip sits just inside par less the spread.
    legBA: {rate: "1.08470", at: NOW - 5n},
    tradeStatuses: ["pending", "settled"],
    consecutiveFailures: 0,
    guardReverts: 0,
    thresholds: THRESHOLDS,
    ...overrides,
  };
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

const breakerSource = readFileSync(fileURLToPath(new URL("../src/breaker.ts", import.meta.url)), "utf8");

/** A chain double that records every call it received, and answers nothing else. */
function recordingPauser(): {pauser: CorridorPauser; calls: string[]} {
  const calls: string[] = [];
  const pauser: CorridorPauser = {
    pauseCorridor: async (corridor) => {
      calls.push(`pauseCorridor(${corridor})`);
      return `0x${"ab".repeat(32)}` as Hex;
    },
  };
  return {pauser, calls};
}

function receiptsFor(corridor: Hex): ReceiptReader {
  return {
    logsOf: async () => [{topics: [CORRIDOR_PAUSE_TOPIC, corridor]}],
  };
}

/** A venue answering a fixed rate on each direction. Never the real one. */
function quotingVenue(rates: Record<string, string>): FxVenue {
  return {
    name: "TestVenue",
    supports: () => true,
    quote: async (pair: FxPair): Promise<FxQuote> => {
      const rate = rates[`${pair.from}${pair.to}`];
      if (rate === undefined) throw new Error(`no fixture rate for ${pair.from}->${pair.to}`);
      return {
        venue: "TestVenue",
        pair,
        rate,
        quoteId: "qte_test",
        expiresAt: "2026-08-02T11:05:30Z",
        type: "reference",
      };
    },
  };
}

describe("six trip sources, each asserted on its own", () => {
  it("names exactly six reasons, and no more", () => {
    expect(TRIP_REASONS).toHaveLength(6);
    expect([...TRIP_REASONS].sort()).toEqual(
      ["GuardRevert", "Outage", "ParBand", "RoundTrip", "Stale", "VenueDistress"].sort(),
    );
  });

  it("ParBand — the venue's quote leaves the governed band against the last accepted mid", () => {
    // 0.94000 against a 0.92184 mid is ~197 bps out, against a 100 bps band.
    const health = evaluateCorridorHealth(healthyInput({legAB: {rate: "0.94000", at: NOW - 5n}}));
    expect(health.trips).toContain<TripReason>("ParBand");
    expect(health.healthy).toBe(false);
    expect(health.measurements.parDeviationBps).toBeGreaterThan(100n);
  });

  it("Stale — the newest successful quote is older than FX_QUOTE_MAX_AGE", () => {
    const health = evaluateCorridorHealth(
      healthyInput({
        legAB: {rate: "0.92184", at: NOW - 600n},
        legBA: {rate: "1.08470", at: NOW - 600n},
      }),
    );
    expect(health.trips).toContain<TripReason>("Stale");
    // Inside the band and still unhealthy: the two reasons are genuinely separate.
    expect(health.trips).not.toContain<TripReason>("ParBand");
    expect(health.measurements.quoteAgeSeconds).toBe(600n);
  });

  it("RoundTrip — both directions in one poll imply a loss beyond the row", () => {
    // 0.92184 x 1.05000 = 0.96793 — a 320 bps round-trip dislocation.
    const health = evaluateCorridorHealth(healthyInput({legBA: {rate: "1.05000", at: NOW - 5n}}));
    expect(health.trips).toContain<TripReason>("RoundTrip");
    expect(health.measurements.roundTripDeviationBps).toBeGreaterThan(100n);
  });

  it("VenueDistress — a trade reaches breaching or breached", () => {
    expect(evaluateCorridorHealth(healthyInput({tradeStatuses: ["pending", "breaching"]})).trips).toContain<TripReason>(
      "VenueDistress",
    );
    const breached = evaluateCorridorHealth(healthyInput({tradeStatuses: ["breached"]}));
    expect(breached.trips).toContain<TripReason>("VenueDistress");
    expect(breached.measurements.distressed).toEqual(["breached"]);
  });

  it("Outage — N consecutive quote failures", () => {
    expect(evaluateCorridorHealth(healthyInput({consecutiveFailures: 2})).healthy).toBe(true);
    const out = evaluateCorridorHealth(healthyInput({consecutiveFailures: 3}));
    expect(out.trips).toContain<TripReason>("Outage");
  });

  it("GuardRevert — a FillOutsideGuard revert pages and trips, not merely fails one origination", () => {
    const health = evaluateCorridorHealth(healthyInput({guardReverts: 1}));
    expect(health.trips).toContain<TripReason>("GuardRevert");
    expect(health.measurements.guardReverts).toBe(1);
  });
});

describe("the negative control", () => {
  /**
   * Without this, six passing trip tests prove only that the function returns something.
   * It is the same fixture every trip test starts from, which is what makes each of those
   * a one-variable experiment rather than six unrelated scenarios.
   */
  it("a healthy corridor produces no trip", () => {
    const health = evaluateCorridorHealth(healthyInput());
    expect(health.healthy).toBe(true);
    expect(health.trips).toEqual([]);
    expect(health.measurements.parDeviationBps).toBeLessThanOrEqual(100n);
    expect(health.measurements.roundTripDeviationBps).toBeLessThanOrEqual(100n);
  });
});

describe("a trip calls pauseCorridor exactly once and nothing else", () => {
  it("writes one pause, confirms it from the receipt, and touches nothing else", async () => {
    const {pauser, calls} = recordingPauser();
    const outcome = await pauseCorridor(CORRIDOR, pauser, receiptsFor(CORRIDOR));

    expect(calls).toEqual([`pauseCorridor(${CORRIDOR})`]);
    expect(outcome.confirmed).toBe(true);
  });

  it("reports unconfirmed when the receipt carries no event for this corridor", async () => {
    const {pauser} = recordingPauser();
    const otherCorridor = corridorOf("0x3600000000000000000000000000000000000000");
    const outcome = await pauseCorridor(CORRIDOR, pauser, receiptsFor(otherCorridor));
    expect(outcome.confirmed).toBe(false);
  });

  it("a full poll on an unhealthy corridor writes exactly one call", async () => {
    const {pauser, calls} = recordingPauser();
    const result = await runCorridorPoll({
      corridor: CORRIDOR,
      pair: {from: "USD", to: "EUR"},
      notional: "407.00",
      // A 320 bps round trip: the corridor is dislocated on both legs of one poll.
      venue: quotingVenue({USDEUR: "0.92184", EURUSD: "1.05000"}),
      thresholds: THRESHOLDS,
      lastAcceptedMidE18: LAST_MID,
      pauser,
      receipts: receiptsFor(CORRIDOR),
      now: NOW,
    });

    expect(result.health.trips).toContain<TripReason>("RoundTrip");
    expect(calls).toEqual([`pauseCorridor(${CORRIDOR})`]);
    expect(result.snapshot.pausedOnChain).toBe(true);
  });

  it("a healthy poll writes nothing at all", async () => {
    const {pauser, calls} = recordingPauser();
    const result = await runCorridorPoll({
      corridor: CORRIDOR,
      pair: {from: "USD", to: "EUR"},
      notional: "407.00",
      venue: quotingVenue({USDEUR: "0.92184", EURUSD: "1.08470"}),
      thresholds: THRESHOLDS,
      lastAcceptedMidE18: LAST_MID,
      pauser,
      now: NOW,
    });

    expect(result.health.healthy).toBe(true);
    expect(calls).toEqual([]);
    expect(result.pause).toBeUndefined();
  });

  it("a venue that refuses becomes Outage rather than an exception nobody decided on", async () => {
    const {pauser, calls} = recordingPauser();
    const result = await runCorridorPoll({
      corridor: CORRIDOR,
      pair: {from: "USD", to: "EUR"},
      notional: "407.00",
      // The shipped default. It throws on every method and produces no number.
      venue: new StubVenue(),
      thresholds: THRESHOLDS,
      lastAcceptedMidE18: LAST_MID,
      pauser,
      // One failure carried in from the previous window, two more here: three consecutive.
      priorFailures: 1,
      now: NOW,
    });

    expect(result.health.trips).toEqual(["Outage"]);
    expect(result.health.measurements.consecutiveFailures).toBe(3);
    expect(calls).toEqual([`pauseCorridor(${CORRIDOR})`]);
  });

  it("two failed legs in one window are two failures, not an outage on their own", async () => {
    const {pauser, calls} = recordingPauser();
    const result = await runCorridorPoll({
      corridor: CORRIDOR,
      pair: {from: "USD", to: "EUR"},
      notional: "407.00",
      venue: new StubVenue(),
      thresholds: THRESHOLDS,
      lastAcceptedMidE18: LAST_MID,
      pauser,
      now: NOW,
    });

    // A refusing venue is not instantly a depeg. Three consecutive failures is the row.
    expect(result.health.measurements.consecutiveFailures).toBe(2);
    expect(result.health.healthy).toBe(true);
    expect(calls).toEqual([]);
  });

  it("holds no restart path and can reach no plan — asserted over the source", () => {
    const code = stripComments(breakerSource);
    expect(code).not.toMatch(/unpause/i);
    expect(code).not.toMatch(/installmentPlan/i);
    expect(code).not.toMatch(/\.repay\(/);
    expect(code).toContain("pauseCorridor");
    // C1: no feed, no TWAP, no valuation, anywhere in the trigger.
    expect(code).not.toMatch(/latestRoundData|chainlink|priceFeed/i);
  });
});

describe("thresholds come from the registry, not from constants", () => {
  it("the same fixture flips from healthy to tripped when a row moves", () => {
    // 0.94000 is ~197 bps off the last mid. The return leg is its reciprocal, so the
    // round trip stays at par and `parBandBps` is the only variable in the experiment.
    const moved = {
      legAB: {rate: "0.94000", at: NOW - 5n},
      legBA: {rate: "1.06380", at: NOW - 5n},
    } as const;

    const wider = evaluateCorridorHealth(
      healthyInput({...moved, thresholds: {...THRESHOLDS, parBandBps: 400n}}),
    );
    const narrower = evaluateCorridorHealth(
      healthyInput({...moved, thresholds: {...THRESHOLDS, parBandBps: 100n}}),
    );

    expect(wider.healthy).toBe(true);
    expect(narrower.trips).toEqual(["ParBand"]);
  });

  it("reads the three governed rows by the keys plan 07-02 seeded", async () => {
    const asked: Hex[] = [];
    const parameters: FxParameterReader = {
      get: async (key) => {
        asked.push(key);
        return 250n;
      },
    };

    const thresholds = await loadCorridorThresholds(parameters, 3);
    expect(thresholds.parBandBps).toBe(250n);
    expect(thresholds.quoteMaxAgeSeconds).toBe(250n);
    expect(thresholds.roundtripMaxBps).toBe(250n);
    expect([...asked].sort()).toEqual(
      [
        FX_PARAMETER_KEYS.parBandBps,
        FX_PARAMETER_KEYS.quoteMaxAge,
        FX_PARAMETER_KEYS.roundtripMaxBps,
      ].sort(),
    );
    // Not compiled anywhere: every governed bound arrived through the reader.
    expect(stripComments(breakerSource)).not.toMatch(/parBandBps\s*[:=]\s*\d/);
  });
});

describe("the round-trip signal needs no external reference", () => {
  /**
   * C1 as a property of the signature. There is nowhere for a reference price to enter,
   * so the conclusion cannot depend on a belief about what a euro should be worth.
   */
  it("computes from two quotes and no third input", () => {
    expect(roundTripDeviationBps.length).toBe(2);
    expect(roundTripDeviationBps({rate: "1", at: 0n}, {rate: "1", at: 0n})).toBe(0n);
    // A round trip that gains is the same dislocation with the sign flipped.
    expect(roundTripDeviationBps({rate: "1.05", at: 0n}, {rate: "1.05", at: 0n})).toBeGreaterThan(100n);
  });
});

describe("the poll is idempotent, and the composition root says what is armed", () => {
  it("keys a job on corridor and window, so a duplicate run is a no-op", () => {
    expect(corridorPollJobKey(CORRIDOR, "2026-08-02T11:05")).toBe(`${CORRIDOR}:2026-08-02T11:05`);
    expect(corridorPollJobKey(CORRIDOR, "2026-08-02T11:05")).toBe(
      corridorPollJobKey(CORRIDOR, "2026-08-02T11:05"),
    );
  });

  it("enqueues onto graphile-worker, whose ladder had no producer until now", () => {
    expect(breakerSource).toContain("graphile-worker");
    expect(breakerSource).toContain("trades/");
  });

  it("says the breaker is detecting-only when it has nowhere to write", () => {
    const lines: string[] = [];
    const composed = composeFxService(readFxConfig({PLAZO_ENVIRONMENT: "sandbox"}), (l) => lines.push(l));

    expect(composed.canPause).toBe(false);
    expect(composed.corridor).toBe(CORRIDOR);
    expect(lines.join("\n")).toContain("detecting only");
    expect(lines.join("\n")).toContain("StubVenue");
  });

  it("says the breaker is armed once a pause address exists", () => {
    const lines: string[] = [];
    const composed = composeFxService(
      readFxConfig({
        PLAZO_ENVIRONMENT: "sandbox",
        PLAZO_ORIGINATION_PAUSE_ADDRESS: "0x5555555555555555555555555555555555555555",
      }),
      (l) => lines.push(l),
    );

    expect(composed.canPause).toBe(true);
    expect(lines.join("\n")).toContain("armed");
  });
});
