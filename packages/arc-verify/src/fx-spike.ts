/**
 * The corridor's preconditions, measured before anything is designed around them.
 *
 * Phase 6 spent about one USDC on a real `depositForBurn` in its first wave, and three
 * later plans stopped guessing as a result. Phase 7 has two questions of the same shape
 * and neither has ever been asked:
 *
 *   1. Does this project hold, or can it obtain, any EURC on Arc testnet at all? Every
 *      live EURC criterion in the phase — seeding the EURC book, originating a EURC plan,
 *      collecting a EURC check — is downstream of the answer, and the repo has only ever
 *      drawn USDC.
 *   2. Is there an AMM on Arc testnet with real USDC/EURC liquidity? Arc's own
 *      contract-address reference lists no DEX. If nothing quotes, the answer is "no" and
 *      FX-05's deviation guard ships against a stubbed venue whose address is a
 *      constructor argument set to zero. A fabricated liquidity claim is a wrong number
 *      in a credit system; a clean negative is a successful spike.
 *
 * Alongside them, three chain reads that stop later plans inheriting a contradiction:
 * EURC's EIP-3009 surface, USYC's lack of one, and the two live FxEscrow candidates.
 *
 * Nothing here sends a transaction and nothing here calls `eth_estimateGas`. Every read
 * goes through `shed()` imported from `./slice.js` — Arc's public RPC sheds roughly a
 * quarter of requests regardless of pacing, and a shed `balanceOf` read as a zero balance
 * would report the corridor unfundable when it is not.
 *
 * Every branch exits 0. An unmet precondition is a measured number with its arithmetic
 * beside it, exactly as `gov08.ts` reports its funding gap — not a failure.
 */
import {
  encodeAbiParameters,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  ARC_EURC,
  ARC_TESTNET_CHAIN_ID,
  ARC_USYC,
  ARC_USYC_TELLER,
  ERC3009_TYPEHASHES,
} from "@plazo/plan-core";

import {shed} from "./slice.js";

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function CANCEL_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

const TELLER_ABI = parseAbi(["function oracle() view returns (address)"]);

const ESCROW_ABI = parseAbi([
  "function owner() view returns (address)",
  "function PERMIT2() view returns (address)",
]);

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * `keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`.
 *
 * The four-field form. Gateway's two-field domain (DEC-37) is a different animal and is
 * not what a FiatToken uses.
 */
const EIP712_DOMAIN_TYPEHASH =
  "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f" as const;

/** ERC-1967 implementation slot: `keccak256("eip1967.proxy.implementation") - 1`. */
const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/**
 * The two live FxEscrow candidates, and why neither is exported.
 *
 * CLAUDE.md names the first; Arc's own contract-address reference names the second. Both
 * hold code. E-04 forbids resolving the disagreement by picking one, because the
 * `verifyingContract` a StableFX settlement signs against arrives in the API response's
 * `typedData.domain` and is read from there at runtime. A compiled constant named
 * `FX_ESCROW` is therefore a defect anywhere in this tree — the same class of error as
 * hardcoding a `DOMAIN_SEPARATOR`, which CLAUDE.md already forbids, and with the same
 * failure mode: it is silently wrong rather than loudly broken.
 *
 * These live inside `probeFxEscrowCandidates` as probe targets. Nothing reads them as an
 * answer and the function deliberately returns no "correct" row.
 */
const ESCROW_CANDIDATES = [
  {
    label: "CLAUDE.md — Part 1 deployed-infrastructure table",
    address: "0x867650F5eAe8df91445971f14d89fd84F0C9a9f8" as Address,
  },
  {
    label: "Arc docs — /arc/references/contract-addresses",
    address: "0xd68256f4D69C6BbEcB873D8588AE0Dc6B8E22E10" as Address,
  },
] as const;

// ─── Formatting ───────────────────────────────────────────────────────────────

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.trim() ?? "unknown";
}

// ─── 1. EURC's EIP-3009 surface, read from the deployed bytecode ──────────────

export interface EurcFacts {
  name: string;
  symbol: string;
  decimals: number;
  version: string;
  domainSeparator: Hex;
  receiveTypehash: Hex;
  transferTypehash: Hex;
  cancelTypehash: Hex;
  derivedSeparator: Hex;
  separatorMatches: boolean;
  typehashesCanonical: boolean;
}

/**
 * Reads EURC's EIP-3009 surface off chain 5042002 rather than off a document.
 *
 * Finding 30 is why this exists at all: a deployed contract whose signature has moved
 * answers some selectors and reverts on others, and the only way to know which is to ask
 * it. CLAUDE.md asserts EURC carries full EIP-3009 with canonical typehashes; this turns
 * that sentence into four `eth_call`s.
 *
 * The domain separator is **derived from the four fields and compared**, never cached. It
 * embeds `chainId` and `verifyingContract`, both of which move on mainnet, and a stored
 * value would make every outstanding EURC strip silently fail to validate the day the
 * config flips. That is the same rule CLAUDE.md already applies to USDC, applied to the
 * second currency.
 *
 * `chainId` is a parameter rather than a chain read on purpose: the separator comparison
 * is what verifies it. If the derived value matches the contract's own, then the name,
 * the version, the chain id and the verifying contract were all four correct at once, and
 * a mismatch says loudly that one of them is not what this build believes.
 */
export async function readEurcFacts(
  publicClient: PublicClient,
  chainId: number = ARC_TESTNET_CHAIN_ID,
): Promise<EurcFacts> {
  const token = ARC_EURC;

  const name = await shed(() =>
    publicClient.readContract({address: token, abi: TOKEN_ABI, functionName: "name"}),
  );
  const symbol = await shed(() =>
    publicClient.readContract({address: token, abi: TOKEN_ABI, functionName: "symbol"}),
  );
  const version = await shed(() =>
    publicClient.readContract({address: token, abi: TOKEN_ABI, functionName: "version"}),
  );
  const decimals = await shed(() =>
    publicClient.readContract({address: token, abi: TOKEN_ABI, functionName: "decimals"}),
  );
  const domainSeparator = await shed(() =>
    publicClient.readContract({address: token, abi: TOKEN_ABI, functionName: "DOMAIN_SEPARATOR"}),
  );
  const receiveTypehash = await shed(() =>
    publicClient.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: "RECEIVE_WITH_AUTHORIZATION_TYPEHASH",
    }),
  );
  const transferTypehash = await shed(() =>
    publicClient.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: "TRANSFER_WITH_AUTHORIZATION_TYPEHASH",
    }),
  );
  const cancelTypehash = await shed(() =>
    publicClient.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: "CANCEL_AUTHORIZATION_TYPEHASH",
    }),
  );

  const derivedSeparator = keccak256(
    encodeAbiParameters(
      [{type: "bytes32"}, {type: "bytes32"}, {type: "bytes32"}, {type: "uint256"}, {type: "address"}],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toHex(name)),
        keccak256(toHex(version)),
        BigInt(chainId),
        token,
      ],
    ),
  );

  return {
    name,
    symbol,
    decimals,
    version,
    domainSeparator,
    receiveTypehash,
    transferTypehash,
    cancelTypehash,
    derivedSeparator,
    separatorMatches: derivedSeparator.toLowerCase() === domainSeparator.toLowerCase(),
    typehashesCanonical:
      receiveTypehash.toLowerCase() === ERC3009_TYPEHASHES.receiveWithAuthorization &&
      transferTypehash.toLowerCase() === ERC3009_TYPEHASHES.transferWithAuthorization &&
      cancelTypehash.toLowerCase() === ERC3009_TYPEHASHES.cancelAuthorization,
  };
}

// ─── 2. USYC's absence of one, proven by a live revert ────────────────────────

export interface UsycFacts {
  symbol: string;
  decimals: number;
  hasEip3009: boolean;
  eip3009Revert: string;
  authorizationStateRevert: string;
  hasPermit: boolean;
  domainSeparator: Hex | null;
  tellerOracle: Address | null;
  tellerOracleRevert: string;
}

/**
 * E-07's "USYC is permit-only" as two reverting selectors rather than as a sentence.
 *
 * A Tier-2 pledge therefore moves by `approve`/`transferFrom` and never by a check strip
 * — DEC-28's precedent, and CLAUDE.md names attempting check collection in USYC as a
 * thing not to do.
 *
 * The Teller's `oracle()` is read and recorded, and recording it is the whole of what
 * this repo may do with it. **Nothing in the contract tree may read that address** (C1):
 * the balance sheet is all-dollar, there is no volatile collateral, and a price feed
 * re-adds an attack surface for nothing. `tools/check-no-oracle.mjs` turns that into a
 * build failure in plan 07-02.
 */
export async function readUsycFacts(publicClient: PublicClient): Promise<UsycFacts> {
  const token = ARC_USYC;

  const symbol = await shed(() =>
    publicClient.readContract({address: token, abi: TOKEN_ABI, functionName: "symbol"}),
  );
  const decimals = await shed(() =>
    publicClient.readContract({address: token, abi: TOKEN_ABI, functionName: "decimals"}),
  );

  let hasEip3009 = false;
  let eip3009Revert = "";
  try {
    await shed(() =>
      publicClient.readContract({
        address: token,
        abi: TOKEN_ABI,
        functionName: "RECEIVE_WITH_AUTHORIZATION_TYPEHASH",
      }),
    );
    hasEip3009 = true;
  } catch (error) {
    eip3009Revert = reason(error);
  }

  let authorizationStateRevert = "";
  try {
    await shed(() =>
      publicClient.readContract({
        address: token,
        abi: TOKEN_ABI,
        functionName: "authorizationState",
        args: [token, ERC3009_TYPEHASHES.receiveWithAuthorization as Hex],
      }),
    );
    hasEip3009 = true;
  } catch (error) {
    authorizationStateRevert = reason(error);
  }

  let domainSeparator: Hex | null = null;
  try {
    domainSeparator = await shed(() =>
      publicClient.readContract({address: token, abi: TOKEN_ABI, functionName: "DOMAIN_SEPARATOR"}),
    );
  } catch {
    domainSeparator = null;
  }

  let tellerOracle: Address | null = null;
  let tellerOracleRevert = "";
  try {
    tellerOracle = await shed(() =>
      publicClient.readContract({
        address: ARC_USYC_TELLER,
        abi: TELLER_ABI,
        functionName: "oracle",
      }),
    );
  } catch (error) {
    tellerOracleRevert = reason(error);
  }

  return {
    symbol,
    decimals,
    hasEip3009,
    eip3009Revert,
    authorizationStateRevert,
    hasPermit: domainSeparator !== null,
    domainSeparator,
    tellerOracle,
    tellerOracleRevert,
  };
}

// ─── 3. The two FxEscrow candidates, neither of them an answer ────────────────

export interface FxEscrowRow {
  label: string;
  address: Address;
  hasCode: boolean;
  codeSize: number;
  implementation: Address | null;
  owner: Address | null;
  permit2: Address | null;
}

export interface FxEscrowProbe {
  rows: FxEscrowRow[];
  implementationsDiffer: boolean;
}

/**
 * Probes both live FxEscrow addresses and **deliberately declines to pick one**.
 *
 * E-04: CLAUDE.md names `0x867650F5…`, Arc's own contract-address reference names
 * `0xd68256f4…`, and both hold code. The resolution is not a choice — the
 * `verifyingContract` a StableFX settlement signs against arrives in the API response's
 * `typedData.domain`, and 07-08 reads it from there and zod-validates that it is present.
 *
 * So this function returns two rows and a boolean, and no field on the result is named or
 * shaped so that a later reader could mistake it for a resolved address. **The constant
 * that must never exist anywhere in this tree is `FX_ESCROW`** — writing it down here, in
 * a comment, is the only place the identifier is allowed to appear.
 */
export async function probeFxEscrowCandidates(publicClient: PublicClient): Promise<FxEscrowProbe> {
  const rows: FxEscrowRow[] = [];

  for (const candidate of ESCROW_CANDIDATES) {
    const code = await shed(() => publicClient.getCode({address: candidate.address}));
    const hasCode = code !== undefined && code !== "0x";

    let implementation: Address | null = null;
    if (hasCode) {
      const slot = await shed(() =>
        publicClient.getStorageAt({address: candidate.address, slot: ERC1967_IMPLEMENTATION_SLOT}),
      );
      if (slot && slot !== `0x${"0".repeat(64)}`) {
        implementation = `0x${slot.slice(-40)}` as Address;
      }
    }

    let owner: Address | null = null;
    if (hasCode) {
      try {
        owner = await shed(() =>
          publicClient.readContract({
            address: candidate.address,
            abi: ESCROW_ABI,
            functionName: "owner",
          }),
        );
      } catch {
        owner = null;
      }
    }

    let permit2: Address | null = null;
    if (hasCode) {
      try {
        permit2 = await shed(() =>
          publicClient.readContract({
            address: candidate.address,
            abi: ESCROW_ABI,
            functionName: "PERMIT2",
          }),
        );
      } catch {
        permit2 = null;
      }
    }

    rows.push({
      label: candidate.label,
      address: candidate.address,
      hasCode,
      codeSize: hasCode && code ? (code.length - 2) / 2 : 0,
      implementation,
      owner,
      permit2,
    });
  }

  const implementations = rows.map((row) => (row.implementation ?? "").toLowerCase());
  const implementationsDiffer =
    implementations.length === 2 && implementations[0] !== implementations[1];

  return {rows, implementationsDiffer};
}
