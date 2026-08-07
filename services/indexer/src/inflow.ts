/**
 * The EIP-7708 native-transfer stream, indexed continuously — UW-04's evidence.
 *
 * ## The one rule this file exists to hold
 *
 * **Only the system emitter's stream is indexed into `inflow`. The USDC contract's own
 * `Transfer` is never indexed into this table, under any circumstance.** E-08: Arc
 * emits both for a single movement, the system emitter's `value` at 18 decimals and
 * the token contract's at 6, and writing both would count one payment twice — inflating
 * every Tier-1 limit by exactly 2×, or by 10^12 if the scales are also confused. The
 * source registered in `ponder.config.ts` is the emitter and only the emitter, and an
 * acceptance gate asserts the token's address does not appear in this file's code.
 *
 * The narrowing to 6 decimals happens **once**, here, at write time, through the single
 * conversion `@plazo/plan-core` exposes for it. Both figures are stored: a consumer that
 * re-narrows is a second place the 10^12 can be made, and a consumer that only ever sees
 * the narrowed figure cannot audit the narrowing that produced it.
 *
 * ## Why the handler writes for an allowlist rather than for everything
 *
 * Arc carries roughly seven native movements per block. Indexing all of them would be
 * an income file over every address on the network, kept by an operator that has no
 * business holding one, and it would cost a sweep nobody can afford (see the backfill
 * note in `ponder.config.ts`). So the handler writes only for wallets the operator was
 * explicitly told to track, through `PLAZO_INFLOW_TRACKED`.
 *
 * **Unset means nothing is indexed, and that is fail-closed on purpose.** Tier 1 then
 * proposes zero, which is the same posture `services/origination/src/tier1.ts` takes
 * when its seam is unconfigured: an unconfigured credit input proposes nothing rather
 * than a plausible number.
 *
 * ## Outflows are not income
 *
 * Arc does not burn the base fee — it credits the block beneficiary. A naive "all logs
 * touching this address" query therefore picks up fee credits as income on the
 * beneficiary's own address. This handler skips any log whose recipient is the block's
 * beneficiary. Measured over blocks 55841988-55842188 on 2026-08-07, no log in the
 * window credited a sampled beneficiary, so on this deployment the fee credit does not
 * appear to travel through the system emitter — the exclusion is kept as defence in
 * depth rather than removed on the strength of one window.
 */
import {ponder} from "ponder:registry";
import {inflow} from "ponder:schema";

import {native18, toMinor6} from "@plazo/plan-core";

/**
 * The wallets this operator is permitted to build an inflow history for.
 *
 * Comma-separated, case-insensitive. An address here is a borrower who reached the
 * point of asking for a Tier-1 limit; it is not a list to grow speculatively, because
 * every entry is a standing instruction to record somebody's receipts.
 *
 * It is an env var rather than a constant in `ponder.config.ts` because it is
 * operational state that changes per borrower, not a deployment address — DEC-55's rule
 * is about addresses the *protocol* is deployed at, and those still all live there.
 */
const TRACKED: ReadonlySet<string> = new Set(
  (process.env["PLAZO_INFLOW_TRACKED"] ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0),
);

if (TRACKED.size === 0) {
  console.warn(
    "PLAZO_INFLOW_TRACKED is unset — no inflow history will be recorded for anyone.\n" +
      "Tier 1 will propose zero for every borrower, which is the intended failure\n" +
      "direction but is indistinguishable at quote time from a borrower with no income.",
  );
}

ponder.on("NativeTransferEmitter:Transfer", async ({event, context}) => {
  const recipient = event.args.to;
  if (!TRACKED.has(recipient.toLowerCase())) return;

  // Arc credits the base fee to the block beneficiary rather than burning it, so a
  // recipient that is this block's beneficiary is being paid for producing the block.
  // That is not income and must not be scored as any.
  const beneficiary = event.block.miner;
  if (beneficiary && recipient.toLowerCase() === beneficiary.toLowerCase()) return;

  // 18 decimals in, narrowed once, both figures stored. `native18` is a distinct brand
  // from `Wei18` precisely so that this value cannot be handed to a balance conversion,
  // and `toMinor6` is the only path out of it.
  const valueNative = native18(event.args.value);

  await context.db
    .insert(inflow)
    .values({
      // Writer-chosen, so a replay is a no-op and nothing waits on a server-assigned
      // value it cannot know before the insert (DEC-58).
      id: `${event.transaction.hash}:${event.log.logIndex}`,
      recipient,
      counterparty: event.args.from,
      valueNative: valueNative as bigint,
      valueMinor: toMinor6(valueNative) as bigint,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
});
