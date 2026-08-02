/**
 * The attestation poller, and the provider that replaced the stub.
 *
 * The assertions worth having here are the ones about what the loop refuses to do:
 * refuses to treat "we asked Iris" as "it is done", and refuses to advance its cursor
 * past a burn it has not finished. Both failure modes are silent — money that stopped
 * moving with nothing in a log — which is why they get a test rather than a comment.
 */
import {readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {beforeAll, afterAll, describe, expect, it} from "vitest";

import {
  attestationFor,
  attestationJobKey,
  fetchAttestation,
  indexerPendingDispatches,
  IrisRoutingError,
  noPendingDispatches,
  notePoll,
  pollDispatched,
  type AttestationRecord,
  type PendingDispatch,
} from "../src/cctp.js";
import {openTestDatabase, type TestDatabase} from "./db.fixture.js";

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

// ─── Iris ────────────────────────────────────────────────────────────────────

let fixture: TestDatabase;

beforeAll(async () => {
  fixture = await openTestDatabase();
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

const TX = "0x1111111111111111111111111111111111111111111111111111111111111111";

/** A fetch stub that records the URL it was asked for. */
function irisStub(responder: () => Response) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    return responder();
  }) as unknown as typeof fetch;
  return {urls, fetchImpl};
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json"}});

describe("the endpoint form that actually routes", () => {
  it("asks /messages/{domain} with a transactionHash query parameter", async () => {
    const {urls, fetchImpl} = irisStub(() => json({messages: []}));
    await fetchAttestation(TX, {fetchImpl, baseUrl: "https://iris.test/v2"});

    expect(urls[0]).toBe(`https://iris.test/v2/messages/26?transactionHash=${TX}`);
    // The documented form. It answers an HTML 404 and never resolves (Pitfall 6).
    expect(urls[0]).not.toContain("messages?");
  });

  it("uses Arc's CCTP domain, which is 26 and is not a chain id", async () => {
    const {urls, fetchImpl} = irisStub(() => json({messages: []}));
    await fetchAttestation(TX, {fetchImpl, baseUrl: "https://iris.test/v2"});
    expect(urls[0]).toContain("/messages/26?");
  });
});

/**
 * Both forms answer 404, so the status code cannot tell them apart. One means "wait and
 * ask again"; the other means the URL is wrong and waiting will never fix it. Branching
 * on the status is how a poller retries a routing error forever, in silence.
 */
describe("the two 404s", () => {
  it("reads a JSON 404 as not-indexed-yet and returns null without throwing", async () => {
    const {fetchImpl} = irisStub(() =>
      json({error: "Message not found for provided parameters"}, 404),
    );

    await expect(
      fetchAttestation(TX, {fetchImpl, baseUrl: "https://iris.test/v2"}),
    ).resolves.toBeNull();
  });

  it("throws on an HTML 404, naming the endpoint form that does not route", async () => {
    const {fetchImpl} = irisStub(
      () => new Response("<!DOCTYPE html><html><body>404</body></html>", {status: 404}),
    );

    const failure = fetchAttestation(TX, {fetchImpl, baseUrl: "https://iris.test/v2"});
    await expect(failure).rejects.toBeInstanceOf(IrisRoutingError);
    await expect(failure).rejects.toThrow(/txHash/);
    await expect(failure).rejects.toThrow(/transactionHash/);
  });

  it("throws on a non-404 error rather than retrying it as a gap", async () => {
    const {fetchImpl} = irisStub(() => json({error: "internal"}, 500));
    await expect(
      fetchAttestation(TX, {fetchImpl, baseUrl: "https://iris.test/v2"}),
    ).rejects.toThrow(/iris 500/);
  });

  it("throws on a body that is neither JSON nor HTML", async () => {
    const {fetchImpl} = irisStub(() => new Response("gateway timeout", {status: 504}));
    await expect(
      fetchAttestation(TX, {fetchImpl, baseUrl: "https://iris.test/v2"}),
    ).rejects.toBeInstanceOf(IrisRoutingError);
  });
});

describe("what counts as an answer", () => {
  it("returns the message and the attestation when the status is complete", async () => {
    const {fetchImpl} = irisStub(() =>
      json({
        messages: [{status: "complete", message: "0xdead", attestation: "0xbeef", eventNonce: "7"}],
      }),
    );

    await expect(
      fetchAttestation(TX, {fetchImpl, baseUrl: "https://iris.test/v2"}),
    ).resolves.toEqual({message: "0xdead", attestation: "0xbeef", eventNonce: "7"});
  });

  /** Indexed but pending is still "ask again later", not an answer. */
  it("returns null for a message that is indexed but not complete", async () => {
    const {fetchImpl} = irisStub(() => json({messages: [{status: "pending_confirmations"}]}));
    await expect(
      fetchAttestation(TX, {fetchImpl, baseUrl: "https://iris.test/v2"}),
    ).resolves.toBeNull();
  });

  it("returns null for a complete message missing half of what a mint needs", async () => {
    const {fetchImpl} = irisStub(() => json({messages: [{status: "complete", message: "0xdead"}]}));
    await expect(
      fetchAttestation(TX, {fetchImpl, baseUrl: "https://iris.test/v2"}),
    ).resolves.toBeNull();
  });
});

describe("the job key", () => {
  it("is identical for two calls with the same plan and domain, so a duplicate crank is a no-op", () => {
    expect(attestationJobKey("0xabc", 3)).toBe(attestationJobKey("0xabc", 3));
    expect(attestationJobKey("0xabc", 3)).toBe("payout:0xabc:3");
  });

  it("differs by domain, because a burn to Base is not a burn to Arbitrum (DEC-36)", () => {
    expect(attestationJobKey("0xabc", 3)).not.toBe(attestationJobKey("0xabc", 6));
  });
});

describe("persistence", () => {
  it("records a pending poll and then completes it in place", async () => {
    const planId = "0xplan-pending";
    await notePoll(fixture.db, {planId, destinationDomain: 3, txHash: TX}, null);

    let row = await attestationFor(fixture.db, planId);
    expect(row).toMatchObject({status: "pending", attempts: 1, message: null});

    await notePoll(
      fixture.db,
      {planId, destinationDomain: 3, txHash: TX},
      {message: "0xdead", attestation: "0xbeef"},
    );

    row = await attestationFor(fixture.db, planId);
    expect(row).toMatchObject({
      status: "complete",
      attempts: 2,
      message: "0xdead",
      attestation: "0xbeef",
    });
  });

  /**
   * A burn asked about four hundred times and still pending is a stuck settlement. The
   * difference between stuck and slow is a number nobody has unless it was recorded.
   */
  it("increments attempts on every poll, including the ones that found nothing", async () => {
    const planId = "0xplan-stuck";
    for (let i = 0; i < 4; i++) {
      await notePoll(fixture.db, {planId, destinationDomain: 6, txHash: TX}, null);
    }
    expect((await attestationFor(fixture.db, planId))?.attempts).toBe(4);
  });

  it("keeps a completed attestation when a later poll finds nothing", async () => {
    const planId = "0xplan-kept";
    await notePoll(
      fixture.db,
      {planId, destinationDomain: 3, txHash: TX},
      {message: "0xdead", attestation: "0xbeef"},
    );
    await notePoll(fixture.db, {planId, destinationDomain: 3, txHash: TX}, null);

    expect(await attestationFor(fixture.db, planId)).toMatchObject({
      message: "0xdead",
      attestation: "0xbeef",
    });
  });

  it("keys by plan and domain together, so two destinations are two rows", async () => {
    const planId = "0xplan-two-domains";
    await notePoll(fixture.db, {planId, destinationDomain: 3, txHash: TX}, null);
    await notePoll(fixture.db, {planId, destinationDomain: 6, txHash: TX}, null);

    expect((await attestationFor(fixture.db, planId, 3))?.destinationDomain).toBe(3);
    expect((await attestationFor(fixture.db, planId, 6))?.destinationDomain).toBe(6);
  });

  it("returns null for a plan nothing has been recorded against", async () => {
    expect(await attestationFor(fixture.db, "0xnever")).toBeNull();
  });
});

/**
 * C10 as a gate rather than a comment: no vendor webhook may appear on this path, and the
 * broken endpoint form may not creep back in outside a comment explaining why it is broken.
 */
describe("the file itself", () => {
  it("names no Circle webhook and no txHash query parameter outside its comments", async () => {
    const source = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cctp.ts"),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => !/^\s*[/*]/.test(line))
      .join("\n");

    expect(code).not.toMatch(/txHash=/);
    expect(code).not.toMatch(/circle.*webhook/i);
    expect(code).toContain("transactionHash=");
  });
});
