/**
 * XCH-01's closeout: an owner, a measured funding branch, and the one assertion that
 * needs no capital at all.
 *
 * ---
 *
 * **Why this file exists is the reason requirements get lost.** Phase 6 built both inbound
 * routes — the Gateway burn intent, transcribed from `circlefin/evm-gateway-contracts`
 * source rather than from a prose guide, and the CCTP two-step fallback (D-14). Neither has
 * ever been exercised: **no burn intent has ever been signed and accepted, and no USDC has
 * ever moved *into* Arc.** REQUIREMENTS.md recorded it as "Carried — no later milestone
 * phase currently covers it", and a requirement no phase owns is a requirement that quietly
 * does not ship. E-12 assigns it to Phase 7, and this is where that assignment lives.
 *
 * ---
 *
 * **DEC-38 constrains what this can even attempt.** Gateway burn intents accept **EOA
 * signatures only**, and DEC-01 keeps the tranche shares as transfer-restricted Reg-D
 * securities held by institutions, so the lender surface assumes a multisig signer until
 * told otherwise. XCH-01 therefore needs a funded **EOA on a second Gateway-supported
 * testnet** — an access-and-funding item, not a code item — and this module's job is to say
 * which chain, which address and how much, in the units the gap is actually paid in.
 *
 * **Both branches are a pass**, on the `gov08.ts` standard. The funding precondition is read
 * **first**, before anything is attempted. A run that half-completes a cross-chain deposit
 * and then stops is worse than one that refuses to start: the money is committed, the
 * assertions did not happen, and the next attempt inherits a state nobody can describe.
 *
 * ---
 *
 * **DEC-37 is the defect this catches with zero capital, and it is the reason the unfunded
 * branch is worth running at all.** Circle Gateway's EIP-712 domain is `{name, version}`
 * and nothing else. `EIP712Domain.sol` says so in as many words: *"This implementation
 * intentionally deviates from the standard by omitting `chainId` and `verifyingContract` …
 * This modification ensures burn intents can be verified across different chains and
 * contract deployments."* Every other EIP-712 surface in this repository uses the
 * four-field form, so the helpful correction is the natural mistake — and it is silent.
 * Adding either field produces a domain separator Gateway has never seen, and every
 * signature is invalid without anything reporting an error.
 *
 * So the two-field assertion runs on **both** branches, and it is demonstrated firing
 * rather than asserted to exist: `assertTwoFieldDomain` is handed a domain with `chainId`
 * added and watched refusing it. A guard nobody has seen refuse is a guard nobody has
 * tested.
 */
import {
  createPublicClient,
  formatEther,
  formatUnits,
  hashDomain,
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
  ARC_CCTP_DOMAIN,
  ARC_GATEWAY_MINTER,
  ARC_GATEWAY_WALLET,
  ARC_MESSAGE_TRANSMITTER_V2,
  ARC_TESTNET_RPC_URL,
  ARC_TOKEN_MESSENGER_V2,
  ARC_TOKEN_MINTER_V2,
  ARC_USDC,
} from "@plazo/plan-core";

import {shed} from "./slice.js";

// ─── Configuration, documented at its point of use (DEC-55) ───────────────────
//
//   PLAZO_XCH01                  — "1" to run this at all. Opt-in, exactly as PLAZO_GOV08 is.
//   PLAZO_XCH01_ORIGIN_CHAIN_ID  — the CCTP/Gateway domain's chain id. Default: Base Sepolia.
//   PLAZO_XCH01_ORIGIN_RPC_URL   — an RPC for that chain. Without it, nothing can be read.
//   PLAZO_XCH01_ORIGIN_KEY       — the funded EOA's key (DEC-38). Never written to disk.
//
// Not listed in `.env.example`, which scopes itself to the operator database and says why:
// a variable listed twice is one list eventually getting it wrong, silently.

/** Base Sepolia. Phase 6's CCTP spike burned *out of* Arc to this chain (finding 28). */
const DEFAULT_ORIGIN_CHAIN_ID = 84_532;

/** Base Sepolia's CCTP/Gateway domain. Circle numbers Gateway domains the way CCTP does. */
const DEFAULT_ORIGIN_DOMAIN = 6;

/** USDC on Base Sepolia — Circle's published testnet address for that chain. */
const DEFAULT_ORIGIN_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

/**
 * The deposit this would move. One dollar.
 *
 * The assertion is **arrival**, not size: a burn intent that Gateway accepts and a mint
 * that lands on Arc prove the route, and a hundred dollars would prove exactly the same
 * thing while costing a hundred dollars. Phase 6's outbound CCTP spike used the same
 * figure for the same reason.
 */
const XCH01_DEPOSIT_NOTIONAL = 1_000_000n;

/**
 * Headroom for whatever Gateway charges, held as an **allowance and named as unmeasured**.
 *
 * DEC-32 measured the CCTP protocol fee out of Arc at exactly zero, as a balance delta
 * rather than as a quote — but Gateway is a different rail with its own fee schedule and
 * **this project has never seen a Gateway invoice**. Writing "the fee is zero" here would
 * be carrying a measurement of one rail across to another, which is the class of error
 * this file exists to prevent. Two dollars of headroom, stated as headroom.
 */
const XCH01_GATEWAY_FEE_ALLOWANCE = 2_000_000n;

/**
 * USDC the origin EOA must hold, on the origin chain.
 *
 *     1.00  the deposit itself
 *   + 2.00  unmeasured Gateway fee allowance
 *   = 3.00  USDC, on the origin chain and not on Arc
 */
export const XCH01_REQUIRED = XCH01_DEPOSIT_NOTIONAL + XCH01_GATEWAY_FEE_ALLOWANCE;

/**
 * Native gas the origin EOA must hold, on the origin chain.
 *
 * Two transactions — `approve` and `GatewayWallet.deposit` — on an EVM testnet whose gas
 * token is ether rather than USDC. 0.002 ETH is generous at Base Sepolia's fees and is
 * stated as generous; the point of the figure is that **the gap is denominated in a second
 * unit**, and a run that reported only the USDC shortfall would send an operator to a USDC
 * faucet and leave them unable to send a transaction.
 */
export const XCH01_ORIGIN_GAS_REQUIRED = 2_000_000_000_000_000n;

/**
 * USDC the deployer must hold on **Arc**, to submit the attestation.
 *
 * `destinationCaller` is left zero in the spec Phase 6 built, so any caller may redeem —
 * which means this run would be the caller. Arc gas is USDC and a 120k-gas transaction
 * costs about 0.0025, so one dollar is four hundred times the need and is here so the
 * arithmetic is complete rather than because it is tight.
 */
export const XCH01_ARC_GAS_REQUIRED = 1_000_000n;

/**
 * Circle Gateway's EIP-712 domain, and it has exactly two fields.
 *
 * From `circlefin/evm-gateway-contracts@ee628dc`, `src/lib/EIP712Domain.sol`. The
 * four-field form every other EIP-712 surface in this repository uses is **wrong here**,
 * and wrong in silence.
 */
const GATEWAY_EIP712_DOMAIN = {name: "GatewayWallet", version: "1"} as const;

/** `keccak256("EIP712Domain(string name,string version)")`, from Circle's own source. */
const TWO_FIELD_DOMAIN_TYPEHASH =
  "0xb03948446334eb9b2196d5eb166f69b9d49403eb4a12f36de8d3f9f3cb8e15c3" as const;

const CODE_PROBE_ABI = parseAbi([
  "function localDomain() view returns (uint32)",
  "function localMinter() view returns (address)",
  "function localMessageTransmitter() view returns (address)",
  "function domain() view returns (uint32)",
  "function isTokenSupported(address token) view returns (bool)",
]);

const ERC20_ABI = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

// ─── Reads, each wrapped once ─────────────────────────────────────────────────

async function view<T>(
  client: PublicClient,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return shed(() => client.readContract({address, abi: abi as any, functionName, args})) as Promise<T>;
}

async function codeAt(client: PublicClient, address: Address): Promise<Hex | undefined> {
  return shed(() => client.getCode({address}));
}

async function nativeBalance(client: PublicClient, address: Address): Promise<bigint> {
  return shed(() => client.getBalance({address}));
}

function usdc(value: bigint): string {
  return `${formatUnits(value, 6)} USDC`;
}

let passed = 0;
let failed = 0;
let noted = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.log(`  XX  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A fact recorded rather than asserted. It does not increment a pass count (findings 16-27). */
function note(label: string, detail: string): void {
  noted++;
  console.log(`  --  ${label} — ${detail}`);
}

// ─── The zero-capital assertion (DEC-37) ──────────────────────────────────────

/**
 * Refuse any Gateway domain that carries more than `name` and `version`.
 *
 * Exported because it is **demonstrated firing**, not merely asserted to exist. Handed a
 * domain with `chainId` added, it must throw; a guard nobody has watched refuse is a guard
 * nobody has tested. The message names the offending field and what it would have cost,
 * because a guard that says only "refused" teaches the next reader to disable it.
 */
export function assertTwoFieldDomain(domain: Record<string, unknown>): void {
  const fields = Object.keys(domain).sort();
  const expected = ["name", "version"];

  const extra = fields.filter((f) => !expected.includes(f));
  const missing = expected.filter((f) => !fields.includes(f));

  if (extra.length > 0 || missing.length > 0) {
    throw new Error(
      `REFUSED: the Gateway EIP-712 domain must be exactly {name, version}. ` +
        `Found [${fields.join(", ")}]` +
        (extra.length > 0 ? `, with ${extra.join(", ")} added` : "") +
        (missing.length > 0 ? `, with ${missing.join(", ")} missing` : "") +
        ".\n\n" +
        "DEC-37. `circlefin/evm-gateway-contracts@ee628dc` src/lib/EIP712Domain.sol omits\n" +
        "`chainId` and `verifyingContract` deliberately, so a burn intent verifies across\n" +
        "chains and deployments. Adding either produces a domain separator Gateway has never\n" +
        "seen — and nothing reports an error. Every signature is simply invalid, at the\n" +
        "counter, after the money has already been deposited.",
    );
  }
}

/**
 * The domain assertion plus its own negative control, run together.
 *
 * The pair is the point. Asserting only that the correct domain passes proves nothing
 * about a check that might accept everything.
 */
function runGatewayDomainAssertion(): void {
  console.log("\nThe Gateway EIP-712 domain — DEC-37, and it costs nothing to check");

  const fields = Object.keys(GATEWAY_EIP712_DOMAIN);
  check("the domain has exactly two fields", fields.length === 2, fields.join(", "));
  check("no chainId", !("chainId" in GATEWAY_EIP712_DOMAIN), "the four-field form is wrong here");
  check(
    "no verifyingContract",
    !("verifyingContract" in GATEWAY_EIP712_DOMAIN),
    "a burn intent verifies across chains and deployments",
  );

  const typehash = keccak256(toHex("EIP712Domain(string name,string version)"));
  check(
    "the two-field EIP712Domain typehash matches Circle's source",
    typehash === TWO_FIELD_DOMAIN_TYPEHASH,
    typehash,
  );

  let accepted = false;
  try {
    assertTwoFieldDomain({...GATEWAY_EIP712_DOMAIN});
    accepted = true;
  } catch {
    accepted = false;
  }
  check("assertTwoFieldDomain accepts the correct domain", accepted);

  // The negative control. Add `chainId` — the single most natural mistake, because every
  // other EIP-712 surface in this repository carries it — and watch the guard refuse.
  let refused = "";
  try {
    assertTwoFieldDomain({...GATEWAY_EIP712_DOMAIN, chainId: arcTestnet.id});
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  check("and refuses one with chainId added", refused.startsWith("REFUSED:"), refused.split("\n")[0] ?? "");

  // The separator itself, so the consequence is a number rather than a claim.
  //
  // Both type arrays are written out rather than inferred, because the whole defect is
  // that the four-field array is the one everybody reaches for. Seeing them side by side
  // is the point.
  const correct = hashDomain({
    domain: GATEWAY_EIP712_DOMAIN,
    types: {
      EIP712Domain: [
        {name: "name", type: "string"},
        {name: "version", type: "string"},
      ],
    },
  });
  const wrong = hashDomain({
    domain: {...GATEWAY_EIP712_DOMAIN, chainId: arcTestnet.id, verifyingContract: ARC_GATEWAY_WALLET},
    types: {
      EIP712Domain: [
        {name: "name", type: "string"},
        {name: "version", type: "string"},
        {name: "chainId", type: "uint256"},
        {name: "verifyingContract", type: "address"},
      ],
    },
  });
  check(
    "the four-field separator is a different value entirely",
    correct !== wrong,
    `${correct.slice(0, 18)}… vs ${wrong.slice(0, 18)}…`,
  );
  note(
    "what that difference costs",
    "every signature against the wrong separator is invalid, and nothing reports it",
  );
}

// ─── The funding precondition ─────────────────────────────────────────────────

export interface Xch01Funding {
  originChainId: number;
  originDomain: number;
  originRpcConfigured: boolean;
  eoa: Address | null;
  usdcHeld: bigint | null;
  gasHeld: bigint | null;
  arcHeld: bigint;
  required: bigint;
  funded: boolean;
  shortfall: bigint;
  gasShortfall: bigint;
  faucetVisits: bigint;
}

/**
 * Read the precondition, first, before anything is attempted.
 *
 * Three unknowns are reported separately rather than collapsed into one boolean, because
 * they are paid for in three different places: USDC on the origin chain, native gas on the
 * origin chain, and USDC on Arc. An operator told only "unfunded" has to guess which.
 *
 * The EOA is derived from `PLAZO_XCH01_ORIGIN_KEY` and never written to disk. A plaintext
 * key file for funded accounts is a liability with a lifetime; the derivation costs nothing
 * and leaks nothing.
 */
export async function readXch01Funding(arcClient: PublicClient): Promise<Xch01Funding> {
  const originChainId = Number(process.env["PLAZO_XCH01_ORIGIN_CHAIN_ID"] ?? DEFAULT_ORIGIN_CHAIN_ID);
  const originRpc = process.env["PLAZO_XCH01_ORIGIN_RPC_URL"];
  const originKey = process.env["PLAZO_XCH01_ORIGIN_KEY"] as Hex | undefined;
  const arcKey = process.env["DEPLOYER_PRIVATE_KEY"] as Hex | undefined;

  const eoa = originKey ? privateKeyToAccount(originKey).address : null;

  let usdcHeld: bigint | null = null;
  let gasHeld: bigint | null = null;

  if (originRpc && eoa) {
    const originClient = createPublicClient({transport: http(originRpc)}) as PublicClient;
    const originUsdc = (process.env["PLAZO_XCH01_ORIGIN_USDC"] as Address | undefined) ?? DEFAULT_ORIGIN_USDC;
    usdcHeld = await view<bigint>(originClient, originUsdc, ERC20_ABI, "balanceOf", [eoa]);
    gasHeld = await nativeBalance(originClient, eoa);
  }

  const arcHeld = arcKey
    ? (await nativeBalance(arcClient, privateKeyToAccount(arcKey).address)) / 1_000_000_000_000n
    : 0n;

  const held = usdcHeld ?? 0n;
  const shortfall = held >= XCH01_REQUIRED ? 0n : XCH01_REQUIRED - held;
  const gas = gasHeld ?? 0n;
  const gasShortfall = gas >= XCH01_ORIGIN_GAS_REQUIRED ? 0n : XCH01_ORIGIN_GAS_REQUIRED - gas;

  return {
    originChainId,
    originDomain: Number(process.env["PLAZO_XCH01_ORIGIN_DOMAIN"] ?? DEFAULT_ORIGIN_DOMAIN),
    originRpcConfigured: Boolean(originRpc),
    eoa,
    usdcHeld,
    gasHeld,
    arcHeld,
    required: XCH01_REQUIRED,
    funded:
      Boolean(originRpc) &&
      eoa !== null &&
      shortfall === 0n &&
      gasShortfall === 0n &&
      arcHeld >= XCH01_ARC_GAS_REQUIRED,
    shortfall,
    gasShortfall,
    // One faucet visit per dollar-ish drip. `faucet.circle.com` dispenses on the origin
    // chain too, and the number of visits is the unit this gap is actually paid in.
    faucetVisits: shortfall === 0n ? 0n : (shortfall + 9_999_999n) / 10_000_000n,
  };
}

// ─── The funded branch, declared rather than written ──────────────────────────

/**
 * Sign a burn intent with the origin EOA, submit it, poll for acceptance, and assert USDC
 * arrived on Arc — the first inbound value movement in this project's history.
 *
 * **Deliberately unwritten, and this is a stub declared as one.** The precondition below
 * has never been met: this project holds no EOA on a second Gateway-supported testnet, and
 * DEC-38 says why one is needed rather than a multisig. Writing hundreds of lines of
 * submission-and-poll code that has never executed against Gateway, and then having a
 * funded operator run it blind, is precisely the hazard the preflight audit in findings
 * 20-27 exists to prevent — that audit found eight defects in one un-run half, one of which
 * would have bricked the pool permanently while reporting success. T-07-12-11 prescribes
 * this remedy for this plan by name.
 *
 * So this throws, and what it must do is written down instead:
 *
 *   - `GET {GATEWAY_API_TESTNET_BASE_URL}/info` and take `burnIntentExpirationHeight` for
 *     the origin domain. **It is a required argument and not a derived one**: a default
 *     lookahead here is a hardcoded expiry by another name, and a burn intent signed
 *     against a sample height has already expired.
 *   - `approve` USDC to `GatewayWallet` on the origin chain and `deposit`. Gas is the
 *     origin chain's native token, which is why `XCH01_ORIGIN_GAS_REQUIRED` exists.
 *   - Build the `BurnIntent` typed data with `TransferSpec` field ordering taken from
 *     `circlefin/evm-gateway-contracts@ee628dc` — `test/js/eip712TestData.js`,
 *     `src/lib/TransferSpec.sol`, `src/lib/BurnIntents.sol`. EIP-712 hashes fields in
 *     declaration order, so a struct assembled from a prose list has a good chance of
 *     being mis-ordered, and a mis-ordered struct produces a signature Gateway rejects —
 *     or, worse, one it accepts against fields the lender did not read.
 *   - Sign it against `GATEWAY_EIP712_DOMAIN`, having run `assertTwoFieldDomain` on the
 *     object that is actually about to be signed rather than on a copy of the constant.
 *   - `POST /v1/transfer` with the signed intent; poll until Gateway attests; submit the
 *     attestation to `GatewayMinter` on Arc — `destinationCaller` is zero, so this run may
 *     be the caller.
 *   - Assert the **Arc balance delta**, not that a transfer record exists. Finding 27: a
 *     ticket is not a payment.
 *   - Report the elapsed time and the balance delta as measured figures, never as quotes
 *     (DEC-32). And record the Gateway fee, which this project has never seen and which
 *     `XCH01_GATEWAY_FEE_ALLOWANCE` currently only guesses at.
 */
function runTheInboundTransfer(): never {
  throw new Error(
    "The XCH-01 inbound Gateway transfer is not implemented. It has never been fundable —\n" +
      "it needs an EOA on a second Gateway-supported testnet (DEC-38) that this project does\n" +
      "not hold — and shipping an un-run implementation of it is the hazard findings 20-27\n" +
      "exist to prevent. Its specification is in this function's docstring.\n" +
      "The zero-capital half of XCH-01 (DEC-37's two-field domain) runs on both branches and\n" +
      "is green.",
  );
}

// ─── The orchestrator ─────────────────────────────────────────────────────────

export async function runXch01(): Promise<void> {
  if (process.env["PLAZO_XCH01"] !== "1") {
    console.log(
      "The XCH-01 live closeout is opt-in. Set PLAZO_XCH01=1 to run it.\n\n" +
        "It reads a funding precondition on a second testnet and runs the zero-capital\n" +
        "Gateway domain assertion (DEC-37) on both branches. It spends nothing on either.",
    );
    return;
  }

  const transport = http(process.env["ARC_TESTNET_RPC_URL"] ?? ARC_TESTNET_RPC_URL);
  const arcClient = createPublicClient({chain: arcTestnet, transport}) as PublicClient;

  console.log("XCH-01 — a lender depositing from a Gateway-supported chain");

  // ── The precondition, first ────────────────────────────────────────────────
  const f = await readXch01Funding(arcClient);

  console.log("\nThe funding precondition, read before anything is attempted");
  console.log(`  origin chain        ${f.originChainId} (Gateway/CCTP domain ${f.originDomain})`);
  console.log(`  origin RPC          ${f.originRpcConfigured ? "configured" : "NOT configured — PLAZO_XCH01_ORIGIN_RPC_URL"}`);
  console.log(`  origin EOA          ${f.eoa ?? "NONE — PLAZO_XCH01_ORIGIN_KEY is unset (DEC-38 needs an EOA, not a multisig)"}`);
  console.log(`  origin USDC held    ${f.usdcHeld === null ? "unreadable" : usdc(f.usdcHeld)}`);
  console.log(`  XCH01_REQUIRED      ${usdc(f.required)} — 1.00 deposit + 2.00 unmeasured Gateway fee allowance`);
  console.log(`  origin USDC short   ${usdc(f.shortfall)}`);
  console.log(`  origin gas held     ${f.gasHeld === null ? "unreadable" : `${formatEther(f.gasHeld)} ETH`}`);
  console.log(`  origin gas required ${formatEther(XCH01_ORIGIN_GAS_REQUIRED)} ETH — approve + deposit, a second unit`);
  console.log(`  origin gas short    ${formatEther(f.gasShortfall)} ETH`);
  console.log(`  Arc USDC held       ${usdc(f.arcHeld)} (for the mint submission; ${usdc(XCH01_ARC_GAS_REQUIRED)} required)`);
  console.log(`  origin faucet trips ${f.faucetVisits}`);
  console.log(`  branch              ${f.funded ? "FUNDED" : "UNFUNDED"}`);

  if (!f.funded) {
    console.log("");
    console.log(
      "  This is a precondition that was not met, not a failure. What is missing is an\n" +
        "  access-and-funding item and not a code item: Gateway burn intents accept EOA\n" +
        "  signatures only (DEC-38), and DEC-01 keeps the tranche shares as transfer-restricted\n" +
        "  Reg-D securities held by institutions — so the lender surface assumes a multisig\n" +
        "  signer, and XCH-01 needs an EOA on a second testnet that this project does not hold.\n" +
        "\n" +
        "  Every check below needs reads rather than capital, and the one that matters most —\n" +
        "  DEC-37's two-field domain — needs neither a chain nor a key.\n",
    );
  }

  // ── Zero capital: the domain, and its negative control ─────────────────────
  runGatewayDomainAssertion();

  // ── Zero capital: the Arc side of both routes still answers ────────────────
  console.log("\nThe Arc side of the Gateway route");
  for (const [label, address] of [
    ["GatewayWallet", ARC_GATEWAY_WALLET],
    ["GatewayMinter", ARC_GATEWAY_MINTER],
  ] as [string, Address][]) {
    const code = await codeAt(arcClient, address);
    const size = code && code !== "0x" ? (code.length - 2) / 2 : 0;
    check(`${label} holds code`, size > 0, `${address} ${size}b`);
  }

  const walletDomain = await view<number>(arcClient, ARC_GATEWAY_WALLET, CODE_PROBE_ABI, "domain");
  check("GatewayWallet.domain is Arc's", Number(walletDomain) === ARC_CCTP_DOMAIN, String(walletDomain));
  const minterDomain = await view<number>(arcClient, ARC_GATEWAY_MINTER, CODE_PROBE_ABI, "domain");
  check("GatewayMinter.domain is Arc's", Number(minterDomain) === ARC_CCTP_DOMAIN, String(minterDomain));
  const supported = await view<boolean>(arcClient, ARC_GATEWAY_MINTER, CODE_PROBE_ABI, "isTokenSupported", [
    ARC_USDC,
  ]);
  check("GatewayMinter supports Arc USDC", supported, ARC_USDC);

  console.log("\nThe CCTP two-step fallback (D-14), on the same chain");
  const localDomain = await view<number>(
    arcClient,
    ARC_MESSAGE_TRANSMITTER_V2,
    CODE_PROBE_ABI,
    "localDomain",
  );
  check(
    "MessageTransmitterV2.localDomain is Arc's",
    Number(localDomain) === ARC_CCTP_DOMAIN,
    String(localDomain),
  );
  const minter = await view<Address>(arcClient, ARC_TOKEN_MESSENGER_V2, CODE_PROBE_ABI, "localMinter");
  check(
    "TokenMessengerV2 names the recorded TokenMinterV2",
    minter.toLowerCase() === ARC_TOKEN_MINTER_V2.toLowerCase(),
    minter,
  );
  note(
    "the fallback's outbound half is the only half ever exercised",
    "Phase 6 burned 1.000000 USDC out of Arc at a measured zero protocol fee (DEC-32, finding 28); nothing has ever come in",
  );

  console.log("");
  console.log(`  ${passed} checks passed, ${failed} failed, ${noted} noted and not counted`);
  console.log(`  branch  ${f.funded ? "FUNDED" : "UNFUNDED"}`);
  console.log("");
  console.log(
    f.funded
      ? "  The precondition is met. The inbound transfer follows."
      : "  XCH-01 is NOT ticked on this branch. It has an owner — Phase 7 — a measured gap, and\n" +
          "  a Manual-Only row in 07-VALIDATION.md carrying this exact command, so the next\n" +
          "  operator does not have to reconstruct it.",
  );

  if (failed > 0) {
    throw new Error(
      `${failed} XCH-01 checks failed. A failing check here is a chain or a constant that has\n` +
        "moved, not a precondition that was not met — the two exit differently on purpose.",
    );
  }

  if (f.funded) runTheInboundTransfer();
}
