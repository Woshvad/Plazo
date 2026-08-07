/**
 * Money units.
 *
 * Arc USDC carries one balance at two decimal scales: 18 natively (it is the gas
 * token) and 6 over ERC-20. EIP-3009 `value` is the 6-decimal figure. A bare
 * `bigint` crossing that boundary is a 10^12 error waiting to happen, and it would
 * not be caught by a type checker, a test with round numbers, or a code review.
 *
 * So the boundary is typed. `Usdc6` and `Wei18` are branded and cannot be assigned
 * to each other or to a plain `bigint` without going through a named conversion.
 *
 * ## Phase 7 adds a third decimal regime, and it is the expensive one
 *
 * EURC is 6 decimals. Arc's native USDC balance is 18. And the EIP-7708 system log
 * that Arc emits for **every** native movement carries an 18-decimal `value`, while
 * the ERC-20 contract's own `Transfer` for that same movement carries 6 — the same
 * balance change appearing twice, from two emitters, at two scales.
 *
 * Summing the two inflates an income figure by 10^12 if the scales are never
 * reconciled, and by exactly 2× if they are reconciled but the duplication is not.
 * Neither number looks wrong. E-08.
 *
 * So the brand carries the **currency** as well as the scale. A scale alone would
 * let a EURC figure be added to a USDC one, and `Native18` is deliberately a
 * different type from `Wei18` even though both are 18-decimal: `Wei18` is a
 * *balance* in Arc's native representation, `Native18` is a *log's `value` field*.
 * Giving those one type is precisely how the 2× duplication survives a typecheck.
 */

declare const brand: unique symbol;

type Branded<T, B> = T & {readonly [brand]: B};

/** USDC at ERC-20 scale — 6 decimals. Everything EIP-3009 signs. */
export type Usdc6 = Branded<bigint, "Usdc6">;

/** USDC at native scale — 18 decimals. Gas accounting, native transfers. */
export type Wei18 = Branded<bigint, "Wei18">;

/**
 * EURC at ERC-20 scale — 6 decimals, verified live (`decimals() == 6`, `version() == "2"`).
 *
 * Same scale as `Usdc6` and deliberately not the same type. The corridor's whole
 * hazard is that one EURC and one USDC are both `1_000_000n`, so a scale-only brand
 * would let a euro be added to a dollar with the compiler agreeing. DEC-21 put one
 * balance sheet in one contract; this is the same separation expressed in the types.
 */
export type Eurc6 = Branded<bigint, "Eurc6">;

/**
 * The `value` field of an EIP-7708 native-transfer log — 18 decimals.
 *
 * **Not `Wei18`, on purpose.** `Wei18` is what `getBalance` returns; `Native18` is
 * what the system emitter at Arc's native-transfer precompile puts in a log's data
 * field. They happen to share a scale and they are not interchangeable, because the
 * only safe operation on a log value is `toMinor6` and the only safe operation on a
 * balance is `toUsdc6`, which refuses a remainder. Merging them would restore
 * exactly the assignment E-08 exists to forbid.
 */
export type Native18 = Branded<bigint, "Native18">;

const SCALE = 1_000_000_000_000n; // 10^12

export function usdc6(value: bigint | number | string): Usdc6 {
  const v = BigInt(value);
  if (v < 0n) throw new RangeError(`Usdc6 cannot be negative: ${v}`);
  return v as Usdc6;
}

export function wei18(value: bigint | number | string): Wei18 {
  const v = BigInt(value);
  if (v < 0n) throw new RangeError(`Wei18 cannot be negative: ${v}`);
  return v as Wei18;
}

/** EURC at ERC-20 scale. Mirrors `usdc6` exactly; the brand is the whole difference. */
export function eurc6(value: bigint | number | string): Eurc6 {
  const v = BigInt(value);
  if (v < 0n) throw new RangeError(`Eurc6 cannot be negative: ${v}`);
  return v as Eurc6;
}

/** An EIP-7708 log value, at the 18 decimals the system emitter writes. */
export function native18(value: bigint | number | string): Native18 {
  const v = BigInt(value);
  if (v < 0n) throw new RangeError(`Native18 cannot be negative: ${v}`);
  return v as Native18;
}

/** Widen to native scale. Always exact. */
export function toWei18(value: Usdc6): Wei18 {
  return (value * SCALE) as Wei18;
}

/**
 * Narrow to ERC-20 scale.
 *
 * Throws on a remainder rather than truncating. A silent truncation here is
 * value quietly disappearing from a settlement, and the amount lost is too small
 * to notice in a single plan and too large to ignore across a book.
 */
export function toUsdc6(value: Wei18): Usdc6 {
  if (value % SCALE !== 0n) {
    throw new RangeError(
      `${value} wei is not representable at 6 decimals; ` +
        `it carries a remainder of ${value % SCALE}. Round explicitly before narrowing.`,
    );
  }
  return (value / SCALE) as Usdc6;
}

/** Round down to ERC-20 scale, returning the dust that was dropped. */
export function narrowWithDust(value: Wei18): {amount: Usdc6; dust: Wei18} {
  return {
    amount: (value / SCALE) as Usdc6,
    dust: (value % SCALE) as Wei18,
  };
}

/**
 * Narrow an EIP-7708 log value to the 6-decimal figure the credit system counts in.
 *
 * **The only narrowing path from a system log, and it is deliberately the only one.**
 * Every consumer of the native-transfer stream — the indexer's write path, the Tier-1
 * scorer, the live decimal-correctness check — reaches 6 decimals through this
 * function or not at all, so there is exactly one place the 10^12 can be got wrong
 * and exactly one place to look when a limit reads strangely.
 *
 * It **truncates**, and does not throw on a remainder the way `toUsdc6` does. That
 * asymmetry is the point rather than an oversight:
 *
 *  - `toUsdc6` narrows a *settlement balance*, where a dropped remainder is value
 *    quietly disappearing from somebody's money. Refusing is correct there.
 *  - `toMinor6` narrows an *observation of somebody else's transfer*, whose value is
 *    whatever it was. A 1-wei-odd inbound payment is an ordinary event on a chain
 *    whose gas token is 18-decimal, and throwing would turn a borrower's income
 *    history into an exception. The floor is the conservative direction: it can only
 *    ever understate income, and understating income can only ever lower a limit.
 *
 * Nothing here reconciles the two streams, because nothing may. The system emitter's
 * log and the ERC-20 contract's log describe **one** balance change; narrowing the
 * first does not make it addable to the second.
 */
export function toMinor6(value: Native18): Usdc6 {
  return (value / SCALE) as Usdc6;
}

/** The currencies this protocol denominates anything in. Not a scale — a unit of account. */
export type Currency = "USDC" | "EURC";

/**
 * A figure that still knows what it is at runtime.
 *
 * The brands above are erased by the compiler: at runtime a `Usdc6` and an `Eurc6`
 * are both `bigint` and nothing can tell them apart. That is fine wherever the value
 * never leaves TypeScript's sight, and useless at the boundaries where it does — a
 * JSON body, a database column, an ABI-decoded log. `assertSameCurrency` is for those,
 * and it needs a tag that survives serialisation, so the tag is carried in the value.
 */
export interface Money {
  readonly currency: Currency;
  readonly value: bigint;
}

/** Tag a 6-decimal figure with the currency it is denominated in. */
export function money(currency: Currency, value: bigint): Money {
  if (value < 0n) throw new RangeError(`${currency} cannot be negative: ${value}`);
  return {currency, value};
}

/**
 * Refuse to let two currencies meet.
 *
 * One EURC and one USDC are both `1_000_000n`, so an addition that crosses them
 * produces a plausible number and no error anywhere. This is the runtime half of what
 * `Eurc6` and `Usdc6` do at compile time, for the boundaries where the brand is gone.
 *
 * Both tags are named in the message, because "currency mismatch" tells an operator
 * nothing about which side of the corridor was wrong.
 */
export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(
      `Currency mismatch: ${a.currency} (${a.value}) and ${b.currency} (${b.value}) ` +
        `are the same scale and not the same money. Convert through the corridor's ` +
        `quoted rate, or keep the two balance sheets apart (DEC-21).`,
    );
  }
}

/** Format for display. `1234560000n` → `"1234.56"`. */
export function formatUsdc6(value: Usdc6): string {
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole.toString();
}

/** Parse a decimal string into `Usdc6`. Rejects excess precision. */
export function parseUsdc6(input: string): Usdc6 {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!match) throw new SyntaxError(`Not a decimal amount: ${input}`);
  const whole = match[1] ?? "0";
  const frac = match[2] ?? "";
  if (frac.length > 6) {
    throw new RangeError(`${input} has ${frac.length} decimal places; USDC carries 6.`);
  }
  return usdc6(BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0"));
}
