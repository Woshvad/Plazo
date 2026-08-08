/**
 * Every environment variable `@plazo/fx` reads, documented here and nowhere else.
 *
 * **DEC-55.** `.env.example` scopes itself to the operator plane's database and says
 * why in its own header: a variable listed twice is one list eventually getting it
 * wrong, silently. The indexer's addresses live in `ponder.config.ts`, the keeper's
 * key lives in `packages/keeper/src/cli.ts`, and the FX service's seven variables
 * live here. Do not add them to `.env.example`.
 *
 * ## Pitfall 8 — the key's own prefix chooses a world
 *
 * A Circle API key carries its class in its first token: `TEST_API_KEY:…` trades on
 * Arc testnet, `LIVE_API_KEY:…` trades on production. Nothing about a misconfigured
 * deployment *fails*: a `LIVE` key in a sandbox process does not error, it settles
 * real euros against a sandbox book. So the class is asserted against
 * `PLAZO_ENVIRONMENT` at startup, printed in the banner, and a mismatch throws.
 *
 * That is exactly how `services/origination` already treats a merchant key — the
 * environment is in the prefix, the refusal is on shape, and it happens before
 * anything is looked up. The difference is only which side of the counter the key
 * sits on: theirs authenticates an inbound caller, this one authenticates *us* to a
 * venue that can move money.
 */
import {ARC_EURC, ARC_TESTNET_CHAIN_ID, ARC_USDC} from "@plazo/plan-core";
import type {Address} from "viem";

/**
 * Which world this deployment serves.
 *
 * Deliberately the same two words `services/origination` uses, because an operator
 * setting `PLAZO_ENVIRONMENT` once should not have to learn that two services spell
 * the same idea differently.
 */
export type Environment = "sandbox" | "live";

/** The class a Circle API key declares in its own first token. */
export type KeyClass = "TEST" | "LIVE";

/** Which key class each world requires. One row, so the mapping cannot drift. */
const CLASS_FOR: Record<Environment, KeyClass> = {sandbox: "TEST", live: "LIVE"};

/** Thrown whenever this service refuses to start rather than trade on a guess. */
export class FxConfigError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unknown-key-class"
      | "key-class-mismatch"
      | "insecure-base-url"
      | "unknown-environment",
  ) {
    super(message);
    this.name = "FxConfigError";
  }
}

/**
 * The class a key declares, from the key alone.
 *
 * Nothing is looked up and nothing is called. A key whose first token is neither
 * `TEST_API_KEY` nor `LIVE_API_KEY` is refused rather than assumed to be a test key:
 * "assume the safe one" is how a live key that arrived in an unexpected shape ends up
 * treated as harmless.
 *
 * The key itself is never returned, never logged and never included in a message —
 * only its class is, which is the one part of it that is not a secret.
 */
export function keyClassOf(key: string): KeyClass {
  const [token] = key.split(":");
  if (token === "TEST_API_KEY") return "TEST";
  if (token === "LIVE_API_KEY") return "LIVE";
  throw new FxConfigError(
    "PLAZO_STABLEFX_API_KEY does not begin with TEST_API_KEY: or LIVE_API_KEY:, so its class " +
      "cannot be determined. A key of unknown class is refused rather than assumed to be a test key.",
    "unknown-key-class",
  );
}

/**
 * Pitfall 8, as a startup assertion.
 *
 * Throws naming **both** sides, because "environment mismatch" tells an operator
 * nothing they can act on and "a LIVE key was presented to the sandbox deployment"
 * tells them which of the two to change.
 */
export function assertKeyClassMatchesEnvironment(key: string, environment: Environment): KeyClass {
  const required = CLASS_FOR[environment];
  if (!required) {
    throw new FxConfigError(
      `PLAZO_ENVIRONMENT is '${String(environment)}', which is neither 'sandbox' nor 'live'`,
      "unknown-environment",
    );
  }
  const actual = keyClassOf(key);
  if (actual !== required) {
    throw new FxConfigError(
      `a ${actual} StableFX key was presented to the '${environment}' deployment, which requires a ` +
        `${required} key. A ${actual} key here would not fail — it would trade on the wrong network.`,
      "key-class-mismatch",
    );
  }
  return actual;
}

/**
 * The default StableFX host per world.
 *
 * Circle publishes one sandbox host and one production host; the StableFX taker paths
 * hang off `/v1/exchange/stablefx/…` on both. Overridable by `PLAZO_STABLEFX_BASE_URL`
 * so a recorded-proxy or a future regional host needs no code change, but the override
 * is still forced through `requireHttps` — a bearer key that can move value must never
 * leave the process over cleartext.
 */
export const DEFAULT_BASE_URL: Record<Environment, string> = {
  sandbox: "https://api-sandbox.circle.com",
  live: "https://api.circle.com",
};

/** HTTPS or nothing. A base URL is the one place a downgrade would be invisible. */
export function requireHttps(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new FxConfigError(`PLAZO_STABLEFX_BASE_URL is not a URL: ${baseUrl}`, "insecure-base-url");
  }
  if (parsed.protocol !== "https:") {
    throw new FxConfigError(
      `PLAZO_STABLEFX_BASE_URL must be https; got ${parsed.protocol}//. The StableFX bearer key ` +
        "can move value, and a cleartext hop is a key given away.",
      "insecure-base-url",
    );
  }
  return parsed.origin;
}

/**
 * Everything this service reads from the environment.
 *
 * Addresses are `undefined` rather than defaulted when unset, except the two token
 * addresses, which are Arc facts rather than deployment choices (`packages/plan-core`
 * carries them and `07-01` re-derived EURC's EIP-712 domain against the live contract).
 * A missing *deployment* address must surface as a refusing seam, not as a zero address
 * a transaction is sent to.
 */
export interface FxConfig {
  /** `PLAZO_ENVIRONMENT` — which world this deployment serves. Default `sandbox`. */
  readonly environment: Environment;
  /**
   * `PLAZO_STABLEFX_API_KEY` — the KYB/AML-gated taker credential.
   *
   * Absent in every deployment today (E-03). Its absence is what makes
   * `resolveFxVenue` return the refusing stub.
   */
  readonly apiKey: string | undefined;
  /** The key's own declared class, once asserted against `environment`. */
  readonly keyClass: KeyClass | undefined;
  /** `PLAZO_STABLEFX_BASE_URL` — defaults per world, always https. */
  readonly baseUrl: string;
  /**
   * `PLAZO_FX_MID_SIGNER_KEY` — the EOA that must hold `FxDeviationGuard.FX_SIGNER_ROLE`.
   *
   * Read into memory and never written anywhere. A mid it signs can only ever make the
   * guard *refuse* a fill (`FxMidAttestation`'s header), so a stolen signer buys the
   * ability to decline trades, not to mint value — but it is still a chain-writing key.
   */
  readonly midSignerKey: string | undefined;
  /** `PLAZO_EURC_ADDRESS` — defaults to the verified Arc testnet EURC (finding 31). */
  readonly eurc: Address;
  /** The other side of the only corridor this phase builds. Not configurable. */
  readonly usdc: Address;
  /** `PLAZO_FX_GUARD_ADDRESS` — `FxDeviationGuard`, the mid's EIP-712 verifying contract. */
  readonly guard: Address | undefined;
  /** `PLAZO_ORIGINATION_PAUSE_ADDRESS` — the breaker's one and only onchain effect. */
  readonly originationPause: Address | undefined;
  /**
   * `PLAZO_FX_PARAMETER_REGISTRY_ADDRESS` — the **third** registry instance (E-01).
   *
   * Every breaker threshold and the mid's TTL ceiling are rows here rather than
   * compiled constants, so an outsider can audit the trigger. DEC-18 applied the same
   * reasoning to the relayer's delay floor.
   */
  readonly parameterRegistry: Address | undefined;
  /** The chain the mid's EIP-712 domain names. Arc testnet unless overridden. */
  readonly chainId: number;
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function address(value: string | undefined, name: string): Address | undefined {
  if (value === undefined || value === "") return undefined;
  if (!HEX_ADDRESS.test(value)) {
    throw new FxConfigError(`${name} is not a 20-byte hex address: ${value}`, "insecure-base-url");
  }
  return value as Address;
}

/**
 * Read the environment once, assert what can be asserted, and hand back a frozen record.
 *
 * `env` is a parameter rather than a direct `process.env` read so a test can prove a
 * `LIVE` key under `sandbox` is refused without setting a global — the same reason
 * `verifyKey` takes its environment rather than reading one.
 */
export function readFxConfig(env: NodeJS.ProcessEnv = process.env): FxConfig {
  const environment = (env["PLAZO_ENVIRONMENT"] as Environment | undefined) ?? "sandbox";
  if (environment !== "sandbox" && environment !== "live") {
    throw new FxConfigError(
      `PLAZO_ENVIRONMENT is '${String(environment)}', which is neither 'sandbox' nor 'live'`,
      "unknown-environment",
    );
  }

  const apiKey = env["PLAZO_STABLEFX_API_KEY"] || undefined;
  const keyClass = apiKey === undefined ? undefined : assertKeyClassMatchesEnvironment(apiKey, environment);

  const chainIdRaw = env["PLAZO_FX_CHAIN_ID"];
  const chainId = chainIdRaw === undefined || chainIdRaw === "" ? ARC_TESTNET_CHAIN_ID : Number(chainIdRaw);

  return Object.freeze({
    environment,
    apiKey,
    keyClass,
    baseUrl: requireHttps(env["PLAZO_STABLEFX_BASE_URL"] || DEFAULT_BASE_URL[environment]),
    midSignerKey: env["PLAZO_FX_MID_SIGNER_KEY"] || undefined,
    eurc: address(env["PLAZO_EURC_ADDRESS"], "PLAZO_EURC_ADDRESS") ?? ARC_EURC,
    usdc: ARC_USDC,
    guard: address(env["PLAZO_FX_GUARD_ADDRESS"], "PLAZO_FX_GUARD_ADDRESS"),
    originationPause: address(env["PLAZO_ORIGINATION_PAUSE_ADDRESS"], "PLAZO_ORIGINATION_PAUSE_ADDRESS"),
    parameterRegistry: address(
      env["PLAZO_FX_PARAMETER_REGISTRY_ADDRESS"],
      "PLAZO_FX_PARAMETER_REGISTRY_ADDRESS",
    ),
    chainId,
  });
}
