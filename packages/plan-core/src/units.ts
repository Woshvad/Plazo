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
 */

declare const brand: unique symbol;

type Branded<T, B> = T & {readonly [brand]: B};

/** USDC at ERC-20 scale — 6 decimals. Everything EIP-3009 signs. */
export type Usdc6 = Branded<bigint, "Usdc6">;

/** USDC at native scale — 18 decimals. Gas accounting, native transfers. */
export type Wei18 = Branded<bigint, "Wei18">;

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
