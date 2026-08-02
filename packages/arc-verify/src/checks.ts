/**
 * Every Arc primitive the protocol depends on, asserted against a live RPC.
 *
 * This is a gate, not a report. Each check either passes or fails the build. The
 * point is not to document what Arc does today — it is to notice the day it stops
 * doing it, and to notice on the mainnet profile before a strip is signed rather
 * than after.
 *
 * Two families of assertion matter especially:
 *
 *  - The *derived* domain separator. It is reconstructed from the four EIP-712
 *    fields and compared to what the token reports. Hardcoding the separator would
 *    make every outstanding strip silently fail to validate the day `chainId` or
 *    `verifyingContract` changes, which is exactly what happens at a mainnet flip.
 *
 *  - The *negative* assertions. USYC having no EIP-3009 is load-bearing: the
 *    idle-buffer and Tier-2 collateral paths are written against `approve` /
 *    `transferFrom` because of it. If USYC gains EIP-3009 later, that should
 *    surface as a deliberate reconsideration, not as an unnoticed capability.
 *
 * A third family joined in Phase 6: the CCTP v2 and Gateway probes. Those two
 * systems belong to Circle, not to Plazo, and they carry three kill switches and
 * a redeployable address set that nothing in this repo controls. Everything the
 * payout path will call is therefore read here — domain, version, pause state,
 * burn ceiling, token support, route table — so that a change on Circle's side
 * is a failing build rather than a merchant payout into an address nobody holds.
 */
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  encodeAbiParameters,
  parseAbi,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import {
  ARC_CCTP_DOMAIN,
  ARC_EURC,
  ARC_GATEWAY_MINTER,
  ARC_GATEWAY_WALLET,
  ARC_MAX_LOG_RANGE,
  ARC_MESSAGE_TRANSMITTER_V2,
  ARC_TOKEN_MESSENGER_V2,
  ARC_TOKEN_MINTER_V2,
  ARC_USDC,
  ARC_USYC,
  CREATE2_DEPLOYER,
  ENTRYPOINT_V07,
  ERC3009_TYPEHASHES,
  GATEWAY_API_TESTNET_BASE_URL,
  GATEWAY_WITHDRAWAL_DELAY_SECONDS,
  IRIS_SANDBOX_BASE_URL,
  MULTICALL3,
  MULTICALL3_FROM,
} from "@plazo/plan-core";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Why the protocol cares. Printed on failure so the fix is obvious. */
  because?: string;
}

export interface NetworkProfile {
  label: string;
  chainId: number;
  rpcUrl: string;
  usdc: Address;
  /** The implementation this build was verified and audited against. */
  expectedImplementation: Address;
}

const ERC20_ABI = [
  {type: "function", name: "name", inputs: [], outputs: [{type: "string"}], stateMutability: "view"},
  {type: "function", name: "symbol", inputs: [], outputs: [{type: "string"}], stateMutability: "view"},
  {type: "function", name: "version", inputs: [], outputs: [{type: "string"}], stateMutability: "view"},
  {type: "function", name: "decimals", inputs: [], outputs: [{type: "uint8"}], stateMutability: "view"},
  {type: "function", name: "paused", inputs: [], outputs: [{type: "bool"}], stateMutability: "view"},
  {
    type: "function",
    name: "isBlacklisted",
    inputs: [{type: "address"}],
    outputs: [{type: "bool"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    inputs: [],
    outputs: [{type: "bytes32"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "TRANSFER_WITH_AUTHORIZATION_TYPEHASH",
    inputs: [],
    outputs: [{type: "bytes32"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "RECEIVE_WITH_AUTHORIZATION_TYPEHASH",
    inputs: [],
    outputs: [{type: "bytes32"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "CANCEL_AUTHORIZATION_TYPEHASH",
    inputs: [],
    outputs: [{type: "bytes32"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "authorizationState",
    inputs: [{type: "address"}, {type: "bytes32"}],
    outputs: [{type: "bool"}],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "receiveWithAuthorization",
    inputs: [
      {type: "address"},
      {type: "address"},
      {type: "uint256"},
      {type: "uint256"},
      {type: "uint256"},
      {type: "bytes32"},
      {type: "bytes"},
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * Circle's `FiatTokenProxy` predates EIP-1967 and stores its implementation at
 * `keccak256("org.zeppelinos.proxy.implementation")`. Arc's USDC is one of these:
 * the EIP-1967 slot reads zero, and assuming otherwise reports "no implementation"
 * for a proxy that plainly has one.
 */
const ZEPPELINOS_IMPLEMENTATION_SLOT: Hex =
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

/** Checked second, so a future migration to the modern slot is still detected. */
const EIP1967_IMPLEMENTATION_SLOT: Hex =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Two addresses that hold nothing. Every probe below is expected to revert. */
const PROBE_A: Address = "0x00000000000000000000000000000000000000a1";
const PROBE_B: Address = "0x00000000000000000000000000000000000000b2";

function pass(name: string, detail: string): CheckResult {
  return {name, ok: true, detail};
}

function fail(name: string, detail: string, because: string): CheckResult {
  return {name, ok: false, detail, because};
}

/** Extract whatever revert text an eth_call produced, at whatever nesting. */
function revertTextOf(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  const walk = (e: unknown): void => {
    if (e == null || typeof e !== "object" || seen.has(e)) return;
    seen.add(e);
    const rec = e as Record<string, unknown>;
    for (const key of ["shortMessage", "details", "message", "reason", "data"]) {
      const v = rec[key];
      if (typeof v === "string") parts.push(v);
    }
    walk(rec["cause"]);
    if (Array.isArray(rec["metaMessages"])) parts.push(rec["metaMessages"].join(" "));
  };
  walk(error);
  return parts.join(" | ");
}

/**
 * Call something expected to revert, and report the revert text.
 *
 * A check that expects a revert must never accept a *successful* call: if payee
 * enforcement stops reverting, the anti-griefing property is gone and a third
 * party can burn a borrower's authorization nonces.
 */
async function expectRevert(
  client: PublicClient,
  args: {to: Address; data: Hex; from?: Address},
): Promise<{reverted: boolean; text: string}> {
  try {
    await client.call({
      to: args.to,
      data: args.data,
      ...(args.from ? {account: args.from} : {}),
    });
    return {reverted: false, text: "call succeeded"};
  } catch (error) {
    // A shed response is not a revert. Swallowing it here would report the
    // strongest possible evidence — "it reverted, the guard is present" — on the
    // basis of a request the node never executed.
    if (isShed(error)) throw error;
    return {reverted: true, text: revertTextOf(error)};
  }
}

function receiveCallData(overrides: {
  from?: Address;
  to?: Address;
  value?: bigint;
  validAfter?: bigint;
  validBefore?: bigint;
  nonce?: Hex;
  signature?: Hex;
}): Hex {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "receiveWithAuthorization",
    args: [
      overrides.from ?? PROBE_A,
      overrides.to ?? PROBE_B,
      overrides.value ?? 1n,
      overrides.validAfter ?? 0n,
      overrides.validBefore ?? 99_999_999_999n,
      overrides.nonce ?? (`0x${"00".repeat(31)}01` as Hex),
      overrides.signature ?? ("0xdeadbeef" as Hex),
    ],
  });
}

async function hasCode(client: PublicClient, address: Address): Promise<boolean> {
  const code = await client.getCode({address});
  return code !== undefined && code !== "0x";
}

/**
 * Load shedding on the public RPC.
 *
 * `rpc.testnet.arc.io` returns JSON-RPC error -32011 "request limit reached" on
 * roughly a quarter of requests, and it does so regardless of pacing — measured at
 * one request per second it still sheds. It is load shedding, not a rate limit, so
 * backing off further does not help; the request simply has to be repeated.
 *
 * viem does not retry this. Its retry predicate covers transport-level failures
 * (HTTP 429, 5xx, timeouts); a shed request arrives as HTTP 200 with an error body
 * and is passed straight through as a rejection.
 *
 * Anything reading Arc through the public RPC needs this handling — the indexer
 * included. A gate that flakes a quarter of the time is worse than no gate: the
 * failure is indistinguishable from a real regression, so people learn to re-run
 * it until it goes green, which is precisely the habit this gate exists to prevent.
 */
const SHED_PATTERN = /request limit reached|-32011|too many requests|rate limit/i;

function isShed(error: unknown): boolean {
  const seen = new Set<unknown>();
  const check = (e: unknown): boolean => {
    if (e == null || seen.has(e)) return false;
    seen.add(e);
    if (typeof e === "string") return SHED_PATTERN.test(e);
    if (typeof e !== "object") return false;
    const rec = e as Record<string, unknown>;
    if (rec["code"] === -32011) return true;
    for (const key of ["message", "shortMessage", "details", "reason"]) {
      const v = rec[key];
      if (typeof v === "string" && SHED_PATTERN.test(v)) return true;
    }
    return check(rec["cause"]) || check(rec["error"]);
  };
  return check(error);
}

/** Serialized, with a bounded retry on shed responses only. */
function createThrottle(gapMs: number, attempts = 8): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();

  const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        // Only shed responses are retried. A genuine assertion failure — a wrong
        // typehash, a missing contract — must surface on the first attempt.
        if (!isShed(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, gapMs * (attempt + 1)));
      }
    }
    throw lastError;
  };

  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      return withRetry(fn);
    });
    tail = run.catch(() => undefined);
    return run as Promise<T>;
  };
}

type Throttle = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * The CCTP v2 and Gateway surface, as read from Arc.
 *
 * Only the views the payout and funding paths actually depend on. Written
 * against `parseAbi` rather than the vendored Circle contracts on purpose: five
 * function signatures do not justify a git submodule under a tree pinned to
 * OpenZeppelin 5.6.1, and a signature that drifts is caught here by the read
 * failing rather than by the compiler agreeing with a stale copy.
 */
const CCTP_ABI = parseAbi([
  "function localDomain() view returns (uint32)",
  "function messageBodyVersion() view returns (uint32)",
  "function paused() view returns (bool)",
  "function burnLimitsPerMessage(address token) view returns (uint256)",
  "function remoteTokenMessengers(uint32 domain) view returns (bytes32)",
]);

const GATEWAY_ABI = parseAbi([
  "function withdrawalDelay() view returns (uint256)",
  "function isTokenSupported(address token) view returns (bool)",
  "function domain() view returns (uint32)",
]);

/** `TokenMinterV2.burnLimitsPerMessage(USDC)`. 10,000,000 USDC at 6 decimals. */
const EXPECTED_BURN_CEILING = 10_000_000_000_000n;

const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;

/** Base Sepolia. A live CCTP v2 domain that is not Arc, used as the route control. */
const CONTROL_REMOTE_DOMAIN = 6;

/**
 * CCTP **v1**'s burn selectors.
 *
 * Their absence is the assertion. The v1 four-argument `depositForBurn` and its
 * five-argument `WithCaller` sibling are what a model trained on three years of
 * CCTP integrations will reach for, and against a v2 deployment they fail at
 * integration rather than at compile time. Proving they are not in the deployed
 * bytecode is what makes the seven-argument form the only shape available.
 */
const CCTP_V1_SELECTORS: ReadonlyArray<[string, string]> = [
  ["6fd3504e", "depositForBurn(uint256,uint32,bytes32,address)"],
  ["f856ddb6", "depositForBurnWithCaller(uint256,uint32,bytes32,address,bytes32)"],
];

/**
 * CCTP v2's seven-argument `depositForBurn`.
 *
 * A control on the search itself. An absence assertion that passes because the
 * bytecode fetch returned empty, or because the scan is looking in the wrong
 * place, is worse than no assertion — it reports the strongest possible evidence
 * on the basis of having looked at nothing.
 */
const CCTP_V2_DEPOSIT_FOR_BURN = "8e0250ee";

/** Circle's proxies for CCTP v2 are EIP-1967, unlike the FiatToken proxy above. */
async function implementationOf(
  client: PublicClient,
  throttle: Throttle,
  proxy: Address,
): Promise<Address> {
  const raw = await throttle(() =>
    client.getStorageAt({address: proxy, slot: EIP1967_IMPLEMENTATION_SLOT}),
  );
  return raw ? (`0x${raw.slice(-40)}` as Address) : ZERO_ADDRESS;
}

/**
 * A JSON GET that degrades to a check failure rather than an exception.
 *
 * Circle's HTTP services are a vendor on the settlement path and they are
 * reachable or they are not. A transport error here has to arrive as a `fail`
 * carrying the status, because a thrown exception aborts the whole gate and
 * takes twenty-five unrelated on-chain assertions down with a DNS hiccup.
 */
async function getJson(url: string): Promise<{ok: true; body: unknown} | {ok: false; why: string}> {
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(20_000)});
    if (!response.ok) return {ok: false, why: `HTTP ${response.status} from ${url}`};
    return {ok: true, body: (await response.json()) as unknown};
  } catch (error) {
    return {ok: false, why: error instanceof Error ? error.message : String(error)};
  }
}

/**
 * CCTP v2 and Circle Gateway, as the merchant payout and lender funding paths
 * assume them.
 *
 * Every address comes from `@plazo/plan-core`. None is written here: a literal
 * in a check file is a literal that can disagree with the one the contract calls,
 * and then the gate is green about an address the protocol does not use.
 */
export async function runCctpAndGatewayChecks(
  client: PublicClient,
  throttle: Throttle,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const cctp = <T>(functionName: string, address: Address, args: readonly unknown[] = []) =>
    throttle(
      () =>
        client.readContract({
          address,
          abi: CCTP_ABI,
          functionName: functionName as never,
          args: args as never,
        }) as Promise<T>,
    );

  const gateway = <T>(functionName: string, address: Address, args: readonly unknown[] = []) =>
    throttle(
      () =>
        client.readContract({
          address,
          abi: GATEWAY_ABI,
          functionName: functionName as never,
          args: args as never,
        }) as Promise<T>,
    );

  // ── CCTP v2: identity and version ─────────────────────────────────────────
  const localDomain = await cctp<number>("localDomain", ARC_MESSAGE_TRANSMITTER_V2);
  results.push(
    localDomain === ARC_CCTP_DOMAIN
      ? pass("cctp localDomain", `${localDomain}`)
      : fail(
          "cctp localDomain",
          `expected ${ARC_CCTP_DOMAIN}, got ${localDomain}`,
          "A payout dispatched to the wrong source domain is a burn Iris will never attest. The USDC leaves the pool and no attestation ever arrives to mint it anywhere.",
        ),
  );

  const bodyVersion = await cctp<number>("messageBodyVersion", ARC_TOKEN_MESSENGER_V2);
  results.push(
    bodyVersion === 1
      ? pass("cctp messageBodyVersion", `${bodyVersion}`)
      : fail(
          "cctp messageBodyVersion",
          `expected 1, got ${bodyVersion}`,
          "The burn message body is versioned. A bump means the message the router produces is decoded differently on the destination, and the seven-argument call shape is no longer the current one.",
        ),
  );

  // ── CCTP v2: the two kill switches Plazo does not hold ────────────────────
  const transmitterPaused = await cctp<boolean>("paused", ARC_MESSAGE_TRANSMITTER_V2);
  results.push(
    transmitterPaused === false
      ? pass("cctp transmitter unpaused", "false")
      : fail(
          "cctp transmitter unpaused",
          "true",
          "Circle can halt all CCTP messaging and Plazo cannot. This is why the burn is dispatched after settlement rather than inside it: a pause must degrade to a queued payout, never to a reverted origination.",
        ),
  );

  const minterPaused = await cctp<boolean>("paused", ARC_TOKEN_MINTER_V2);
  results.push(
    minterPaused === false
      ? pass("cctp minter unpaused", "false")
      : fail(
          "cctp minter unpaused",
          "true",
          "The second switch. Minting is halted, so a burn that leaves Arc has nothing to land in until Circle unpauses.",
        ),
  );

  const burnCeiling = await cctp<bigint>("burnLimitsPerMessage", ARC_TOKEN_MINTER_V2, [ARC_USDC]);
  results.push(
    burnCeiling >= EXPECTED_BURN_CEILING
      ? pass("cctp burn ceiling", `${burnCeiling} (10,000,000 USDC at 6 decimals)`)
      : fail(
          "cctp burn ceiling",
          `expected at least ${EXPECTED_BURN_CEILING}, got ${burnCeiling}`,
          "Per-message, and enforced at burn time. A payout above the ceiling reverts, so the dispatcher would have to split it — and it does not, because the ceiling is four orders of magnitude above any Pay-in-4 ticket.",
        ),
  );

  // ── CCTP v2: the route table ──────────────────────────────────────────────
  const remoteRoute = await cctp<Hex>("remoteTokenMessengers", ARC_TOKEN_MESSENGER_V2, [
    CONTROL_REMOTE_DOMAIN,
  ]);
  results.push(
    remoteRoute !== ZERO_BYTES32
      ? pass("cctp remote route", `domain ${CONTROL_REMOTE_DOMAIN} → ${remoteRoute}`)
      : fail(
          "cctp remote route",
          `domain ${CONTROL_REMOTE_DOMAIN} reads bytes32(0)`,
          "Base Sepolia is the control destination for the live spike and the first non-Arc payout corridor. An empty route means Arc can reach nothing, and the whole cross-chain half of the merchant plane is unreachable.",
        ),
  );

  const selfRoute = await cctp<Hex>("remoteTokenMessengers", ARC_TOKEN_MESSENGER_V2, [
    ARC_CCTP_DOMAIN,
  ]);
  results.push(
    selfRoute === ZERO_BYTES32
      ? pass("cctp has no self-route", `domain ${ARC_CCTP_DOMAIN} reads bytes32(0), as expected`)
      : fail(
          "cctp has no self-route",
          `domain ${ARC_CCTP_DOMAIN} now reads ${selfRoute}`,
          "CCTP has no self-domain route. A router that did not branch on Arc first would burn into a void, and this is the read that makes the branch mandatory rather than defensive. If a self-route ever appears, revisit deliberately — do not let it change the payout path unnoticed.",
        ),
  );

  // ── Negative assertion: CCTP v1 is not there ──────────────────────────────
  const implementation = await implementationOf(client, throttle, ARC_TOKEN_MESSENGER_V2);
  const implementationCode =
    implementation === ZERO_ADDRESS
      ? undefined
      : await throttle(() => client.getCode({address: implementation}));
  const bytecode = (implementationCode ?? "").toLowerCase();

  results.push(
    bytecode.includes(CCTP_V2_DEPOSIT_FOR_BURN)
      ? pass("cctp v2 depositForBurn present", `${implementation} carries 0x${CCTP_V2_DEPOSIT_FOR_BURN}`)
      : fail(
          "cctp v2 depositForBurn present",
          implementation === ZERO_ADDRESS
            ? "no implementation behind the TokenMessengerV2 proxy"
            : `0x${CCTP_V2_DEPOSIT_FOR_BURN} not found in ${implementation} (${bytecode.length} hex chars)`,
          "The control on the selector scan below. Without it an empty or unreachable bytecode fetch would report the v1 selectors as absent, which is the strongest possible evidence produced by having looked at nothing.",
        ),
  );

  const v1Present = CCTP_V1_SELECTORS.filter(([selector]) => bytecode.includes(selector));
  results.push(
    v1Present.length === 0
      ? pass("cctp v1 selectors absent", `neither v1 burn selector is in ${implementation}`)
      : fail(
          "cctp v1 selectors absent",
          v1Present.map(([selector, signature]) => `0x${selector} ${signature}`).join(", "),
          "Building against the v1 four-argument `depositForBurn` fails at integration; its absence is what makes the seven-argument form the only shape. If v1 reappeared, a call written against the wrong arity would compile, deploy, and lose a merchant's settlement.",
        ),
  );

  // ── Circle Gateway ────────────────────────────────────────────────────────
  const withdrawalDelay = await gateway<bigint>("withdrawalDelay", ARC_GATEWAY_WALLET);
  results.push(
    withdrawalDelay === BigInt(GATEWAY_WITHDRAWAL_DELAY_SECONDS)
      ? pass("gateway withdrawalDelay", `${withdrawalDelay}s (14 days)`)
      : fail(
          "gateway withdrawalDelay",
          `expected ${GATEWAY_WITHDRAWAL_DELAY_SECONDS}, got ${withdrawalDelay}`,
          "The docs say 7 days and the chain says 14, and the chain is what this pin records. If this ever reads 604800 the docs became right and the lender surface's stated wait is now a week too long — which is a change to a number shown to a lender, not a code change.",
        ),
  );

  const walletSupportsUsdc = await gateway<boolean>("isTokenSupported", ARC_GATEWAY_WALLET, [
    ARC_USDC,
  ]);
  const minterSupportsUsdc = await gateway<boolean>("isTokenSupported", ARC_GATEWAY_MINTER, [
    ARC_USDC,
  ]);
  results.push(
    walletSupportsUsdc && minterSupportsUsdc
      ? pass("gateway supports USDC", "wallet and minter both true")
      : fail(
          "gateway supports USDC",
          `wallet ${walletSupportsUsdc}, minter ${minterSupportsUsdc}`,
          "Both halves have to accept the token or the unified-balance funding path has a leg that reverts. The wallet takes the deposit; the minter is what lands it on Arc.",
        ),
  );

  const walletDomain = await gateway<number>("domain", ARC_GATEWAY_WALLET);
  const minterDomain = await gateway<number>("domain", ARC_GATEWAY_MINTER);
  results.push(
    walletDomain === ARC_CCTP_DOMAIN && minterDomain === ARC_CCTP_DOMAIN
      ? pass("gateway domain", `wallet and minter both ${ARC_CCTP_DOMAIN}`)
      : fail(
          "gateway domain",
          `wallet ${walletDomain}, minter ${minterDomain}, expected ${ARC_CCTP_DOMAIN} for both`,
          "Gateway numbers domains the same way CCTP does. A burn intent names a source domain, and one signed against the wrong number is a signature over the wrong transfer.",
        ),
  );

  // ── Circle's HTTP services ────────────────────────────────────────────────
  const fees = await getJson(
    `${IRIS_SANDBOX_BASE_URL}/burn/USDC/fees/${ARC_CCTP_DOMAIN}/${CONTROL_REMOTE_DOMAIN}`,
  );
  if (!fees.ok) {
    results.push(
      fail(
        "iris fee oracle",
        fees.why,
        "The fee oracle is what says `maxFee = 0` is acceptable out of Arc. Unreachable is not the same as zero — if this cannot be read, the dispatcher must read a fee at dispatch time rather than assume one.",
      ),
    );
  } else {
    const rows = Array.isArray(fees.body)
      ? (fees.body as Array<{finalityThreshold?: number; minimumFee?: number}>)
      : [];
    const nonZero = rows.filter((row) => row.minimumFee !== 0);
    results.push(
      rows.length >= 2 && nonZero.length === 0
        ? pass(
            "iris fee oracle",
            `minimumFee 0 at thresholds ${rows.map((r) => r.finalityThreshold).join(" and ")}`,
          )
        : fail(
            "iris fee oracle",
            JSON.stringify(fees.body),
            "Zero at both thresholds is why there is no fast/standard toggle. A non-zero minimum means `CCTP_MAX_FEE_FROM_ARC = 0n` now reverts every dispatch, and the fee has to be quoted from this endpoint instead of assumed.",
          ),
    );
  }

  const info = await getJson(`${GATEWAY_API_TESTNET_BASE_URL}/info`);
  if (!info.ok) {
    results.push(
      fail(
        "gateway api lists Arc",
        info.why,
        "`/v1/info` is unauthenticated and is where a burn intent's `maxBlockHeight` comes from. If it is unreachable the lender funding path cannot sign an intent that will still be valid at burn time.",
      ),
    );
  } else {
    const domains = (info.body as {domains?: Array<{domain?: number; chain?: string}>}).domains ?? [];
    const arc = domains.find((d) => d.domain === ARC_CCTP_DOMAIN);
    results.push(
      arc
        ? pass("gateway api lists Arc", `domain ${ARC_CCTP_DOMAIN} among ${domains.length} testnet domains`)
        : fail(
            "gateway api lists Arc",
            `domain ${ARC_CCTP_DOMAIN} not among ${domains.map((d) => d.domain).join(",")}`,
            "Arc being a Gateway domain is what makes XCH-01's inbound path exist at all. Delisted means lenders fund through CCTP's two-step route only, and the lender surface must stop offering the other one.",
          ),
    );
  }

  return results;
}

export async function runChecks(profile: NetworkProfile): Promise<CheckResult[]> {
  const client = createPublicClient({
    transport: http(profile.rpcUrl, {
      retryCount: 5,
      retryDelay: 400,
      timeout: 30_000,
    }),
  }) as PublicClient;

  const throttle = createThrottle(Number(process.env["ARC_VERIFY_GAP_MS"] ?? 140));
  const results: CheckResult[] = [];

  const read = <T>(functionName: string, address: Address, args: readonly unknown[] = []) =>
    throttle(
      () =>
        client.readContract({
          address,
          abi: ERC20_ABI,
          functionName: functionName as never,
          args: args as never,
        }) as Promise<T>,
    );

  // ── Network identity ──────────────────────────────────────────────────────
  const chainId = await throttle(() => client.getChainId());
  results.push(
    chainId === profile.chainId
      ? pass("chain id", `${chainId}`)
      : fail(
          "chain id",
          `expected ${profile.chainId}, got ${chainId}`,
          "The domain separator embeds chainId. Signing against the wrong chain produces authorizations the token will never accept.",
        ),
  );

  const blockNumber = await throttle(() => client.getBlockNumber());
  results.push(pass("reachable", `${profile.rpcUrl} at block ${blockNumber}`));

  // ── The check rail ────────────────────────────────────────────────────────
  results.push(
    (await throttle(() => hasCode(client, profile.usdc)))
      ? pass("USDC deployed", profile.usdc)
      : fail(
          "USDC deployed",
          `no code at ${profile.usdc}`,
          "There is no check rail without it. Everything downstream is moot.",
        ),
  );

  // Serialized on purpose — a Promise.all here is what tripped the rate limiter.
  const name = await read<string>("name", profile.usdc);
  const symbol = await read<string>("symbol", profile.usdc);
  const version = await read<string>("version", profile.usdc);
  const decimals = await read<number>("decimals", profile.usdc);

  results.push(
    name === "USDC"
      ? pass("USDC name", `"${name}"`)
      : fail(
          "USDC name",
          `expected "USDC", got "${name}"`,
          'The EIP-712 domain uses the name verbatim. Canonical FiatToken deployments use "USD Coin"; Arc does not, and assuming the canonical string produces a separator that validates nothing.',
        ),
  );
  results.push(
    version === "2"
      ? pass("USDC version", `"${version}"`)
      : fail("USDC version", `expected "2", got "${version}"`, "Also an EIP-712 domain field."),
  );
  results.push(
    decimals === 6
      ? pass("USDC ERC-20 decimals", `${decimals}`)
      : fail(
          "USDC ERC-20 decimals",
          `expected 6, got ${decimals}`,
          "EIP-3009 `value` is the 6-decimal figure even though the same balance is 18-decimal natively. A change here is a 10^12 error in every authorization.",
        ),
  );
  results.push(pass("USDC symbol", symbol));

  // ── EIP-3009 typehashes ───────────────────────────────────────────────────
  const typehashChecks: Array<[string, string, Hex]> = [
    [
      "TRANSFER_WITH_AUTHORIZATION_TYPEHASH",
      "transferWithAuthorization",
      ERC3009_TYPEHASHES.transferWithAuthorization as Hex,
    ],
    [
      "RECEIVE_WITH_AUTHORIZATION_TYPEHASH",
      "receiveWithAuthorization",
      ERC3009_TYPEHASHES.receiveWithAuthorization as Hex,
    ],
    [
      "CANCEL_AUTHORIZATION_TYPEHASH",
      "cancelAuthorization",
      ERC3009_TYPEHASHES.cancelAuthorization as Hex,
    ],
  ];

  for (const [fn, label, expected] of typehashChecks) {
    const actual = await read<Hex>(fn, profile.usdc);
    results.push(
      actual.toLowerCase() === expected.toLowerCase()
        ? pass(`typehash ${label}`, actual)
        : fail(
            `typehash ${label}`,
            `expected ${expected}, got ${actual}`,
            "Not byte-identical to canonical FiatToken. Every signature the SDK builds would be rejected.",
          ),
    );
  }

  // ── Domain separator, derived rather than trusted ─────────────────────────
  const reportedSeparator = await read<Hex>("DOMAIN_SEPARATOR", profile.usdc);
  const derivedSeparator = keccak256(
    encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"), [
      EIP712_DOMAIN_TYPEHASH,
      keccak256(toHex(name)),
      keccak256(toHex(version)),
      BigInt(chainId),
      profile.usdc,
    ]),
  );

  results.push(
    reportedSeparator.toLowerCase() === derivedSeparator.toLowerCase()
      ? pass("domain separator reconstructs", reportedSeparator)
      : fail(
          "domain separator reconstructs",
          `token reports ${reportedSeparator}, four-field derivation gives ${derivedSeparator}`,
          "The SDK derives the separator from (name, version, chainId, verifyingContract) at runtime. If the token computes it differently, every strip is unsignable — and this is exactly the check that catches a mainnet flip.",
        ),
  );

  // ── Behavioural assertions ────────────────────────────────────────────────
  const authState = await read<boolean>("authorizationState", profile.usdc, [
    ZERO_ADDRESS,
    `0x${"00".repeat(32)}` as Hex,
  ]);
  results.push(
    authState === false
      ? pass("authorizationState readable", "unused nonce reads false")
      : fail(
          "authorizationState readable",
          `unused nonce read ${authState}`,
          "Single-use nonces are how a check cannot clear twice.",
        ),
  );

  const payeeProbe = await throttle(() =>
    expectRevert(client, {
      to: profile.usdc,
      data: receiveCallData({to: PROBE_B}),
      from: PROBE_A, // deliberately not the payee
    }),
  );
  results.push(
    payeeProbe.reverted && /caller must be the payee/i.test(payeeProbe.text)
      ? pass("payee enforcement", "caller must be the payee")
      : fail(
          "payee enforcement",
          payeeProbe.text,
          "Without it a third party can submit a borrower's authorization to the wrong payee and permanently burn the nonce — griefing a plan into being unsignable.",
        ),
  );

  const notYetValid = await throttle(() =>
    expectRevert(client, {
      to: profile.usdc,
      data: receiveCallData({to: PROBE_B, validAfter: 99_999_999_999n}),
      from: PROBE_B,
    }),
  );
  results.push(
    notYetValid.reverted && /not yet valid/i.test(notYetValid.text)
      ? pass("validAfter post-dating", "authorization is not yet valid")
      : fail(
          "validAfter post-dating",
          notYetValid.text,
          "Post-dating is the mechanism. Without an enforced validAfter a signed strip is not a set of dated checks, it is a blank cheque.",
        ),
  );

  const expired = await throttle(() =>
    expectRevert(client, {
      to: profile.usdc,
      data: receiveCallData({to: PROBE_B, validAfter: 0n, validBefore: 1n}),
      from: PROBE_B,
    }),
  );
  results.push(
    expired.reverted && /expired/i.test(expired.text)
      ? pass("validBefore expiry", "authorization is expired")
      : fail(
          "validBefore expiry",
          expired.text,
          "Self-expiry bounds the borrower's exposure to a signature they cannot revoke by any other means.",
        ),
  );

  // ── Operational state ─────────────────────────────────────────────────────
  try {
    const paused = await read<boolean>("paused", profile.usdc);
    results.push(
      paused === false
        ? pass("token not paused", "false")
        : fail(
            "token not paused",
            "true",
            "A paused token must suspend the grace and delinquency clocks rather than manufacture delinquencies. If this is true in CI, the halt path needs exercising, not ignoring.",
          ),
    );
  } catch (error) {
    results.push(
      fail(
        "token pause state readable",
        revertTextOf(error),
        "The plan state machine has a HALTED state fed by this read.",
      ),
    );
  }

  try {
    await read<boolean>("isBlacklisted", profile.usdc, [ZERO_ADDRESS]);
    results.push(pass("blocklist readable", "isBlacklisted(address) present"));
  } catch (error) {
    results.push(
      fail(
        "blocklist readable",
        revertTextOf(error),
        "A bounce caused by a blocklisted borrower is a compliance event, not a credit event, and the two carry opposite Passport and provisioning treatments.",
      ),
    );
  }

  const readSlot = async (slot: Hex): Promise<Address> => {
    const raw = await throttle(() => client.getStorageAt({address: profile.usdc, slot}));
    return raw ? (`0x${raw.slice(-40)}` as Address) : ZERO_ADDRESS;
  };

  let implementation = await readSlot(ZEPPELINOS_IMPLEMENTATION_SLOT);
  if (implementation === ZERO_ADDRESS) implementation = await readSlot(EIP1967_IMPLEMENTATION_SLOT);

  if (implementation === ZERO_ADDRESS) {
    results.push(
      fail(
        "USDC implementation readable",
        "both the zeppelinos and EIP-1967 slots read zero",
        "The proxy layout changed, or USDC is no longer a proxy. Either way the pinned implementation can no longer be checked, and a silent upgrade would go unnoticed.",
      ),
    );
  } else if (implementation.toLowerCase() === profile.expectedImplementation.toLowerCase()) {
    results.push(pass("USDC implementation pinned", implementation));
  } else {
    results.push(
      fail(
        "USDC implementation pinned",
        `expected ${profile.expectedImplementation}, found ${implementation}`,
        "Arc USDC was upgraded. A borrower's authorization is a signature over a digest the token interprets — new logic can interpret it differently. " +
          "Re-run the full verification, diff the new implementation against the old, and only then update the pin. Do not update the pin to make this green.",
      ),
    );
  }

  // ── The one buildable corridor ────────────────────────────────────────────
  // Absence is the signal here, so a shed response must not be mistaken for one.
  const absentOnRevert = (error: unknown): null => {
    if (isShed(error)) throw error;
    return null;
  };

  const eurcReceive = await read<Hex>("RECEIVE_WITH_AUTHORIZATION_TYPEHASH", ARC_EURC).catch(
    absentOnRevert,
  );
  results.push(
    eurcReceive?.toLowerCase() === ERC3009_TYPEHASHES.receiveWithAuthorization
      ? pass("EURC carries EIP-3009", ARC_EURC)
      : fail(
          "EURC carries EIP-3009",
          eurcReceive ?? "absent",
          "EURC is the only non-USDC token on Arc that can carry a check. It is the entire FX corridor; every other currency in the specification is configuration for contracts that do not exist.",
        ),
  );

  // ── Negative assertion ────────────────────────────────────────────────────
  const usycReceive = await read<Hex>("RECEIVE_WITH_AUTHORIZATION_TYPEHASH", ARC_USYC).catch(
    absentOnRevert,
  );
  results.push(
    usycReceive === null
      ? pass("USYC has no EIP-3009", "permit only, as expected")
      : fail(
          "USYC has no EIP-3009",
          `now reports ${usycReceive}`,
          "The idle-buffer and Tier-2 collateral paths are written against approve/transferFrom because USYC cannot carry a check. If that changed, revisit deliberately — do not let a capability appear unnoticed.",
        ),
  );

  // ── Infrastructure the protocol assumes ───────────────────────────────────
  const infrastructure: Array<[string, Address, string]> = [
    [
      "CREATE2 deployer",
      CREATE2_DEPLOYER,
      "Third-party tooling expects it. Plans deliberately do not use it — anyone can deploy through it, so an address derived from it is squattable.",
    ],
    ["Multicall3", MULTICALL3, "Batched reads for the indexer and the surfaces."],
    [
      "Multicall3From",
      MULTICALL3_FROM,
      "Arc-specific. Batches keeper cranks across a due-date wave.",
    ],
    [
      "EntryPoint v0.7",
      ENTRYPOINT_V07,
      "Circle Paymaster covers v0.7 on Arc and not v0.8. Borrower-side gas sponsorship depends on this exact version.",
    ],
  ];

  for (const [label, address, because] of infrastructure) {
    results.push(
      (await throttle(() => hasCode(client, address)))
        ? pass(label, address)
        : fail(label, `no code at ${address}`, because),
    );
  }

  // ── RPC limits the indexer must respect ───────────────────────────────────
  const logProbe = await throttle(() =>
    client
      .request({
        method: "eth_getLogs",
        params: [
          {
            fromBlock: toHex(blockNumber - BigInt(ARC_MAX_LOG_RANGE + 1)),
            toBlock: toHex(blockNumber),
          },
        ],
      } as never)
      .then(() => ({limited: false, text: "accepted an over-range request"}))
      .catch((error: unknown) => ({limited: true, text: revertTextOf(error)})),
  );

  results.push(
    logProbe.limited
      ? pass("eth_getLogs range limit", `rejects > ${ARC_MAX_LOG_RANGE} blocks, as documented`)
      : fail(
          "eth_getLogs range limit",
          logProbe.text,
          `The indexer chunks at ${ARC_MAX_LOG_RANGE}. If the limit moved, the chunk size is now either wrong or needlessly conservative.`,
        ),
  );

  // ── The cross-chain layer, which belongs to Circle ────────────────────────
  // Runs by default rather than behind a flag. A payout path verified only when
  // someone remembers to ask is a payout path verified after the incident.
  results.push(...(await runCctpAndGatewayChecks(client, throttle)));

  return results;
}
