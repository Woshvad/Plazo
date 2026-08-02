/**
 * The attestation poller, and the provider that replaced the stub.
 *
 * The assertions worth having here are the ones about what the loop refuses to do:
 * refuses to treat "we asked Iris" as "it is done", and refuses to advance its cursor
 * past a burn it has not finished. Both failure modes are silent — money that stopped
 * moving with nothing in a log — which is why they get a test rather than a comment.
 */
import {describe, expect, it} from "vitest";

import {
  indexerPendingDispatches,
  noPendingDispatches,
  pollDispatched,
  type AttestationRecord,
  type PendingDispatch,
} from "../src/cctp.js";

const BURN = (id: string, blockNumber: number): PendingDispatch => ({
  id,
  txHash: `0x${id.replace(/-/g, "").padStart(64, "0")}`,
  token: "0x3600000000000000000000000000000000000000",
  recipient: "0x000000000000000000000000000000000000dec1",
  domain: 3,
  amount: "86400000",
  blockNumber: String(blockNumber),
  timestamp: 1_800_000_000 + blockNumber,
});

const done = (...ids: string[]): ReadonlyMap<string, AttestationRecord> =>
  new Map(ids.map((id) => [id, {id, complete: true}]));

describe("the stub the wiring replaced", () => {
  it("does nothing, so an unpointed poller is quiet rather than broken", async () => {
    expect(await noPendingDispatches({})).toEqual([]);
    const result = await pollDispatched({attestations: new Map()});
    expect(result.outstanding).toEqual([]);
    expect(result.cursor).toBeUndefined();
  });
});

describe("one sweep of the attestation poller", () => {
  const found = [BURN("100-1", 100), BURN("200-1", 200), BURN("300-1", 300)];
  const dispatches = async () => found;

  it("reports every burn it has no record of", async () => {
    const result = await pollDispatched({dispatches, attestations: new Map()});
    expect(result.outstanding.map((d) => d.id)).toEqual(["100-1", "200-1", "300-1"]);
  });

  it("leaves out the ones it has already completed", async () => {
    const result = await pollDispatched({dispatches, attestations: done("100-1", "200-1")});
    expect(result.outstanding.map((d) => d.id)).toEqual(["300-1"]);
  });

  /**
   * An attestation that was requested and never came back is exactly the case that must
   * be retried. Treating "we asked" as "it is done" is how a settlement goes quiet
   * forever, and the record carries `complete` rather than merely existing for this
   * reason alone.
   */
  it("retries a record that exists but is not complete", async () => {
    const attestations = new Map([["200-1", {id: "200-1", complete: false}]]);
    const result = await pollDispatched({dispatches, attestations});
    expect(result.outstanding.map((d) => d.id)).toContain("200-1");
  });

  it("advances the cursor across a prefix of completed burns", async () => {
    const result = await pollDispatched({dispatches, attestations: done("100-1", "200-1")});
    expect(result.cursor).toBe(200n);
  });

  /**
   * The cursor is what decides whether a burn is ever seen again. One stuck attestation
   * must make the sweep slower, which is visible, rather than lossy, which is not.
   */
  it("holds the cursor at a burn it has not finished, even if later ones are done", async () => {
    const result = await pollDispatched({dispatches, attestations: done("300-1")});
    expect(result.cursor).toBeUndefined();
    expect(result.outstanding.map((d) => d.id)).toEqual(["100-1", "200-1"]);
  });

  it("keeps the cursor where it was when the sweep found nothing", async () => {
    const result = await pollDispatched({
      dispatches: async () => [],
      attestations: new Map(),
      cursor: 512n,
    });
    expect(result.cursor).toBe(512n);
  });

  it("passes the cursor to the provider so the read is bounded", async () => {
    let seen: bigint | undefined;
    await pollDispatched({
      dispatches: async ({after}) => {
        seen = after;
        return [];
      },
      attestations: new Map(),
      cursor: 54_714_174n,
    });
    expect(seen).toBe(54_714_174n);
  });
});

describe("the provider reads the indexer, and only the indexer", () => {
  it("asks the indexer's own dispatch route", async () => {
    let requested = "";
    const provider = indexerPendingDispatches("http://indexer:42069", (async (url: URL) => {
      requested = url.toString();
      return new Response(JSON.stringify({dispatches: [BURN("100-1", 100)]}), {status: 200});
    }) as unknown as typeof fetch);

    const dispatches = await provider({after: 99n, limit: 10});

    expect(requested).toContain("/v1/payouts/dispatches");
    expect(requested).toContain("after=99");
    expect(requested).toContain("limit=10");
    expect(dispatches.map((d) => d.id)).toEqual(["100-1"]);
  });

  it("tolerates a trailing slash on the configured base url", async () => {
    let requested = "";
    const provider = indexerPendingDispatches("http://indexer:42069/", (async (url: URL) => {
      requested = url.toString();
      return new Response(JSON.stringify({dispatches: []}), {status: 200});
    }) as unknown as typeof fetch);

    await provider({});
    expect(requested).not.toContain("//v1/");
  });

  /**
   * A refusal must be an error, not an empty sweep. An empty sweep is indistinguishable
   * from "nothing to do", and a poller that reads a 500 as "nothing to do" stops
   * settling and reports success while doing it.
   */
  it("throws when the indexer refuses, rather than reporting nothing to do", async () => {
    const provider = indexerPendingDispatches("http://indexer:42069", (async () =>
      new Response("nope", {status: 503})) as unknown as typeof fetch);

    await expect(provider({})).rejects.toThrow(/indexer refused/);
  });

  it("reads an empty body as no work rather than failing", async () => {
    const provider = indexerPendingDispatches("http://indexer:42069", (async () =>
      new Response(JSON.stringify({}), {status: 200})) as unknown as typeof fetch);

    expect(await provider({})).toEqual([]);
  });
});
