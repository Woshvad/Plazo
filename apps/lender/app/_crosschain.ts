/**
 * Getting capital onto Arc, and getting it off again. XCH-01.
 *
 * The two directions are not symmetric, and this module exists partly to stop the
 * surface implying a round trip that does not exist:
 *
 * - **In:** Circle Gateway, or — for a lender Gateway will not serve — CCTP's two-step
 *   (`depositForBurn` to domain 26, then a normal deposit on Arc).
 * - **Out:** CCTP. Zero fee from Arc to every domain, seconds. Gateway's
 *   `initiateWithdrawal` → wait → `withdraw` is a **fourteen-day** non-attested escape
 *   hatch out of a unified balance and is *not* the redemption route.
 *
 * Both inbound routes ship because Circle's technical guide states that Gateway burn
 * intents accept **EOA signatures only** — Gateway must statically verify the signature
 * off-chain and guarantee it is still valid at burn time, which an ERC-1271 contract
 * signer cannot promise. DEC-01 keeps the tranche shares as transfer-restricted Reg-D
 * securities held by institutions, and institutions overwhelmingly hold through
 * multisigs. Planning only the Gateway path would lock the target lender out of the
 * feature (D-14). The CCTP fallback is correct whether or not that documentation is
 * right, which is the point of building it.
 *
 * **Every function here is a pure read or a pure constructor.** Nothing in this module
 * sends a transaction. Plazo holds no gas token on any chain but Arc (D-12), so the
 * inbound leg is a *described plan* the lender's own wallet executes, never something
 * this app can perform on their behalf.
 *
 * Live-vs-sample follows `_data.ts` exactly: read the service when it is configured,
 * fall back to a built-in sample of the same shape, and carry `live: boolean` on every
 * payload. A demo indistinguishable from production is how a screenshot ends up in a
 * deck describing a book that does not exist.
 */

import {
  ARC_CCTP_DOMAIN,
  ARC_GATEWAY_MINTER,
  ARC_GATEWAY_WALLET,
  ARC_TOKEN_MESSENGER_V2,
  ARC_USDC,
  CCTP_FINALITY_STANDARD,
  CCTP_MAX_FEE_FROM_ARC,
  GATEWAY_API_TESTNET_BASE_URL,
  formatUsdc6,
  mintRecipient,
  parseUsdc6,
  usdc6,
} from "@plazo/plan-core";
import type {Usdc6} from "@plazo/plan-core";

type Hex = `0x${string}`;

/** `destinationCaller` zero means any caller may redeem the attestation. */
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;

// ─────────────────────────────────────────────────────────────────────────────
// Where the service lives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The value `PLAZO_GATEWAY_API_URL` should be set to on testnet.
 *
 * Gateway's `/v1/info` and `/v1/balances` both answer 200 unauthenticated, so this
 * module *could* reach the network with no configuration at all. It deliberately does
 * not. Talking to a third-party API is a decision somebody makes, and a surface that
 * silently made it would produce a screen nobody can tell apart from the sample — the
 * same failure `_data.ts` guards against, running in the other direction.
 */
export const GATEWAY_API_DEFAULT_URL = GATEWAY_API_TESTNET_BASE_URL;

/**
 * Read at call time rather than at module load, so a test can configure it and so a
 * server restart is not required to point at a different Gateway deployment.
 */
function configuredBase(override?: string): string | undefined {
  return override ?? process.env["PLAZO_GATEWAY_API_URL"];
}

/** Options every read in this module accepts. */
export interface GatewayReadOptions {
  /** Overrides `PLAZO_GATEWAY_API_URL`. Supplying it opts into the network. */
  baseUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/info — the supported domains and the current expiry height
// ─────────────────────────────────────────────────────────────────────────────

/** One row of Gateway's `/v1/info` domain list. */
export interface GatewayDomain {
  chain: string;
  network: string;
  domain: number;
  walletContract: {address: string; supportedTokens: string[]};
  minterContract: {address: string; supportedTokens: string[]};
  /** Decimal strings. Block heights, not money — they do not go through `Usdc6`. */
  processedHeight: string;
  burnIntentExpirationHeight: string;
}

export interface GatewayInfo {
  live: boolean;
  version: number;
  domains: GatewayDomain[];
}

/**
 * The thirteen testnet domains, as `/v1/info` returned them on 2026-08-02.
 *
 * Heights are frozen at the moment of capture and are stale by construction, which is
 * exactly why a sample payload must never be mistaken for a live one — a burn intent
 * signed against a sample `burnIntentExpirationHeight` would already have expired.
 * `live: false` is what stops that, and it reaches the UI.
 */
const SAMPLE_INFO: GatewayInfo = {
  live: false,
  version: 1,
  domains: [
    domainRow("Ethereum", "Sepolia", 0, "11400414", "11450905"),
    domainRow("Avalanche", "Fuji", 1, "57498028", "57901230"),
    domainRow("Optimism", "Sepolia", 2, "0", "0"),
    domainRow("Arbitrum", "Sepolia", 3, "293804396", "11450906"),
    domainRow("Solana", "Devnet", 5, "0", "0"),
    domainRow("Base", "Sepolia", 6, "44934224", "45237309"),
    domainRow("Polygon", "Amoy", 7, "0", "0"),
    domainRow("Unichain", "Sepolia", 10, "0", "0"),
    domainRow("Sonic", "Testnet", 13, "17271777", "18135777"),
    domainRow("Worldchain", "Sepolia", 14, "32543689", "32847742"),
    domainRow("Sei", "Atlantic", 16, "263092805", "264604808"),
    domainRow("HyperEVM", "Testnet", 19, "60456843", "61061644"),
    domainRow("ARC", "Testnet", ARC_CCTP_DOMAIN, "54863401", "56073002"),
  ],
};

function domainRow(
  chain: string,
  network: string,
  domain: number,
  processedHeight: string,
  burnIntentExpirationHeight: string,
): GatewayDomain {
  return {
    chain,
    network,
    domain,
    walletContract: {address: ARC_GATEWAY_WALLET, supportedTokens: ["USDC"]},
    minterContract: {address: ARC_GATEWAY_MINTER, supportedTokens: ["USDC"]},
    processedHeight,
    burnIntentExpirationHeight,
  };
}

/**
 * `GET /v1/info`. Unauthenticated, verified live.
 *
 * Gateway deploys `GatewayWallet` and `GatewayMinter` at the *same* address on every
 * supported domain, which is why the sample rows can name Arc's constants for all
 * thirteen without lying.
 */
export async function gatewayDomains(options: GatewayReadOptions = {}): Promise<GatewayInfo> {
  const base = configuredBase(options.baseUrl);
  if (!base) return SAMPLE_INFO;

  const response = await fetch(`${base}/info`, {cache: "no-store"});
  if (!response.ok) throw new Error(`/info returned ${response.status}`);
  const body = (await response.json()) as {version: number; domains: GatewayDomain[]};
  return {live: true, version: body.version, domains: body.domains};
}

/**
 * The current `maxBlockHeight` for a domain, read from `/v1/info` **at signing time**.
 *
 * Arc advances at 0.514 s per block, so an intent signed against a stale height expires
 * fast. There is no lookahead constant here on purpose: a hardcoded one is a guess that
 * silently rots, and the failure mode is a signature Gateway accepts and then drops.
 */
export function expirationHeightFor(info: GatewayInfo, domain: number): bigint {
  const row = info.domains.find((d) => d.domain === domain);
  if (!row) throw new Error(`Gateway does not list domain ${domain}`);
  return BigInt(row.burnIntentExpirationHeight);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/balances — the unified balance, in decimal strings
// ─────────────────────────────────────────────────────────────────────────────

export interface BalanceSource {
  domain: number;
  depositor: Hex;
}

export interface DomainBalance {
  domain: number;
  depositor: string;
  /** Spendable now. */
  balance: Usdc6;
  /** Deposited but not yet finalised into the unified balance. */
  pendingBatch: Usdc6;
}

export interface UnifiedBalance {
  live: boolean;
  token: string;
  balances: DomainBalance[];
  /** Every domain's spendable balance, summed. */
  total: Usdc6;
}

/**
 * Gateway answers with **decimal strings at six decimals** — `"0.368700"`, `"0"` — and
 * not with integers.
 *
 * `parseUsdc6` is the only converter used. A float parse of `"0.368700"` yields
 * `0.3687`, and every arithmetic step after that is a rounding error in a balance a
 * lender is about to sign against. The module is grep-gated against the float path for
 * the same reason the CCTP `mintRecipient` padding is a named function with a test:
 * the wrong answer here is well-formed and silent.
 */
function parseGatewayAmount(decimal: string): Usdc6 {
  return parseUsdc6(decimal);
}

/** `POST /v1/balances`. Unauthenticated, verified live. */
export async function unifiedBalance(
  request: {token: string; sources: BalanceSource[]},
  options: GatewayReadOptions = {},
): Promise<UnifiedBalance> {
  const base = configuredBase(options.baseUrl);
  if (!base) {
    return {live: false, token: request.token, balances: [], total: usdc6(0n)};
  }

  const response = await fetch(`${base}/balances`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(request),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`/balances returned ${response.status}`);

  const body = (await response.json()) as {
    token: string;
    balances: {domain: number; depositor: string; balance: string; pendingBatch: string}[];
  };

  const balances: DomainBalance[] = body.balances.map((row) => ({
    domain: row.domain,
    depositor: row.depositor,
    balance: parseGatewayAmount(row.balance),
    pendingBatch: parseGatewayAmount(row.pendingBatch),
  }));

  let total = 0n;
  for (const row of balances) total += row.balance;

  return {live: true, token: body.token, balances, total: usdc6(total)};
}

/** Display helper, so a component never reaches for a float either. */
export function usdcDisplay(value: Usdc6): string {
  return formatUsdc6(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// The burn intent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Field ordering and types taken from **`circlefin/evm-gateway-contracts`**, commit
 * `ee628dc35ee67bc8ad30ba0606cc70888688a3f1`, files:
 *
 * - `test/js/eip712TestData.js` — the `TransferSpec` / `BurnIntent` type arrays, which
 *   are what Circle's own `eth_signTypedData_v4` round-trip test signs
 * - `src/lib/TransferSpec.sol` — `struct TransferSpec` and `TRANSFER_SPEC_TYPEHASH`
 * - `src/lib/BurnIntents.sol` — `struct BurnIntent` and `BURN_INTENT_TYPEHASH`
 * - `src/lib/EIP712Domain.sol` — the domain, which is *not* the usual one
 *
 * Taken from source and not from the documentation because the fetched technical guide
 * lists the field *names* but no authoritative ordering, and EIP-712 hashes the fields
 * in declaration order. A struct assembled from a prose list has a good chance of being
 * mis-ordered, and a mis-ordered struct produces a signature Gateway rejects — or, far
 * worse, one it accepts against fields the lender did not read (assumption A1).
 *
 * `TYPE_STRINGS` below is asserted byte-identical to the strings in Circle's own
 * typehash comments by `test/crosschain.test.ts`, so a transcription slip in the arrays
 * is a failing test rather than a rejected signature at the counter.
 */
export const TRANSFER_SPEC_FIELDS = [
  {name: "version", type: "uint32"},
  {name: "sourceDomain", type: "uint32"},
  {name: "destinationDomain", type: "uint32"},
  {name: "sourceContract", type: "bytes32"},
  {name: "destinationContract", type: "bytes32"},
  {name: "sourceToken", type: "bytes32"},
  {name: "destinationToken", type: "bytes32"},
  {name: "sourceDepositor", type: "bytes32"},
  {name: "destinationRecipient", type: "bytes32"},
  {name: "sourceSigner", type: "bytes32"},
  {name: "destinationCaller", type: "bytes32"},
  {name: "value", type: "uint256"},
  {name: "salt", type: "bytes32"},
  {name: "hookData", type: "bytes"},
] as const;

export const BURN_INTENT_FIELDS = [
  {name: "maxBlockHeight", type: "uint256"},
  {name: "maxFee", type: "uint256"},
  {name: "spec", type: "TransferSpec"},
] as const;

/**
 * The EIP-712 domain, which omits `chainId` and `verifyingContract`.
 *
 * That is not an oversight to be helpfully corrected. `EIP712Domain.sol` says so
 * explicitly: *"This implementation intentionally deviates from the standard by
 * omitting `chainId` and `verifyingContract` … This modification ensures burn intents
 * can be verified across different chains and contract deployments."* Adding either
 * field changes the domain separator and every signature becomes invalid.
 *
 * `keccak256("EIP712Domain(string name,string version)")` =
 * `0xb03948446334eb9b2196d5eb166f69b9d49403eb4a12f36de8d3f9f3cb8e15c3`.
 */
export const GATEWAY_EIP712_DOMAIN = {name: "GatewayWallet", version: "1"} as const;

/** `TRANSFER_SPEC_VERSION` in `src/lib/TransferSpec.sol`. */
export const TRANSFER_SPEC_VERSION = 1;

/**
 * The typehashes as Circle's source declares them, carried so the strings this module
 * builds can be checked against a value nobody here computed.
 */
export const CIRCLE_TYPEHASHES = {
  transferSpec: "0x44409c7ba8872720f5fc290d2788c2d70a3905b7ca1cdb2ffa152791a69e089b",
  burnIntent: "0x8b99d17a83a2dd1add9fc2a450e22732c7e8564aa110ab99c20485a7a10ba37c",
  burnIntentSet: "0xe30760cf7d79e3521ad1553a73a6c6f8d33226ea613eaa29ceda6de148fbd07a",
} as const;

/** The exact preimages of the two typehashes above, verbatim from Circle's comments. */
export const TYPE_STRINGS = {
  transferSpec:
    "TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt,bytes hookData)",
  burnIntent:
    "BurnIntent(uint256 maxBlockHeight,uint256 maxFee,TransferSpec spec)TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain,bytes32 sourceContract,bytes32 destinationContract,bytes32 sourceToken,bytes32 destinationToken,bytes32 sourceDepositor,bytes32 destinationRecipient,bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt,bytes hookData)",
} as const;

/** Renders a field array back into its EIP-712 type string, for the parity assertion. */
export function encodeTypeString(
  name: string,
  fields: readonly {readonly name: string; readonly type: string}[],
): string {
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

export interface TransferSpecInput {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  sourceContract: Hex;
  destinationContract: Hex;
  sourceToken: Hex;
  destinationToken: Hex;
  sourceDepositor: Hex;
  destinationRecipient: Hex;
  sourceSigner: Hex;
  destinationCaller: Hex;
  value: bigint;
  salt: Hex;
  hookData: Hex;
}

export interface BurnIntentTypedData {
  types: {
    TransferSpec: typeof TRANSFER_SPEC_FIELDS;
    BurnIntent: typeof BURN_INTENT_FIELDS;
  };
  primaryType: "BurnIntent";
  domain: typeof GATEWAY_EIP712_DOMAIN;
  message: {maxBlockHeight: bigint; maxFee: bigint; spec: TransferSpecInput};
}

/**
 * Assemble the typed data a lender's wallet signs. A constructor — it signs nothing,
 * sends nothing and reaches no network.
 *
 * `maxBlockHeight` is a required argument rather than something this function derives,
 * because the only correct source for it is `/v1/info` read at signing time
 * (`expirationHeightFor`). A default here would be a hardcoded lookahead by another
 * name.
 */
export function buildBurnIntent(input: {
  maxBlockHeight: bigint;
  maxFee: bigint;
  spec: TransferSpecInput;
}): BurnIntentTypedData {
  if (input.spec.version !== TRANSFER_SPEC_VERSION) {
    throw new Error(
      `TransferSpec.version must be ${TRANSFER_SPEC_VERSION}; got ${input.spec.version}`,
    );
  }
  if (input.spec.destinationDomain === input.spec.sourceDomain) {
    throw new Error("A Gateway transfer to its own domain is not a transfer");
  }
  return {
    types: {TransferSpec: TRANSFER_SPEC_FIELDS, BurnIntent: BURN_INTENT_FIELDS},
    primaryType: "BurnIntent",
    domain: GATEWAY_EIP712_DOMAIN,
    message: {maxBlockHeight: input.maxBlockHeight, maxFee: input.maxFee, spec: input.spec},
  };
}

/**
 * A spec for the common case: move a lender's own USDC from `sourceDomain` to Arc,
 * landing on their own Arc address.
 *
 * `destinationCaller` is left zero so any caller may redeem the attestation — Plazo
 * deploys nothing on the source chain and cannot promise to be the caller. `hookData`
 * is empty for the same reason a CCTP hook is not built (D-12): hook data requires a
 * destination-side contract somebody deploys and funds.
 */
export function arcInboundSpec(input: {
  sourceDomain: number;
  depositor: Hex;
  arcRecipient: Hex;
  value: Usdc6;
  salt: Hex;
}): TransferSpecInput {
  return {
    version: TRANSFER_SPEC_VERSION,
    sourceDomain: input.sourceDomain,
    destinationDomain: ARC_CCTP_DOMAIN,
    sourceContract: mintRecipient(ARC_GATEWAY_WALLET),
    destinationContract: mintRecipient(ARC_GATEWAY_MINTER),
    sourceToken: mintRecipient(ARC_USDC),
    destinationToken: mintRecipient(ARC_USDC),
    sourceDepositor: mintRecipient(input.depositor),
    destinationRecipient: mintRecipient(input.arcRecipient),
    sourceSigner: mintRecipient(input.depositor),
    destinationCaller: ZERO_BYTES32,
    value: input.value,
    salt: input.salt,
    hookData: "0x",
  };
}

export type SelfCheckResult =
  | {ok: true; status: number; message: string}
  | {ok: false; status: number; message: string; because: string};

/**
 * The cheap detection for a mis-shaped intent.
 *
 * `POST /v1/transfer` with an empty array answers 400 with *"At least one signed burn
 * intent or burn intent set is required"* — an error about a missing **signed burn
 * intent**. If Gateway ever starts rejecting at the body-parsing layer instead, the
 * wire format this module builds has moved underneath it, and that is worth knowing
 * before a lender's signature is the thing that discovers it.
 *
 * One shot, read-only, and it moves no money: an empty array cannot burn anything.
 */
export async function burnIntentSelfCheck(
  options: GatewayReadOptions = {},
): Promise<SelfCheckResult> {
  const base = configuredBase(options.baseUrl) ?? GATEWAY_API_DEFAULT_URL;
  const response = await fetch(`${base}/transfer`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: "[]",
    cache: "no-store",
  });
  const body = (await response.json()) as {message?: string};
  const message = body.message ?? "";

  if (/signed burn intent/i.test(message)) {
    return {ok: true, status: response.status, message};
  }
  return {
    ok: false,
    status: response.status,
    message,
    because:
      "Gateway rejected an empty transfer body without naming a signed burn intent. " +
      "The request shape this module builds may no longer be the one it parses.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The CCTP two-step (D-14)
// ─────────────────────────────────────────────────────────────────────────────

/** One step of a described plan. Nothing here executes. */
export interface RouteStep {
  index: number;
  where: string;
  call: string;
  args: Record<string, string>;
  why: string;
}

export interface RoutePlan {
  route: "gateway" | "cctp-two-step" | "cctp-out";
  headline: string;
  amount: string;
  latency: string;
  fee: string;
  steps: RouteStep[];
  caveats: string[];
}

/**
 * The route a lender takes when Gateway will not serve their signer class.
 *
 * Two steps and no signer-class restriction: `depositForBurn` is an ordinary contract
 * call, so a Safe executes it exactly as an EOA does. Returned as a recipe rather than
 * performed, because step one happens on a chain where Plazo holds no gas (D-12).
 */
export function cctpDepositPlan(input: {
  fromDomain: number;
  amount: Usdc6;
  arcRecipient: Hex;
  sourceTokenMessenger?: Hex;
}): RoutePlan {
  const padded = mintRecipient(input.arcRecipient);
  return {
    route: "cctp-two-step",
    headline: `Burn on domain ${input.fromDomain}, mint on Arc, then deposit`,
    amount: formatUsdc6(input.amount),
    latency: "seconds to mint on Arc, then the pool's next epoch close",
    fee: "an inbound CCTP fee may apply on the source domain; Arc charges none",
    steps: [
      {
        index: 1,
        where: `the source chain (CCTP domain ${input.fromDomain})`,
        call: "TokenMessengerV2.depositForBurn",
        args: {
          amount: formatUsdc6(input.amount),
          destinationDomain: String(ARC_CCTP_DOMAIN),
          mintRecipient: padded,
          burnToken: "the source chain's USDC",
          destinationCaller: ZERO_BYTES32,
          minFinalityThreshold: String(CCTP_FINALITY_STANDARD),
          tokenMessenger: input.sourceTokenMessenger ?? "the source chain's TokenMessengerV2",
        },
        why:
          "An ordinary contract call. There is no signer-class restriction, which is the " +
          "whole reason this route exists alongside Gateway.",
      },
      {
        index: 2,
        where: "Arc",
        call: "TranchedCreditPool.requestDeposit",
        args: {asset: ARC_USDC, amount: formatUsdc6(input.amount)},
        why:
          "The mint lands as ordinary USDC in your own Arc wallet. Depositing it is the " +
          "same call any Arc-resident lender makes.",
      },
    ],
    caveats: [
      "mintRecipient is left-padded to 32 bytes. Right-padding produces a well-formed " +
        "bytes32 that mints to a different, unowned address, and there is no recovery.",
      "A deposit confers no claim until the epoch closes (DEC-22). Bridged funds that " +
        "show no shares yet are queued, not lost.",
    ],
  };
}

/**
 * The route off Arc. **This is the redemption route.**
 *
 * Fee zero to every destination — measured as a balance delta on a real burn out of
 * Arc, not quoted from the fee oracle (DEC-32). There is deliberately no fast/standard
 * toggle: Circle's oracle returns `minimumFee: 0` from domain 26 at *both* thresholds,
 * so a toggle would be a control with no effect and a second code path to test (D-15).
 */
export function cctpRedeemPlan(input: {toDomain: number; amount: Usdc6; recipient: Hex}): RoutePlan {
  if (input.toDomain === ARC_CCTP_DOMAIN) {
    throw new Error("CCTP has no self-domain route; a payout to domain 26 is a plain transfer");
  }
  return {
    route: "cctp-out",
    headline: `Redeem on Arc, then burn to CCTP domain ${input.toDomain}`,
    amount: formatUsdc6(input.amount),
    latency: "seconds, once the redemption ticket is filled",
    fee: "zero from Arc to every domain",
    steps: [
      {
        index: 1,
        where: "Arc",
        call: "TranchedCreditPool.redeem",
        args: {amount: formatUsdc6(input.amount)},
        why:
          "The tranche position becomes ordinary USDC on Arc. Redemptions fill from the " +
          "liquidity buffer and queue behind the tickets already in front of you.",
      },
      {
        index: 2,
        where: "Arc",
        call: "TokenMessengerV2.depositForBurn",
        args: {
          tokenMessenger: ARC_TOKEN_MESSENGER_V2,
          burnToken: ARC_USDC,
          amount: formatUsdc6(input.amount),
          destinationDomain: String(input.toDomain),
          mintRecipient: mintRecipient(input.recipient),
          destinationCaller: ZERO_BYTES32,
          maxFee: CCTP_MAX_FEE_FROM_ARC.toString(),
          minFinalityThreshold: String(CCTP_FINALITY_STANDARD),
        },
        why:
          "maxFee is 0 and minFinalityThreshold is 2000 (standard). Both thresholds price " +
          "identically out of Arc, and Arc's single-slot finality means standard arrives in " +
          "about half a second anyway.",
      },
    ],
    caveats: [
      "You complete the mint yourself on the destination chain with the message bytes and " +
        "Circle's attestation. Plazo holds no gas token on any chain but Arc (D-12).",
      "Circle holds three kill switches on this path — a transmitter pause, a minter pause " +
        "and a messenger denylist — none of which Plazo controls.",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Which route a signer class can actually use
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The signer classes a lender might hold through.
 *
 * `plan-core`'s `SignerClass` is the two-valued on-chain distinction the check strip
 * cares about (EOA vs. ERC-1271 contract). This is the finer-grained *product* question
 * — which wallet a lender actually uses — and the four values collapse onto that pair.
 */
export type SignerKind = "eoa" | "smart-account" | "msca" | "safe";

export interface SignerAdvice {
  kind: SignerKind;
  label: string;
  /** Every route this signer class can actually complete. Never empty. */
  routes: ("gateway" | "cctp-two-step")[];
  gatewayAvailable: boolean;
  reason: string;
}

/**
 * Why Gateway is EOA-only, stated once.
 *
 * Gateway credits the destination before the source burn settles, so it must verify the
 * signature *statically*, off-chain, and be certain it will still be valid at burn time.
 * An ERC-1271 signature cannot offer that: `isValidSignature` is contract state, and a
 * contract that answers yes now can answer no in the next block — an owner rotation, a
 * threshold change or a module removal is enough. So Gateway does not ask.
 */
const CONTRACT_SIGNER_REASON =
  "Gateway must verify a burn intent's signature off-chain and be certain it is still " +
  "valid at burn time. An ERC-1271 contract signature is contract state — an owner " +
  "rotation or a threshold change can invalidate it between signing and burning — so " +
  "Gateway accepts EOA signatures only. Use the CCTP two-step: depositForBurn is an " +
  "ordinary contract call your wallet executes like any other.";

const EOA_REASON =
  "An EOA signature is verifiable off-chain and cannot be revoked, so both routes are " +
  "open. Gateway is one signature; the CCTP two-step is two transactions. Neither is " +
  "wrong.";

const LABELS: Record<SignerKind, string> = {
  eoa: "EOA (a plain private key)",
  "smart-account": "Smart contract account",
  msca: "Passkey MSCA (ERC-6900)",
  safe: "Safe or other multisig",
};

/**
 * Which route a given signer class can use, and why.
 *
 * Rendered *beside* the routes rather than after a failed attempt. An institutional
 * lender discovering mid-ceremony that their multisig cannot sign a Gateway burn intent
 * is a denial of service dressed as a UX problem (T-06-07-04).
 */
export function signerClassAdvice(kind: SignerKind): SignerAdvice {
  const isEoa = kind === "eoa";
  return {
    kind,
    label: LABELS[kind],
    routes: isEoa ? ["gateway", "cctp-two-step"] : ["cctp-two-step"],
    gatewayAvailable: isEoa,
    reason: isEoa ? EOA_REASON : CONTRACT_SIGNER_REASON,
  };
}

/** Every signer class, so the surface can show the whole table rather than one row. */
export const SIGNER_KINDS: SignerKind[] = ["eoa", "smart-account", "msca", "safe"];
