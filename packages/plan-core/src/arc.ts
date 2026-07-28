/**
 * Arc network constants.
 *
 * Every value here was read from the live network, not from documentation. The
 * addresses are checked by `@plazo/arc-verify` on every CI run, so a change on
 * Arc's side surfaces as a failing gate rather than as a production incident.
 */
import type {Address} from "viem";

export const ARC_TESTNET_CHAIN_ID = 5_042_002;

/**
 * Reserved but not open. `rpc.mainnet.arc.io` returns UNAUTHORIZED and viem ships
 * this chain with an empty RPC array. Arc mainnet is not live and has no announced
 * date; nothing in this repo plans against one.
 */
export const ARC_MAINNET_CHAIN_ID = 5_042;

export const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.io";
export const ARC_TESTNET_EXPLORER = "https://testnet.arcscan.app";

/**
 * The check rail. Gas token and loan currency are the same balance, which is why
 * borrower-side transactions must be sponsored: a borrower holding exactly one
 * installment cannot otherwise afford to cure their own plan.
 */
export const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";

/** Full EIP-3009, canonical typehashes, `version() == "2"`. The one buildable corridor. */
export const ARC_EURC: Address = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

/**
 * Liquidity-buffer parking only.
 *
 * Permit and `DOMAIN_SEPARATOR` only — no EIP-3009. It cannot carry a check, so
 * Tier-2 pledges and idle-buffer parking move through `approve`/`transferFrom`.
 * `@plazo/arc-verify` asserts the absence, so a future upgrade that adds EIP-3009
 * shows up as a deliberate decision rather than as a silent capability change.
 */
export const ARC_USYC: Address = "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C";
export const ARC_USYC_TELLER: Address = "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A";

/**
 * The canonical permissionless CREATE2 deployer.
 *
 * Present on Arc, and deliberately unused for plans. Anyone can deploy through it,
 * so an address derived from it is squattable between signing and origination.
 * Plans deploy from `PlanFactory`; this constant exists so the verification script
 * can confirm the deployer's presence for third-party tooling.
 */
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Arc-specific. Batches calls with a spoofable `from`; used for keeper cranks. */
export const MULTICALL3_FROM: Address = "0x522fAf9A91c41c443c66765030741e4AaCe147D0";

/** Circle Paymaster covers v0.7 on Arc. v0.8 does not include Arc. */
export const ENTRYPOINT_V07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

/**
 * The public RPC hard-errors (-32614) above this range. Any indexer or log sweep
 * must chunk below it.
 */
export const ARC_MAX_LOG_RANGE = 10_000;

/** Measured over 1,000 blocks. Deterministic single-slot finality, zero reorgs. */
export const ARC_BLOCK_TIME_SECONDS = 0.514;

export const ERC3009_TYPEHASHES = {
  transferWithAuthorization:
    "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267",
  receiveWithAuthorization:
    "0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8",
  cancelAuthorization: "0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429",
} as const;

/**
 * The EIP-712 domain of Arc USDC.
 *
 * Note the name is `"USDC"`, not `"USD Coin"`. The separator is derived from these
 * four fields at runtime and never hardcoded: it embeds `chainId` and
 * `verifyingContract`, both of which change on mainnet, and a baked-in value would
 * make every outstanding strip silently fail to validate the day the config flips.
 */
export const ARC_USDC_DOMAIN = {
  name: "USDC",
  version: "2",
  chainId: ARC_TESTNET_CHAIN_ID,
  verifyingContract: ARC_USDC,
} as const;
