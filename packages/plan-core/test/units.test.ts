/**
 * The decimal boundary is the highest-frequency arithmetic error available on Arc:
 * one balance, two scales, 10^12 apart. These tests exist because a test with round
 * numbers would pass under either scale.
 */
import {describe, expect, it} from "vitest";

import {
  assertSameCurrency,
  eurc6,
  formatUsdc6,
  money,
  narrowWithDust,
  native18,
  parseUsdc6,
  toMinor6,
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

// ─── E-08: two logs, one balance change, two scales ──────────────────────────

describe("the EIP-7708 log value and the ERC-20 log value", () => {
  it("narrows a log value by truncating rather than refusing", () => {
    // `toUsdc6` throws on this exact figure; `toMinor6` must not. A 1-wei-odd
    // inbound payment is an ordinary event on a chain whose gas token is
    // 18-decimal, and an income history that throws is an income history of zero.
    expect(toMinor6(native18(75_000_000_000_000_000_001n))).toBe(75_000_000n);
    expect(() => toUsdc6(wei18(75_000_000_000_000_000_001n))).toThrow(/not representable/);
  });

  it("floors, so the error can only ever understate income", () => {
    // One wei below a whole minor unit. Rounding up here would manufacture income
    // out of dust across ninety days of a busy wallet.
    expect(toMinor6(native18(999_999_999_999n))).toBe(0n);
    expect(toMinor6(native18(1_999_999_999_999n))).toBe(1n);
  });

  /**
   * The guard, demonstrated catching the thing it exists to catch.
   *
   * A single ERC-20 `transfer()` of 100 USDC on Arc emits **both** logs: the system
   * emitter's at 18 decimals and the token contract's at 6. These are the two
   * figures a naive implementation has in hand, and the two ways of adding them.
   */
  describe("a naive sum of both streams", () => {
    const nativeLog = native18(100_000_000_000_000_000_000n); // 100 USDC, 18-dec
    const erc20Log = usdc6(100_000_000n); //                     the same 100 USDC, 6-dec
    const correct = toMinor6(nativeLog);

    it("agrees with the ERC-20 stream once narrowed — they are one movement", () => {
      expect(correct).toBe(erc20Log);
    });

    it("inflates by 10^12 + 1 when the scales are never reconciled", () => {
      const naive = (nativeLog as bigint) + (erc20Log as bigint);
      expect(naive).toBe(100_000_000_000_100_000_000n);
      expect(naive / correct).toBe(1_000_000_000_001n);
    });

    it("inflates by exactly 2x when the scales are reconciled and the duplication is not", () => {
      const reconciledButDoubled = (correct as bigint) + (erc20Log as bigint);
      expect(reconciledButDoubled).toBe(200_000_000n);
      expect(reconciledButDoubled / correct).toBe(2n);
    });
  });
});

describe("the brands", () => {
  it("refuses a log value where a balance is expected — at compile time", () => {
    // @ts-expect-error -- Native18 is not Wei18. This directive is the assertion:
    // `tsc` fails the build if the call ever becomes legal, because an unused
    // `@ts-expect-error` is itself an error. `pnpm --filter @plazo/plan-core
    // typecheck` runs `tsconfig.test.json` for exactly this line.
    expect(() => toUsdc6(native18(1_000_000_000_000n))).not.toThrow();
  });

  it("refuses a EURC figure where a USDC figure is expected — at compile time", () => {
    // @ts-expect-error -- one EURC and one USDC are both 1_000_000n at runtime.
    expect(formatUsdc6(eurc6(1_000_000n))).toBe("1");
  });

  it("rejects negatives at construction, for the two new brands too", () => {
    expect(() => eurc6(-1n)).toThrow(RangeError);
    expect(() => native18(-1n)).toThrow(RangeError);
  });
});

describe("assertSameCurrency", () => {
  it("passes two figures in the same currency", () => {
    expect(() => assertSameCurrency(money("USDC", 1n), money("USDC", 2n))).not.toThrow();
  });

  it("names both currencies when they differ", () => {
    expect(() => assertSameCurrency(money("USDC", 1_000_000n), money("EURC", 1_000_000n))).toThrow(
      /USDC \(1000000\).*EURC \(1000000\)/s,
    );
  });

  it("rejects a negative tagged figure", () => {
    expect(() => money("EURC", -1n)).toThrow(RangeError);
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
