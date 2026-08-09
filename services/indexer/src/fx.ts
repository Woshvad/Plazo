/**
 * The corridor, indexed.
 *
 * Three streams that together answer the one question FX-04 asks off chain: did a
 * cross-currency origination get a fair rate, and if the corridor stopped, when and why.
 *
 * - **`FillGuarded`** — every fill that cleared the deviation guard, with the floor it had
 *   to clear. The floor is stored because the signed mid it came from was consumed in the
 *   same call and cannot be quoted again; a guard whose threshold is unauditable after the
 *   fact is one nobody can hold to account.
 * - **`PayoutCurrencySet` / `CurrencyAllowed`** — what a merchant asked to be settled in,
 *   and whether that currency is still permitted. Two tables rather than one because
 *   DEC-112 keeps them apart on chain: `payoutCurrencyOf` re-reads the allowlist on every
 *   call, so a merchant's election survives a withdrawal that stops it taking effect, and
 *   a surface has to be able to show both to explain why the money went out in dollars.
 * - **`CorridorSet`** — which FX router, parameter registry and underwriter priced a
 *   corridor. Listed where `SettlementEscrow.RouterSet` is not: there is one per corridor,
 *   it is re-pointable, and the deployment record holds a single router key.
 *
 * ## The corridor pause stream is already indexed, and is not duplicated here
 *
 * `OriginationPause.CorridorPauseSet` is FX-04's breaker made observable, and it is
 * handled in `origination.ts` beside `GlobalPauseSet`, writing to `pauseEvent` — see
 * `origination.ts` where both pause handlers sit together. **Registering a second handler
 * for it here would be an error, not a redundancy**: Ponder allows one handler per event
 * name, so the process would refuse to start, and if it did not the row would be written
 * twice.
 *
 * What this file adds instead is the join. Plan 07-08's `services/fx` decides to trip a
 * breaker and records a reason; the chain records that a corridor was paused. Neither
 * half is evidence on its own — a trip reason with no pause is a decision nobody
 * executed, and a pause with no reason is an outage nobody can explain — so
 * `corridorPauseWindows` in `./corridor.ts` turns the chain's edges into the intervals
 * the operator's half joins against. It lives there rather than here for the reason
 * `settlement.ts` exists: a pure function in a module free of `ponder:registry` is one a
 * test can import.
 */
import {ponder} from "ponder:registry";

import {corridorWiring, currencyAllowance, fxFill, merchantCurrency} from "ponder:schema";

import {fxHeadroom, logId} from "./corridor.js";

// ─────────────────────────────────────────────────────────────────────────────
// The deviation guard (FX-04)
// ─────────────────────────────────────────────────────────────────────────────

ponder.on("FxDeviationGuard:FillGuarded", async ({event, context}) => {
  await context.db
    .insert(fxFill)
    .values({
      id: logId(event.transaction.hash, event.log.logIndex),
      corridor: event.args.corridor,
      venue: event.args.venue,
      amountIn: event.args.amountIn,
      amountOut: event.args.amountOut,
      floor: event.args.floor,
      headroom: fxHeadroom(event.args.amountOut, event.args.floor),
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
      timestamp: Number(event.block.timestamp),
    })
    // Writer-chosen id, so a replay writes the same row rather than a second one.
    .onConflictDoNothing();
});

// ─────────────────────────────────────────────────────────────────────────────
// Payout currency (DEC-112)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The election, not the effect.
 *
 * `payoutCurrencyOf` re-reads the allowlist on every call, so this row says what the
 * merchant asked for and never what they will be paid in. A surface joins it against
 * `currencyAllowance` to answer "why did my settlements go back to dollars", which is the
 * question DEC-112 creates and which neither table can answer alone.
 */
ponder.on("MerchantCurrencyRegistry:PayoutCurrencySet", async ({event, context}) => {
  const updatedAt = Number(event.block.timestamp);
  await context.db
    .insert(merchantCurrency)
    .values({
      id: event.args.merchant.toLowerCase() as `0x${string}`,
      currency: event.args.currency,
      blockNumber: event.block.number,
      updatedAt,
    })
    .onConflictDoUpdate(() => ({
      currency: event.args.currency,
      blockNumber: event.block.number,
      updatedAt,
    }));
});

/**
 * `DomainDenied` in the currency plane.
 *
 * A current-value getter can say a currency is not allowed. It cannot say when it stopped
 * being allowed or who did it, and those are the two facts a merchant whose settlements
 * silently reverted needs — the same reason `PayoutRouter.DomainDenied` is a log rather
 * than a read.
 */
ponder.on("MerchantCurrencyRegistry:CurrencyAllowed", async ({event, context}) => {
  const updatedAt = Number(event.block.timestamp);
  await context.db
    .insert(currencyAllowance)
    .values({
      id: event.args.currency.toLowerCase() as `0x${string}`,
      allowed: event.args.allowed,
      by: event.args.by,
      blockNumber: event.block.number,
      updatedAt,
    })
    .onConflictDoUpdate(() => ({
      allowed: event.args.allowed,
      by: event.args.by,
      blockNumber: event.block.number,
      updatedAt,
    }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Corridor wiring
// ─────────────────────────────────────────────────────────────────────────────

ponder.on("CheckoutRouter:CorridorSet", async ({event, context}) => {
  const updatedAt = Number(event.block.timestamp);
  await context.db
    .insert(corridorWiring)
    .values({
      id: event.args.token.toLowerCase() as `0x${string}`,
      fxRouter: event.args.fxRouter,
      parameters: event.args.parameters,
      underwriter: event.args.underwriter,
      setBy: event.args.by,
      blockNumber: event.block.number,
      updatedAt,
    })
    .onConflictDoUpdate(() => ({
      fxRouter: event.args.fxRouter,
      parameters: event.args.parameters,
      underwriter: event.args.underwriter,
      setBy: event.args.by,
      blockNumber: event.block.number,
      updatedAt,
    }));
});
