/**
 * Merchant API keys: issue, verify, rotate, revoke. MERCH-05 and D-18.
 *
 * A key is the whole of a merchant's authority over this API, so the shape of the thing
 * decides most of the security properties before a line of lookup code is written.
 *
 * ## The format is `plazo_{env}_{keyId}_{secret}`
 *
 * The **environment is in the prefix**, not in a column somebody has to remember to
 * filter on. A sandbox key pasted into a production deployment is refused on shape, one
 * string comparison in, before the database is asked anything — which means the refusal
 * cannot be defeated by a row being wrong. `WHERE is_sandbox = false` is a filter that
 * gets forgotten exactly once, and the cost of forgetting it is sandbox traffic settling
 * real money.
 *
 * The `keyId` is public, indexable and non-secret. It is the handle a merchant names in
 * a rotation call and the column the lookup is an index seek on. The `secret` is 32 bytes
 * from `crypto.randomBytes`, base64url.
 *
 * ## At rest: `sha256(secret)` and four characters
 *
 * Not bcrypt, not argon2, not scrypt. Those exist to make a *low-entropy* secret
 * expensive to guess; a 256-bit random token has nothing to strengthen, and a slow KDF
 * would put a deliberate delay on the authentication path of every request in exchange
 * for no additional resistance. The last four characters are stored in cleartext because
 * a merchant with three keys needs to know which one they are about to revoke.
 *
 * ## The comparison is constant-time, always
 *
 * `verifyKey` looks the row up by `keyId` and then compares the presented secret's hash
 * with `crypto.timingSafeEqual`. A `WHERE secret_hash = $1` on user input would make the
 * *database* the comparator and its index a timing oracle; a `===` in JavaScript would be
 * one directly. An unknown `keyId` still runs a compare against a decoy hash, so "no such
 * key" and "wrong secret" take the same shape of work.
 *
 * ## Rotation overlaps, because a deploy is not atomic
 *
 * `rotateKey` issues a **new** key and stamps `expiresAt = now + overlap` on the old one
 * rather than killing it. Both authenticate during the window. A rotation that revoked
 * immediately would make every rotation an outage whose length is however long a
 * merchant's deploy takes, and the practical consequence of that is that nobody ever
 * rotates. `revokeKey` is the other thing — the immediate kill for a key believed
 * compromised — and it wins over `expiresAt` unconditionally.
 *
 * ## Never
 *
 * Never log a full key (`redact` is here for that), never return a secret after the
 * response that created it, and never let one key grant more than one merchant.
 */
import {createHash, randomBytes, timingSafeEqual} from "node:crypto";

import {and, eq} from "drizzle-orm";

import {merchantAccount, merchantApiKey} from "./db/schema.js";
import type {Db} from "./db/client.js";

/**
 * Which world a key belongs to.
 *
 * The database column carries these exact two strings under a check constraint
 * (06-02a), on both `merchant_account` and `merchant_api_key`. The constraint is the
 * belt; the code below is the braces, because a check constraint cannot tell you that a
 * *live* merchant was handed a *sandbox* key — only that each value is one of two.
 */
export type Environment = "sandbox" | "live";

/**
 * The token that appears in the key itself.
 *
 * `sandbox` is spelled `test` in the key because that is the word every developer
 * already reads as "this cannot move money", and the research fixes the example as
 * `plazo_test_k1a2b3_9f…`. The database keeps the longer word; the two are mapped here,
 * in one place, rather than being two vocabularies that drift.
 */
const ENVIRONMENT_TOKEN: Record<Environment, string> = {sandbox: "test", live: "live"};

const TOKEN_ENVIRONMENT: Record<string, Environment> = {test: "sandbox", live: "live"};

/** Every key starts with this, so a leaked string is greppable in a log or a repository. */
export const KEY_PREFIX = "plazo";

/** The default rotation overlap, and the ceiling a merchant may raise it to. */
export const DEFAULT_OVERLAP_DAYS = 7;
export const MAX_OVERLAP_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A typed error with a string-union `code`, mirroring `SessionError` exactly.
 *
 * The code is what the route maps to a status; the message is what a human reads. They
 * are deliberately separate so that a message can be made more helpful without changing
 * an API contract, and so that no route has to match on prose.
 */
export class KeyError extends Error {
  constructor(
    message: string,
    readonly code:
      | "malformed"
      | "wrong-environment"
      | "unknown-key"
      | "bad-secret"
      | "revoked"
      | "expired"
      | "unknown-merchant"
      | "environment-mismatch"
      | "overlap-out-of-range"
      | "not-yours",
  ) {
    super(message);
    this.name = "KeyError";
  }
}

/** A key as anyone but its owner may see it. There is no secret on this record. */
export interface KeyRecord {
  readonly keyId: string;
  readonly merchantId: string;
  readonly environment: Environment;
  /** The last four characters of the secret. Enough to recognise, useless to present. */
  readonly last4: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly rotatedFrom: string | null;
}

/**
 * The one and only time a secret crosses a boundary.
 *
 * Returned by `issueKey` and `rotateKey`, serialised into exactly one HTTP response, and
 * never readable again. If a merchant loses it they rotate; there is no recovery path and
 * there must not be one, because a recovery path is a second place the secret lives.
 */
export interface IssuedKey {
  readonly record: KeyRecord;
  /** `plazo_{env}_{keyId}_{secret}`. Never persisted, never logged. */
  readonly key: string;
}

/** Who the presented key says you are. This is the only source of a merchant identity. */
export interface MerchantIdentity {
  readonly merchantId: string;
  readonly keyId: string;
  readonly environment: Environment;
  /** The merchant's settlement address, from their account row — never from a request. */
  readonly address: string;
}

/** The shape of a presented key, before anything has been looked up. */
export interface ParsedKey {
  readonly environment: Environment;
  readonly keyId: string;
  readonly secret: string;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * A hash no secret produces, for the unknown-key path.
 *
 * Comparing against this rather than returning early keeps the work done for "no such
 * key" the same shape as the work done for "wrong secret". Timing is not the strongest
 * signal an attacker has, but the fix costs one hash and removes an oracle that
 * enumerates valid key ids.
 */
const DECOY_HASH = sha256("plazo.decoy.never-a-real-secret");

/** Constant-time over equal-length hex digests. Never `===`, and never a bare compare. */
function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Parse a presented key without touching the database.
 *
 * Everything checkable from the string alone is checked here: the vendor prefix, a known
 * environment token, and four non-empty segments. A malformed key never reaches a query,
 * which is what makes the environment check in `verifyKey` a *shape* rejection rather
 * than a lookup that happened to miss.
 */
export function parseKey(presented: string): ParsedKey {
  /**
   * Split on the first three underscores only, because **base64url contains `_`**.
   *
   * The separator and the secret's alphabet overlap: `randomBytes(32).toString("base64url")`
   * emits `-` and `_` alongside the alphanumerics, so roughly every key has an underscore
   * inside its secret and a naive four-way split rejects it as malformed. Found by the
   * first run of this file's own suite, which is the only reason it is not a launch defect.
   *
   * The parse stays unambiguous because the three fields before the secret cannot contain
   * an underscore: the prefix is a literal, the environment token is one of two literals,
   * and the `keyId` is hex.
   */
  const parts = presented.split("_");
  if (parts.length < 4) {
    throw new KeyError("api key is not in the form plazo_{env}_{keyId}_{secret}", "malformed");
  }
  const [prefix, token, keyId] = parts as [string, string, string];
  const secret = parts.slice(3).join("_");
  if (prefix !== KEY_PREFIX || !token || !keyId || !secret) {
    throw new KeyError("api key is not in the form plazo_{env}_{keyId}_{secret}", "malformed");
  }
  const environment = TOKEN_ENVIRONMENT[token];
  if (!environment) {
    throw new KeyError(`api key names an unknown environment '${token}'`, "malformed");
  }
  return {environment, keyId, secret};
}

/**
 * Redact anything that looks like a key out of a string bound for a log.
 *
 * Prefix match, because the point is to catch a key nobody realised was in the string —
 * an error message that echoed a header, a stringified request. The `keyId` survives on
 * purpose: it is not a secret, and it is the only thing that makes a log line useful for
 * telling which key an incident involved.
 */
export function redact(line: string): string {
  return line.replace(
    /plazo_(test|live)_([A-Za-z0-9-]+)_[A-Za-z0-9_-]+/g,
    (_match, token: string, keyId: string) => `${KEY_PREFIX}_${token}_${keyId}_[redacted]`,
  );
}

function toRecord(row: typeof merchantApiKey.$inferSelect): KeyRecord {
  return {
    keyId: row.keyId,
    merchantId: row.merchantId,
    environment: row.environment as Environment,
    last4: row.last4,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    rotatedFrom: row.rotatedFrom,
  };
}

/**
 * A merchant account, or a refusal.
 *
 * Every issue path goes through this, so an environment disagreement between a merchant
 * and the key being minted for them is impossible to reach — not merely unlikely. The
 * check constraint on the column cannot express this relation; only a read of both rows
 * can (T-06-06-08).
 */
async function requireMerchant(db: Db, merchantId: string, environment: Environment) {
  const [merchant] = await db
    .select()
    .from(merchantAccount)
    .where(eq(merchantAccount.merchantId, merchantId))
    .limit(1);

  if (!merchant) throw new KeyError(`no merchant account ${merchantId}`, "unknown-merchant");
  if (merchant.environment !== environment) {
    throw new KeyError(
      `a ${environment} key cannot be issued to a ${merchant.environment} merchant`,
      "environment-mismatch",
    );
  }
  return merchant;
}

interface Mint {
  readonly keyId: string;
  readonly secret: string;
  readonly key: string;
  readonly last4: string;
  readonly secretHash: string;
}

/** 32 bytes of entropy, base64url, and the derived at-rest fields. */
function mint(environment: Environment): Mint {
  const keyId = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return {
    keyId,
    secret,
    key: `${KEY_PREFIX}_${ENVIRONMENT_TOKEN[environment]}_${keyId}_${secret}`,
    last4: secret.slice(-4),
    secretHash: sha256(secret),
  };
}

export interface IssueOptions {
  readonly merchantId: string;
  readonly environment: Environment;
  readonly rotatedFrom?: string | undefined;
  readonly now?: Date | undefined;
}

/**
 * Issue a key. The secret exists in this process and in the response, and nowhere else.
 */
export async function issueKey(db: Db, options: IssueOptions): Promise<IssuedKey> {
  await requireMerchant(db, options.merchantId, options.environment);

  const now = options.now ?? new Date();
  const minted = mint(options.environment);

  const [row] = await db
    .insert(merchantApiKey)
    .values({
      keyId: minted.keyId,
      merchantId: options.merchantId,
      environment: options.environment,
      secretHash: minted.secretHash,
      last4: minted.last4,
      createdAt: now,
      rotatedFrom: options.rotatedFrom ?? null,
    })
    .returning();

  return {record: toRecord(row!), key: minted.key};
}

/** Every key a merchant holds, newest first. Secrets are not on this path at all. */
export async function listKeys(db: Db, merchantId: string): Promise<KeyRecord[]> {
  const rows = await db
    .select()
    .from(merchantApiKey)
    .where(eq(merchantApiKey.merchantId, merchantId));

  return rows
    .map(toRecord)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export interface VerifyOptions {
  /**
   * The environment this deployment serves.
   *
   * Passed in rather than read from `process.env` inside the function, so that a test can
   * prove a sandbox key is refused by a live verifier without setting a global.
   */
  readonly environment: Environment;
  readonly now?: Date | undefined;
}

/**
 * Verify a presented key and return the merchant it authorises. Exactly one merchant.
 *
 * The order of the checks is deliberate. Shape first, so a wrong-environment key never
 * becomes a query. Then a single indexed read on the public `keyId`. Then the
 * constant-time secret compare. Then the lifecycle: revocation beats expiry, because
 * "compromised" must not be able to be outlived by "superseded".
 */
export async function verifyKey(
  db: Db,
  presented: string,
  options: VerifyOptions,
): Promise<MerchantIdentity> {
  const parsed = parseKey(presented);

  if (parsed.environment !== options.environment) {
    throw new KeyError(
      `a ${parsed.environment} key was presented to the ${options.environment} api`,
      "wrong-environment",
    );
  }

  const now = options.now ?? new Date();

  const [row] = await db
    .select({
      key: merchantApiKey,
      merchantEnvironment: merchantAccount.environment,
      address: merchantAccount.address,
    })
    .from(merchantApiKey)
    .leftJoin(merchantAccount, eq(merchantAccount.merchantId, merchantApiKey.merchantId))
    .where(eq(merchantApiKey.keyId, parsed.keyId))
    .limit(1);

  if (!row || !row.address) {
    // Compared anyway, so an unknown key id costs the same as a wrong secret.
    hashesMatch(sha256(parsed.secret), DECOY_HASH);
    throw new KeyError("no such api key", "unknown-key");
  }

  if (!hashesMatch(sha256(parsed.secret), row.key.secretHash)) {
    throw new KeyError("api key secret does not match", "bad-secret");
  }

  if (row.key.revokedAt && row.key.revokedAt.getTime() <= now.getTime()) {
    throw new KeyError("api key was revoked", "revoked");
  }
  if (row.key.expiresAt && row.key.expiresAt.getTime() <= now.getTime()) {
    throw new KeyError("api key expired at the end of its rotation overlap", "expired");
  }

  /**
   * The sandbox-settles-real-money check, in the code path and not only in the schema.
   *
   * Two rows each individually satisfying their check constraint can still disagree with
   * each other, and this is the disagreement that matters.
   */
  if (row.key.environment !== row.merchantEnvironment) {
    throw new KeyError(
      "api key environment disagrees with its merchant account",
      "environment-mismatch",
    );
  }

  return {
    merchantId: row.key.merchantId,
    keyId: row.key.keyId,
    environment: row.key.environment as Environment,
    address: row.address,
  };
}

export interface RotateOptions {
  /** How long the old key keeps working. Default 7 days, merchant-settable to 30. */
  readonly overlapDays?: number | undefined;
  readonly now?: Date | undefined;
  /**
   * Whose key this must be.
   *
   * Supplied by the route from the verified identity on the context. A rotation call that
   * did not check ownership would let any authenticated merchant rotate any key id they
   * could guess, and key ids are not secret.
   */
  readonly merchantId?: string | undefined;
}

/**
 * The outcome of a rotation: a new key, and the moment the old one stops working.
 */
export interface Rotation {
  readonly issued: IssuedKey;
  readonly retired: KeyRecord;
}

/**
 * Rotate with an overlap. Both keys authenticate until `retired.expiresAt`.
 */
export async function rotateKey(
  db: Db,
  keyId: string,
  options: RotateOptions = {},
): Promise<Rotation> {
  const overlapDays = options.overlapDays ?? DEFAULT_OVERLAP_DAYS;
  if (!Number.isFinite(overlapDays) || overlapDays < 0 || overlapDays > MAX_OVERLAP_DAYS) {
    throw new KeyError(
      `rotation overlap must be between 0 and ${MAX_OVERLAP_DAYS} days`,
      "overlap-out-of-range",
    );
  }

  const now = options.now ?? new Date();

  const [existing] = await db
    .select()
    .from(merchantApiKey)
    .where(eq(merchantApiKey.keyId, keyId))
    .limit(1);

  if (!existing) throw new KeyError(`no such api key ${keyId}`, "unknown-key");
  if (options.merchantId && existing.merchantId !== options.merchantId) {
    throw new KeyError("that api key belongs to another merchant", "not-yours");
  }

  const issued = await issueKey(db, {
    merchantId: existing.merchantId,
    environment: existing.environment as Environment,
    rotatedFrom: existing.keyId,
    now,
  });

  const expiresAt = new Date(now.getTime() + overlapDays * DAY_MS);
  const [retired] = await db
    .update(merchantApiKey)
    .set({expiresAt})
    .where(eq(merchantApiKey.keyId, keyId))
    .returning();

  return {issued, retired: toRecord(retired!)};
}

export interface RevokeOptions {
  readonly now?: Date | undefined;
  readonly merchantId?: string | undefined;
}

/**
 * Kill a key now.
 *
 * The row stays. A deleted key row is a rotation history with a hole in it, and the
 * question "which key was live when this settlement was originated" has to remain
 * answerable after the key is gone.
 */
export async function revokeKey(
  db: Db,
  keyId: string,
  options: RevokeOptions = {},
): Promise<KeyRecord> {
  const now = options.now ?? new Date();

  const where = options.merchantId
    ? and(eq(merchantApiKey.keyId, keyId), eq(merchantApiKey.merchantId, options.merchantId))
    : eq(merchantApiKey.keyId, keyId);

  const [row] = await db.update(merchantApiKey).set({revokedAt: now}).where(where).returning();
  if (!row) throw new KeyError(`no such api key ${keyId}`, "unknown-key");
  return toRecord(row);
}

/**
 * Create a sandbox merchant and their first key, in one call.
 *
 * This is the self-serve door, and it can only ever make a `sandbox` row. A live merchant
 * is created by an operator process after KYB and after `MerchantRegistry.attestKyb` on
 * chain — which is the belt to this braces: a sandbox key points at a deployment where
 * the attestation was never made, so even a key that somehow escaped its environment
 * would find the chain refusing to originate for it.
 */
export async function createSandboxMerchant(
  db: Db,
  address: string,
  now: Date = new Date(),
): Promise<{merchantId: string; address: string; issued: IssuedKey}> {
  const [existing] = await db
    .select()
    .from(merchantAccount)
    .where(eq(merchantAccount.address, address))
    .limit(1);

  const merchant =
    existing ??
    (
      await db
        .insert(merchantAccount)
        .values({address, environment: "sandbox", createdAt: now})
        .returning()
    )[0]!;

  if (merchant.environment !== "sandbox") {
    throw new KeyError(
      "that address already has a live merchant account; sandbox self-serve cannot issue against it",
      "environment-mismatch",
    );
  }

  const issued = await issueKey(db, {
    merchantId: merchant.merchantId,
    environment: "sandbox",
    now,
  });

  return {merchantId: merchant.merchantId, address: merchant.address, issued};
}
