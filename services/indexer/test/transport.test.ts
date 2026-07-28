import {describe, expect, it} from "vitest";

import {ARC_MAX_LOG_RANGE} from "@plazo/plan-core";
import {chunkBlockRange, isShedResponse} from "../src/transport.js";

describe("shed detection", () => {
  it("recognises the raw JSON-RPC error", () => {
    expect(isShedResponse({code: -32011, message: "request limit reached"})).toBe(true);
  });

  it("recognises it wrapped by viem", () => {
    // viem nests the original error several layers down and stringifies it into
    // shortMessage/details along the way.
    const wrapped = {
      shortMessage: "RPC Request failed.",
      cause: {
        details: "request limit reached",
        cause: {code: -32011},
      },
    };
    expect(isShedResponse(wrapped)).toBe(true);
  });

  it("does not treat a real failure as shed", () => {
    // The distinction that matters: retrying a genuine error hides it. A wrong
    // typehash or a missing contract must surface on the first attempt.
    expect(isShedResponse(new Error("execution reverted: FiatTokenV2: authorization is expired"))).toBe(
      false,
    );
    expect(isShedResponse({code: -32000, message: "execution reverted"})).toBe(false);
    expect(isShedResponse(null)).toBe(false);
  });

  it("terminates on a self-referential error", () => {
    const cyclic: Record<string, unknown> = {message: "boom"};
    cyclic["cause"] = cyclic;
    expect(isShedResponse(cyclic)).toBe(false);
  });
});

describe("log range chunking", () => {
  it("returns one chunk when the range fits", () => {
    expect(chunkBlockRange(100n, 200n)).toEqual([{fromBlock: 100n, toBlock: 200n}]);
  });

  it("never exceeds the RPC limit", () => {
    const chunks = chunkBlockRange(0n, 100_000n);
    for (const chunk of chunks) {
      const span = chunk.toBlock - chunk.fromBlock + 1n;
      expect(span).toBeLessThanOrEqual(BigInt(ARC_MAX_LOG_RANGE));
    }
  });

  it("covers the range exactly, with no gaps or overlaps", () => {
    const chunks = chunkBlockRange(1_000n, 45_678n);
    expect(chunks[0]!.fromBlock).toBe(1_000n);
    expect(chunks.at(-1)!.toBlock).toBe(45_678n);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.fromBlock).toBe(chunks[i - 1]!.toBlock + 1n);
    }
  });

  it("handles a single block", () => {
    expect(chunkBlockRange(42n, 42n)).toEqual([{fromBlock: 42n, toBlock: 42n}]);
  });

  it("returns nothing for an inverted range", () => {
    expect(chunkBlockRange(200n, 100n)).toEqual([]);
  });
});
