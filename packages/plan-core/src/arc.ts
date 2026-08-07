/**
 * Arc network constants.
 *
 * Every value here was read from the live network, not from documentation. The
 * addresses are checked by `@plazo/arc-verify` on every CI run, so a change on
 * Arc's side surfaces as a failing gate rather than as a production incident.
 */
import {pad, type Address, type Hex} from "viem";

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

/**
 * The `FiatTokenProxy` implementation behind Arc USDC, as of 2026-07-28.
 *
 * Pinned so that an upgrade fails CI rather than passing unnoticed. A borrower's
 * authorization is a signature over a digest the token interprets; new logic can
 * interpret it differently, so an implementation change is a re-verification and a
 * re-audit, not a version bump.
 *
 * Read from `keccak256("org.zeppelinos.proxy.implementation")` — Circle's proxy
 * predates EIP-1967 and the modern slot reads zero.
 *
 * Note: the project's Part 0 research recorded `0x3910B7cb…` here. It now reads the
 * address below. Whether Arc upgraded or the earlier figure came from a
 * delegatecall further down the trace, the pin is what makes the next change
 * visible.
 */
export const ARC_USDC_IMPLEMENTATION: Address = "0xC6AD664ac6679F4Ce74e10E91449C93Ec1ae3cA6";

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
 * Arc's EIP-7708 native-transfer system emitter.
 *
 * Because USDC is the gas token, Arc emits a canonical ERC-20 `Transfer` log from this
 * address for **every** native movement — payroll, remittances, contract endowments,
 * precompile movements. A borrower's complete inflow history is therefore a filtered
 * log scan, which is the mechanism UW-04's Tier-1 limit is built on and which no
 * incumbent underwriting against a bank rail has.
 *
 * **Its `value` is 18 decimals. The USDC contract's own `Transfer` for the same
 * movement is 6.** One balance change, two logs, two emitters, two scales. Summing
 * them inflates income by 10^12 if the scales are never reconciled and by exactly 2× if
 * they are reconciled and the duplication is not, and neither figure looks wrong. E-08.
 *
 * The rule is: filter by this address, use this stream alone, and narrow exactly once
 * through `toMinor6` — which takes a `Native18`, a brand deliberately distinct from
 * `Wei18` so that a log value and a balance cannot be interchanged by accident.
 *
 * It lives here, beside `ARC_USDC` and `ARC_EURC`, because it is a network constant
 * rather than a Plazo deployment: `@plazo/arc-verify` reads the stream against the live
 * chain, `services/indexer` registers it as a source, and one literal that both consume
 * is one literal that cannot disagree with itself. Confirmed live on chain 5042002 on
 * 2026-08-07 — canonical topic0, `from` and `to` indexed, `value` at 18 decimals.
 */
export const ARC_NATIVE_TRANSFER_EMITTER: Address =
  "0xfffffffffffffffffffffffffffffffffffffffe";

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

// ─── CCTP v2 and Gateway ──────────────────────────────────────────────────────
//
// Where a merchant's settlement goes once it leaves Arc, and where a lender's
// capital comes from before it arrives. Every address below was read from chain
// 5042002 and carries bytecode; `@plazo/arc-verify` re-reads the live shape of
// each one on every CI run, so a Circle redeployment or a pause surfaces as a
// failing gate rather than as a payout into a void.
//
// None of these are hardcoded into a contract. A mainnet flip moves every one of
// them, and the flip is a change to this file plus a re-run of the gate.

/**
 * Arc's identifier inside CCTP's own domain numbering.
 *
 * **This is not `block.chainid`.** Arc is chain 5042002 and CCTP domain 26; the
 * two numbers have nothing to do with each other and are not derivable from one
 * another. Ethereum is chain 1 and domain 0, Base Sepolia is chain 84532 and
 * domain 6. Passing a chain id where a domain is expected produces a burn Iris
 * will never attest, and the USDC is gone.
 *
 * `TokenMessengerV2.remoteTokenMessengers(26)` returns `bytes32(0)` on Arc:
 * CCTP has no self-domain route, so a payout to domain 26 is a plain transfer
 * and never a burn.
 */
export const ARC_CCTP_DOMAIN = 26;

/**
 * CCTP v2 `TokenMessengerV2` on Arc — the burn side.
 *
 * This is the **testnet** address, and it is deployed at the same address on
 * every CCTP v2 testnet domain rather than being Arc-specific. The mainnet
 * address `0x28b5a0e9C621a5BaDaA536219b3a228C8168cf5d` holds no code on Arc,
 * which is exactly what a testnet should look like. A mainnet flip moves this
 * constant and re-runs `pnpm arc:verify`; nothing else changes.
 *
 * Proxy at this address; implementation `0xf07c0ad1…` as of 2026-08-01. The
 * seven-argument `depositForBurn` (selector `0x8e0250ee`) is present and the
 * CCTP **v1** four-argument form is absent, which is what makes the v2 shape the
 * only shape.
 */
export const ARC_TOKEN_MESSENGER_V2: Address = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";

/**
 * CCTP v2 `MessageTransmitterV2` on Arc — the message side.
 *
 * `depositForBurn` emits `MessageSent(bytes message)` from here, not from the
 * messenger, so a payout dispatcher that watches the wrong address sees nothing
 * and reports a successful burn with no message to attest. `localDomain()` reads
 * 26 and `signatureThreshold()` reads 2.
 *
 * It also holds one of the three kill switches Plazo does not control:
 * `paused()` halts all CCTP messaging. That is why the burn is dispatched after
 * settlement rather than inside it.
 */
export const ARC_MESSAGE_TRANSMITTER_V2: Address = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";

/**
 * CCTP v2 `TokenMinterV2` on Arc.
 *
 * Holds the per-message burn ceiling — `burnLimitsPerMessage(ARC_USDC)` reads
 * `1e13`, which is 10,000,000 USDC at 6 decimals — and the second kill switch.
 * Plazo never calls it directly; it is here so the gate can read the ceiling and
 * the pause state, because a payout larger than the ceiling reverts and a payout
 * during a minter pause strands.
 */
export const ARC_TOKEN_MINTER_V2: Address = "0xb43db544E2c27092c107639Ad201b3dEfAbcF192";

/**
 * Circle Gateway `GatewayWallet` on Arc — where a unified balance is deposited.
 *
 * The inbound half of the lender funding path. It carries
 * `depositWithAuthorization` (EIP-3009), which means a lender can fund a
 * unified balance with the same signature primitive the check strip uses. It
 * does **not** carry `depositWithPermit` in any arity.
 */
export const ARC_GATEWAY_WALLET: Address = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

/**
 * Circle Gateway `GatewayMinter` on Arc — where an attested unified balance
 * lands as USDC.
 *
 * `gatewayMint(bytes attestationPayload, bytes signature)`. A bare
 * `mint(bytes,bytes)` is absent.
 */
export const ARC_GATEWAY_MINTER: Address = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B";

/**
 * Circle's attestation service, sandbox.
 *
 * ⚠️ **The endpoint form documented in Circle's own technical guide does not
 * route.** `GET /v2/messages?txHash=…` returns an HTML `Cannot GET /v2/messages`
 * with status 404. The working form is
 *
 *     GET /v2/messages/{sourceDomain}?transactionHash=0x…
 *     GET /v2/messages/{sourceDomain}?nonce=0x…
 *
 * and when the message genuinely is not indexed yet it answers 404 with a JSON
 * body of `{"error":"Message not found for provided parameters"}`.
 *
 * Both forms return 404, so **a poller must branch on the body shape, not on the
 * status code**. One 404 means "wait and ask again"; the other means the URL is
 * wrong and waiting will never fix it.
 */
export const IRIS_SANDBOX_BASE_URL = "https://iris-api-sandbox.circle.com/v2";

/** The mainnet attestation service. Same path shapes, same 404 caveat. */
export const IRIS_MAINNET_BASE_URL = "https://iris-api.circle.com/v2";

/**
 * Circle Gateway's testnet API.
 *
 * `/v1/info` and `/v1/balances` both answered 200 unauthenticated, which matches
 * Circle's position that Gateway kit keys are free and require no KYC. `/v1/info`
 * lists Arc as domain 26 among thirteen testnet domains.
 */
export const GATEWAY_API_TESTNET_BASE_URL = "https://gateway-api-testnet.circle.com/v1";

/**
 * `minFinalityThreshold` for every burn Plazo sends. 2000 is "standard"
 * (source-finalized); 1000 is "fast".
 *
 * There is deliberately no fast/standard toggle. Circle's fee oracle returns
 * `minimumFee: 0` from domain 26 to every destination at **both** thresholds, so
 * fast buys nothing that standard does not already give — and Arc's
 * deterministic single-slot finality means "finalized" arrives in about half a
 * second anyway. A toggle here would be a control with no effect and a second
 * code path to test.
 */
export const CCTP_FINALITY_STANDARD = 2000;

/**
 * `maxFee` for every burn Plazo sends.
 *
 * Zero, and not as an optimism: the fee oracle was queried live for domains
 * 0,1,2,3,6,7,10,11,13,14,16,21 out of Arc and returned `minimumFee: 0` for all
 * of them at both finality thresholds. Outbound merchant payouts from Arc are
 * free. (Inbound is not — Ethereum→Arc fast costs a basis point — and the
 * asymmetry runs in Plazo's favour.)
 *
 * If this ever needs to be non-zero, the fee is read from the oracle at dispatch
 * time rather than guessed, because a `maxFee` below the minimum reverts.
 */
export const CCTP_MAX_FEE_FROM_ARC = 0n;

/**
 * `GatewayWallet.withdrawalDelay()` on Arc, in seconds. Fourteen days.
 *
 * Circle's documentation says seven. The chain says fourteen, and the chain
 * wins — this figure was read from the deployed contract, not from a page.
 *
 * It matters because it is the honest headline for the lender surface: Gateway's
 * `initiateWithdrawal` → wait → `withdraw` is the non-attested escape hatch out
 * of a unified balance, not a transfer, and presenting it as the redemption route
 * would understate the wait by a week. The redemption route out of Arc is CCTP,
 * which costs zero and clears in seconds.
 */
export const GATEWAY_WITHDRAWAL_DELAY_SECONDS = 1_209_600;

/**
 * An address as CCTP's `mintRecipient`: **left**-padded to 32 bytes.
 *
 * The padding direction is the whole function. `mintRecipient` is a `bytes32`
 * and an address is 20 bytes, so something has to fill the other twelve. Left
 * padding — `0x000…0<address>` — is what every CCTP implementation decodes back
 * to an address. Right padding produces a well-formed `bytes32` that decodes to
 * a *different*, unowned address on the destination chain, and the mint
 * succeeds. There is no revert, no error, and no recovery: the USDC exists, at
 * an address whose key does not.
 *
 * So this is a named function with a test asserting the direction, rather than
 * an inline cast at each call site.
 */
export function mintRecipient(recipient: Address): Hex {
  return pad(recipient, {size: 32});
}
