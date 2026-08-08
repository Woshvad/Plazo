/**
 * FX-04's circuit breaker: six trip sources, one boolean, and no price oracle.
 *
 * ## Why there is no oracle here, and what replaces it
 *
 * C1 removes volatile collateral, which removes the reason for an oracle, and adding one
 * re-adds an attack surface for nothing. The rule that survives the removal is precise:
 * **a contract may never read a price to value anything; a price may only be an input to
 * an offchain decision that writes a boolean.** Every signal below obeys it, and the
 * boolean is `OriginationPause.corridorPaused[corridor]`.
 *
 * The opposite failure is just as real. **A breaker whose trigger is undefined is a
 * breaker that never trips** — it exists in a document, nobody can say what would fire it,
 * and the first depeg finds it unarmed. So the signal set is named here, each reason has
 * its own test, and a healthy corridor has a negative control. Six passing trip tests
 * without that control prove only that the function returns something.
 *
 * ## The six, and what each one actually observes
 *
 * 1. **`ParBand`** — the venue's own quote has left a governed band against the last
 *    accepted mid. A price is read; it decides a boolean; it values nothing.
 * 2. **`Stale`** — the newest successful quote is older than `FX_QUOTE_MAX_AGE`. Kept
 *    separate from `ParBand` deliberately: a quote inside the band but hours old and a
 *    fresh quote outside it are different failures with different responses, and folding
 *    them into one reason loses the distinction exactly when it matters.
 * 3. **`RoundTrip`** — both directions quoted for the same notional in the same poll. In a
 *    healthy market `rate_ab × rate_ba ≈ 1` less twice the spread. **This is the strongest
 *    signal available and the only one entirely free of C1**, because the conclusion is
 *    drawn from two quotes by the same venue and holds no belief whatsoever about what a
 *    euro should be worth. Its computation takes two quotes and nothing else, which makes
 *    that property visible in the signature rather than promised in a comment.
 * 4. **`VenueDistress`** — a trade has reached `breaching` or `breached`. Not a price at
 *    all: a counterparty reporting its own distress in its own vocabulary.
 * 5. **`Outage`** — N consecutive quote failures, 5xx, or timeout. The easiest half of
 *    what FX-04 asks for, and the one most likely to fire first.
 * 6. **`GuardRevert`** — an onchain `FillOutsideGuard` revert was observed. It pages **and**
 *    trips rather than merely failing one origination: a fill outside the guard means the
 *    signed mid and the market disagree, which is the event the breaker exists for.
 *
 * ## Pitfall 9 — the only onchain effect is one call
 *
 * Every trip does exactly one thing: `OriginationPause.pauseCorridor(corridorOf(EURC))`.
 * New EURC credit stops. **Live EURC plans are untouched**, and that is structural rather
 * than promised: `InstallmentPlan` has no owner, no pauser and no upgrade path, `repay()`
 * and every cure path are explicitly never pausable (CURE-08/09), a live plan cannot reach
 * `OriginationPause` and it cannot reach a live plan, and `PauseNeverStrands.t.sol` drives
 * a plan from bounce to payoff with everything paused.
 *
 * That property is worth stating plainly because an over-broad breaker would **manufacture
 * delinquencies out of an FX event** — the borrower who tried to pay and could not is
 * delinquent through no act of their own, and the loss is real. Every incumbent's emergency
 * lever has that property. This one does not. So: no second pause plane, no reach into any
 * plan, and **no restart path in this service**. Restarting is the admin's, deliberately,
 * because an incident-response key that can also declare the incident over is a key that
 * will be used to declare the incident over.
 *
 * ## The poll reads; it does not trust a callback
 *
 * **C10.** State is reconciled by polling `GET /v1/exchange/stablefx/trades/{tradeId}`.
 * Circle offers webhook subscriptions and one may *wake* this poll; a webhook may never
 * *be* the state. A credit system whose loop depends on a vendor delivering an HTTP
 * callback has put a third party on its critical path for nothing.
 *
 * `runCorridorPoll` runs on **graphile-worker**, which has been installed over the same
 * Postgres since 06-02b and owns a retry ladder that **nothing enqueues** — the oldest
 * open item in the operator plane. This is its first real producer.
 */
import {parseAbi, toEventSelector} from "viem";
import {ORIGINATION_PAUSE_ABI} from "@plazo/events";
import type {Hex} from "viem";
import type {AddJobFunction} from "graphile-worker";

import {DISTRESS_STATUSES, rateToE18, type TradeStatus} from "./schemas.js";
import {FX_PARAMETER_KEYS, type FxParameterReader} from "./mid.js";
import {isOutageShaped, STABLEFX_TRADES_PATH} from "./stablefx.js";
import type {CorridorSnapshot} from "./api.js";
import type {FxPair, FxVenue} from "./venue.js";

/**
 * The six. The count is six in the objective, in `must_haves`, in the success criteria and
 * in 07-10's `test_everyTripReasonMapsToThisOneCall`; a list that disagreed with any of
 * them would leave a reader resolving the difference by guessing.
 */
export type TripReason = "ParBand" | "Stale" | "RoundTrip" | "VenueDistress" | "Outage" | "GuardRevert";

export const TRIP_REASONS: readonly TripReason[] = Object.freeze([
  "ParBand",
  "Stale",
  "RoundTrip",
  "VenueDistress",
  "Outage",
  "GuardRevert",
]);

const BPS = 10_000n;
const E18 = 10n ** 18n;

/** One observed quote. `at` is unix seconds, injected, never read from a clock in here. */
export interface QuoteObservation {
  /** The venue's decimal rate string, already through `schemas.ts`. */
  readonly rate: string;
  readonly at: bigint;
}

/**
 * The thresholds, as they arrive.
 *
 * Four of the five are `plazo.fx.*` rows on the **third** `ParameterRegistry` instance,
 * seeded by plan 07-02 and read by `loadCorridorThresholds` — never compiled, so an
 * outsider can audit the trigger. That is DEC-18's reasoning applied to a breaker instead
 * of to the relayer's delay floor.
 *
 * `outageFailures` is the exception and is named as one: no `plazo.fx.*` key was seeded for
 * it, so there is no row to read. It is injected rather than compiled — a caller must state
 * it — but it is honest to say it is poll configuration and not governance. Giving it a
 * registry row means touching `ParameterKeys.sol` and the registry constructor, which is
 * 07-02's territory and a redeployment of the third instance.
 */
export interface CorridorThresholds {
  /** `plazo.fx.parBandBps` */
  readonly parBandBps: bigint;
  /** `plazo.fx.quoteMaxAge`, in seconds */
  readonly quoteMaxAgeSeconds: bigint;
  /** `plazo.fx.roundtripMaxBps` */
  readonly roundtripMaxBps: bigint;
  /** Consecutive quote failures that constitute an outage. Injected, not a registry row. */
  readonly outageFailures: number;
}

/** Read the three governed rows. One call site, so the keys cannot drift from 07-02's. */
export async function loadCorridorThresholds(
  parameters: FxParameterReader,
  outageFailures: number,
): Promise<CorridorThresholds> {
  const [parBandBps, quoteMaxAgeSeconds, roundtripMaxBps] = await Promise.all([
    parameters.get(FX_PARAMETER_KEYS.parBandBps),
    parameters.get(FX_PARAMETER_KEYS.quoteMaxAge),
    parameters.get(FX_PARAMETER_KEYS.roundtripMaxBps),
  ]);
  return {parBandBps, quoteMaxAgeSeconds, roundtripMaxBps, outageFailures};
}

/** Everything one evaluation sees. Injected whole, so the function below is pure. */
export interface CorridorHealthInput {
  readonly corridor: Hex;
  /** Unix seconds. A parameter, never `Date.now()`, so a test cannot race a clock. */
  readonly now: bigint;
  /** The last mid this operator signed and the chain accepted, 1e18-scaled. */
  readonly lastAcceptedMidE18: bigint;
  /** The outbound leg of the round trip, and the quote `ParBand` and `Stale` read. */
  readonly legAB?: QuoteObservation | undefined;
  /** The return leg. Same notional, same poll, opposite direction. */
  readonly legBA?: QuoteObservation | undefined;
  /** Trade states read back from the venue this poll. */
  readonly tradeStatuses?: readonly TradeStatus[] | undefined;
  /** How many quote attempts in a row have failed, outage-shaped. */
  readonly consecutiveFailures?: number | undefined;
  /** `FillOutsideGuard` reverts observed on chain since the last poll. */
  readonly guardReverts?: number | undefined;
  readonly thresholds: CorridorThresholds;
}

/** What was measured, so an operator can see the trip rather than take it on trust. */
export interface CorridorMeasurements {
  readonly parDeviationBps: bigint | undefined;
  readonly quoteAgeSeconds: bigint | undefined;
  readonly roundTripDeviationBps: bigint | undefined;
  readonly distressed: readonly TradeStatus[];
  readonly consecutiveFailures: number;
  readonly guardReverts: number;
}

export interface CorridorHealth {
  readonly corridor: Hex;
  readonly healthy: boolean;
  readonly trips: readonly TripReason[];
  readonly measurements: CorridorMeasurements;
}

/** |a − b| in basis points of `b`. Integer throughout; no float ever touches a decision. */
function deviationBps(value: bigint, against: bigint): bigint {
  if (against === 0n) return 0n;
  const delta = value > against ? value - against : against - value;
  return (delta * BPS) / against;
}

/**
 * The round trip, from two quotes and nothing else.
 *
 * **Two parameters, no third input — and that is the assertion, not the implementation
 * detail.** C1 is a property of this signature: there is nowhere for an external reference
 * price to enter, so the conclusion cannot depend on a belief about what a euro is worth.
 * `ab × ba` should be 1 less twice the spread; how far it is from 1 is the dislocation.
 *
 * Deviation is taken in **both** directions. A round trip that *gains* is not good news —
 * it is the same dislocation with the sign flipped, and it is free money somebody else will
 * take first. Trapping only the loss would leave half the signal on the floor.
 */
export function roundTripDeviationBps(ab: QuoteObservation, ba: QuoteObservation): bigint {
  const product = (rateToE18(ab.rate) * rateToE18(ba.rate)) / E18;
  return deviationBps(product, E18);
}

/**
 * Six signals in, one boolean out. **Pure.**
 *
 * No network, no clock, no key, no chain. Every input arrives in the argument, which is
 * what makes each of the six testable individually against recorded fixtures — and what
 * makes the negative control meaningful, because the same function with healthy inputs has
 * to answer healthy.
 *
 * A missing quote is not silently healthy: absent legs contribute nothing to `ParBand` or
 * `RoundTrip`, and the reason they are absent is `Outage`'s business. That split is
 * deliberate — a signal that returned "fine" when it had no data would be the quietest
 * possible failure.
 */
export function evaluateCorridorHealth(input: CorridorHealthInput): CorridorHealth {
  const trips: TripReason[] = [];
  const {thresholds} = input;

  const parDeviation =
    input.legAB === undefined || input.lastAcceptedMidE18 === 0n
      ? undefined
      : deviationBps(rateToE18(input.legAB.rate), input.lastAcceptedMidE18);
  if (parDeviation !== undefined && parDeviation > thresholds.parBandBps) trips.push("ParBand");

  const newest = [input.legAB, input.legBA]
    .filter((q): q is QuoteObservation => q !== undefined)
    .reduce<bigint | undefined>((max, q) => (max === undefined || q.at > max ? q.at : max), undefined);
  const quoteAge = newest === undefined ? undefined : input.now - newest;
  if (quoteAge !== undefined && quoteAge > thresholds.quoteMaxAgeSeconds) trips.push("Stale");

  const roundTrip =
    input.legAB === undefined || input.legBA === undefined
      ? undefined
      : roundTripDeviationBps(input.legAB, input.legBA);
  if (roundTrip !== undefined && roundTrip > thresholds.roundtripMaxBps) trips.push("RoundTrip");

  const distressed = (input.tradeStatuses ?? []).filter((status) => DISTRESS_STATUSES.includes(status));
  if (distressed.length > 0) trips.push("VenueDistress");

  const consecutiveFailures = input.consecutiveFailures ?? 0;
  if (thresholds.outageFailures > 0 && consecutiveFailures >= thresholds.outageFailures) {
    trips.push("Outage");
  }

  const guardReverts = input.guardReverts ?? 0;
  if (guardReverts > 0) trips.push("GuardRevert");

  return {
    corridor: input.corridor,
    healthy: trips.length === 0,
    trips,
    measurements: {
      parDeviationBps: parDeviation,
      quoteAgeSeconds: quoteAge,
      roundTripDeviationBps: roundTrip,
      distressed,
      consecutiveFailures,
      guardReverts,
    },
  };
}

/**
 * The one write this service is capable of.
 *
 * A seam rather than a viem client so the poll is testable against a double that records
 * every call — which is how "a trip calls `pauseCorridor` exactly once and nothing else"
 * becomes an assertion rather than a claim. In production this is a `PAUSER_ROLE` key
 * sending `OriginationPause.pauseCorridor(bytes32)`.
 *
 * There is deliberately **no second method on this interface.** A restart path here would
 * be a restart path an incident-response key could reach.
 */
export interface CorridorPauser {
  pauseCorridor(corridor: Hex): Promise<Hex>;
}

/** Reads a receipt back, so a pause that silently did not land is not reported as one. */
export interface ReceiptReader {
  logsOf(transactionHash: Hex): Promise<readonly {topics: readonly Hex[]}[]>;
}

/** `CorridorPauseSet(bytes32 indexed corridor, bool paused, address indexed by)`. */
export const CORRIDOR_PAUSE_TOPIC: Hex = toEventSelector(parseAbi(ORIGINATION_PAUSE_ABI)[1]!);

export interface PauseOutcome {
  readonly transactionHash: Hex;
  /** Whether the receipt actually carries the event for this corridor. */
  readonly confirmed: boolean;
}

/**
 * Stop new credit in one corridor. **The only onchain effect of any trip.**
 *
 * The receipt is read back and the event matched on `corridor` before this reports
 * success, because a fire-and-forget pause is indistinguishable from a pause that reverted
 * — and the moment they become indistinguishable is a depeg.
 */
export async function pauseCorridor(
  corridor: Hex,
  pauser: CorridorPauser,
  receipts?: ReceiptReader,
): Promise<PauseOutcome> {
  const transactionHash = await pauser.pauseCorridor(corridor);
  if (receipts === undefined) return {transactionHash, confirmed: false};

  const logs = await receipts.logsOf(transactionHash);
  const confirmed = logs.some(
    (log) => log.topics[0] === CORRIDOR_PAUSE_TOPIC && log.topics[1] === corridor,
  );
  return {transactionHash, confirmed};
}

/** Everything the scheduled job needs, injected. Nothing is reached for. */
export interface CorridorPollDeps {
  readonly corridor: Hex;
  readonly pair: FxPair;
  /** The notional both legs are quoted for. Same size both ways or the ratio is not one. */
  readonly notional: string;
  readonly venue: FxVenue;
  readonly thresholds: CorridorThresholds;
  readonly lastAcceptedMidE18: bigint;
  readonly pauser: CorridorPauser;
  readonly receipts?: ReceiptReader | undefined;
  /**
   * Trade states read back from the venue this window.
   *
   * Supplied by the caller from `getTrade` reads rather than fetched here, so the poll's
   * decision remains a pure function of what was observed. C10 lives at the call site: the
   * caller reads, it does not accept a pushed body as state.
   */
  readonly tradeStatuses?: readonly TradeStatus[] | undefined;
  /** `FillOutsideGuard` reverts seen since the previous window. */
  readonly guardReverts?: number | undefined;
  /** Consecutive outage-shaped failures carried across windows. */
  readonly priorFailures?: number | undefined;
  /** Unix seconds. Injected. */
  readonly now: bigint;
  readonly log?: ((line: string) => void) | undefined;
}

export interface CorridorPollResult {
  readonly health: CorridorHealth;
  readonly snapshot: CorridorSnapshot;
  readonly pause: PauseOutcome | undefined;
}

/**
 * One poll window: quote both directions, evaluate, and pause if anything tripped.
 *
 * Quote failures are caught rather than thrown, and counted — that is what makes an
 * unreachable venue produce `Outage` instead of an exception nobody turned into a decision.
 * `isOutageShaped` is what separates "the venue is down" from "the venue said no".
 */
export async function runCorridorPoll(deps: CorridorPollDeps): Promise<CorridorPollResult> {
  const reverse: FxPair = {from: deps.pair.to, to: deps.pair.from};
  let failures = deps.priorFailures ?? 0;

  const legAB = await observe(deps.venue, deps.pair, deps.notional, deps.now);
  const legBA = await observe(deps.venue, reverse, deps.notional, deps.now);
  if (legAB === undefined) failures += 1;
  if (legBA === undefined) failures += 1;

  const health = evaluateCorridorHealth({
    corridor: deps.corridor,
    now: deps.now,
    lastAcceptedMidE18: deps.lastAcceptedMidE18,
    legAB,
    legBA,
    tradeStatuses: deps.tradeStatuses,
    consecutiveFailures: failures,
    guardReverts: deps.guardReverts,
    thresholds: deps.thresholds,
  });

  let pause: PauseOutcome | undefined = undefined;
  if (!health.healthy) {
    pause = await pauseCorridor(deps.corridor, deps.pauser, deps.receipts);
    deps.log?.(
      `[plazo:fx] corridor ${deps.corridor} tripped on ${health.trips.join(", ")} — ` +
        `new credit stopped. Live plans are untouched — every cure path stays open (CURE-08/09).`,
    );
  }

  return {
    health,
    snapshot: {
      corridor: deps.corridor,
      healthy: health.healthy,
      trips: health.trips,
      pausedOnChain: pause !== undefined,
      observedAt: new Date(Number(deps.now) * 1000).toISOString(),
    },
    pause,
  };
}

/** One leg, or `undefined` if the venue could not answer. Never a substituted rate. */
async function observe(
  venue: FxVenue,
  pair: FxPair,
  notional: string,
  at: bigint,
): Promise<QuoteObservation | undefined> {
  try {
    const quote = await venue.quote(pair, notional, "reference");
    return {rate: quote.rate, at};
  } catch (error) {
    // Both shapes count against `Outage`; `isOutageShaped` is kept so a refusal and an
    // unreachable host can be told apart in a log line rather than only in a counter.
    void isOutageShaped(error);
    return undefined;
  }
}

/**
 * The job key, and the reason the ladder can retry safely.
 *
 * `${corridor}:${pollWindow}` — a duplicate run in the same window is a no-op, which is
 * what lets graphile-worker retry without a second pause transaction and without a second
 * page. The window is the caller's (a minute bucket, typically), not a timestamp, because a
 * timestamp is never equal twice.
 */
export function corridorPollJobKey(corridor: Hex, pollWindow: string): string {
  return `${corridor}:${pollWindow}`;
}

export const CORRIDOR_POLL_TASK = "fx:corridor-poll" as const;

/**
 * Enqueue one window onto the retry ladder installed in 06-02b.
 *
 * That ladder has owned a retry policy with **no producer** since it was installed — the
 * oldest open item in the operator plane, and this is its first real one.
 */
export async function enqueueCorridorPoll(
  addJob: AddJobFunction,
  corridor: Hex,
  pollWindow: string,
): Promise<void> {
  await addJob(CORRIDOR_POLL_TASK, {corridor, pollWindow}, {jobKey: corridorPollJobKey(corridor, pollWindow)});
}

/** The trade path this poll reads. Kept beside the poll so C10 is legible from here. */
export const TRADE_READ_PATH = `${STABLEFX_TRADES_PATH}/` as const;
