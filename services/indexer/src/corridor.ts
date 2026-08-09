/**
 * The decisions behind the corridor and credit-ladder streams, in a module a test can
 * import.
 *
 * `fx.ts` and `underwriting.ts` import `ponder:registry` and cannot be loaded outside the
 * Ponder runtime. Everything here is a pure function over event arguments, so the parts
 * worth cornering — which collection was a payroll sweep, how close a fill came to its
 * floor, what a pledge log row is called — are assertable directly rather than inferable
 * from a database after a run.
 */

/**
 * The three kinds of pledge log row.
 *
 * A `text` column and not a database-level enum (DEC-57): such a type has to be altered
 * before a value can be added, and that alter is the statement that breaks a cross-service
 * push. The constraint lives here instead, where a bad value is a compile error.
 */
export const PLEDGE_KINDS = ["pledged", "released", "yieldPaid"] as const;
export type PledgeKind = (typeof PLEDGE_KINDS)[number];

/** The zero address, which no configured contract ever is. */
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Was this collection a payroll deduction?
 *
 * **This is the whole of the sweep stream, and it exists because the sweeper's own events
 * are not in the schema.** `PayrollSweeper.Swept`, `.SweepOptedIn` and `.SweepOptedOut`
 * each carry the plan's counterparty as an indexed address beside a `planId`, so
 * `@plazo/events` v5 declines to list them: indexing that stream would build a permanent,
 * enumerable wallet → plans map, which is the exposure the whole schema is keyed by
 * `planId` to avoid.
 *
 * Nothing is lost by it. A sweep settles its installment through `InstallmentPlan.repay`,
 * so the plan emits `CheckCleared(planId, index, amount, keeper)` with the sweeper's
 * contract address in `keeper` — a contract, never a wallet. "This was payroll" is this
 * comparison.
 *
 * An unconfigured sweeper is the zero address, and no `keeper` is ever the zero address,
 * so the stream is empty rather than claiming every collection was payroll. The check is
 * explicit rather than relying on the equality: a `keeper` that somehow *were* zero would
 * otherwise match a sweeper nobody deployed.
 */
export const isPayrollSweep = (keeper: `0x${string}`, sweeper: `0x${string}`): boolean => {
  if (sweeper.toLowerCase() === ZERO) return false;
  return keeper.toLowerCase() === sweeper.toLowerCase();
};

/**
 * How much room a fill had above the guard's floor.
 *
 * FX-04's margin. Stored on the row rather than computed at read time because the mid it
 * was derived from has been consumed — `FxDeviationGuard` marks the session id used
 * before the external call and never clears it, so the threshold cannot be re-quoted and
 * an observer checking the band afterwards cannot rebuild it from anything but the log.
 *
 * A fill that reverted never emits, so this is never negative in practice; it is clamped
 * anyway rather than trusted, because a stored negative would sort to the top of "closest
 * to the floor" and read as the guard having failed.
 */
export const fxHeadroom = (amountOut: bigint, floor: bigint): bigint =>
  amountOut > floor ? amountOut - floor : 0n;

/**
 * A log's unique coordinates, as a writer-chosen id (DEC-58).
 *
 * `${txHash}:${logIndex}` rather than `${block}-${logIndex}`: both are unique, and the
 * transaction hash is the one a reader can paste into an explorer. A replay writes the
 * same id and the upsert is a no-op, which is what makes every handler in this plane
 * idempotent without a read-modify-write.
 */
export const logId = (txHash: `0x${string}`, logIndex: number): string =>
  `${txHash}:${logIndex}`;

/** A `pauseEvent` row, narrowed to what a window needs. */
export interface PauseReading {
  corridor: `0x${string}`;
  paused: boolean;
  timestamp: number;
}

/** A closed or still-open interval during which one corridor was shut. */
export interface PauseWindow {
  corridor: `0x${string}`;
  from: number;
  /** `null` while the corridor is still paused. */
  to: number | null;
}

/**
 * FX-04's breaker, as intervals rather than as edges.
 *
 * This is the join between plan 07-08's `services/fx` and the chain. That service decides
 * to trip a breaker and records its reason; `OriginationPause.CorridorPauseSet` records
 * that the corridor was shut. Neither half is evidence alone — a trip reason with no pause
 * is a decision nobody executed, and a pause with no reason is an outage nobody can
 * explain — and a reason carries a timestamp, not an edge, so it can only be matched
 * against an interval.
 *
 * Two properties the shape has to get right, both of which an edge list gets wrong:
 *
 * - **A repeated `paused: true` does not open a second window.** The setter is not
 *   idempotence-guarded on chain, and two trips of the same breaker are one outage.
 * - **A corridor still paused at the end of the stream yields `to: null`.** Dropping the
 *   unterminated window would make an ongoing outage — the case an operator most needs to
 *   see — the one case that does not appear.
 *
 * Readings are expected newest-last, as an indexer returns them ordered by timestamp.
 */
export const corridorPauseWindows = (readings: PauseReading[]): PauseWindow[] => {
  const open = new Map<string, PauseWindow>();
  const windows: PauseWindow[] = [];

  for (const reading of readings) {
    const key = reading.corridor.toLowerCase();
    const current = open.get(key);

    if (reading.paused) {
      if (current) continue; // already shut; two trips are one outage
      const window: PauseWindow = {corridor: reading.corridor, from: reading.timestamp, to: null};
      open.set(key, window);
      windows.push(window);
      continue;
    }

    if (current) {
      current.to = reading.timestamp;
      open.delete(key);
    }
    // An unpause with no open window is a corridor being opened that was never shut —
    // the state at genesis, or a range that began mid-outage. Not a window.
  }

  return windows;
};
