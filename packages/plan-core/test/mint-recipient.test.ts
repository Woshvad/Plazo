/**
 * `mintRecipient` has exactly one job and one way to get it wrong.
 *
 * A right-padded `bytes32` is still a valid `bytes32`. CCTP will accept it, Iris
 * will attest it, and the destination chain will mint real USDC to an address
 * nobody holds the key to. Nothing reverts. So the padding direction is asserted
 * here rather than trusted to a reviewer noticing which viem helper was called.
 */
import {describe, expect, it} from "vitest";
import {pad, type Address} from "viem";

import {
  ARC_CCTP_DOMAIN,
  CCTP_FINALITY_STANDARD,
  CCTP_MAX_FEE_FROM_ARC,
  GATEWAY_WITHDRAWAL_DELAY_SECONDS,
  mintRecipient,
} from "../src/arc.js";

/** Deliberately tail-heavy: right padding would move the `aa` and it would show. */
const TAIL_HEAVY: Address = "0x00000000000000000000000000000000000000aa";
const NORMAL: Address = "0xF4ee61950B63cCA5C82f1146484d018Ac95Bd0F2";

describe("mintRecipient", () => {
  it("is left-padded", () => {
    const encoded = mintRecipient(TAIL_HEAVY);
    expect(encoded).toBe(`0x${"00".repeat(31)}aa`);
    expect(encoded.endsWith("aa")).toBe(true);
    // 32 bytes = 64 nibbles; 20 bytes of address leaves 24 leading zero nibbles.
    expect(/^0x0{24}/.test(encoded)).toBe(true);
  });

  it("is not right-padded", () => {
    expect(mintRecipient(TAIL_HEAVY)).not.toBe(pad(TAIL_HEAVY, {size: 32, dir: "right"}));
  });

  it("preserves the address in the low 20 bytes", () => {
    const encoded = mintRecipient(NORMAL);
    expect(`0x${encoded.slice(-40)}`.toLowerCase()).toBe(NORMAL.toLowerCase());
  });

  it("produces 32 bytes", () => {
    expect(mintRecipient(NORMAL)).toHaveLength(66);
  });
});

describe("CCTP constants", () => {
  it("names Arc's CCTP domain, which is not its chain id", () => {
    expect(ARC_CCTP_DOMAIN).toBe(26);
  });

  it("always sends standard finality at zero fee out of Arc", () => {
    expect(CCTP_FINALITY_STANDARD).toBe(2000);
    expect(CCTP_MAX_FEE_FROM_ARC).toBe(0n);
  });

  it("records the chain's fourteen-day Gateway withdrawal delay, not the docs' seven", () => {
    expect(GATEWAY_WITHDRAWAL_DELAY_SECONDS).toBe(14 * 24 * 60 * 60);
  });
});
