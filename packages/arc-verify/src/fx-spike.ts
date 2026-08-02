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
  createPublicClient,
  encodeAbiParameters,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {arcTestnet} from "viem/chains";

import {
  ARC_EURC,
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_RPC_URL,
  ARC_USDC,
  ARC_USYC,
  ARC_USYC_TELLER,
  ERC3009_TYPEHASHES,
} from "@plazo/plan-core";

import {faucetAccount} from "./faucet.js";
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

/** Uniswap-v2 shape. Routers expose it as a plain view. */
const V2_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
]);

/**
 * Uniswap-v3 `QuoterV2` shape.
 *
 * Declared `view` here deliberately. On the real quoter it is non-payable — it reverts
 * inside a swap and decodes the revert data — but every client calls it with `eth_call`
 * anyway, and this module only ever calls, never sends.
 */
const V3_QUOTER_ABI = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
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

/**
 * The compiled minimum ticket a EURC plan must be able to front, in EURC's 6 decimals.
 */
const EURC_MIN_TICKET = 75_000_000n;

/**
 * What a virgin EURC book needs behind that ticket.
 *
 * Finding 13's arithmetic, applied to the second currency: UW-02 caps Tier-0 paper at a
 * share of the pool and the compiled band's ceiling is 25%, so `MIN_TICKET` of 75 needs
 * 4x that — 300 — of book capitalisation before `MIN_RESERVE_BPS`,
 * `MIN_SUBORDINATION_BPS` and the Tier-0 book-share cap all clear and the headroom
 * actually reaches the ticket. Widening a band to make a testnet run fit is forbidden
 * (DEC-02); the requirement is the control working.
 */
const EURC_BOOK_SEED = 4n * EURC_MIN_TICKET;

/**
 * EURC the corridor needs before a live EURC origination is attemptable.
 *
 *     300.00  book capitalisation (4x MIN_TICKET, finding 13)
 *   +  75.00  the borrower's ticket
 *   = 375.00  EURC
 *
 * This is **on top of** the USDC position, not instead of it: STATE.md records the
 * deployer at ~80.43 USDC against a 409.84 peak requirement, so the credit half is
 * already 329.41 short. Nothing here spends USDC — the figure is stated so a later plan
 * budgets both rather than discovering the second one.
 */
export const EURC_SEED_REQUIRED = EURC_BOOK_SEED + EURC_MIN_TICKET;

/**
 * The measured USDC drip at `faucet.circle.com`, per address per request.
 *
 * Provenance: finding 34's predecessor — the GOV-08 top-up procedure measured ~20 USDC
 * per address across seventeen implied visits. **Whether the same faucet dispenses EURC
 * at all, let alone at this size, is the question this module exists to answer**, so this
 * constant is used only to express the USDC shortfall and never to project a EURC one.
 */
const FAUCET_DRIP = 20_000_000n;

/** How many derived collection addresses to check for EURC. */
const FAUCET_PROBE_COUNT = 3;

/**
 * The AMM candidates, every one of them LOW confidence and every one carrying its source.
 *
 * **No DEX appears in Arc's official contract-address reference.** 07-RESEARCH.md's
 * tertiary sources name Coco DEX, Tower Exchange and a claim that Curve is on Arc — none
 * in a primary source, and **none of the three publishes an Arc-testnet contract
 * address**, so none of them can be probed by address. What can be probed is the set of
 * canonical addresses a standard fork lands on when it is deployed by the usual
 * deterministic means; if a Uniswap-shaped venue exists on Arc at all, one of these is
 * where it is most likely to be.
 *
 * A row here is a hypothesis, not a venue. `withCode` and `quoting` are separate fields
 * precisely so that "something is deployed there" can never be reported as "it quotes",
 * and `best` stays `null` unless a quote actually returned a number.
 */
export interface AmmCandidate {
  label: string;
  address: Address;
  source: string;
  confidence: "low";
  shape: "uniswap-v2" | "uniswap-v3";
}

export const AMM_CANDIDATES: readonly AmmCandidate[] = [
  {
    label: "Uniswap v3 QuoterV2",
    address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    source: "Uniswap canonical cross-chain deployment address; not listed for Arc",
    confidence: "low",
    shape: "uniswap-v3",
  },
  {
    label: "Uniswap v3 SwapRouter02",
    address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    source: "Uniswap canonical cross-chain deployment address; not listed for Arc",
    confidence: "low",
    shape: "uniswap-v3",
  },
  {
    label: "Uniswap v3 Factory",
    address: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    source: "Uniswap canonical cross-chain deployment address; not listed for Arc",
    confidence: "low",
    shape: "uniswap-v3",
  },
  {
    label: "Uniswap v2 Router02",
    address: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    source: "Uniswap v2 mainnet router, the address forks most often reuse",
    confidence: "low",
    shape: "uniswap-v2",
  },
  {
    label: "Uniswap v2 Factory",
    address: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    source: "Uniswap v2 mainnet factory, the address forks most often reuse",
    confidence: "low",
    shape: "uniswap-v2",
  },
  {
    label: "Uniswap UniversalRouter",
    address: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af",
    source: "Uniswap canonical cross-chain deployment address; not listed for Arc",
    confidence: "low",
    shape: "uniswap-v2",
  },
  {
    label: "Curve Router NG",
    address: "0xF0d4c12A5768D806021F80a262B4d39d26C58b8D",
    source: "Curve docs cross-chain router; the 'Curve is on Arc' claim has no primary source",
    confidence: "low",
    shape: "uniswap-v2",
  },
];

/** One hundred units of the sold currency. Small enough that a real pool would fill it. */
const QUOTE_NOTIONAL = 100_000_000n;

/** The fee tiers a stablecoin pair would plausibly use, in hundredths of a bip. */
const V3_FEE_TIERS = [100, 500, 3_000] as const;

// ─── Formatting ───────────────────────────────────────────────────────────────

function money(value: bigint, symbol: string): string {
  return `${formatUnits(value, 6)} ${symbol}`;
}

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

// ─── 4. The EURC funding position, and the faucet question ────────────────────

export interface FaucetProbeRow {
  index: number;
  address: Address;
  eurc: bigint;
}

export interface CorridorFunding {
  deployer: Address;
  eurcHeld: bigint;
  usdcHeld: bigint;
  required: bigint;
  funded: boolean;
  shortfall: bigint;
  faucetRows: FaucetProbeRow[];
  faucetEurcTotal: bigint;
  eurcEverObtained: bigint;
  usdcShortfallVisits: bigint;
}

/**
 * The EURC precondition, read first and reported as a branch.
 *
 * **The faucet is not called and is not pretended to be called.** `faucet.circle.com` is
 * an interactive, captcha-gated web form with no public API; a function here that
 * `fetch`ed it would either fail or, worse, look like it had succeeded. What is
 * measurable without lying is *how much EURC this project has ever been able to obtain* —
 * the deployer's balance plus the balances of the derived collection addresses
 * `faucet.ts` already stands up. That is the number the phase actually needs, and if it
 * is zero then the answer to "does the faucet dispense EURC" is "not to this project, and
 * here are the addresses to try it at".
 *
 * The addresses are derived from `DEPLOYER_PRIVATE_KEY`, never written to disk. A
 * plaintext key file for funded accounts is a liability with a lifetime; the derivation
 * costs nothing and leaks nothing.
 */
export async function readCorridorFunding(
  publicClient: PublicClient,
  deployerKey: Hex,
): Promise<CorridorFunding> {
  const deployer = privateKeyToAccount(deployerKey).address;

  const eurcHeld = await shed(() =>
    publicClient.readContract({
      address: ARC_EURC,
      abi: TOKEN_ABI,
      functionName: "balanceOf",
      args: [deployer],
    }),
  );

  // Native, 18 decimals, narrowed by 1e12 to the ERC-20 view — `gov08.ts` does the same,
  // and the two are one balance on Arc rather than two accounts.
  const native = await shed(() => publicClient.getBalance({address: deployer}));
  const usdcHeld = native / 1_000_000_000_000n;

  const faucetRows: FaucetProbeRow[] = [];
  for (let index = 0; index < FAUCET_PROBE_COUNT; index++) {
    const address = faucetAccount(deployerKey, index).address;
    const eurc = await shed(() =>
      publicClient.readContract({
        address: ARC_EURC,
        abi: TOKEN_ABI,
        functionName: "balanceOf",
        args: [address],
      }),
    );
    faucetRows.push({index, address, eurc});
  }

  const faucetEurcTotal = faucetRows.reduce((sum, row) => sum + row.eurc, 0n);
  const eurcEverObtained = eurcHeld + faucetEurcTotal;
  const required = EURC_SEED_REQUIRED;
  const funded = eurcEverObtained >= required;
  const shortfall = funded ? 0n : required - eurcEverObtained;

  return {
    deployer,
    eurcHeld,
    usdcHeld,
    required,
    funded,
    shortfall,
    faucetRows,
    faucetEurcTotal,
    eurcEverObtained,
    usdcShortfallVisits: (shortfall + FAUCET_DRIP - 1n) / FAUCET_DRIP,
  };
}

// ─── 5. Whether a venue exists at all ─────────────────────────────────────────

export interface AmmProbeRow {
  candidate: AmmCandidate;
  hasCode: boolean;
  codeSize: number;
  quoted: bigint | null;
  detail: string;
}

export interface AmmProbe {
  probed: AmmProbeRow[];
  withCode: AmmProbeRow[];
  quoting: AmmProbeRow[];
  best: AmmProbeRow | null;
}

/**
 * FX-05's venue question, asked of the chain instead of of a search engine.
 *
 * Each candidate is checked for bytecode first, and only a candidate that holds code is
 * asked for a quote. The three fields are kept apart on purpose: `probed` is every
 * hypothesis, `withCode` is every address that turned out to hold *something*, and
 * `quoting` is the strictly smaller set that returned a number for 100 USDC of EURC.
 * `best` is `null` unless `quoting` is non-empty.
 *
 * **A null `best` is a result, not an error.** It means no venue with USDC/EURC liquidity
 * was found on Arc testnet, which is what Arc's own contract-address reference already
 * implies by listing no DEX at all. FX-05's deviation guard then ships against a stubbed
 * venue whose router address is a constructor argument set to zero, and 07-03's
 * `test_ammVenueWithZeroRouterRefuses` makes that the tested, shipped configuration. An
 * unexercised guard on a stub venue is still the audited artefact FX-05 asks for; a
 * fabricated liquidity claim is a wrong number in a credit system.
 */
export async function probeAmmVenues(
  publicClient: PublicClient,
  candidates: readonly AmmCandidate[] = AMM_CANDIDATES,
): Promise<AmmProbe> {
  const probed: AmmProbeRow[] = [];

  for (const candidate of candidates) {
    const code = await shed(() => publicClient.getCode({address: candidate.address}));
    const hasCode = code !== undefined && code !== "0x";
    const codeSize = hasCode && code ? (code.length - 2) / 2 : 0;

    if (!hasCode) {
      probed.push({candidate, hasCode, codeSize, quoted: null, detail: "no bytecode at address"});
      continue;
    }

    let quoted: bigint | null = null;
    let detail = "";

    if (candidate.shape === "uniswap-v2") {
      try {
        const amounts = await shed(() =>
          publicClient.readContract({
            address: candidate.address,
            abi: V2_ROUTER_ABI,
            functionName: "getAmountsOut",
            args: [QUOTE_NOTIONAL, [ARC_USDC, ARC_EURC]],
          }),
        );
        const out = amounts[amounts.length - 1];
        if (out !== undefined && out > 0n) {
          quoted = out;
          detail = "getAmountsOut returned";
        } else {
          detail = "getAmountsOut returned zero";
        }
      } catch (error) {
        detail = `getAmountsOut refused: ${reason(error)}`;
      }
    } else {
      for (const fee of V3_FEE_TIERS) {
        try {
          const result = await shed(() =>
            publicClient.readContract({
              address: candidate.address,
              abi: V3_QUOTER_ABI,
              functionName: "quoteExactInputSingle",
              args: [
                {
                  tokenIn: ARC_USDC,
                  tokenOut: ARC_EURC,
                  amountIn: QUOTE_NOTIONAL,
                  fee,
                  sqrtPriceLimitX96: 0n,
                },
              ],
            }),
          );
          const out = result[0];
          if (out > 0n) {
            quoted = out;
            detail = `quoteExactInputSingle returned at fee ${fee}`;
            break;
          }
          detail = `quoteExactInputSingle returned zero at fee ${fee}`;
        } catch (error) {
          detail = `quoteExactInputSingle refused at fee ${fee}: ${reason(error)}`;
        }
      }
    }

    probed.push({candidate, hasCode, codeSize, quoted, detail});
  }

  const withCode = probed.filter((row) => row.hasCode);
  const quoting = probed.filter((row) => row.quoted !== null && row.quoted > 0n);
  const best =
    quoting.reduce<AmmProbeRow | null>(
      (bestSoFar, row) =>
        bestSoFar === null || (row.quoted ?? 0n) > (bestSoFar.quoted ?? 0n) ? row : bestSoFar,
      null,
    ) ?? null;

  return {probed, withCode, quoting, best};
}

// ─── The run ──────────────────────────────────────────────────────────────────

function line(): void {
  console.log("─".repeat(78));
}

/**
 * All five readers, one section each, and **exit 0 on every branch**.
 *
 * The unfunded branch and the no-venue branch are the ones this is most likely to take,
 * and both are results the phase was written to accept. Nothing here throws to signal a
 * precondition; a throw means the chain did not answer, which is a different thing.
 */
export async function runFxSpike(): Promise<void> {
  const rpcUrl = process.env["ARC_TESTNET_RPC_URL"] ?? ARC_TESTNET_RPC_URL;
  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl),
  }) as PublicClient;

  const chainId = await shed(() => publicClient.getChainId());

  console.log("");
  line();
  console.log(`FX corridor spike — chain ${chainId} via ${rpcUrl}`);
  console.log("Reads only. No transaction is sent and no gas is estimated.");
  line();

  // ── 1. EURC ────────────────────────────────────────────────────────────────
  console.log("\n1. EURC's EIP-3009 surface, read from the deployed bytecode");
  const eurc = await readEurcFacts(publicClient, chainId);
  console.log(`  address              ${ARC_EURC}`);
  console.log(`  name / symbol        ${eurc.name} / ${eurc.symbol}`);
  console.log(`  decimals             ${eurc.decimals}${eurc.decimals === 6 ? "" : "  <- NOT 6"}`);
  console.log(`  version              "${eurc.version}"`);
  console.log(`  receive typehash     ${eurc.receiveTypehash}`);
  console.log(`  transfer typehash    ${eurc.transferTypehash}`);
  console.log(`  cancel typehash      ${eurc.cancelTypehash}`);
  console.log(`  typehashes canonical ${eurc.typehashesCanonical ? "yes" : "NO"}`);
  console.log(`  separator (read)     ${eurc.domainSeparator}`);
  console.log(`  separator (derived)  ${eurc.derivedSeparator}`);
  console.log(
    `  separator matches    ${eurc.separatorMatches ? "yes — derived from the four fields, never stored" : "NO"}`,
  );

  // ── 2. USYC ────────────────────────────────────────────────────────────────
  console.log("\n2. USYC is permit-only, and the revert is the proof");
  const usyc = await readUsycFacts(publicClient);
  console.log(`  address              ${ARC_USYC}`);
  console.log(`  symbol / decimals    ${usyc.symbol} / ${usyc.decimals}`);
  console.log(`  EIP-3009             ${usyc.hasEip3009 ? "PRESENT — E-07 is stale" : "absent"}`);
  console.log(`    typehash call      ${usyc.eip3009Revert || "answered"}`);
  console.log(`    authorizationState ${usyc.authorizationStateRevert || "answered"}`);
  console.log(`  permit / separator   ${usyc.hasPermit ? usyc.domainSeparator : "absent"}`);
  console.log(`  Teller               ${ARC_USYC_TELLER}`);
  console.log(`  Teller oracle()      ${usyc.tellerOracle ?? usyc.tellerOracleRevert}`);
  console.log(
    "  C1: that oracle address is recorded here and read by nothing in contracts/src.\n" +
      "      A Tier-2 pledge is approve/transferFrom at par minus the governed haircut.",
  );

  // ── 3. FxEscrow ────────────────────────────────────────────────────────────
  console.log("\n3. FxEscrow — two live candidates, and neither is an answer");
  const escrow = await probeFxEscrowCandidates(publicClient);
  for (const row of escrow.rows) {
    console.log(`  ${row.address}`);
    console.log(`    source             ${row.label}`);
    console.log(`    code               ${row.hasCode ? `${row.codeSize} bytes` : "none"}`);
    console.log(`    implementation     ${row.implementation ?? "slot empty / not ERC-1967"}`);
    console.log(`    owner()            ${row.owner ?? "did not answer"}`);
    console.log(`    PERMIT2()          ${row.permit2 ?? "did not answer"}`);
  }
  console.log(
    `  implementations differ  ${escrow.implementationsDiffer ? "YES" : "no"}\n` +
      "  E-04: the verifyingContract is read from the StableFX response's typedData.domain\n" +
      "        at runtime. Neither address above is exported and neither is the answer.",
  );

  // ── 4. EURC funding ────────────────────────────────────────────────────────
  console.log("\n4. EURC funding — the precondition every live EURC criterion sits on");
  const deployerKey = process.env["DEPLOYER_PRIVATE_KEY"] as Hex | undefined;
  if (!deployerKey) {
    console.log(
      "  DEPLOYER_PRIVATE_KEY is not set, so the EURC funding branch could not be read.\n" +
        "  Set it and re-run; nothing above needs it and nothing below is affected.",
    );
  } else {
    const funding = await readCorridorFunding(publicClient, deployerKey);
    console.log(`  deployer             ${funding.deployer}`);
    console.log(`  eurcHeld             ${money(funding.eurcHeld, "EURC")}`);
    console.log(`  usdcHeld             ${money(funding.usdcHeld, "USDC")}`);
    console.log(`  EURC_SEED_REQUIRED   ${money(funding.required, "EURC")}`);
    console.log(`  branch               ${funding.funded ? "FUNDED" : "UNFUNDED"}`);
    console.log(`  shortfall            ${money(funding.shortfall, "EURC")}`);
    console.log("");
    console.log("  EURC ever obtained by an address this repo controls:");
    console.log(`    deployer           ${money(funding.eurcHeld, "EURC")}`);
    for (const row of funding.faucetRows) {
      console.log(`    faucet[${row.index}] ${row.address}  ${money(row.eurc, "EURC")}`);
    }
    console.log(`    total              ${money(funding.eurcEverObtained, "EURC")}`);
    console.log("");
    if (funding.eurcEverObtained === 0n) {
      console.log(
        "  This project has never held any EURC on Arc testnet. faucet.circle.com is an\n" +
          "  interactive, captcha-gated web form with no public API, so whether it dispenses\n" +
          "  EURC at all — and at what drip — is a manual step, not an automatable one.\n" +
          "  Request EURC on Arc Testnet at https://faucet.circle.com for the deployer and\n" +
          "  the three addresses above, then re-run this command; it re-reads and re-branches.",
      );
    }
    console.log(
      "  The EURC seed is ON TOP OF the USDC position, not instead of it. STATE.md records\n" +
        "  the credit half already short against the 409.84 USDC peak requirement, and this\n" +
        "  spike spends nothing to say so. Widening a Tier-0 band or the reserve floor to make\n" +
        "  a live run fit is forbidden (DEC-02).",
    );
  }

  // ── 5. AMM venue ───────────────────────────────────────────────────────────
  console.log("\n5. AMM venue — is there anywhere on Arc testnet to fill USDC/EURC?");
  const amm = await probeAmmVenues(publicClient);
  console.log(`  notional probed      ${money(QUOTE_NOTIONAL, "USDC")} -> EURC`);
  console.log(`  candidates probed    ${amm.probed.length}`);
  console.log(`  holding bytecode     ${amm.withCode.length}`);
  console.log(`  returning a quote    ${amm.quoting.length}`);
  console.log("");
  for (const row of amm.probed) {
    console.log(`  ${row.candidate.address}  ${row.candidate.label}`);
    console.log(`    confidence         ${row.candidate.confidence} — ${row.candidate.source}`);
    console.log(`    code               ${row.hasCode ? `${row.codeSize} bytes` : "none"}`);
    console.log(`    quote              ${row.quoted === null ? row.detail : money(row.quoted, "EURC")}`);
  }
  console.log("");

  if (amm.best) {
    console.log(
      `  VENUE FOUND — ${amm.best.candidate.address} quoted ` +
        `${money(amm.best.quoted ?? 0n, "EURC")} for ${money(QUOTE_NOTIONAL, "USDC")}.\n` +
        "  Record the address and the rate in finding 34 and pass it to AmmVenue's constructor.",
    );
  } else {
    console.log(
      "  NO VENUE FOUND — no venue with USDC/EURC liquidity exists on Arc testnet as far as\n" +
        "  this probe can tell. Arc's official contract-address reference lists no DEX at all,\n" +
        "  and none of the tertiary candidates (Coco DEX, Tower Exchange, the 'Curve is on Arc'\n" +
        "  claim) publishes an Arc-testnet contract address to probe. FX-05's deviation guard\n" +
        "  therefore ships against a stubbed venue whose router is a constructor argument set\n" +
        "  to address(0), and 07-03 asserts that configuration refuses rather than fabricating.\n" +
        "  This is a recorded absence, not a failure, and no placeholder address is emitted.",
    );
  }

  console.log("");
  line();
  console.log("Every branch above is a pass. Record the figures in FINDINGS.md 31-34.");
  line();
  console.log("");
}
