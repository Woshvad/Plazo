/**
 * An Arc-aware RPC transport.
 *
 * Two things about `rpc.testnet.arc.io` break naive clients, both measured rather
 * than read in documentation:
 *
 * 1. **Load shedding.** Roughly a quarter of requests come back as JSON-RPC error
 *    -32011 "request limit reached", and it happens regardless of pacing — measured
 *    at one request per second it still sheds. viem does not retry it: a shed
 *    request arrives as HTTP 200 with an error body, so viem's retry predicate,
 *    which covers transport failures, never fires. An indexer without this handling
 *    stalls on a quarter of its requests and reports the stall as a chain error.
 *
 * 2. **A hard 10,000-block `eth_getLogs` range.** Exceeding it is error -32614,
 *    not a truncated result. Every historical sweep has to chunk below it.
 *
 * `@plazo/arc-verify` asserts both of these on every CI run, so if Arc's behaviour
 * changes, the gate says so before this silently becomes over-conservative.
 */
import {http, type HttpTransportConfig, type Transport} from "viem";

import {ARC_MAX_LOG_RANGE, ARC_TESTNET_RPC_URL} from "@plazo/plan-core";

const SHED_PATTERN = /request limit reached|-32011|too many requests|rate limit/i;

/** Recognise a shed response at any nesting depth. */
export function isShedResponse(error: unknown): boolean {
  const seen = new Set<unknown>();
  const check = (e: unknown): boolean => {
    if (e == null || seen.has(e)) return false;
    seen.add(e);
    if (typeof e === "string") return SHED_PATTERN.test(e);
    if (typeof e !== "object") return false;
    const rec = e as Record<string, unknown>;
    if (rec["code"] === -32011) return true;
    for (const key of ["message", "shortMessage", "details", "reason"]) {
      const v = rec[key];
      if (typeof v === "string" && SHED_PATTERN.test(v)) return true;
    }
    return check(rec["cause"]) || check(rec["error"]);
  };
  return check(error);
}

export interface ArcTransportOptions {
  url?: string;
  /** Attempts per shed request. Only shed responses are retried. */
  shedRetries?: number;
  /** Base backoff in milliseconds; grows linearly across attempts. */
  backoffMs?: number;
}

export function arcTransport(options: ArcTransportOptions = {}): Transport {
  const url = options.url ?? process.env["ARC_TESTNET_RPC_URL"] ?? ARC_TESTNET_RPC_URL;
  const shedRetries = options.shedRetries ?? 8;
  const backoffMs = options.backoffMs ?? 150;

  const config: HttpTransportConfig = {
    // Transport-level failures — 429, 5xx, timeouts. viem handles these itself.
    retryCount: 3,
    retryDelay: 300,
    timeout: 30_000,
    // Batching multiplies the blast radius of a shed response: one shed batch loses
    // every call in it, and the retry then re-sends work that already succeeded.
    batch: false,
  };

  const base = http(url, config);

  return ((params) => {
    const instance = base(params);
    const request = instance.request.bind(instance);

    return {
      ...instance,
      request: async (args: never, opts?: never) => {
        let lastError: unknown;
        for (let attempt = 0; attempt < shedRetries; attempt++) {
          try {
            return await request(args, opts);
          } catch (error) {
            lastError = error;
            if (!isShedResponse(error)) throw error;
            await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
          }
        }
        throw lastError;
      },
    };
  }) as Transport;
}

/**
 * Split a block range into chunks the public RPC will accept.
 *
 * Chunks at `ARC_MAX_LOG_RANGE - 1` rather than at the limit: the boundary is
 * documented as a maximum but was only measured as "rejects above", and being one
 * block conservative costs nothing against the cost of a backfill that fails at an
 * arbitrary depth.
 */
export function chunkBlockRange(
  fromBlock: bigint,
  toBlock: bigint,
  maxRange = ARC_MAX_LOG_RANGE,
): Array<{fromBlock: bigint; toBlock: bigint}> {
  if (toBlock < fromBlock) return [];
  const stride = BigInt(maxRange - 1);
  const chunks: Array<{fromBlock: bigint; toBlock: bigint}> = [];
  for (let start = fromBlock; start <= toBlock; start += stride + 1n) {
    const end = start + stride > toBlock ? toBlock : start + stride;
    chunks.push({fromBlock: start, toBlock: end});
  }
  return chunks;
}
