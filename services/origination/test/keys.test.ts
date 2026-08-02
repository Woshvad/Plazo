/**
 * Merchant API keys, against a real Postgres.
 *
 * The properties worth asserting here are the ones a typecheck cannot see and a mock
 * would agree with regardless: that a rotation overlap is genuinely an overlap, that
 * revocation beats expiry, that a sandbox key is refused by a live verifier before any
 * row is read, and that a key whose environment disagrees with its merchant's is refused
 * even though both rows individually satisfy their check constraints.
 *
 * The last one is the sandbox-settles-real-money failure, and it is the reason the check
 * exists in the code path as well as in the schema (T-06-06-08).
 */
import {readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {eq} from "drizzle-orm";
import {beforeAll, afterAll, describe, expect, it} from "vitest";

import {merchantAccount, merchantApiKey} from "../src/db/schema.js";
import {
  createSandboxMerchant,
  DEFAULT_OVERLAP_DAYS,
  issueKey,
  KeyError,
  listKeys,
  parseKey,
  redact,
  revokeKey,
  rotateKey,
  verifyKey,
} from "../src/keys.js";
import {openTestDatabase, type TestDatabase} from "./db.fixture.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let fixture: TestDatabase;

beforeAll(async () => {
  fixture = await openTestDatabase();
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

let nextAddress = 0;
const address = (): string => `0x${(++nextAddress).toString(16).padStart(40, "0")}`;

async function merchant(environment: "sandbox" | "live" = "sandbox"): Promise<string> {
  const [row] = await fixture.db
    .insert(merchantAccount)
    .values({address: address(), environment})
    .returning();
  return row!.merchantId;
}

describe("the shape of a key, before anything is looked up", () => {
  it("is plazo_{env}_{keyId}_{secret}", async () => {
    const {issued} = await createSandboxMerchant(fixture.db, address());
    const parsed = parseKey(issued.key);

    expect(issued.key.startsWith("plazo_test_")).toBe(true);
    expect(parsed.environment).toBe("sandbox");
    expect(parsed.keyId).toBe(issued.record.keyId);
    // 32 bytes, base64url. Never shorter, whatever an implementation might drift to.
    expect(Buffer.from(parsed.secret, "base64url")).toHaveLength(32);
  });

  it("refuses anything that is not four segments behind the vendor prefix", () => {
    for (const bad of ["", "plazo", "plazo_test_only-three", "stripe_test_a_b", "plazo_test__secret"]) {
      expect(() => parseKey(bad)).toThrow(KeyError);
    }
  });

  /**
   * base64url's alphabet includes `_`, which is also the field separator. The parse takes
   * the first three underscores and leaves the rest to the secret; without that, roughly
   * every key issued would be rejected as malformed by its own verifier.
   */
  it("parses a secret that contains the separator, because base64url does", () => {
    const parsed = parseKey("plazo_test_abc123_aa_bb-cc_dd");
    expect(parsed.keyId).toBe("abc123");
    expect(parsed.secret).toBe("aa_bb-cc_dd");
  });

  it("refuses an environment token it does not know", () => {
    expect(() => parseKey("plazo_staging_abc_secret")).toThrow(/unknown environment/);
  });

  /**
   * The rejection this whole format exists for. A live deployment refuses a sandbox key
   * on shape — one string comparison in, with no database reached — so the refusal cannot
   * be defeated by a row being wrong.
   */
  it("refuses a sandbox key at a live verifier before any lookup", async () => {
    const {issued} = await createSandboxMerchant(fixture.db, address());

    // A handle that would throw if it were touched at all: the assertion is that it is not.
    const exploding = new Proxy({} as never, {
      get() {
        throw new Error("verifyKey reached the database on a wrong-environment key");
      },
    });

    await expect(verifyKey(exploding, issued.key, {environment: "live"})).rejects.toMatchObject({
      code: "wrong-environment",
    });
  });
});

describe("verification", () => {
  it("returns exactly one merchant, and their address comes from their account row", async () => {
    const created = await createSandboxMerchant(fixture.db, address());
    const identity = await verifyKey(fixture.db, created.issued.key, {environment: "sandbox"});

    expect(identity.merchantId).toBe(created.merchantId);
    expect(identity.address).toBe(created.address);
    expect(identity.keyId).toBe(created.issued.record.keyId);
  });

  it("refuses a key whose secret has been changed by one character", async () => {
    const {issued} = await createSandboxMerchant(fixture.db, address());
    const parsed = parseKey(issued.key);
    const tampered = `plazo_test_${parsed.keyId}_${parsed.secret.slice(0, -1)}${
      parsed.secret.endsWith("A") ? "B" : "A"
    }`;

    await expect(verifyKey(fixture.db, tampered, {environment: "sandbox"})).rejects.toMatchObject({
      code: "bad-secret",
    });
  });

  it("refuses an unknown key id without saying anything else about it", async () => {
    await expect(
      verifyKey(fixture.db, "plazo_test_deadbeef_notarealsecret", {environment: "sandbox"}),
    ).rejects.toMatchObject({code: "unknown-key"});
  });

  it("stores a hash and a tail, and never the secret", async () => {
    const {issued} = await createSandboxMerchant(fixture.db, address());
    const secret = parseKey(issued.key).secret;

    const [row] = await fixture.db
      .select()
      .from(merchantApiKey)
      .where(eq(merchantApiKey.keyId, issued.record.keyId));

    expect(row!.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.secretHash).not.toContain(secret);
    expect(row!.last4).toBe(secret.slice(-4));
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  /**
   * Two rows, each individually satisfying its own check constraint, that disagree with
   * each other. The schema cannot express this relation; only a read of both can. This is
   * the failure mode the whole environment discipline exists to prevent.
   */
  it("refuses a sandbox key whose merchant account is live", async () => {
    const merchantId = await merchant("live");
    const {key, record} = await issueKey(fixture.db, {merchantId, environment: "live"});

    // Force the disagreement the way a bad migration or a hand-edited row would.
    await fixture.db
      .update(merchantApiKey)
      .set({environment: "sandbox"})
      .where(eq(merchantApiKey.keyId, record.keyId));

    const sandboxForm = key.replace("plazo_live_", "plazo_test_");
    await expect(verifyKey(fixture.db, sandboxForm, {environment: "sandbox"})).rejects.toMatchObject({
      code: "environment-mismatch",
    });
  });

  it("refuses to issue a live key to a sandbox merchant at all", async () => {
    const merchantId = await merchant("sandbox");
    await expect(issueKey(fixture.db, {merchantId, environment: "live"})).rejects.toMatchObject({
      code: "environment-mismatch",
    });
  });
});

/**
 * D-18's overlap, proven as an overlap rather than as a column being set.
 *
 * A rotation that revoked immediately would make every rotation an outage the length of a
 * merchant's deploy, and the practical consequence is that nobody rotates.
 */
describe("rotation with a 7-day overlap", () => {
  it("leaves both keys authenticating during the window, then only the new one", async () => {
    const created = await createSandboxMerchant(fixture.db, address());
    const old = created.issued;
    const at = new Date("2026-08-02T12:00:00Z");

    const rotation = await rotateKey(fixture.db, old.record.keyId, {now: at});

    const duringOverlap = new Date(at.getTime() + 3 * DAY_MS);
    await expect(
      verifyKey(fixture.db, old.key, {environment: "sandbox", now: duringOverlap}),
    ).resolves.toMatchObject({merchantId: created.merchantId});
    await expect(
      verifyKey(fixture.db, rotation.issued.key, {environment: "sandbox", now: duringOverlap}),
    ).resolves.toMatchObject({merchantId: created.merchantId});

    const afterOverlap = new Date(at.getTime() + (DEFAULT_OVERLAP_DAYS + 1) * DAY_MS);
    await expect(
      verifyKey(fixture.db, old.key, {environment: "sandbox", now: afterOverlap}),
    ).rejects.toMatchObject({code: "expired"});
    await expect(
      verifyKey(fixture.db, rotation.issued.key, {environment: "sandbox", now: afterOverlap}),
    ).resolves.toMatchObject({merchantId: created.merchantId});
  });

  it("expires the old key exactly `overlapDays` after the rotation", async () => {
    const created = await createSandboxMerchant(fixture.db, address());
    const at = new Date("2026-08-02T12:00:00Z");

    const rotation = await rotateKey(fixture.db, created.issued.record.keyId, {now: at, overlapDays: 2});
    expect(rotation.retired.expiresAt?.getTime()).toBe(at.getTime() + 2 * DAY_MS);
  });

  it("records what the new key replaced, so the history is not a set of unrelated rows", async () => {
    const created = await createSandboxMerchant(fixture.db, address());
    const rotation = await rotateKey(fixture.db, created.issued.record.keyId);
    expect(rotation.issued.record.rotatedFrom).toBe(created.issued.record.keyId);
  });

  it("refuses an overlap longer than the 30-day ceiling", async () => {
    const created = await createSandboxMerchant(fixture.db, address());
    await expect(
      rotateKey(fixture.db, created.issued.record.keyId, {overlapDays: 31}),
    ).rejects.toMatchObject({code: "overlap-out-of-range"});
  });

  it("refuses to rotate a key that belongs to another merchant", async () => {
    const mine = await createSandboxMerchant(fixture.db, address());
    const theirs = await createSandboxMerchant(fixture.db, address());

    await expect(
      rotateKey(fixture.db, theirs.issued.record.keyId, {merchantId: mine.merchantId}),
    ).rejects.toMatchObject({code: "not-yours"});
  });
});

describe("revocation", () => {
  it("kills a key immediately, and beats an expiry that has not arrived", async () => {
    const created = await createSandboxMerchant(fixture.db, address());
    const at = new Date("2026-08-02T12:00:00Z");
    await rotateKey(fixture.db, created.issued.record.keyId, {now: at});

    // Mid-overlap, so the key is still inside its window when it is revoked.
    const during = new Date(at.getTime() + DAY_MS);
    await expect(
      verifyKey(fixture.db, created.issued.key, {environment: "sandbox", now: during}),
    ).resolves.toBeTruthy();

    await revokeKey(fixture.db, created.issued.record.keyId, {now: during});

    await expect(
      verifyKey(fixture.db, created.issued.key, {environment: "sandbox", now: during}),
    ).rejects.toMatchObject({code: "revoked"});
  });

  it("keeps the row, because the rotation history has to stay answerable", async () => {
    const created = await createSandboxMerchant(fixture.db, address());
    await revokeKey(fixture.db, created.issued.record.keyId);

    const rows = await listKeys(fixture.db, created.merchantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeInstanceOf(Date);
  });

  it("refuses to revoke another merchant's key", async () => {
    const mine = await createSandboxMerchant(fixture.db, address());
    const theirs = await createSandboxMerchant(fixture.db, address());

    await expect(
      revokeKey(fixture.db, theirs.issued.record.keyId, {merchantId: mine.merchantId}),
    ).rejects.toMatchObject({code: "unknown-key"});
  });
});

describe("self-serve sandbox", () => {
  it("creates a sandbox merchant and a first key, and can only ever create sandbox", async () => {
    const created = await createSandboxMerchant(fixture.db, address());
    expect(created.issued.record.environment).toBe("sandbox");

    const [row] = await fixture.db
      .select()
      .from(merchantAccount)
      .where(eq(merchantAccount.merchantId, created.merchantId));
    expect(row!.environment).toBe("sandbox");
  });

  it("issues a second key against an address that already self-served, rather than a second account", async () => {
    const addr = address();
    const first = await createSandboxMerchant(fixture.db, addr);
    const second = await createSandboxMerchant(fixture.db, addr);

    expect(second.merchantId).toBe(first.merchantId);
    expect(await listKeys(fixture.db, first.merchantId)).toHaveLength(2);
  });

  it("refuses to self-serve against an address that already has a live account", async () => {
    const addr = address();
    await fixture.db.insert(merchantAccount).values({address: addr, environment: "live"});

    await expect(createSandboxMerchant(fixture.db, addr)).rejects.toMatchObject({
      code: "environment-mismatch",
    });
  });
});

describe("never logging a key", () => {
  it("redacts the secret and keeps the key id, which is not one", async () => {
    const {issued} = await createSandboxMerchant(fixture.db, address());
    const line = redact(`refused request with ${issued.key} from 10.0.0.1`);

    expect(line).not.toContain(parseKey(issued.key).secret);
    expect(line).toContain(issued.record.keyId);
    expect(line).toContain("[redacted]");
  });
});

/**
 * A grep gate is not a test, but the property it guards is real, so it is asserted here
 * too — against the file on disk, where a future edit would break it.
 */
describe("the comparison is constant-time, in the source", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const code = async (file: string) =>
    (await readFile(join(here, "..", "src", file), "utf8"))
      .split("\n")
      .filter((line) => !/^\s*[/*]/.test(line))
      .join("\n");

  it("uses timingSafeEqual and never compares a secret with ===", async () => {
    const keys = await code("keys.ts");
    expect(keys).toContain("timingSafeEqual");
    expect(keys).not.toMatch(/secret\s*===/);
  });

  it("no longer claims authentication is unbuilt, and reads no merchant header", async () => {
    const api = await code("api.ts");
    expect(api).not.toContain("Phase 6's `MERCH-05`");
    expect(api).not.toMatch(/req\.header\("x-merchant/);
    expect(api).toContain("requireKey");
  });
});
