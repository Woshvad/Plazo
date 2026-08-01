/**
 * The servicing plane: reminders, balances, top-ups, the relayer and the console.
 *
 * NOTIF-01 through NOTIF-05, OPS-04, OPS-07, XCH-03, XCH-04 and the service half of
 * COLL-07. Proprietary — this is the operator's, not the protocol's.
 *
 * The organising constraint is the same one the origination services were built under
 * and it is worth restating, because this is the layer most likely to violate it: none
 * of this may become load-bearing for a borrower who already holds a signed strip. A
 * plan collects because a keeper is paid to crank it, cures because `repay()` is never
 * pausable, and terminates because the mark is bountied. Everything in this package is
 * a courtesy on top of that — a warning before a bounce, a receipt after a payment, a
 * support agent who can waive a fee. GOV-08's requirement that the whole loop runs with
 * every operator role at the zero address is what that means in practice, and it is why
 * the fee waiver settles by paying the plan rather than by reaching into it.
 */
export * from "./balance.js";
export * from "./ladder.js";
export * from "./relayer.js";
export * from "./console.js";
export * from "./api.js";
