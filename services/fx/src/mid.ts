/**
 * The signed mid, as this service produces it and as `FxDeviationGuard` will read it.
 *
 * The TypeScript half of `contracts/src/libraries/FxMidAttestation.sol` (plan 07-03). One
 * struct, one type string, one domain — and all three have to agree with the Solidity
 * **byte for byte**, because an EIP-712 disagreement does not fail loudly. It produces a
 * digest the contract has never seen, `ECDSA.recover` returns some other address, and the
 * guard reports an unauthorised signer for a signature that was, in fact, correctly made.
 *
 * **DEC-37 is what that looks like when it happens.** Circle Gateway's domain is
 * `{name, version}` only; adding `chainId` — which every other EIP-712 surface in this
 * repository does — made every burn intent silently unverifiable. The lesson taken from
 * it here is not "be careful": it is that a domain must never be *assumed*. So
 * `MID_TYPE_STRING` is **derived from `MID_TYPES`** rather than typed out beside it, and
 * `test/venue.test.ts` hashes it and compares against the type string read out of the
 * Solidity source. Permuting two fields of the struct turns that test red.
 *
 * ## What a mid can and cannot do
 *
 * It can only make the guard **refuse**. `FxMidAttestation`'s own header says it, and
 * `tools/check-no-oracle.mjs` names the library as the one legal shape a price may take
 * on chain: a signed, band-bounded, short-TTL floor a fill must beat. It cannot value a
 * position, raise a limit or price a payout. A stolen signing key therefore buys the
 * ability to decline trades the chain would have allowed — which is a real harm, and a
 * much smaller one than an oracle key.
 */
import {encodeAbiParameters, keccak256, stringToHex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import type {Address, Hex} from "viem";

import {rateToE18} from "./schemas.js";

/**
 * The struct, in declaration order, mirrored from `FxMidAttestation.Mid`.
 *
 * **Field order is part of the commitment.** Transposing two fields of the same ABI width
 * changes nothing the compiler can see and everything the signature means — the Solidity
 * header says exactly that, and this is the copy it says must be read together with it.
 */
export const MID_TYPES = {
  FxMidAttestation: [
    {name: "corridor", type: "bytes32"},
    {name: "fromToken", type: "address"},
    {name: "toToken", type: "address"},
    {name: "midE18", type: "uint256"},
    {name: "validUntil", type: "uint256"},
    {name: "sessionId", type: "bytes32"},
  ],
} as const;

export const MID_PRIMARY_TYPE = "FxMidAttestation" as const;

/**
 * The canonical EIP-712 type string, **derived** from `MID_TYPES` and never transcribed.
 *
 * Two declarations of the same thing are two things that can disagree. There is one here,
 * and the string is a projection of it.
 */
export const MID_TYPE_STRING: string = `${MID_PRIMARY_TYPE}(${MID_TYPES[MID_PRIMARY_TYPE].map(
  (field) => `${field.type} ${field.name}`,
).join(",")})`;

/** `keccak256(MID_TYPE_STRING)`. Compared against the Solidity `MID_TYPEHASH` in test. */
export const MID_TYPEHASH: Hex = keccak256(stringToHex(MID_TYPE_STRING));

/** One EIP-712 domain family for the whole protocol; only `verifyingContract` differs. */
export const DOMAIN_NAME = "Plazo" as const;
export const DOMAIN_VERSION = "1" as const;

/** The mid a signer commits to. Money-shaped fields are `bigint`, never `number`. */
export interface FxMid {
  readonly corridor: Hex;
  readonly fromToken: Address;
  readonly toToken: Address;
  readonly midE18: bigint;
  readonly validUntil: bigint;
  readonly sessionId: Hex;
}

/**
 * `CheckoutRouter.corridorOf(token)`, reproduced.
 *
 * `keccak256(abi.encode("PLAZO.CORRIDOR", token))` — and the string literal is encoded by
 * solc as a **dynamic `string`**, not packed and not padded into a word: offset, address,
 * length 14, then the bytes. That was measured against solc 0.8.30 rather than assumed,
 * because the two encodings differ and both look plausible in source.
 *
 * There is exactly one derivation of a corridor id in this repository and this is the
 * mirror of it. A second, subtly different one would produce a pause on a corridor no
 * origination ever checks — a breaker that trips into thin air.
 */
export function corridorOf(token: Address): Hex {
  return keccak256(
    encodeAbiParameters([{type: "string"}, {type: "address"}], [CORRIDOR_LABEL, token]),
  );
}

/** The literal inside `corridorOf`. Named so the mirror is greppable from both sides. */
export const CORRIDOR_LABEL = "PLAZO.CORRIDOR" as const;

/**
 * The EIP-712 payload for a mid verified by `guard`.
 *
 * The domain is built from the four fields at call time, exactly as
 * `FxMidAttestation.domainSeparator` does, and for the same reason C8 gives: a separator
 * embeds `chainId`, so a cached one is silently wrong the day the config flips to another
 * network. `verifyingContract` here is **the guard** — this is Plazo's own attestation and
 * Plazo's own domain, which is a different object entirely from the Permit2 domain
 * `venue.ts` receives from StableFX and passes through untouched.
 */
export function midTypedData(mid: FxMid, chainId: number, guard: Address) {
  return {
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId,
      verifyingContract: guard,
    },
    types: MID_TYPES,
    primaryType: MID_PRIMARY_TYPE,
    message: {
      corridor: mid.corridor,
      fromToken: mid.fromToken,
      toToken: mid.toToken,
      midE18: mid.midE18,
      validUntil: mid.validUntil,
      sessionId: mid.sessionId,
    },
  } as const;
}

/**
 * A read of the third `ParameterRegistry` instance.
 *
 * Injected rather than constructed so the clamp is testable without a chain, and so the
 * service reads the *same row the guard reads* rather than a constant that agrees with it
 * today. DEC-18's reasoning: a bound an outsider can audit is a bound.
 */
export interface FxParameterReader {
  get(key: Hex): Promise<bigint>;
}

/** The four `plazo.fx.*` rows this service reads. Seeded by plan 07-02; never written here. */
export const FX_PARAMETER_KEYS = {
  midMaxTtl: keccak256(stringToHex("plazo.fx.midMaxTtl")),
  quoteMaxAge: keccak256(stringToHex("plazo.fx.quoteMaxAge")),
  roundtripMaxBps: keccak256(stringToHex("plazo.fx.roundtripMaxBps")),
  parBandBps: keccak256(stringToHex("plazo.fx.parBandBps")),
  maxDeviationBps: keccak256(stringToHex("plazo.fx.maxDeviationBps")),
} as const;

export interface SignMidInput {
  /** The corridor bucket, from `corridorOf`. */
  readonly corridor: Hex;
  readonly fromToken: Address;
  readonly toToken: Address;
  /** The **parsed** rate, as a decimal string. Never a raw response field. */
  readonly rate: string;
  readonly sessionId: Hex;
  /** How long the caller would like the mid to live, in seconds. Clamped below. */
  readonly ttlSeconds: bigint;
}

export interface SignMidOptions {
  readonly chainId: number;
  readonly guard: Address;
  /** `PLAZO_FX_MID_SIGNER_KEY`. Must hold `FxDeviationGuard.FX_SIGNER_ROLE`. */
  readonly privateKey: Hex;
  readonly parameters: FxParameterReader;
  /** Unix seconds. Injected so a test does not race a clock. */
  readonly now: bigint;
}

export interface SignedMid {
  readonly mid: FxMid;
  readonly signature: Hex;
  /** The ceiling that was applied, so a caller can see it was applied. */
  readonly maxTtlSeconds: bigint;
  /** Whether the requested TTL was cut down. */
  readonly clamped: boolean;
}

/**
 * Sign a mid, having validated first and clamped second.
 *
 * **Validate before signing, never after (V5).** `rate` arrives as a decimal string that
 * has already been through `schemas.ts`, and `rateToE18` re-parses it here rather than
 * trusting the caller — the conversion is the last place a bad number can be stopped
 * before it becomes this operator's signature.
 *
 * **The TTL is clamped, not checked.** `FX_MID_MAX_TTL` is read from the registry at sign
 * time, and a longer request is cut down rather than refused. The guard applies the same
 * row and reverts `MidTooLong` above it, so a service that signed long would be producing
 * signatures the chain is guaranteed to reject — a self-inflicted outage whose cause is
 * invisible from the failed origination. Clamping makes the service structurally unable to
 * sign something the guard will refuse.
 */
export async function signMid(input: SignMidInput, options: SignMidOptions): Promise<SignedMid> {
  const midE18 = rateToE18(input.rate);
  const maxTtlSeconds = await options.parameters.get(FX_PARAMETER_KEYS.midMaxTtl);
  const requested = input.ttlSeconds < 0n ? 0n : input.ttlSeconds;
  const granted = requested > maxTtlSeconds ? maxTtlSeconds : requested;

  const mid: FxMid = {
    corridor: input.corridor,
    fromToken: input.fromToken,
    toToken: input.toToken,
    midE18,
    validUntil: options.now + granted,
    sessionId: input.sessionId,
  };

  const account = privateKeyToAccount(options.privateKey);
  const signature = await account.signTypedData(midTypedData(mid, options.chainId, options.guard));

  return {mid, signature, maxTtlSeconds, clamped: granted < requested};
}
