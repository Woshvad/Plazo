/**
 * The decimal boundary is the highest-frequency arithmetic error available on Arc:
 * one balance, two scales, 10^12 apart. These tests exist because a test with round
 * numbers would pass under either scale.
 */
import {describe, expect, it} from "vitest";

import {
  formatUsdc6,
  narrowWithDust,
  parseUsdc6,
  toUsdc6,
  toWei18,
  usdc6,
  wei18,
} from "../src/units.js";

describe("scale conversion", () => {
  it("widens exactly", () => {
    expect(toWei18(usdc6(75_000_000n))).toBe(75_000_000_000_000_000_000n);
  });

  it("round-trips", () => {
    const amount = usdc6(1_234_567n);
    expect(toUsdc6(toWei18(amount))).toBe(amount);
  });

  it("refuses to silently truncate a remainder", () => {
    // One wei short of a representable amount. Truncating here would be value
    // disappearing from a settlement — too small to notice in one plan, too large
    // to ignore across a book.
    expect(() => toUsdc6(wei18(75_000_000_000_000_000_001n))).toThrow(/not representable/);
  });

  it("reports the dust when rounding is explicit", () => {
    const {amount, dust} = narrowWithDust(wei18(75_000_000_000_000_000_001n));
    expect(amount).toBe(75_000_000n);
    expect(dust).toBe(1n);
  });

  it("rejects negatives at construction", () => {
    expect(() => usdc6(-1n)).toThrow(RangeError);
    expect(() => wei18(-1n)).toThrow(RangeError);
  });
});

describe("parsing and formatting", () => {
  it.each([
    ["75", 75_000_000n],
    ["75.00", 75_000_000n],
    ["0.000001", 1n],
    ["1234.56", 1_234_560_000n],
  ])("parses %s", (input, expected) => {
    expect(parseUsdc6(input)).toBe(expected);
  });

  it("rejects excess precision rather than rounding it away", () => {
    expect(() => parseUsdc6("1.0000001")).toThrow(/carries 6/);
  });

  it("rejects non-numeric input", () => {
    expect(() => parseUsdc6("75 USDC")).toThrow(SyntaxError);
  });

  it.each([
    [75_000_000n, "75"],
    [1_234_560_000n, "1234.56"],
    [1n, "0.000001"],
    [0n, "0"],
  ])("formats %s", (input, expected) => {
    expect(formatUsdc6(usdc6(input))).toBe(expected);
  });
});
