/**
 * The corridor, read back off the chain it was deployed to — and MERCH-07 closed against
 * the bytecode rather than against a plan claiming it.
 *
 * ---
 *
 * **Finding 30 is why this module exists, and it is not a hypothetical.** Plan 06-13
 * discovered live that `MerchantRegistry` at the vintage-3 address answered
 * `vestingBpsFor`, `payoutRouteOf` and `velocityCapFor` and **reverted on `categoryOf`** —
 * a selector the new router called on every origination. A deployed contract whose
 * signature has moved answers some selectors and reverts on others, and nothing about the
 * source tree can tell you which. One `eth_call` costs nothing; a stale dependency is
 * invisible until every checkout reverts.
 *
 * So `assertRolesRewired` does two things a role check normally does not. It re-reads
 * **every** grant from the deployed contract after the rewire, and it then `eth_call`s
 * **every selector the new router will invoke on every contract it depends on**, by name,
 * including `categoryOf`.
 *
 * ---
 *
 * **This module writes nothing and moves nothing.** There is no `sendTransaction`, no
 * fixed gas figure and no `estimateGas` — the last of those is unusable near a full
 * balance anyway, because the estimator prepays its upper bound out of the balance being
 * moved. Everything here is an `eth_call`, an `eth_getCode` or a balance read, so it is
 * safe to re-run and re-running is the point: the funding branch changes the moment
 * someone tops up an address.
 *
 * **Both funding branches are a pass**, on the `gov08.ts` standard. The precondition is
 * read *first*, before anything is attempted, because a run that half-capitalises a book
 * and then stops is worse than one that refuses to start: the money is committed, the
 * assertions did not happen, and the next attempt inherits a state nobody can describe.
 *
 * **Widening a Tier-0 band or a reserve floor so a live run fits the deployer's balance is
 * forbidden** (DEC-02). UW-02 caps Tier-0 paper at a share of the book and the compiled
 * band's ceiling is 25%, so the protocol's own 75 minimum ticket needs 300 of book capital
 * behind it before the headroom reaches it (finding 13). That is the control working. If a
 * future reader is here because the funding gap is annoying: the answer is the faucet, or
 * the 46 USDC still recoverable by `withdrawBond` on the superseded `MerchantRegistry`.
 */
import {
  createPublicClient,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {arcTestnet} from "viem/chains";

import {ARC_TESTNET_RPC_URL} from "@plazo/plan-core";

import {EURC_SEED_REQUIRED, readCorridorFunding} from "./fx-spike.js";
import {loadDeployment, outstandingRequirement, shed} from "./slice.js";

/** EURC on Arc testnet. Full EIP-3009, canonical typehashes (finding 31). */
const ARC_EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as const;

/** USYC, the pledge asset. No EIP-3009 (finding 32). */
const ARC_USYC = "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C" as const;

/**
 * The superseded `MerchantRegistry`, and the 46 USDC standing on it.
 *
 * 06-13 replaced this registry because the live one had no `categoryOf`, and a merchant's
 * posted bond stayed behind. It is **recoverable, not stranded**: `withdrawBond` is
 * merchant-callable and `requiredBond` reads zero with no fronted exposure outstanding.
 * Named here rather than in a document because a run that does not know about it sends an
 * operator to the faucet for money the protocol is already holding for them.
 */
const SUPERSEDED_MERCHANT_REGISTRY = "0xcbab6e5e3c97a6a232f4a99bc07fd8eb8ee8dd4d" as const;

/** What Circle's faucet hands one address, measured across the drips that funded the first credit run. */
const FAUCET_DRIP = 20_000_000n;

/** The recoverable bond on the superseded registry, measured in plan 06-13. */
const RECOVERABLE_BOND = 46_000_000n;

const KEY = (name: string): Hex => keccak256(toHex(name));

/**
 * The fifteen rows plan 07-02 added, by name.
 *
 * Every one is probed against **both** new registry instances. `get()` reverts
 * `ParameterUndefined` on a key nobody set, so a EURC origination reading a row the EURC
 * instance does not carry is a revert rather than a smaller limit (DEC-72, finding 29) —
 * and the two instances are the same bytecode, so a disagreement here would mean one of
 * them is not what the record says it is.
 */
const NEW_PARAMETER_KEYS = [
  "plazo.fx.corridorHaircutBps",
  "plazo.fx.maxDeviationBps",
  "plazo.fx.midMaxTtl",
  "plazo.fx.quoteMaxAge",
  "plazo.fx.roundtripMaxBps",
  "plazo.fx.parBandBps",
  "plazo.tier1.incomeMultipleBps",
  "plazo.tier1.pseudonymousCap",
  "plazo.tier1.payrollBonusBps",
  "plazo.tier1.inflowLookback",
  "plazo.tier1.inflowMinMonths",
  "plazo.tier1.inflowMinCounterparties",
  "plazo.tier2.pledgeHaircutBps",
  "plazo.tier3.partnerCap",
  "plazo.tier3.partnerMaxTtl",
] as const;

// ─── ABIs, narrow and by name ─────────────────────────────────────────────────

const ACCESS_ABI = parseAbi([
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleAdmin(bytes32 role) view returns (bytes32)",
]);

const REGISTRY_ABI = parseAbi([
  "function get(bytes32 key) view returns (uint256)",
  "function isDefined(bytes32 key) view returns (bool)",
]);

const POOL_ABI = parseAbi([
  "function originator() view returns (address)",
  "function originationOpen() view returns (bool)",
  "function acceptsSchedule(uint256 installmentCount, uint256 interval) view returns (bool)",
  "function concentrationHeadroom(address merchant, bytes32 corridor) view returns (uint256, uint256)",
  "function totalAssets() view returns (uint256)",
  "function openPlans() view returns (uint256)",
  "function token() view returns (address)",
  "function productLine() view returns (bytes32)",
  "function seniorShares() view returns (address)",
  "function juniorShares() view returns (address)",
]);

const ROUTER_ABI = parseAbi([
  "function corridorConfigOf(address token) view returns ((address fxRouter, address parameters, address underwriter))",
  "function fxRouterOf(address token) view returns (address)",
  "function corridorOf(address token) pure returns (bytes32)",
  "function baseToken() view returns (address)",
  "function parameters() view returns (address)",
  "function currencies() view returns (address)",
  "function settlementEscrow() view returns (address)",
  "function fxGuard() view returns (address)",
  "function fxVenue() view returns (address)",
  "function payout() view returns (address)",
  "function underwriter() view returns (address)",
  "function UNDERWRITER_ROLE() view returns (bytes32)",
]);

const MERCHANTS_ABI = parseAbi([
  "function categoryOf(address merchant) view returns (uint8)",
  "function payoutRouteOf(address merchant) view returns (address, uint32)",
  "function vestingBpsFor(address merchant) view returns (uint256)",
  "function velocityCapFor(address merchant) view returns (uint256)",
  "function requiredBond(address merchant) view returns (uint256)",
  "function bondOf(address merchant) view returns (uint256)",
  "function isSeasoned(address merchant) view returns (bool)",
  "function token() view returns (address)",
  "function BOOKKEEPER_ROLE() view returns (bytes32)",
  "function SLASHER_ROLE() view returns (bytes32)",
]);

const CURRENCIES_ABI = parseAbi([
  "function payoutCurrencyOf(address merchant) view returns (address)",
  "function electedCurrencyOf(address merchant) view returns (address)",
  "function isAllowed(address currency) view returns (bool)",
]);

const TIERED_ABI = parseAbi([
  "function capFor(bytes32 personId, uint8 identity, uint8 signerClass, address borrower, bytes32 planId) view returns (uint256)",
  "function tierOf(bytes32 personId, address borrower, bytes32 planId) view returns (uint8)",
  "function tier0() view returns (address)",
  "function pledges() view returns (address)",
  "function sweeper() view returns (address)",
  "function partner() view returns (address)",
  "function parameters() view returns (address)",
  "function ORIGINATOR_ROLE() view returns (bytes32)",
]);

const TIER0_ABI = parseAbi([
  "function bookHeadroom() view returns (uint256)",
  "function pool() view returns (address)",
  "function passport() view returns (address)",
  "function parameters() view returns (address)",
  "function isSeasoned(bytes32 personId) view returns (bool)",
  "function pseudonymousId(address borrower) view returns (bytes32)",
  "function ORIGINATOR_ROLE() view returns (bytes32)",
]);

const PLEDGE_ABI = parseAbi([
  "function limitFor(address pledger) view returns (uint256)",
  "function freeOf(address pledger) view returns (uint256)",
  "function pledgedValueOf(address pledger) view returns (uint256)",
  "function lockedOf(address pledger) view returns (uint256)",
  "function asset() view returns (address)",
  "function BINDER_ROLE() view returns (bytes32)",
]);

const SWEEPER_ABI = parseAbi([
  "function isOptedIn(bytes32 planId, address borrower) view returns (bool)",
  "function factory() view returns (address)",
]);

const PAYOUT_ABI = parseAbi([
  "function supportsDomain(uint32 domain) view returns (bool)",
  "function queued(address token, address recipient, uint32 domain) view returns (uint256)",
]);

const FX_ROUTER_ABI = parseAbi([
  "function accountingToken() view returns (address)",
  "function isSupported(address fromToken) view returns (bool)",
  "function normalize(address fromToken, uint256 amount) view returns (uint256)",
]);

const GUARD_ABI = parseAbi(["function FX_SIGNER_ROLE() view returns (bytes32)"]);
const ESCROW_ABI = parseAbi(["function router() view returns (address)"]);
const FACTORY_ABI = parseAbi([
  "function originator() view returns (address)",
  "function implementation() view returns (address)",
]);
const POOLS_ABI = parseAbi([
  "function isPool(address pool) view returns (bool)",
  "function poolFor(bytes32 productLine) view returns (address)",
]);
const PAUSES_ABI = parseAbi([
  "function isOpen(bytes32 corridor) view returns (bool)",
  "function requireOpen(bytes32 corridor) view",
  "function PAUSER_ROLE() view returns (bytes32)",
]);
const ELIGIBILITY_ABI = parseAbi([
  "function isEligible(address asset, address account) view returns (bool)",
]);
const PASSPORT_ABI = parseAbi([
  "function READER_ROLE() view returns (bytes32)",
  "function WRITER_ROLE() view returns (bytes32)",
]);
const RECEIVABLE_ABI = parseAbi(["function ISSUER_ROLE() view returns (bytes32)"]);
const KILLSWITCH_ABI = parseAbi([
  "function REGISTRAR_ROLE() view returns (bytes32)",
  "function throttleBps() view returns (uint256)",
]);
const REFUND_ABI = parseAbi(["function ARBITER_ROLE() view returns (bytes32)"]);
const VENUE_ABI = parseAbi([
  "function supportsPair(address fromToken, address toToken) view returns (bool)",
  "function router() view returns (address)",
]);

// ─── The three read primitives, each wrapped exactly once ─────────────────────
//
// Arc's public RPC sheds roughly a quarter of requests regardless of pacing and viem does
// not retry it — a shed request arrives as HTTP 200 with an error body, which is not a
// transport failure as far as any client is concerned. Three helpers rather than three
// hundred call sites, so "every chain read goes through `shed()`" is a property of the
// file rather than a habit that survives until someone is in a hurry.

async function view<T>(
  client: PublicClient,
  address: Address,
  abi: Abi | readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  return shed(() =>
    client.readContract({address, abi: abi as Abi, functionName, args}),
  ) as Promise<T>;
}

async function codeAt(client: PublicClient, address: Address): Promise<Hex | undefined> {
  return shed(() => client.getCode({address}));
}

async function nativeBalance(client: PublicClient, address: Address): Promise<bigint> {
  return shed(() => client.getBalance({address}));
}

// ─── Reporting ────────────────────────────────────────────────────────────────

export interface CorridorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

class Report {
  readonly rows: CorridorCheck[] = [];
  passed = 0;
  failed = 0;
  noted = 0;

  check(name: string, ok: boolean, detail = ""): void {
    this.rows.push({name, ok, detail});
    if (ok) {
      this.passed++;
      console.log(`  ok  ${name}${detail ? ` (${detail})` : ""}`);
    } else {
      this.failed++;
      console.log(`  XX  ${name}${detail ? ` — ${detail}` : ""}`);
    }
  }

  /**
   * A row that cannot be witnessed without capital, or a fact recorded rather than
   * asserted.
   *
   * It prints differently and **does not increment a pass count** (findings 16-27).
   * Reporting an unwitnessed property as a pass is a lie that keeps being told while the
   * suite quietly stops asking. An unrun row is *absent*, not noted.
   */
  note(name: string, detail: string): void {
    this.noted++;
    console.log(`  --  ${name} — ${detail}`);
  }
}

function usdc(value: bigint): string {
  return `${formatUnits(value, 6)} USDC`;
}

function eur(value: bigint): string {
  return `${formatUnits(value, 6)} EURC`;
}

function same(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

const ZERO = "0x0000000000000000000000000000000000000000";

// ─── 1. The record, and that every address in it holds code ───────────────────

/**
 * The eighteen keys plan 07-12 adds, plus the two demotions it forces.
 *
 * Typed as a flat record rather than an interface over `loadDeployment`'s return so this
 * module can assert on keys that file does not know about yet. `rewireBlock2` is a number
 * and is checked as one; everything else is an address and is checked for bytecode.
 */
export interface CorridorDeployment {
  [key: string]: string | number | Record<string, string> | undefined;
}

/** The eighteen new keys, in the order the plan names them. */
const NEW_KEYS = [
  "fxParameterRegistry",
  "eurcParameterRegistry",
  "fxRouterEurc",
  "eurcPool",
  "eurcSeniorShares",
  "eurcJuniorShares",
  "fxDeviationGuard",
  "ammVenue",
  "stableFxVenueStub",
  "pledgeVault",
  "payrollSweeper",
  "tieredUnderwriter",
  "eurcTier0Underwriter",
  "eurcTieredUnderwriter",
  "partnerUnderwriterStub",
  "merchantCurrencyRegistry",
  "checkoutRouterLegacyV2",
  "rewireBlock2",
] as const;

/**
 * Load the record and prove every key it gained names something real.
 *
 * A key naming an address with no bytecode is finding 12's failure — a record written
 * during a `forge script`'s *local* execution by a run that then failed at the send step.
 * It is a loud, named error here rather than an `undefined` surfacing in the indexer three
 * days later.
 *
 * **The distinctness assertions are the B-2a half.** If `eurcParameterRegistry` equalled
 * `fxParameterRegistry`, or the EURC `Tier0Underwriter` equalled the dollar one, the
 * two-book design would be silently undone: `bookHeadroom()` divides by `totalAssets()` on
 * one settable pool and `outstandingExposure` is one scalar, so every credit comparison
 * would cross currencies again at 1:1 while producing entirely plausible numbers.
 */
export async function readCorridorDeployment(
  client: PublicClient,
  chainId: number,
): Promise<{deployment: CorridorDeployment; report: Report}> {
  const deployment = loadDeployment(chainId) as unknown as CorridorDeployment;
  const report = new Report();

  console.log("\nThe deployment record — eighteen new keys");

  for (const key of NEW_KEYS) {
    const value = deployment[key];

    if (key === "rewireBlock2") {
      const block = Number(value ?? 0);
      const first = Number(deployment["rewireBlock"] ?? 0);
      report.check(
        "rewireBlock2 is after rewireBlock",
        block > 0 && block > first,
        `${block} > ${first}`,
      );
      continue;
    }

    if (typeof value !== "string") {
      report.check(`${key} is present`, false, "missing from the record");
      continue;
    }

    const code = await codeAt(client, value as Address);
    const size = code && code !== "0x" ? (code.length - 2) / 2 : 0;
    report.check(`${key} holds code`, size > 0, `${value} ${size}b`);
  }

  console.log("\nB-2a — two books, and two of every contract that holds one");

  const pairs: [string, string, string][] = [
    ["ParameterRegistry instances differ", "fxParameterRegistry", "eurcParameterRegistry"],
    ["Tier0Underwriter instances differ", "tier0", "eurcTier0Underwriter"],
    ["TieredUnderwriter instances differ", "tieredUnderwriter", "eurcTieredUnderwriter"],
    ["credit pools differ", "creditPool", "eurcPool"],
    ["IdentityFXRouter instances differ", "fxRouter", "fxRouterEurc"],
    ["tranche seniors differ", "seniorShares", "eurcSeniorShares"],
    ["tranche juniors differ", "juniorShares", "eurcJuniorShares"],
    ["the router was replaced", "checkoutRouter", "checkoutRouterLegacyV2"],
  ];

  for (const [label, a, b] of pairs) {
    const left = deployment[a] as string | undefined;
    const right = deployment[b] as string | undefined;
    report.check(label, !!left && !!right && !same(left, right), `${left} vs ${right}`);
  }

  const currencies = deployment["registryCurrencies"] as Record<string, string> | undefined;
  report.check(
    "each registry records the currency it answers in",
    !!currencies && currencies["fxParameterRegistry"] === "USDC" && currencies["eurcParameterRegistry"] === "EURC",
    JSON.stringify(currencies ?? {}),
  );

  return {deployment, report};
}

// ─── 2. The rewire, re-read from the deployed contracts ───────────────────────

/**
 * Every grant re-read from the chain, and every selector the new router will call probed
 * by name.
 *
 * **What "moved" means here, and where it deliberately does not.** Three of the rewired
 * authorities are single-valued — `TranchedCreditPool.originator`, `PlanFactory.originator`
 * and `SettlementEscrow.router` — so the new address holding them *is* the old address not
 * holding them, and those are asserted as moves. The `AccessControl` grants are additive
 * and **nothing was revoked (D-24)**: `recognise` is permissionless and `poolOf[planId]`
 * for every plan the superseded router originated lives on that address. Those are
 * reported as deliberate retentions rather than asserted absent, because asserting
 * absence would be asserting that D-24 was violated.
 */
export async function assertRolesRewired(
  client: PublicClient,
  d: CorridorDeployment,
  report: Report,
): Promise<void> {
  const router = d["checkoutRouter"] as Address;
  const oldRouter = d["checkoutRouterLegacyV2"] as Address;
  const eurcPool = d["eurcPool"] as Address;
  const tiered = d["tieredUnderwriter"] as Address;
  const eurcTiered = d["eurcTieredUnderwriter"] as Address;
  const eurcTier0 = d["eurcTier0Underwriter"] as Address;
  const tier0 = d["tier0"] as Address;
  const pledges = d["pledgeVault"] as Address;
  const merchants = d["merchantRegistry"] as Address;
  const passport = d["passport"] as Address;

  console.log("\nThe rewire — every authority re-read from the deployed contract");

  const poolOriginator = await view<Address>(client, d["creditPool"] as Address, POOL_ABI, "originator");
  report.check("USDC pool originator is the new router", same(poolOriginator, router), poolOriginator);

  const eurcOriginator = await view<Address>(client, eurcPool, POOL_ABI, "originator");
  report.check("EURC pool originator is the new router", same(eurcOriginator, router), eurcOriginator);

  const factoryOriginator = await view<Address>(client, d["planFactory"] as Address, FACTORY_ABI, "originator");
  report.check(
    "PlanFactory originator is the new router",
    same(factoryOriginator, router),
    `${factoryOriginator} — not in the plan's rewire list; originate() refuses any other caller`,
  );

  const escrowRouter = await view<Address>(client, d["settlementEscrow"] as Address, ESCROW_ABI, "router");
  report.check("SettlementEscrow router is the new router", same(escrowRouter, router), escrowRouter);
  report.note(
    "the superseded SettlementEscrow keeps its own router",
    `${d["settlementEscrowLegacy"]} — setRouter is one-way (RouterAlreadySet), which is why a new escrow was forced`,
  );

  const originatorRole = await view<Hex>(client, tier0, TIER0_ABI, "ORIGINATOR_ROLE");

  const grants: [string, Address, Hex, Address][] = [
    ["Tier0(USD).ORIGINATOR -> TieredUnderwriter(USD)", tier0, originatorRole, tiered],
    ["TieredUnderwriter(USD).ORIGINATOR -> router", tiered, originatorRole, router],
    ["Tier0(EUR).ORIGINATOR -> TieredUnderwriter(EUR)", eurcTier0, originatorRole, eurcTiered],
    ["TieredUnderwriter(EUR).ORIGINATOR -> router", eurcTiered, originatorRole, router],
  ];
  for (const [label, on, role, holder] of grants) {
    const held = await view<boolean>(client, on, ACCESS_ABI, "hasRole", [role, holder]);
    report.check(label, held, holder);
  }

  const binderRole = await view<Hex>(client, pledges, PLEDGE_ABI, "BINDER_ROLE");
  for (const [label, holder] of [
    ["PledgeVault.BINDER -> TieredUnderwriter(USD)", tiered],
    ["PledgeVault.BINDER -> TieredUnderwriter(EUR)", eurcTiered],
  ] as [string, Address][]) {
    const held = await view<boolean>(client, pledges, ACCESS_ABI, "hasRole", [binderRole, holder]);
    report.check(label, held, holder);
  }

  const issuerRole = await view<Hex>(client, d["receivable"] as Address, RECEIVABLE_ABI, "ISSUER_ROLE");
  const issuerHeld = await view<boolean>(client, d["receivable"] as Address, ACCESS_ABI, "hasRole", [
    issuerRole,
    router,
  ]);
  report.check("ReceivableToken.ISSUER -> router", issuerHeld, router);

  const bookkeeperRole = await view<Hex>(client, merchants, MERCHANTS_ABI, "BOOKKEEPER_ROLE");
  const bookkeeperHeld = await view<boolean>(client, merchants, ACCESS_ABI, "hasRole", [bookkeeperRole, router]);
  report.check("MerchantRegistry.BOOKKEEPER -> router", bookkeeperHeld, router);

  const slasherRole = await view<Hex>(client, merchants, MERCHANTS_ABI, "SLASHER_ROLE");
  const slasherHeld = await view<boolean>(client, merchants, ACCESS_ABI, "hasRole", [
    slasherRole,
    d["refundEscrow"] as Address,
  ]);
  report.check("MerchantRegistry.SLASHER -> RefundEscrow", slasherHeld, d["refundEscrow"] as string);

  const registrarRole = await view<Hex>(client, d["killSwitch"] as Address, KILLSWITCH_ABI, "REGISTRAR_ROLE");
  const registrarHeld = await view<boolean>(client, d["killSwitch"] as Address, ACCESS_ABI, "hasRole", [
    registrarRole,
    router,
  ]);
  report.check("FirstPaymentDefaultSwitch.REGISTRAR -> router", registrarHeld, router);

  const readerRole = await view<Hex>(client, passport, PASSPORT_ABI, "READER_ROLE");
  const writerRole = await view<Hex>(client, passport, PASSPORT_ABI, "WRITER_ROLE");
  for (const [label, role, holder] of [
    ["PlazoPassport.READER -> router", readerRole, router],
    ["PlazoPassport.READER -> Tier0(EUR)", readerRole, eurcTier0],
    ["PlazoPassport.WRITER -> Tier0(EUR)", writerRole, eurcTier0],
  ] as [string, Hex, Address][]) {
    const held = await view<boolean>(client, passport, ACCESS_ABI, "hasRole", [role, holder]);
    report.check(label, held, holder);
  }

  const eurcTier0Pool = await view<Address>(client, eurcTier0, TIER0_ABI, "pool");
  report.check("Tier0(EUR).pool is the EURC book", same(eurcTier0Pool, eurcPool), eurcTier0Pool);
  const eurcTier0Passport = await view<Address>(client, eurcTier0, TIER0_ABI, "passport");
  report.check("Tier0(EUR).passport is set", same(eurcTier0Passport, passport), eurcTier0Passport);

  const registered = await view<Address>(client, d["poolRegistry"] as Address, POOLS_ABI, "poolFor", [
    KEY("plazo.line.payin4.eurc"),
  ]);
  report.check("PoolRegistry names the EURC product line", same(registered, eurcPool), registered);
  const isPool = await view<boolean>(client, d["poolRegistry"] as Address, POOLS_ABI, "isPool", [eurcPool]);
  report.check("PoolRegistry.isPool(eurcPool)", isPool, "settlementRecipient must be a registered book");

  const eligibleRouter = await view<boolean>(client, d["eligibilityRegistry"] as Address, ELIGIBILITY_ABI, "isEligible", [
    d["eurcSeniorShares"] as Address,
    router,
  ]);
  report.check("EligibilityRegistry accredits the router (finding 16)", eligibleRouter, router);
  const eligiblePool = await view<boolean>(client, d["eligibilityRegistry"] as Address, ELIGIBILITY_ABI, "isEligible", [
    d["eurcSeniorShares"] as Address,
    eurcPool,
  ]);
  report.check("EligibilityRegistry accredits the EURC book (finding 16)", eligiblePool, eurcPool);
  report.note(
    "the EURC lender is deliberately NOT accredited",
    "two books mean two eligibility sets, and accrediting a lender is a decision about a person",
  );

  const signerRole = await view<Hex>(client, d["fxDeviationGuard"] as Address, GUARD_ABI, "FX_SIGNER_ROLE");
  const configuredSigner = (process.env["PLAZO_FX_MID_SIGNER"] as Address | undefined) ?? deployerAddress();
  if (configuredSigner) {
    const signerHeld = await view<boolean>(client, d["fxDeviationGuard"] as Address, ACCESS_ABI, "hasRole", [
      signerRole,
      configuredSigner,
    ]);
    report.check("FxDeviationGuard.FX_SIGNER -> the configured mid signer", signerHeld, configuredSigner);
  } else {
    report.note("FxDeviationGuard.FX_SIGNER", "no signer configured to check against");
  }

  console.log("\nD-24 — what the superseded router still holds, on purpose");
  for (const [label, on, role] of [
    ["ReceivableToken.ISSUER", d["receivable"] as Address, issuerRole],
    ["MerchantRegistry.BOOKKEEPER", merchants, bookkeeperRole],
    ["FirstPaymentDefaultSwitch.REGISTRAR", d["killSwitch"] as Address, registrarRole],
    ["PlazoPassport.READER", passport, readerRole],
  ] as [string, Address, Hex][]) {
    const held = await view<boolean>(client, on, ACCESS_ABI, "hasRole", [role, oldRouter]);
    report.note(
      `${label} still held by the superseded router`,
      held ? "yes — nothing was revoked (D-24)" : "no — it was never granted or has been withdrawn",
    );
  }

  // ── Every selector the new router will invoke, by name ─────────────────────
  //
  // This is the finding-30 defence proper. `categoryOf` is probed first and by name
  // because it is the exact selector that reverted on the live registry in 06-13 while
  // every other selector on the same contract answered.
  console.log("\nEvery selector the new router will call, probed by name (finding 30)");

  const probe = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      const value = await fn();
      report.check(label, true, Array.isArray(value) ? value.join(", ") : String(value));
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
      report.check(label, false, message);
    }
  };

  const anyMerchant = "0x0000000000000000000000000000000000000001" as Address;
  const anyPerson = KEY("plazo.probe.person");

  await probe("MerchantRegistry.categoryOf", () =>
    view(client, merchants, MERCHANTS_ABI, "categoryOf", [anyMerchant]),
  );
  await probe("MerchantRegistry.payoutRouteOf", () =>
    view(client, merchants, MERCHANTS_ABI, "payoutRouteOf", [anyMerchant]),
  );
  await probe("MerchantRegistry.vestingBpsFor", () =>
    view(client, merchants, MERCHANTS_ABI, "vestingBpsFor", [anyMerchant]),
  );
  await probe("MerchantRegistry.velocityCapFor", () =>
    view(client, merchants, MERCHANTS_ABI, "velocityCapFor", [anyMerchant]),
  );
  await probe("MerchantRegistry.requiredBond", () =>
    view(client, merchants, MERCHANTS_ABI, "requiredBond", [anyMerchant]),
  );
  await probe("MerchantRegistry.bondOf", () => view(client, merchants, MERCHANTS_ABI, "bondOf", [anyMerchant]));
  await probe("MerchantRegistry.isSeasoned", () =>
    view(client, merchants, MERCHANTS_ABI, "isSeasoned", [anyMerchant]),
  );

  const currencies = d["merchantCurrencyRegistry"] as Address;
  await probe("MerchantCurrencyRegistry.payoutCurrencyOf", () =>
    view(client, currencies, CURRENCIES_ABI, "payoutCurrencyOf", [anyMerchant]),
  );
  await probe("MerchantCurrencyRegistry.electedCurrencyOf", () =>
    view(client, currencies, CURRENCIES_ABI, "electedCurrencyOf", [anyMerchant]),
  );
  await probe("MerchantCurrencyRegistry.isAllowed", () =>
    view(client, currencies, CURRENCIES_ABI, "isAllowed", [ARC_EURC]),
  );

  for (const [label, underwriter] of [
    ["TieredUnderwriter(USD)", tiered],
    ["TieredUnderwriter(EUR)", eurcTiered],
  ] as [string, Address][]) {
    await probe(`${label}.capFor (five-argument)`, () =>
      view(client, underwriter, TIERED_ABI, "capFor", [anyPerson, 0, 0, anyMerchant, anyPerson]),
    );
    await probe(`${label}.tierOf`, () =>
      view(client, underwriter, TIERED_ABI, "tierOf", [anyPerson, anyMerchant, anyPerson]),
    );
  }

  await probe("Tier0(EUR).isSeasoned", () => view(client, eurcTier0, TIER0_ABI, "isSeasoned", [anyPerson]));
  await probe("Tier0(EUR).bookHeadroom", () => view(client, eurcTier0, TIER0_ABI, "bookHeadroom"));
  await probe("Tier0(USD).bookHeadroom", () => view(client, tier0, TIER0_ABI, "bookHeadroom"));

  await probe("PledgeVault.limitFor", () => view(client, pledges, PLEDGE_ABI, "limitFor", [anyMerchant]));
  await probe("PledgeVault.freeOf", () => view(client, pledges, PLEDGE_ABI, "freeOf", [anyMerchant]));
  await probe("PledgeVault.pledgedValueOf", () =>
    view(client, pledges, PLEDGE_ABI, "pledgedValueOf", [anyMerchant]),
  );
  await probe("PledgeVault.lockedOf (bindPlan's own read)", () =>
    view(client, pledges, PLEDGE_ABI, "lockedOf", [anyMerchant]),
  );

  await probe("PayrollSweeper.isOptedIn", () =>
    view(client, d["payrollSweeper"] as Address, SWEEPER_ABI, "isOptedIn", [anyPerson, anyMerchant]),
  );

  for (const [label, pool] of [
    ["USDC book", d["creditPool"] as Address],
    ["EURC book", eurcPool],
  ] as [string, Address][]) {
    await probe(`${label}.concentrationHeadroom`, () =>
      view(client, pool, POOL_ABI, "concentrationHeadroom", [anyMerchant, KEY("plazo.probe.corridor")]),
    );
    await probe(`${label}.acceptsSchedule(4, 14 days)`, () =>
      view(client, pool, POOL_ABI, "acceptsSchedule", [4n, 1_209_600n]),
    );
    await probe(`${label}.originationOpen`, () => view(client, pool, POOL_ABI, "originationOpen"));
    await probe(`${label}.totalAssets`, () => view(client, pool, POOL_ABI, "totalAssets"));
  }

  await probe("OriginationPause.requireOpen", () =>
    view(client, d["pauses"] as Address, PAUSES_ABI, "requireOpen", [KEY("PLAZO.CORRIDOR.USD")]),
  );
  await probe("OriginationPause.isOpen", () =>
    view(client, d["pauses"] as Address, PAUSES_ABI, "isOpen", [KEY("PLAZO.CORRIDOR.USD")]),
  );

  await probe("IdentityFXRouter(EURC).accountingToken", () =>
    view(client, d["fxRouterEurc"] as Address, FX_ROUTER_ABI, "accountingToken"),
  );
  await probe("IdentityFXRouter(EURC).isSupported(EURC)", () =>
    view(client, d["fxRouterEurc"] as Address, FX_ROUTER_ABI, "isSupported", [ARC_EURC]),
  );
  await probe("IdentityFXRouter(EURC).normalize(EURC, 1)", () =>
    view(client, d["fxRouterEurc"] as Address, FX_ROUTER_ABI, "normalize", [ARC_EURC, 1n]),
  );
  await probe("AmmVenue.supportsPair(USDC, EURC)", () =>
    view(client, d["ammVenue"] as Address, VENUE_ABI, "supportsPair", [d["token"] as Address, ARC_EURC]),
  );

  // ── The fifteen new rows, against both new instances ───────────────────────
  console.log("\nThe fifteen Phase 7 parameter rows, on both new instances (DEC-72, finding 29)");
  for (const registryKey of ["fxParameterRegistry", "eurcParameterRegistry"] as const) {
    const registry = d[registryKey] as Address;
    let defined = 0;
    const undefinedRows: string[] = [];
    for (const name of NEW_PARAMETER_KEYS) {
      const isDefined = await view<boolean>(client, registry, REGISTRY_ABI, "isDefined", [KEY(name)]);
      if (isDefined) defined++;
      else undefinedRows.push(name);
    }
    report.check(
      `${registryKey} defines all fifteen`,
      defined === NEW_PARAMETER_KEYS.length,
      defined === NEW_PARAMETER_KEYS.length ? `${defined}/15` : `missing ${undefinedRows.join(", ")}`,
    );
  }

  // The two instances are the same bytecode, so their seeded values agree by
  // construction today — and the *reason* they are two instances is that they will not
  // agree forever. Printed rather than asserted equal, because equality is the launch
  // hypothesis (DEC-90) and asserting it would freeze the hypothesis into a gate.
  console.log("\nWhere the two parameter sets stand today (DEC-90 — parity is a hypothesis)");
  for (const name of ["plazo.tier0.bookShareBps", "plazo.fx.corridorHaircutBps", "plazo.tier2.pledgeHaircutBps"]) {
    const usd = await view<bigint>(client, d["fxParameterRegistry"] as Address, REGISTRY_ABI, "get", [KEY(name)]);
    const euro = await view<bigint>(client, d["eurcParameterRegistry"] as Address, REGISTRY_ABI, "get", [KEY(name)]);
    report.note(name, `USD ${usd} · EUR ${euro}`);
  }
  const liveBookShare = await view<bigint>(client, d["parameterRegistry"] as Address, REGISTRY_ABI, "get", [
    KEY("plazo.tier0.bookShareBps"),
  ]);
  report.note(
    "the live registry's governed bookShareBps",
    `${liveBookShare} — a fresh instance seeds from constants and does not inherit it`,
  );

  // ── The corridor rows themselves ───────────────────────────────────────────
  console.log("\nBoth corridors, complete in all three fields (CorridorIncomplete)");
  for (const [label, token] of [
    ["USDC", d["token"] as Address],
    ["EURC", ARC_EURC as Address],
  ] as [string, Address][]) {
    const config = await view<{fxRouter: Address; parameters: Address; underwriter: Address}>(
      client,
      router,
      ROUTER_ABI,
      "corridorConfigOf",
      [token],
    );
    const complete =
      !same(config.fxRouter, ZERO) && !same(config.parameters, ZERO) && !same(config.underwriter, ZERO);
    report.check(
      `corridorConfigOf(${label}) has three non-zero fields`,
      complete,
      `${config.fxRouter} / ${config.parameters} / ${config.underwriter}`,
    );
  }

  const baseToken = await view<Address>(client, router, ROUTER_ABI, "baseToken");
  report.check("router.baseToken is USDC", same(baseToken, d["token"] as string), baseToken);
  const merchantsToken = await view<Address>(client, merchants, MERCHANTS_ABI, "token");
  report.check(
    "the bond ledger keeps the base currency",
    same(merchantsToken, baseToken),
    `${merchantsToken} — requiredBond would otherwise compare two currencies at 1:1`,
  );
  const sweeperFactory = await view<Address>(client, d["payrollSweeper"] as Address, SWEEPER_ABI, "factory");
  report.check(
    "PayrollSweeper is paired with the factory it serves (DEC-100)",
    same(sweeperFactory, d["planFactory"] as string),
    sweeperFactory,
  );
  const pledgeAsset = await view<Address>(client, pledges, PLEDGE_ABI, "asset");
  report.check("PledgeVault's asset is USYC (E-07)", same(pledgeAsset, ARC_USYC), pledgeAsset);
  const eurcPoolToken = await view<Address>(client, eurcPool, POOL_ABI, "token");
  report.check("the EURC book's accounting token is EURC", same(eurcPoolToken, ARC_EURC), eurcPoolToken);
}

// ─── 3. MERCH-07, against the deployed addresses ──────────────────────────────

/**
 * MERCH-07's two halves, closed against the bytecode rather than against the source.
 *
 * D-13 split the requirement when Phase 6 closed the chain half, and REQUIREMENTS.md's own
 * note says the box is tickable only when both land. Both are verified here against the
 * **deployed** addresses (DEC-73, finding 30): one `eth_call` costs nothing, and a stale
 * dependency is invisible until every checkout reverts.
 */
export async function runMerch07(
  client: PublicClient,
  d: CorridorDeployment,
  report: Report,
): Promise<void> {
  console.log("\nMERCH-07 — the chain half (Phase 6), against the deployed PayoutRouter");

  const payout = d["payoutRouter"] as Address;
  const arcDomain = 26;
  const baseSepolia = 6;

  const supportsBase = await view<boolean>(client, payout, PAYOUT_ABI, "supportsDomain", [baseSepolia]);
  report.check("PayoutRouter.supportsDomain(6 — Base)", supportsBase, payout);
  const supportsEth = await view<boolean>(client, payout, PAYOUT_ABI, "supportsDomain", [0]);
  report.check("PayoutRouter.supportsDomain(0 — Ethereum)", supportsEth, payout);

  // DEC-36. `dispatch` is deliberately permissionless, so a two-key queue would let any
  // stranger choose where a merchant's settlement lands — and the burn is irreversible.
  // The three-argument shape is the control, and it is asserted by calling it.
  const queued = await view<bigint>(client, payout, PAYOUT_ABI, "queued", [
    d["token"] as Address,
    "0x0000000000000000000000000000000000000001",
    baseSepolia,
  ]);
  report.check(
    "PayoutRouter.queued takes three arguments (DEC-36)",
    typeof queued === "bigint",
    `token, recipient, domain -> ${queued}`,
  );
  report.note("Arc's own CCTP domain", `${arcDomain} — the source side, not a payout destination`);

  console.log("\nMERCH-07 — the currency half (Phase 7), against the deployed corridor");

  const currencies = d["merchantCurrencyRegistry"] as Address;
  const unconfigured = "0x00000000000000000000000000000000000000aa" as Address;

  const defaultCurrency = await view<Address>(client, currencies, CURRENCIES_ABI, "payoutCurrencyOf", [
    unconfigured,
  ]);
  report.check(
    "an unconfigured merchant elects nothing",
    same(defaultCurrency, ZERO),
    "address(0) means the plan's own currency — always payable, since the pool already holds it",
  );

  const eurcAllowed = await view<boolean>(client, currencies, CURRENCIES_ABI, "isAllowed", [ARC_EURC]);
  report.check("EURC is an allowed payout currency", eurcAllowed, ARC_EURC);
  const usdcAllowed = await view<boolean>(client, currencies, CURRENCIES_ABI, "isAllowed", [d["token"] as Address]);
  report.check("USDC is an allowed payout currency", usdcAllowed, d["token"] as string);

  const router = d["checkoutRouter"] as Address;
  const eurcFxRouter = await view<Address>(client, router, ROUTER_ABI, "fxRouterOf", [ARC_EURC]);
  report.check(
    "the router resolves EURC to the EURC identity router",
    same(eurcFxRouter, d["fxRouterEurc"] as string),
    eurcFxRouter,
  );

  const accounting = await view<Address>(client, eurcFxRouter, FX_ROUTER_ABI, "accountingToken");
  report.check(
    "and that router's accountingToken reads EURC (E-01)",
    same(accounting, ARC_EURC),
    `${accounting} — one contract, one constructor argument, no second file`,
  );

  report.note(
    "a live cross-currency settlement",
    "unwitnessable on the shipped configuration — both venues refuse by design (E-03, finding 34). " +
      "07-VALIDATION.md Manual-Only row 3 carries the command and the precondition",
  );
}

// ─── 4. The funded branch, declared rather than written ───────────────────────

/**
 * Seed the EURC book, accredit its lender, bond a merchant, originate one EURC plan and
 * collect its first check.
 *
 * **Deliberately unwritten, and this is a stub declared as one.** The precondition below
 * has never been met on this chain — measured EURC held by every address this project
 * controls is **zero** against `EURC_SEED_REQUIRED` of 375 (finding 34) — so every line of
 * an implementation here would be code that has never executed against Arc. The standing
 * lesson from the funded slice runs is that un-run live code is where the defects are:
 * five failures found one at a time, then a preflight audit of the un-run half that turned
 * up eight more, one of which would have bricked the pool permanently while reporting
 * success. T-07-12-11 names this hazard for this plan by name and prescribes exactly this
 * remedy.
 *
 * So this throws, and what it must do is written down instead:
 *
 *   - Seed both EURC tranches with the permanent per-tranche seed (POOL-12), then
 *     `requestDeposit` **junior first** — senior capacity is a function of the
 *     subordination beneath it — wait out the epoch, `markEpoch`, `closeEpoch`, and
 *     `claimShares` on both. POOL-03 made entry asynchronous and a second book does not
 *     get to shortcut it. Shorten the epoch parameter and then close the open one, or a
 *     control assertion fails against a window that began before the run did.
 *   - `EligibilityRegistry.setGlobal(eurcLender, true)` — **finding 16, and the deployment
 *     deliberately does not do it.** Two books mean two eligibility sets, and a book
 *     nobody may deposit into is what that finding is.
 *   - `fundReserve` to `MIN_RESERVE_BPS` of `totalAssets()`, in EURC.
 *   - Onboard and bond a merchant, then `setPayoutCurrency` to the *other* currency,
 *     pranked as the merchant — there is no merchant argument to pass.
 *   - Originate one EURC plan through the new router with a signed mid, and collect its
 *     first installment. The strip signs against **EURC's** domain separator, not the
 *     dollar token's: the two differ by `name` and `verifyingContract`, so a strip signed
 *     against one can never validate against the other (finding 31).
 *   - Assert the merchant received `principal − mdr − withholding` in **their** chosen
 *     currency. That single origination is FX-02 and MERCH-07's currency half witnessed
 *     together.
 *   - Every write uses a fixed gas figure with its provenance in a comment. `eth_estimateGas`
 *     is unusable near a full balance — the estimator prepays its upper bound out of the
 *     balance being moved.
 *   - Print the total cost as a **measured balance delta**, never as a quote (DEC-32).
 *
 * The Foundry proof of record is green and complete: `test_eurcPlanOriginatesAndRepays`,
 * `test_currencyLegsAreIndependent` and `test_eurcOriginationDoesNotConsumeUsdcBookHeadroom`
 * all run against `CorridorFixture`. What defers is the live witness and nothing else.
 */
function runTheCorridorLoop(): never {
  throw new Error(
    "The live EURC corridor loop is not implemented. It has never been fundable on this\n" +
      "chain — measured EURC held is zero against EURC_SEED_REQUIRED of 375 (finding 34) —\n" +
      "and shipping an un-run implementation of it is the hazard findings 20-27 exist to\n" +
      "prevent. Its specification is in this function's docstring.\n" +
      "FX-02's proof of record is `forge test --root contracts --match-path test/fx/Corridor.t.sol`.",
  );
}

// ─── 5. The orchestrator ──────────────────────────────────────────────────────

function deployerAddress(): Address | undefined {
  const key = process.env["DEPLOYER_PRIVATE_KEY"] as Hex | undefined;
  if (!key) return undefined;
  return privateKeyToAccount(key).address;
}

export async function runCorridorVerify(): Promise<void> {
  const chainId = Number(process.env["PLAZO_CHAIN_ID"] ?? arcTestnet.id);
  const transport = http(process.env["ARC_TESTNET_RPC_URL"] ?? ARC_TESTNET_RPC_URL);
  const client = createPublicClient({chain: arcTestnet, transport}) as PublicClient;

  const deployerKey = process.env["DEPLOYER_PRIVATE_KEY"] as Hex | undefined;
  const deployer = deployerAddress();

  console.log(`The Phase 7 corridor, live on chain ${chainId}`);

  // ── The precondition, first, and the branch it decides ─────────────────────
  //
  // Before anything is attempted. Both branches are a pass; only one of them spends.
  const eurcFunding = deployerKey ? await readCorridorFunding(client, deployerKey) : null;
  const startBalance = deployer ? await nativeBalance(client, deployer) : 0n;

  const deployment = loadDeployment(chainId) as unknown as CorridorDeployment;
  const credit = deployer
    ? await outstandingRequirement(
        client,
        loadDeployment(chainId),
        (process.env["PLAZO_MERCHANT"] as Address | undefined) ?? deployer,
      )
    : null;

  const usdcHeld = startBalance / 1_000_000_000_000n;
  const eurcHeld = eurcFunding?.eurcEverObtained ?? 0n;
  const eurcShortfall = eurcFunding?.shortfall ?? EURC_SEED_REQUIRED;
  const funded = (eurcFunding?.funded ?? false) && (credit ? credit.needed <= usdcHeld : false);

  console.log("\nThe funding precondition, read before anything is attempted");
  console.log(`  deployer            ${deployer ?? "(no DEPLOYER_PRIVATE_KEY — read-only run)"}`);
  console.log(`  USDC held           ${usdc(usdcHeld)}`);
  console.log(`  USDC still required ${credit ? usdc(credit.needed) : "(unknown)"}`);
  console.log(`  EURC held           ${eur(eurcHeld)} (deployer + every derived collection address)`);
  console.log(`  EURC required       ${eur(EURC_SEED_REQUIRED)} — 4x MIN_TICKET of book plus the ticket`);
  console.log(`  EURC shortfall      ${eur(eurcShortfall)}`);
  console.log(`  branch              ${funded ? "FUNDED" : "UNFUNDED"}`);

  if (!funded) {
    const visits = (eurcShortfall + FAUCET_DRIP - 1n) / FAUCET_DRIP;
    console.log(`  faucet visits       ${visits} at ~${eur(FAUCET_DRIP)} per address, if EURC drips at all`);
    console.log("");
    console.log(
      `  Before the faucet: ${usdc(RECOVERABLE_BOND)} is still recoverable on the superseded\n` +
        `  MerchantRegistry at ${SUPERSEDED_MERCHANT_REGISTRY}. \`withdrawBond\` is\n` +
        "  merchant-callable and `requiredBond` reads zero with no fronted exposure outstanding,\n" +
        "  so that is money the protocol is already holding rather than money to go and get.\n" +
        "  It is USDC and not EURC, so it closes the credit half of the gap and not this one.\n",
    );
    console.log(
      "  This is a precondition that was not met, not a failure. Widening a Tier-0 band or a\n" +
        "  reserve floor so the run fits is forbidden (DEC-02): UW-02 caps Tier-0 paper at a\n" +
        "  share of the book and that cap is one of the two things standing between an unproven\n" +
        "  scorecard and the senior tranche. Every check below needs reads rather than capital.\n",
    );
  }

  const {report} = await readCorridorDeployment(client, chainId);
  await assertRolesRewired(client, deployment, report);
  await runMerch07(client, deployment, report);

  const endBalance = deployer ? await nativeBalance(client, deployer) : 0n;
  const spent = startBalance > endBalance ? startBalance - endBalance : 0n;

  console.log("");
  console.log(`  ${report.passed} checks passed, ${report.failed} failed, ${report.noted} noted and not counted`);
  console.log(`  measured balance delta across this run  ${usdc(spent / 1_000_000_000_000n)}`);
  console.log(`  branch                                  ${funded ? "FUNDED" : "UNFUNDED"}`);

  if (report.failed > 0) {
    throw new Error(
      `${report.failed} corridor checks failed. A failing check here is a deployment that is\n` +
        "wired wrong, not a precondition that was not met — the two exit differently on purpose.",
    );
  }

  if (funded) runTheCorridorLoop();
}
