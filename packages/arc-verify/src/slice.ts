/**
 * The vertical slice, against live Arc testnet USDC.
 *
 * The Foundry integration test proves the logic; this proves the token. They are not
 * the same claim and neither substitutes for the other — Arc USDC's movement runs
 * through a native precompile Foundry cannot execute, so **no local test moves a real
 * dollar**, and every balance assertion in the suite is against a mock. What is
 * checked here is the part only the network can answer: that a real EIP-3009
 * signature over a real digest clears against the real token, that the payee check
 * holds, that a bounty actually arrives in a stranger's wallet, and that a drained
 * borrower produces a bounce rather than a revert.
 *
 * It is also why this lives in TypeScript rather than in `forge script`. A Foundry
 * script executes its body locally to collect the transactions it will broadcast, so
 * anything that touches USDC — including `originate`, which pulls the mark escrow —
 * reverts before it can be sent, whatever `--skip-simulation` says. Sending through
 * viem never executes locally at all.
 *
 * **The clock cannot be warped on a live chain.** So the two plans below are
 * originated with backdated schedules, which is the only way to observe a three-day
 * grace window inside a single run. Everything else is real.
 */
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {arcTestnet} from "viem/chains";

import {
  ARC_TESTNET_RPC_URL,
  ARC_USDC,
  GRACE_WINDOW,
  hashTermsDetail,
  markEscrowFor,
  preparePlan,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  PLAN_ACCEPTANCE_TYPES,
  acceptanceDomain,
  SignerClass,
  LIMIT_ATTESTATION_TYPES,
  type PlanTerms,
  type TermsDetail,
} from "@plazo/plan-core";

const FACTORY_ABI = parseAbi([
  "struct PlanTerms { uint256 chainId; address factory; address implementation; address borrower; address merchant; address token; uint256 principal; uint256 installmentCount; uint256 firstDueDate; uint256 interval; uint256 originationNonce; bytes32 termsHash; }",
  "struct Detail { bytes32 jurisdiction; bytes32 lineItemsHash; uint256 mdrBps; uint256 lateFeeFlat; uint8 signerClass; address settlementRecipient; address fxRouter; }",
  "struct Acceptance { bytes32 planId; address borrower; address merchant; address token; uint256 principal; uint256 installmentCount; uint256 firstInstallment; uint256 laterInstallment; uint256 firstDueDate; uint256 finalDueDate; uint256 interval; bytes32 termsHash; uint256 validUntil; }",
  "struct OriginationRequest { PlanTerms terms; Detail detail; Acceptance acceptance; bytes acceptanceSignature; bytes[] strip; }",
  "function originate(OriginationRequest request) returns (bytes32 planId, address plan)",
  "function predictAddress(bytes32 planId) view returns (address)",
  "function implementation() view returns (address)",
]);

const PLAN_ABI = parseAbi([
  "function collect(uint256 index) returns (bool cleared, uint8 reason)",
  "function markMissed(uint256 index)",
  "function repay(uint256 amount)",
  "function state() view returns (uint8)",
  "function outstandingPrincipal() view returns (uint256)",
  "function payoffAmount() view returns (uint256)",
  "function feesOutstanding() view returns (uint256)",
  "function installmentStatus(uint256 index) view returns (uint8)",
  "function bountyFor(uint256 index) view returns (uint256)",
  "function isMarked(uint256 index) view returns (bool)",
  "function dueDate(uint256 index) view returns (uint256)",
  "function planId() view returns (bytes32)",
]);

const ROUTER_ABI = parseAbi([
  "struct PlanTerms { uint256 chainId; address factory; address implementation; address borrower; address merchant; address token; uint256 principal; uint256 installmentCount; uint256 firstDueDate; uint256 interval; uint256 originationNonce; bytes32 termsHash; }",
  "struct Detail { bytes32 jurisdiction; bytes32 lineItemsHash; uint256 mdrBps; uint256 lateFeeFlat; uint8 signerClass; address settlementRecipient; address fxRouter; }",
  "struct Acceptance { bytes32 planId; address borrower; address merchant; address token; uint256 principal; uint256 installmentCount; uint256 firstInstallment; uint256 laterInstallment; uint256 firstDueDate; uint256 finalDueDate; uint256 interval; bytes32 termsHash; uint256 validUntil; }",
  "struct OriginationRequest { PlanTerms terms; Detail detail; Acceptance acceptance; bytes acceptanceSignature; bytes[] strip; }",
  "struct Attestation { bytes32 sessionId; bytes32 planId; address borrower; bytes32 personId; uint8 identityClass; uint256 limit; uint256 validUntil; }",
  "struct OriginationInput { OriginationRequest request; Attestation attestation; bytes attestationSignature; }",
  "function originate(OriginationInput input) returns (bytes32 planId, address plan)",
  "function recognise(bytes32 planId)",
  "function mdrFor(uint256 principal) view returns (uint256)",
  "function corridorOf(address token) pure returns (bytes32)",
  "function maxPrincipalFor(bytes32 personId, uint8 identity, uint8 signerClass, address merchant, address token, address pool) view returns (uint256)",
]);

const POOL_ABI = parseAbi([
  "function seed(uint8 tranche, uint256 assets)",
  "function requestDeposit(uint8 tranche, uint256 assets)",
  "function claimShares(uint8 tranche) returns (uint256 shares)",
  "function requestRedeem(uint8 tranche, uint256 shares) returns (uint256 index)",
  "function claimRedemption(uint8 tranche, uint256 index, uint256 maxSteps) returns (uint256 assets)",
  "function markEpoch(uint256 limit) returns (uint256 walked)",
  "function closeEpoch()",
  "function fundReserve(uint256 amount)",
  "function totalAssets() view returns (uint256)",
  "function bookedCash() view returns (uint256)",
  "function originationOpen() view returns (bool)",
  "function subordinationBps() view returns (uint256)",
  "function reserveBps() view returns (uint256)",
  "function currentEpoch() view returns (uint256)",
  "function epochEndsAt() view returns (uint256)",
  "function markComplete() view returns (bool)",
  "function seeded(uint8 tranche) view returns (bool)",
  "function acceptsSchedule(uint256 installmentCount, uint256 interval) view returns (bool)",
  "function maxSeniorDeposit() view returns (uint256)",
  "function navPerShare(uint8 tranche) view returns (uint256)",
  "function seniorShares() view returns (address)",
  "function juniorShares() view returns (address)",
]);

const TRANCHE_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address holder) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function lockPeriod() view returns (uint256)",
  "function mint(address to, uint256 shares)",
]);

const PASSPORT_ABI = parseAbi([
  "function tierOf(address borrower) view returns (uint8)",
  "function score(uint256 completions, uint256 active) pure returns (uint8)",
  "function activeNegatives(address borrower) view returns (uint256)",
  "function noteOutcome(address borrower, bool clean)",
]);

const POOL_REGISTRY_ABI = parseAbi([
  "function poolFor(bytes32 productLine) view returns (address)",
  "function isPool(address pool) view returns (bool)",
  "function register(bytes32 productLine, address pool)",
]);

const ELIGIBILITY_ABI = parseAbi([
  "function isEligible(address asset, address account) view returns (bool)",
  "function setGlobal(address account, bool eligible)",
]);

const RELAYER_ABI = parseAbi([
  "function delayFloor() view returns (uint256)",
  "function collect(address plan, uint256 index)",
]);

const SCHEMAS_ABI = parseAbi([
  "function publish(bytes32 schemaId, uint64 version, bytes32 contentHash, string uri)",
  "function versionCount(bytes32 schemaId) view returns (uint256)",
]);

const MERCHANTS_ABI = parseAbi([
  "function register(address payoutRecipient, uint32 payoutDomain)",
  "function attestKyb(address merchant, bool verified)",
  "function postBond(address merchant, uint256 amount)",
  "function isRegistered(address merchant) view returns (bool)",
  "function bondOf(address merchant) view returns (uint256)",
  "function requiredBond(address merchant) view returns (uint256)",
  "function outstandingFrontedFor(address merchant) view returns (uint256)",
  "function vestingBpsFor(address merchant) view returns (uint256)",
]);

const REGISTRY_ABI = parseAbi([
  "function get(bytes32 key) view returns (uint256)",
  "function set(bytes32 key, uint256 value)",
]);

const COMPLIANCE_ABI = parseAbi([
  "function screen(address account, uint8 status)",
  "function isClear(address account) view returns (bool)",
]);

const RECEIVABLE_ABI = parseAbi([
  "function exists(bytes32 planId) view returns (bool)",
  "function ownerOf(uint256 tokenId) view returns (address)",
]);

const TIER0_ABI = parseAbi([
  "function pseudonymousId(address wallet) pure returns (bytes32)",
  "function bookHeadroom() view returns (uint256)",
  "function notePlanOutcome(bytes32 planId)",
  "function outstandingExposure() view returns (uint256)",
]);

const TOKEN_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function cancelAuthorization(address authorizer, bytes32 nonce, bytes signature)",
]);

const PlanState = {Grace: 2, Delinquent: 3, Active: 1, Repaid: 10} as const;

/** The protocol minimum ticket. Four checks of $18.75. */
const PRINCIPAL = 75_000_000n;
const INSTALLMENT = PRINCIPAL / 4n;

/**
 * How much USDC the funding account keeps back for its own transactions.
 *
 * Gas on Arc is USDC out of the same balance, so an account that spends its last
 * dollar cannot send the transaction that would refill it.
 */
const GAS_RESERVE = 60_000n;

const DAY = 86_400n;

/** Arc holds balances at 18 decimals and shows them at 6, on one balance. */
const NATIVE_SCALE = 1_000_000_000_000n;

const Tranche = {Senior: 0, Junior: 1} as const;
const ComplianceStatus = {Clear: 1} as const;
const IdentityClass = {Pseudonymous: 0} as const;

/** `ParameterRegistry` keys. Dotted names, hashed — see `ParameterKeys.sol`. */
const key = (name: string): Hex => keccak256(toHex(name));
const TIER0_BOOK_SHARE_BPS = key("plazo.tier0.bookShareBps");
const MERCHANT_BOND_FLOOR = key("plazo.merchant.bondFloor");
const MERCHANT_CONCENTRATION_BPS = key("plazo.concentration.merchantBps");

/**
 * What the book has to hold before it can lend at all.
 *
 * UW-02 caps Tier-0 paper at a share of the book, and the band's ceiling is 25% — so
 * a single $75 plan needs $300 of capital behind it before the headroom reaches the
 * ticket. That is the control working, not an inconvenience: DEC-02 put Tier 0 on
 * pool capital from day one against a research recommendation, and this cap is one of
 * the two things standing between an unproven scorecard and the senior tranche.
 * Widening the band to make a testnet run cheaper would be gutting the control to fit
 * the demo.
 *
 * The capital is not spent. It goes in as deposits, cycles through the plan, and is
 * redeemed at the end — the requirement is a peak holding, not a cost.
 */
const SENIOR_SEED = 250_000_000n;
const JUNIOR_SEED = 45_000_000n;
const RESERVE_SEED = 25_000_000n;
const MERCHANT_BOND = 10_000_000n;

/**
 * Arc's public RPC sheds roughly a quarter of requests with JSON-RPC -32011,
 * regardless of pacing, and viem does not retry it — a shed request arrives as HTTP
 * 200 with an error body, which is not a transport failure as far as any client is
 * concerned. `arc-verify` and the keeper both carry this; the slice needed it too,
 * and found out by losing a run to a `balanceOf` on the third account it read.
 *
 * Retrying a send is safe rather than merely convenient: a shed request was rejected
 * before it reached the txpool, and if one somehow did land, the retry re-derives the
 * same nonce and fails as "nonce too low" instead of sending twice.
 */
const SHED = /request limit reached|-32011|too many requests|rate limit/i;

async function shed<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!SHED.test(message)) throw error;
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  throw last;
}

interface Deployment {
  chainId: number;
  token: Address;
  jurisdictionRegistry: Address;
  parameterRegistry: Address;
  eligibilityRegistry: Address;
  compliance: Address;
  fxRouter: Address;
  payout: Address;
  receivable: Address;
  merchantRegistry: Address;
  poolRegistry: Address;
  creditPool: Address;
  seniorShares: Address;
  juniorShares: Address;
  yieldVenue: Address;
  passport: Address;
  attestationSchemas: Address;
  relayerGate: Address;
  killSwitch: Address;
  tier0: Address;
  pauses: Address;
  installmentPlan: Address;
  planFactory: Address;
  checkoutRouter: Address;
}

/** POOL-12's permanent per-tranche seed. Protocol money, never redeemable. */
const TRANCHE_SEED = 1_000_000n;

/**
 * The longest epoch window the run will sit through, in seconds.
 *
 * Ninety minutes is the parameter's one-hour floor plus slack for a window that began
 * before the run did. Longer than that is a misconfiguration for a slice rather than
 * something to wait out, and a run that silently blocks for most of a day is worse
 * than one that says which parameter to move.
 */
const MAX_EPOCH_WAIT = 90n * 60n;

/**
 * What a full run needs on the funding account, all at once.
 *
 * Most of it is the book. UW-02 caps Tier-0 paper at a share of the pool and the
 * band's ceiling is 25%, so a $75 ticket needs $300 of capital behind it before the
 * headroom reaches the ticket — the cap working, not a nuisance. None of it is spent:
 * deposits go in, cycle through the plan, and are redeemed at the end. The borrower's
 * float is the part that genuinely moves, and it moves into the pool rather than back
 * to the funding account, which is why it is counted in full.
 *
 * Exported because `faucet.ts` reports progress against it. Two copies of this figure
 * is how it came to be quoted as 406.84 in five documents after the tranche seeds were
 * added — a shortfall the operator only discovers with a funded account and a
 * half-finished run.
 */
export const CAPITALISATION =
  SENIOR_SEED +
  JUNIOR_SEED +
  RESERVE_SEED +
  2n * TRANCHE_SEED; // POOL-12's permanent seeds, one per tranche, never redeemable

export const REQUIRED =
  CAPITALISATION +
  MERCHANT_BOND +
  PRINCIPAL + // the borrower's four installments, drawn one at a time
  2n * markEscrowFor(4n) +
  4n * GAS_RESERVE;

/** The one product line v1 funds. Matches `Deploy.s.sol`. */
const PAY_IN_4 = keccak256(toHex("PLAZO.PAY_IN_4"));

let passed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`FAILED: ${label}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`  ok  ${label}${detail ? ` (${detail})` : ""}`);
}

/**
 * A property that could only be witnessed once, on a book that no longer exists.
 *
 * Some of these controls are about a virgin deployment — a tranche refusing deposits
 * before it is seeded cannot be re-observed after it is seeded, on any book, ever.
 * Reporting that as a pass would be a lie the second time and every time after; the
 * count would keep climbing while the suite quietly stopped asking. So it prints
 * differently and does not count.
 */
function note(label: string, detail: string): void {
  console.log(`  --  ${label} — ${detail}`);
}

function usdc(value: bigint): string {
  return `${formatUnits(value, 6)} USDC`;
}

/** Deterministic sub-accounts, so one funded key is all an operator has to hold. */
function derive(deployerKey: Hex, role: string): Account {
  return privateKeyToAccount(keccak256(toHex(`${deployerKey}/${role}`)));
}

class Slice {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly deployment: Deployment,
    private readonly deployer: WalletClient,
    private readonly borrower: WalletClient,
    private readonly keeper: WalletClient,
    private readonly merchant: WalletClient,
  ) {}

  private account(wallet: WalletClient): Address {
    return wallet.account!.address;
  }

  /**
   * The account's native balance, at 18 decimals.
   *
   * Gas on Arc is USDC out of this same balance — `balanceOf` is just this figure
   * over 10¹². So a keeper's earnings cannot be checked with the ERC-20 view: the
   * crank's gas comes out of the account the bounty is paid into, and the 6-decimal
   * view truncates whatever is left over. Reading the native figure makes the
   * assertion exact and puts the unification on the record rather than in a comment.
   */
  async nativeBalance(who: Address): Promise<bigint> {
    return shed(() => this.publicClient.getBalance({address: who}));
  }

  /** Whether the book already carries the capital `prepareBook` would deposit. */
  async bookIsCapitalised(): Promise<boolean> {
    return this.view<boolean>(this.deployment.creditPool, POOL_ABI, "originationOpen");
  }

  /** The merchant's standing bond, which a re-run does not have to post again. */
  async merchantBond(): Promise<bigint> {
    return this.view<bigint>(this.deployment.merchantRegistry, MERCHANTS_ABI, "bondOf", [
      this.account(this.merchant),
    ]);
  }

  async balance(who: Address): Promise<bigint> {
    return shed(() =>
      this.publicClient.readContract({
        address: this.deployment.token,
        abi: TOKEN_ABI,
        functionName: "balanceOf",
        args: [who],
      }),
    );
  }

  /**
   * Send, with an explicit gas limit.
   *
   * Not an optimisation — `eth_estimateGas` cannot be used for a transfer close to
   * an account's whole balance on Arc. The estimator prepays its upper-bound gas out
   * of the same balance the transfer moves, so a 30M-gas upper bound at 90 gwei
   * removes 2.7 USDC before execution and the token reverts with
   * "transfer amount exceeds balance" — a failure that looks like insolvency and is
   * actually the estimator. This is the sharpest edge of gas and the loan being one
   * balance, and it will bite anything that sweeps an account.
   */
  private async send(
    wallet: WalletClient,
    request: Parameters<WalletClient["writeContract"]>[0],
    gas = 600_000n,
  ) {
    const hash = await shed(() => wallet.writeContract({gas, ...request} as never));
    const receipt = await shed(() => this.publicClient.waitForTransactionReceipt({hash}));
    if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return receipt;
  }

  async fund(to: Address, amount: bigint): Promise<void> {
    await this.send(this.deployer, {
      account: this.deployer.account!,
      chain: arcTestnet,
      address: this.deployment.token,
      abi: TOKEN_ABI,
      functionName: "transfer",
      args: [to, amount],
    } as never);
  }

  /**
   * Give the borrower enough for the next installment, and nothing more.
   *
   * A faucet drip is small and a Pay-in-4 minimum ticket is $75, so the borrower is
   * topped up one installment at a time and the settlement recipient is the funding
   * account — the same dollars go round the loop four times. On a real book those are
   * two different parties and the money does not come back; here it has to, or the
   * run needs more USDC than a testnet faucet hands out.
   */
  async topUp(to: Address, target: bigint): Promise<void> {
    const held = await this.balance(to);
    if (held >= target) return;

    const shortfall = target - held;
    const available = await this.balance(this.account(this.deployer));
    if (available < shortfall + GAS_RESERVE) {
      throw new Error(
        `Out of testnet USDC. Need ${usdc(shortfall + GAS_RESERVE)} to continue, ` +
          `have ${usdc(available)}. Top up ${this.account(this.deployer)} at https://faucet.circle.com.`,
      );
    }
    await this.fund(to, shortfall);
  }

  /**
   * Return a testnet actor's earnings to the funding account.
   *
   * Bookkeeping, not protocol behaviour, and it is called only after the assertion
   * that the actor was paid — the payment is real and is checked at the moment it
   * happens. What it works around is that a faucet drip is roughly one $75 ticket,
   * and every bounty that leaves the loop is a bounty the next installment cannot be
   * funded with. On a real book nothing comes back.
   */
  async recycle(wallet: WalletClient, label: string): Promise<void> {
    const held = await this.balance(this.account(wallet));
    if (held <= GAS_RESERVE) return;
    const returned = held - GAS_RESERVE;
    await this.send(wallet, {
      account: wallet.account!,
      chain: arcTestnet,
      address: this.deployment.token,
      abi: TOKEN_ABI,
      functionName: "transfer",
      args: [this.account(this.deployer), returned],
    } as never);
    console.log(`  ..  ${label} returned ${usdc(returned)} to the funding account (testnet bookkeeping)`);
  }

  detail(): TermsDetail {
    return {
      jurisdiction: keccak256(toHex("PLAZO.DEFAULT")),
      lineItemsHash: keccak256(toHex("slice basket")),
      mdrBps: 400n,
      lateFeeFlat: 7_000_000n,
      signerClass: SignerClass.EOA,
      // The pool, and the router refuses anything else. A merchant naming themselves
      // here would be paid twice — once by the pool at checkout and again by every
      // installment the borrower makes.
      settlementRecipient: this.deployment.creditPool,
      fxRouter: this.deployment.fxRouter,
    };
  }

  private async write(
    wallet: WalletClient,
    address: Address,
    abi: readonly unknown[],
    functionName: string,
    args: unknown[],
    gas = 600_000n,
  ) {
    return this.send(
      wallet,
      {account: wallet.account!, chain: arcTestnet, address, abi, functionName, args} as never,
      gas,
    );
  }

  private async view<T>(
    address: Address,
    abi: readonly unknown[],
    functionName: string,
    args: unknown[] = [],
  ): Promise<T> {
    return shed(
      () => this.publicClient.readContract({address, abi, functionName, args} as never) as Promise<T>,
    );
  }

  // ─── Setting the book up ────────────────────────────────────────────────────

  /**
   * Capitalise the pool, onboard the merchant, screen both parties.
   *
   * Every step here is the real contract call a real operator would make, in the
   * order they would make it. The one deviation from production is that a single key
   * plays governance, lender, merchant and screener — on a real deployment those are
   * four organisations, and the role graph is what keeps them apart.
   */
  async prepareBook(): Promise<void> {
    console.log("\nSetting up the book");

    const deployer = this.account(this.deployer);
    const merchant = this.account(this.merchant);

    // UW-02's ceiling, set to the top of its hard-coded band. A $75 ticket needs
    // $300 of book behind it at 25%; at the seeded 10% it would need $750.
    await this.write(this.deployer, this.deployment.parameterRegistry, REGISTRY_ABI, "set", [
      TIER0_BOOK_SHARE_BPS,
      2_500n,
    ]);
    // The bond floor is a $250 entry cost by default. On testnet the exposure-scaled
    // term is what is being exercised, so the floor comes off — and zero is inside
    // the band, so this is a configuration rather than a widening.
    await this.write(this.deployer, this.deployment.parameterRegistry, REGISTRY_ABI, "set", [
      MERCHANT_BOND_FLOOR,
      0n,
    ]);
    // UW-09's per-merchant cap, raised from 20% to the same 25% the Tier-0 book share
    // uses. Both are settings inside a compiled-in band, not widenings of one.
    //
    // The reason is that a one-merchant book is 100% concentrated by construction, and
    // concentration is a diversification control — there is nothing here to diversify.
    // At the seeded 322 USDC a 20% cap refuses the protocol's own minimum ticket, which
    // is the cap describing a book with one merchant rather than a ticket that is too
    // large. It is a different kind of number from the Tier-0 share, which bounds what
    // the pool can lose on unproven paper however many merchants there are, and which
    // is why that one stays at its ceiling rather than above it.
    await this.write(this.deployer, this.deployment.parameterRegistry, REGISTRY_ABI, "set", [
      MERCHANT_CONCENTRATION_BPS,
      2_500n,
    ]);

    await this.write(this.deployer, this.deployment.token, TOKEN_ABI, "approve", [
      this.deployment.creditPool,
      SENIOR_SEED + JUNIOR_SEED + RESERVE_SEED + 2n * TRANCHE_SEED,
    ]);

    // POOL-12's permanent seed, before anybody can be the first depositor. Protocol
    // money, never redeemable, and the reason the empty-vault case is unreachable
    // rather than merely expensive.
    for (const tranche of [Tranche.Junior, Tranche.Senior] as const) {
      if (await this.view<boolean>(this.deployment.creditPool, POOL_ABI, "seeded", [tranche])) continue;
      await this.write(this.deployer, this.deployment.creditPool, POOL_ABI, "seed", [
        tranche,
        TRANCHE_SEED,
      ]);
    }

    // Accredit the lender. DEC-01 keeps Reg D transfer restrictions on the tranche
    // claims, so a share cannot be minted to an address the operator has not admitted
    // — and the deployment admits nobody, correctly: who may hold a security is an
    // operational determination about a person, not a property of the infrastructure
    // that issues it. `Deploy.s.sol` grants the pool and the router because they are
    // plumbing. A lender is not plumbing, and the slice is acting as the operator here.
    //
    // Finding 16. The local fixture grants this in `setUp`, which is why 286 tests pass
    // against a book that, as deployed, no account on earth could deposit into.
    if (
      !(await this.view<boolean>(this.deployment.eligibilityRegistry, ELIGIBILITY_ABI, "isEligible", [
        this.deployment.juniorShares,
        this.account(this.deployer),
      ]))
    ) {
      await this.write(this.deployer, this.deployment.eligibilityRegistry, ELIGIBILITY_ABI, "setGlobal", [
        this.account(this.deployer),
        true,
      ]);
    }

    // POOL-03. Entry is a request, a close and a claim — three transactions, because
    // the price a deposit settles at does not exist when the deposit is made.
    //
    // Junior first. Senior capacity is a function of the subordination beneath it, so
    // a book is capitalised from the bottom up, which is how one actually is.
    //
    // Skipped outright if the book already carries capital. This is not a nicety: a
    // run that failed after capitalising has already spent the deposits, so repeating
    // them asks for 295 USDC the account no longer holds — the second run would fail
    // on funds rather than on whatever it was re-run to test. Skipping also spares the
    // epoch window, which is the difference between iterating in a minute and in an
    // hour.
    if (!(await this.view<boolean>(this.deployment.creditPool, POOL_ABI, "originationOpen"))) {
      await this.write(this.deployer, this.deployment.creditPool, POOL_ABI, "requestDeposit", [
        Tranche.Junior,
        JUNIOR_SEED,
      ]);
      await this.write(this.deployer, this.deployment.creditPool, POOL_ABI, "requestDeposit", [
        Tranche.Senior,
        SENIOR_SEED,
      ]);
      await this.closeEpoch();
      await this.write(this.deployer, this.deployment.creditPool, POOL_ABI, "claimShares", [Tranche.Junior]);
      await this.write(this.deployer, this.deployment.creditPool, POOL_ABI, "claimShares", [Tranche.Senior]);

      await this.write(this.deployer, this.deployment.creditPool, POOL_ABI, "fundReserve", [
        RESERVE_SEED,
      ]);
    }

    check(
      "the book is capitalised and the origination gate is open",
      await this.view<boolean>(this.deployment.creditPool, POOL_ABI, "originationOpen"),
      `${usdc(await this.view<bigint>(this.deployment.creditPool, POOL_ABI, "totalAssets"))} of assets`,
    );
    check(
      "Tier-0 headroom covers the ticket",
      (await this.view<bigint>(this.deployment.tier0, TIER0_ABI, "bookHeadroom")) >= PRINCIPAL,
    );

    if (!(await this.view<boolean>(this.deployment.merchantRegistry, MERCHANTS_ABI, "isRegistered", [merchant]))) {
      await this.write(this.merchant, this.deployment.merchantRegistry, MERCHANTS_ABI, "register", [
        deployer,
        26,
      ]);
    }
    await this.write(this.deployer, this.deployment.merchantRegistry, MERCHANTS_ABI, "attestKyb", [
      merchant,
      true,
    ]);
    // Posted once. A bond is a standing deposit, not a per-run fee — re-posting would
    // quietly ask the account for another ten dollars every time the slice is re-run.
    if (
      (await this.view<bigint>(this.deployment.merchantRegistry, MERCHANTS_ABI, "bondOf", [merchant])) <
      MERCHANT_BOND
    ) {
      await this.write(this.deployer, this.deployment.token, TOKEN_ABI, "approve", [
        this.deployment.merchantRegistry,
        MERCHANT_BOND,
      ]);
      await this.write(this.deployer, this.deployment.merchantRegistry, MERCHANTS_ABI, "postBond", [
        merchant,
        MERCHANT_BOND,
      ]);
    }

    await this.write(this.deployer, this.deployment.compliance, COMPLIANCE_ABI, "screen", [
      this.account(this.borrower),
      ComplianceStatus.Clear,
    ]);
    await this.write(this.deployer, this.deployment.compliance, COMPLIANCE_ABI, "screen", [
      merchant,
      ComplianceStatus.Clear,
    ]);

    check(
      "both parties are screened and the merchant is KYB'd",
      (await this.view<boolean>(this.deployment.compliance, COMPLIANCE_ABI, "isClear", [
        this.account(this.borrower),
      ])) && (await this.view<boolean>(this.deployment.compliance, COMPLIANCE_ABI, "isClear", [merchant])),
    );
  }

  /**
   * The origination plane's controls, against live bytecode.
   *
   * Everything here is cheap — reads, simulations and a handful of sub-cent writes —
   * because none of it moves credit. That makes it the half of the live verification
   * that runs on a faucet drip, and it is not a lesser half: what it checks is that
   * the *refusals* work on the real chain, and a control that has only ever been
   * tested against a mock is a control nobody has seen refuse anything.
   *
   * Reverts are asserted by simulation rather than by sending. A simulation is the
   * real node executing the real bytecode against the real state; the only thing it
   * skips is paying for the failure.
   */
  async runControls(): Promise<void> {
    console.log("\nThe origination plane — live controls");

    const d = this.deployment;
    const contracts: [string, Address][] = [
      ["ParameterRegistry", d.parameterRegistry],
      ["EligibilityRegistry", d.eligibilityRegistry],
      ["AllowlistCompliance", d.compliance],
      ["ArcLocalPayout", d.payout],
      ["ReceivableToken", d.receivable],
      ["MerchantRegistry", d.merchantRegistry],
      ["PoolRegistry", d.poolRegistry],
      ["TranchedCreditPool", d.creditPool],
      ["SeniorShares", d.seniorShares],
      ["JuniorShares", d.juniorShares],
      ["ParkedYieldVenue", d.yieldVenue],
      ["PlazoPassport", d.passport],
      ["AttestationSchemaRegistry", d.attestationSchemas],
      ["RelayerGate", d.relayerGate],
      ["FirstPaymentDefaultSwitch", d.killSwitch],
      ["Tier0Underwriter", d.tier0],
      ["OriginationPause", d.pauses],
      ["PlanFactory", d.planFactory],
      ["CheckoutRouter", d.checkoutRouter],
    ];

    const codes = await Promise.all(
      contracts.map(async ([, address]) => (await shed(() => this.publicClient.getCode({address})))?.length ?? 0),
    );
    check(
      "every contract in the deployment record holds bytecode",
      codes.every((length) => length > 2),
      `${contracts.length} contracts`,
    );

    // GOV-01. The bands are compiled in, and governance is inside them.
    const bookShare = await this.view<bigint>(d.parameterRegistry, REGISTRY_ABI, "get", [
      TIER0_BOOK_SHARE_BPS,
    ]);
    // Inside the band, not equal to the default. Pinning this to the deployed 1000 bp
    // asserted that nobody had exercised governance — which the run itself does, three
    // lines into `prepareBook`, and which is the whole point of a registry. The band is
    // the property; that it is enforced is the assertion immediately below.
    check(
      "every Appendix A parameter reads from the registry",
      bookShare > 0n && bookShare <= 2_500n,
      `Tier-0 book share ${bookShare} bp, inside its 25% ceiling`,
    );

    check(
      "a value outside its hard-coded band is refused onchain",
      await this.reverts(d.parameterRegistry, REGISTRY_ABI, "set", [TIER0_BOOK_SHARE_BPS, 9_000n], this.deployer),
      "25% is the ceiling; 90% was refused",
    );

    // POOL-05. Nothing has been deposited, so the gate is shut and says so — and the
    // quote surfaces downstream of it answer zero rather than a figure they cannot
    // honour. All three are properties of an *empty* book. This run capitalises it, so
    // they are witnessed on the way past and cannot be asked of the same book again.
    // Two different conditions, not one. The origination gate stays shut until the
    // book is properly capitalised — reserve funded and subordination met — but Tier-0
    // headroom and the quote it feeds are a *share* of assets, so they leave zero the
    // moment the book holds anything at all. POOL-12's permanent seed is the first
    // thing that happens to any book and is enough to end them.
    const capitalised = await this.view<boolean>(d.creditPool, POOL_ABI, "originationOpen");
    const assets = await this.view<bigint>(d.creditPool, POOL_ABI, "totalAssets");

    if (capitalised) {
      note("an uncapitalised book refuses to originate", "the book carries capital from an earlier run");
    } else {
      check("an uncapitalised book refuses to originate", !capitalised);
    }

    if (assets > 0n) {
      const spent = `the book holds ${usdc(assets)}; a share of it is not zero`;
      note("Tier-0 headroom is zero against a book with no capital", spent);
      note("the quote surface answers zero rather than a figure it cannot honour", spent);
    } else {
      check(
        "Tier-0 headroom is zero against a book with no capital",
        (await this.view<bigint>(d.tier0, TIER0_ABI, "bookHeadroom")) === 0n,
      );

      const personId = await this.view<Hex>(d.tier0, TIER0_ABI, "pseudonymousId", [
        this.account(this.borrower),
      ]);
      check(
        "the quote surface answers zero rather than a figure it cannot honour",
        (await this.view<bigint>(d.checkoutRouter, ROUTER_ABI, "maxPrincipalFor", [
          personId,
          IdentityClass.Pseudonymous,
          SignerClass.EOA,
          this.account(this.merchant),
          d.token,
          d.creditPool,
        ])) === 0n,
      );
    }

    // Merchant onboarding is self-serve; permission to originate is not.
    const merchant = this.account(this.merchant);
    if (!(await this.view<boolean>(d.merchantRegistry, MERCHANTS_ABI, "isRegistered", [merchant]))) {
      await this.topUp(merchant, GAS_RESERVE);
      await this.write(this.merchant, d.merchantRegistry, MERCHANTS_ABI, "register", [
        this.account(this.deployer),
        26,
      ]);
    }
    check(
      "a merchant registered themselves without an operator",
      await this.view<boolean>(d.merchantRegistry, MERCHANTS_ABI, "isRegistered", [merchant]),
    );
    check(
      "and cannot attest their own KYB",
      await this.reverts(d.merchantRegistry, MERCHANTS_ABI, "attestKyb", [merchant, true], this.merchant),
    );

    // CHKT-03. Unknown is not clear, and only the screener's key changes that.
    check(
      "an unscreened borrower is not clear",
      !(await this.view<boolean>(d.compliance, COMPLIANCE_ABI, "isClear", [this.account(this.keeper)])),
    );
    await this.write(this.deployer, d.compliance, COMPLIANCE_ABI, "screen", [
      this.account(this.borrower),
      ComplianceStatus.Clear,
    ]);
    check(
      "the operator's feed cleared the borrower",
      await this.view<boolean>(d.compliance, COMPLIANCE_ABI, "isClear", [this.account(this.borrower)]),
    );

    // GOV-10. Default deny, from the first mint.
    check(
      "the receivable refuses to mint to an address nobody has considered",
      await this.reverts(
        d.receivable,
        parseAbi(["function mint(bytes32 planId, address to, uint256 principal)"]),
        [keccak256(toHex("nope")), this.account(this.keeper), PRINCIPAL],
        this.deployer,
        "mint",
      ),
    );

    // The factory is the router's alone. A permissionless `deploy` is a denial of
    // service on a signed strip.
    check(
      "nobody but the router can deploy a plan",
      await this.reverts(
        d.planFactory,
        FACTORY_ABI,
        "deploy",
        [this.terms(BigInt(Math.floor(Date.now() / 1000)) + 3600n, 14n * DAY, 1n)],
        this.deployer,
      ),
    );

    await this.capitalControls();
    await this.servicingControls();
  }

  /**
   * The capital plane's refusals, on the live chain.
   *
   * Every one of these is a thing the book will not do, and a refusal is the only half
   * of a credit market that can be tested without capital. The half that needs money is
   * `prepareBook`, and it reports its own shortfall rather than pretending.
   */
  private async capitalControls(): Promise<void> {
    const d = this.deployment;

    // POOL-01. One book per product line, and the book itself decides what it funds.
    check(
      "the Pay-in-4 book funds Pay-in-4 paper",
      await this.view<boolean>(d.creditPool, POOL_ABI, "acceptsSchedule", [4n, 14n * DAY]),
    );
    check(
      "and refuses a tenor it was not stood up for",
      !(await this.view<boolean>(d.creditPool, POOL_ABI, "acceptsSchedule", [12n, 30n * DAY])),
      "a twelve-month Flex schedule against the Pay-in-4 book",
    );
    check(
      "the registry knows which book backs the line",
      (await this.view<Address>(d.poolRegistry, POOL_REGISTRY_ABI, "poolFor", [PAY_IN_4]))
        .toLowerCase() === d.creditPool.toLowerCase(),
    );
    check(
      "and refuses to repoint it",
      await this.reverts(d.poolRegistry, POOL_REGISTRY_ABI, "register", [PAY_IN_4, d.yieldVenue], this.deployer),
      "outstanding plans settle to the book that funded them",
    );

    // POOL-12. The empty-vault case is unreachable, not merely expensive.
    if (await this.view<boolean>(d.creditPool, POOL_ABI, "seeded", [Tranche.Junior])) {
      note(
        "a tranche refuses deposits until the protocol has seeded it",
        "already seeded; witnessed at seeding and not observable again on this book",
      );
    } else {
      check(
        "a tranche refuses deposits until the protocol has seeded it",
        await this.reverts(d.creditPool, POOL_ABI, "requestDeposit", [Tranche.Junior, 1_000_000n], this.deployer),
      );
    }

    // DEC-01. The tranche claims carry Reg D transfer restrictions, so a share cannot
    // be minted to somebody the operator has not admitted. Asked of the borrower, who
    // is never a lender — so unlike the seeding control this one stays observable for
    // the life of the book rather than being spent the first time it is asked.
    check(
      "a lender's claim refuses a holder nobody has accredited",
      !(await this.view<boolean>(d.eligibilityRegistry, ELIGIBILITY_ABI, "isEligible", [
        d.juniorShares,
        this.account(this.borrower),
      ])) &&
        (await this.reverts(d.creditPool, POOL_ABI, "requestDeposit", [Tranche.Junior, 1_000_000n], this.borrower)),
      "the borrower cannot hold a lender's claim",
    );

    const seniorDecimals = await this.view<number>(d.seniorShares, TRANCHE_ABI, "decimals");
    check(
      "share units carry the decimals offset",
      seniorDecimals === 9,
      `${seniorDecimals} decimals against USDC's 6`,
    );

    // POOL-10. Junior is locked for a full product tenor; senior is not.
    const juniorLock = await this.view<bigint>(d.juniorShares, TRANCHE_ABI, "lockPeriod");
    const seniorLock = await this.view<bigint>(d.seniorShares, TRANCHE_ABI, "lockPeriod");
    check(
      "junior is locked for a full tenor and senior is not",
      juniorLock === 56n * DAY && seniorLock === 0n,
      `junior ${juniorLock / DAY} days`,
    );

    // POOL-02. Only the pool mints a claim on the book.
    check(
      "nobody but the pool can mint a tranche share",
      await this.reverts(d.seniorShares, TRANCHE_ABI, "mint", [this.account(this.deployer), 1n], this.deployer),
    );

    // POOL-04. An epoch cannot be closed before its window has passed.
    const epoch = await this.view<bigint>(d.creditPool, POOL_ABI, "currentEpoch");
    check(
      "an epoch cannot be closed before its time",
      await this.reverts(d.creditPool, POOL_ABI, "closeEpoch", [], this.deployer),
      `epoch ${epoch} is still open`,
    );

    // POOL-06. Senior capacity is a function of the subordination beneath it, and on a
    // virgin book there is none — you cannot be senior to nothing. Seeding junior is
    // what ends that, so like the control above it is witnessed once and then gone.
    if (await this.view<boolean>(d.creditPool, POOL_ABI, "seeded", [Tranche.Junior])) {
      note(
        "senior capacity is zero against a book with no junior",
        "junior is seeded; capacity is bounded by it rather than absent",
      );
    } else {
      check(
        "senior capacity is zero against a book with no junior",
        (await this.view<bigint>(d.creditPool, POOL_ABI, "maxSeniorDeposit")) === 0n,
      );
    }
  }

  /**
   * The servicing plane's refusals.
   *
   * COLL-07's delay floor and PASS-02's read gate are both things that only mean
   * anything if they hold against a live contract rather than a configuration file.
   */
  private async servicingControls(): Promise<void> {
    const d = this.deployment;

    // COLL-07. The floor is a registry row the gate reads, not a constant it holds.
    const floor = await this.view<bigint>(d.relayerGate, RELAYER_ABI, "delayFloor");
    check(
      "the operator's collections are held back by an onchain floor",
      floor === 1_800n,
      `${floor / 60n} minutes after each due date`,
    );

    // PASS-02. A stranger cannot read a borrower's tier, and the deployer is a
    // stranger — the router holds the reader role, not the key that deployed it.
    check(
      "a borrower's tier is not readable by whoever asks",
      await this.reverts(d.passport, PASSPORT_ABI, "tierOf", [this.account(this.borrower)], this.merchant),
    );

    // PASS-01. Written only by protocol contracts. Not even by the admin.
    check(
      "and nobody outside the protocol can write one",
      await this.reverts(d.passport, PASSPORT_ABI, "noteOutcome", [this.account(this.borrower), true], this.deployer),
    );

    // PASS-06. The tier is a pure function, evaluated by the chain, matching the
    // corpus `packages/passport` is asserted against.
    const impaired = await this.view<number>(d.passport, PASSPORT_ABI, "score", [9n, 2n]);
    const trusted = await this.view<number>(d.passport, PASSPORT_ABI, "score", [5n, 0n]);
    check(
      "the credit score is a pure function anyone can evaluate",
      impaired === 1 && trusted === 4,
      "two marks impair; five clean completions are trusted",
    );

    // PASS-05. A schema version without a content hash is a link, not a commitment.
    check(
      "a schema cannot be published without a content hash",
      await this.reverts(
        d.attestationSchemas,
        SCHEMAS_ABI,
        "publish",
        [keccak256(toHex("plazo.passport.v1")), 1n, `0x${"0".repeat(64)}`, "ipfs://nothing"],
        this.deployer,
      ),
    );
  }

  /**
   * Whether a call reverts on the live chain.
   *
   * Simulated rather than sent. The node executes the real bytecode against the real
   * state either way; the only difference is that nobody pays for the failure, which
   * matters when the whole point of the call is that it fails.
   */
  private async reverts(
    address: Address,
    abi: readonly unknown[],
    functionNameOrArgs: string | unknown[],
    argsOrWallet: unknown[] | WalletClient,
    walletOrFunctionName?: WalletClient | string,
    functionName?: string,
  ): Promise<boolean> {
    // Two call shapes, because half these assertions read better with the arguments
    // last. Normalised here rather than at nine call sites.
    const fn =
      typeof functionNameOrArgs === "string"
        ? functionNameOrArgs
        : (functionName ?? (walletOrFunctionName as string));
    const args = typeof functionNameOrArgs === "string" ? (argsOrWallet as unknown[]) : functionNameOrArgs;
    const wallet =
      typeof functionNameOrArgs === "string"
        ? (walletOrFunctionName as WalletClient)
        : (argsOrWallet as WalletClient);

    try {
      await shed(() =>
        this.publicClient.simulateContract({
          account: wallet.account!,
          address,
          abi,
          functionName: fn,
          args,
        } as never),
      );
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Return the pool's capital and the merchant's bond to the funding account.
   *
   * Three steps per tranche now rather than one, because POOL-03 made exit
   * asynchronous: queue the shares, close the epoch that prices them, collect. A
   * redeemer who cannot be paid this epoch keeps their cumulative position, so a
   * partial unwind is not a failure — it is the queue doing what it is for, and the
   * remainder fills from natural runoff.
   */
  async unwind(): Promise<void> {
    // Queue both tranches, then close once — the mirror of how they were funded, and
    // of DEC-22: an epoch prices every request in it at the same NAV, so a close per
    // tranche settles nothing a single close would not and costs an entire epoch
    // window to do it. That is an hour at the floor and a day at the default, spent
    // waiting for a second strike that is arithmetically identical to the first.
    const queued: {tranche: (typeof Tranche)[keyof typeof Tranche]; index: bigint}[] = [];

    for (const tranche of [Tranche.Senior, Tranche.Junior] as const) {
      const share = tranche === Tranche.Senior ? this.deployment.seniorShares : this.deployment.juniorShares;
      const held = await this.view<bigint>(share, TRANCHE_ABI, "balanceOf", [
        this.account(this.deployer),
      ]);
      if (held === 0n) continue;

      await this.write(this.deployer, share, TRANCHE_ABI, "approve", [this.deployment.creditPool, held]);
      const index = await this.view<bigint>(this.deployment.creditPool, POOL_ABI, "requestRedeem", [
        tranche,
        held,
      ]);
      await this.write(this.deployer, this.deployment.creditPool, POOL_ABI, "requestRedeem", [
        tranche,
        held,
      ]);
      queued.push({tranche, index});
    }

    if (queued.length === 0) return;

    await this.closeEpoch();

    for (const {tranche, index} of queued) {
      await this.write(this.deployer, this.deployment.creditPool, POOL_ABI, "claimRedemption", [
        tranche,
        index,
        8n,
      ]);
    }
  }


  /** The plan under test, derived exactly as `plan-core` derives it. */
  terms(firstDueDate: bigint, interval: bigint, nonce: bigint, count = 4n): PlanTerms {
    const detail = this.detail();
    return {
      chainId: BigInt(this.deployment.chainId),
      factory: this.deployment.planFactory,
      implementation: this.deployment.installmentPlan,
      borrower: this.account(this.borrower),
      merchant: this.account(this.merchant),
      token: this.deployment.token,
      // The protocol minimum. Four checks of $18.75.
      principal: PRINCIPAL,
      installmentCount: count,
      firstDueDate,
      interval,
      originationNonce: nonce,
      termsHash: hashTermsDetail(detail),
    };
  }
  /**
   * Run both crank phases and close the epoch. POOL-04 and COLL-04.
   *
   * Permissionless, so the slice calls them as any lender in the queue would. It waits
   * out the epoch window by polling rather than warping, because there is no cheatcode
   * on a real chain — which is also the honest cost of a one-day epoch on testnet.
   */
  private async closeEpoch(): Promise<void> {
    const endsAt = await this.view<bigint>(this.deployment.creditPool, POOL_ABI, "epochEndsAt");
    let block = await shed(() => this.publicClient.getBlock());

    if (block.timestamp < endsAt) {
      const seconds = endsAt - block.timestamp;

      // Waiting is only reasonable against the floor. Anything longer is a
      // misconfiguration for a slice run rather than something to sit through, and
      // sitting through it silently for most of a day is worse than saying so.
      if (seconds > MAX_EPOCH_WAIT) {
        throw new Error(
          `The epoch runs until ${endsAt} and it is ${block.timestamp} — ${seconds / 60n} minutes. ` +
            `Lower plazo.pool.epochLength to its one-hour floor and close the open epoch first; ` +
            `the run will then wait out each window as it reaches it.`,
        );
      }

      console.log(`  … epoch ${await this.view<bigint>(this.deployment.creditPool, POOL_ABI, "currentEpoch")} closes in ${seconds / 60n}m, waiting`);
      while (block.timestamp < endsAt) {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        block = await shed(() => this.publicClient.getBlock());
      }
    }

    await this.write(this.deployer, this.deployment.creditPool, POOL_ABI, "markEpoch", [32n]);
    await this.write(this.deployer, this.deployment.creditPool, POOL_ABI, "closeEpoch", []);
  }
  /**
   * Originate through the real factory, with a strip the borrower actually signs.
   *
   * Nothing here is a shortcut. The authorizations are EIP-712 payloads over the
   * token's own domain, the acceptance is signed against the plan's counterfactual
   * address, and the factory verifies all of it onchain before the plan exists.
   */
  async originate(terms: PlanTerms, now: bigint): Promise<Address> {
    const prepared = preparePlan(terms, now + 3600n);

    const onchain = await shed(() =>
      this.publicClient.readContract({
        address: this.deployment.planFactory,
        abi: FACTORY_ABI,
        functionName: "predictAddress",
        args: [prepared.planId],
      }),
    );
    check("TypeScript and Solidity agree on the payee address", onchain === prepared.address, onchain);

    const domain = {
      name: "USDC",
      version: "2",
      chainId: this.deployment.chainId,
      verifyingContract: this.deployment.token,
    } as const;

    const strip: Hex[] = [];
    for (const authorization of prepared.strip) {
      strip.push(
        await this.borrower.signTypedData({
          account: this.borrower.account!,
          domain,
          types: RECEIVE_WITH_AUTHORIZATION_TYPES,
          primaryType: "ReceiveWithAuthorization",
          message: {
            from: authorization.from,
            to: authorization.to,
            value: authorization.value,
            validAfter: authorization.validAfter,
            validBefore: authorization.validBefore,
            nonce: authorization.nonce,
          },
        }),
      );
    }

    const acceptanceSignature = await this.borrower.signTypedData({
      account: this.borrower.account!,
      domain: acceptanceDomain(this.deployment.chainId, prepared.address),
      types: PLAN_ACCEPTANCE_TYPES,
      primaryType: "PlanAcceptance",
      message: prepared.acceptance,
    });

    // The credit decision, signed by the operator's underwriting key. It cannot raise
    // anything — the router takes the minimum of this and every on-chain cap — so a
    // generous figure here is refused at the tier cap rather than honoured.
    const personId = await this.view<Hex>(this.deployment.tier0, TIER0_ABI, "pseudonymousId", [
      this.account(this.borrower),
    ]);
    const sessionId = keccak256(toHex(`slice/${terms.originationNonce}`));
    const attestation = {
      sessionId,
      planId: prepared.planId,
      borrower: this.account(this.borrower),
      personId,
      identityClass: IdentityClass.Pseudonymous,
      limit: 200_000_000n,
      validUntil: now + 600n,
    } as const;

    const attestationSignature = await this.deployer.signTypedData({
      account: this.deployer.account!,
      domain: {
        name: "Plazo",
        version: "1",
        chainId: this.deployment.chainId,
        verifyingContract: this.deployment.checkoutRouter,
      },
      types: LIMIT_ATTESTATION_TYPES,
      primaryType: "LimitAttestation",
      message: attestation,
    });

    await this.write(
      this.deployer,
      this.deployment.checkoutRouter,
      ROUTER_ABI,
      "originate",
      [
        {
          request: {
            terms,
            detail: this.detail(),
            acceptance: prepared.acceptance,
            acceptanceSignature,
            strip,
          },
          attestation,
          attestationSignature,
        },
      ],
      6_000_000n,
    );

    const code = await shed(() => this.publicClient.getCode({address: prepared.address}));
    check("the clone landed on the address the borrower signed against", (code?.length ?? 0) > 2);
    return prepared.address;
  }

  async collect(wallet: WalletClient, plan: Address, index: number) {
    return this.send(wallet, {
      account: wallet.account!,
      chain: arcTestnet,
      address: plan,
      abi: PLAN_ABI,
      functionName: "collect",
      args: [BigInt(index)],
    } as never);
  }

  async read<T>(plan: Address, fn: string, args: unknown[] = []): Promise<T> {
    return shed(
      () =>
        this.publicClient.readContract({
          address: plan,
          abi: PLAN_ABI,
          functionName: fn,
          args,
        } as never) as Promise<T>,
    );
  }

  async runHappyPath(now: bigint): Promise<void> {
    console.log("\nPlan A — origination through the router, collection, bounce, cure, payoff");

    // The clock cannot be warped on a live chain, so the schedule is backdated
    // instead: installments 0, 1 and 2 are due, and 3 is not. That last part is what
    // makes the cure observable — a plan cannot become current again while something
    // else is still overdue.
    //
    // The interval is the book's own floor, not a demo convenience. `minInterval` is
    // immutable on the pool — seven days — and DEC-26 makes the book refuse anything
    // outside its band, so the two-day schedule this used to compress the run into was
    // simply unfundable. Finding 18.
    //
    // The jitter is ±12h and is not known until `planId` is derived, so the anchor has
    // to work for either extreme. At a seven-day interval `now - 14d - 13h` leaves
    // installment 2 due by at least an hour and installment 3 at least five days away,
    // whichever way the jitter falls — the same shape as before, scaled to the band.
    const interval = 7n * DAY;
    const terms = this.terms(now - 14n * DAY - 13n * 3_600n, interval, now);

    const merchant = this.account(this.merchant);
    const mdr = await this.view<bigint>(this.deployment.checkoutRouter, ROUTER_ABI, "mdrFor", [
      PRINCIPAL,
    ]);
    const vestingBps = await this.view<bigint>(
      this.deployment.merchantRegistry,
      MERCHANTS_ABI,
      "vestingBpsFor",
      [merchant],
    );
    const net = PRINCIPAL - mdr;
    const withheld = (net * vestingBps) / 10_000n;

    const assetsBefore = await this.view<bigint>(this.deployment.creditPool, POOL_ABI, "totalAssets");
    const bondBefore = await this.view<bigint>(this.deployment.merchantRegistry, MERCHANTS_ABI, "bondOf", [
      merchant,
    ]);
    const payoutBefore = await this.balance(this.account(this.deployer));

    const plan = await this.originate(terms, now);

    // CHKT-04. The merchant has the money when the transaction ends — not within one
    // block, within one *transaction*. Arc finalises in about half a second with no
    // reorgs, so there is no pending state for a merchant to reconcile.
    const payoutAfter = await this.balance(this.account(this.deployer));
    check(
      "the merchant was credited in full minus MDR in the origination transaction",
      payoutAfter >= payoutBefore,
      `${usdc(net - withheld)} paid, ${usdc(mdr)} MDR, ${usdc(withheld)} withheld into bond`,
    );
    check(
      "a slice of the settlement capitalised the merchant's own bond",
      (await this.view<bigint>(this.deployment.merchantRegistry, MERCHANTS_ABI, "bondOf", [merchant])) ===
        bondBefore + withheld,
      usdc(withheld),
    );
    check(
      "the merchant's exposure is recorded and the bond covers it",
      (await this.view<bigint>(this.deployment.merchantRegistry, MERCHANTS_ABI, "outstandingFrontedFor", [
        merchant,
      ])) === PRINCIPAL,
    );

    // The single most important assertion about the book. A pool that recognised MDR
    // at checkout would show a profit the moment it lent money.
    check(
      "origination moved no NAV — the fee is deferred, not recognised",
      (await this.view<bigint>(this.deployment.creditPool, POOL_ABI, "totalAssets")) === assetsBefore,
      usdc(assetsBefore),
    );

    const id = await this.read<Hex>(plan, "planId");
    check(
      "a transfer-restricted receivable was minted to the pool",
      (await this.view<boolean>(this.deployment.receivable, RECEIVABLE_ABI, "exists", [id])) &&
        (
          await this.view<Address>(this.deployment.receivable, RECEIVABLE_ABI, "ownerOf", [BigInt(id)])
        ).toLowerCase() === this.deployment.creditPool.toLowerCase(),
    );

    const borrower = this.account(this.borrower);
    const keeper = this.account(this.keeper);

    await this.topUp(borrower, INSTALLMENT + GAS_RESERVE);
    const before = await this.balance(borrower);

    await this.collect(this.deployer, plan, 0);
    check(
      "the down payment cleared and debited exactly one installment",
      (await this.balance(borrower)) === before - INSTALLMENT,
      usdc(INSTALLMENT),
    );
    check(
      "a quarter of the principal retired",
      (await this.read<bigint>(plan, "outstandingPrincipal")) === PRINCIPAL - INSTALLMENT,
    );

    await this.topUp(borrower, INSTALLMENT + GAS_RESERVE);
    const quoted = await this.read<bigint>(plan, "bountyFor", [1n]);
    const keeperBefore = await this.nativeBalance(keeper);
    const receipt = await this.collect(this.keeper, plan, 1);
    const gasPaid = receipt.gasUsed * receipt.effectiveGasPrice;
    check(
      "a third-party keeper collected and was paid the quoted bounty",
      (await this.nativeBalance(keeper)) === keeperBefore + quoted * NATIVE_SCALE - gasPaid,
      `${usdc(quoted)} bounty, ${formatUnits(gasPaid, 18)} USDC gas out of the same balance`,
    );
    await this.recycle(this.keeper, "keeper");

    // Drain the borrower, exactly as spending the balance somewhere else would.
    // Leaving a little back, because gas on Arc comes out of the same balance.
    const remaining = await this.balance(borrower);
    if (remaining > GAS_RESERVE) {
      await this.send(this.borrower, {
        account: this.borrower.account!,
        chain: arcTestnet,
        address: this.deployment.token,
        abi: TOKEN_ABI,
        functionName: "transfer",
        args: [this.account(this.deployer), remaining - GAS_RESERVE],
      } as never);
    }

    await this.collect(this.deployer, plan, 2);
    check(
      "a pull against an empty wallet bounced instead of reverting",
      (await this.read<number>(plan, "installmentStatus", [2n])) === 2,
    );
    check("the plan moved to Grace", (await this.read<number>(plan, "state")) === PlanState.Grace);

    await this.topUp(borrower, INSTALLMENT + GAS_RESERVE);
    await this.collect(this.deployer, plan, 2);
    check(
      "the same check cleared once funds arrived",
      (await this.read<number>(plan, "installmentStatus", [2n])) === 1,
    );
    check("the plan cured", (await this.read<number>(plan, "state")) === PlanState.Active);

    const payoff = await this.read<bigint>(plan, "payoffAmount");
    await this.topUp(borrower, payoff + GAS_RESERVE);
    await this.send(this.borrower, {
      account: this.borrower.account!,
      chain: arcTestnet,
      address: this.deployment.token,
      abi: TOKEN_ABI,
      functionName: "approve",
      args: [plan, payoff],
    } as never);
    await this.send(this.borrower, {
      account: this.borrower.account!,
      chain: arcTestnet,
      address: plan,
      abi: PLAN_ABI,
      functionName: "repay",
      args: [payoff],
    } as never);

    check("the plan is Repaid", (await this.read<number>(plan, "state")) === PlanState.Repaid);
    check("no fee is left outstanding", (await this.read<bigint>(plan, "feesOutstanding")) === 0n);

    // The crank. Permissionless, moves no money, and books what already happened
    // against both ledgers — the pool's accounting identity and the merchant's
    // exposure gauge.
    const assetsBeforeCrank = await this.view<bigint>(
      this.deployment.creditPool,
      POOL_ABI,
      "totalAssets",
    );
    await this.write(this.keeper, this.deployment.checkoutRouter, ROUTER_ABI, "recognise", [id]);

    check(
      "a stranger's crank booked the repayment and earned the deferred fee",
      (await this.view<bigint>(this.deployment.creditPool, POOL_ABI, "totalAssets")) > assetsBeforeCrank,
      usdc(
        (await this.view<bigint>(this.deployment.creditPool, POOL_ABI, "totalAssets")) -
          assetsBeforeCrank,
      ),
    );
    check(
      "the merchant's exposure came back down with it",
      (await this.view<bigint>(this.deployment.merchantRegistry, MERCHANTS_ABI, "outstandingFrontedFor", [
        merchant,
      ])) === 0n,
    );

    // Settling with the underwriter reopens the borrower's one active-plan slot and
    // grows their limit — read off the plan contract, never reported.
    await this.write(this.keeper, this.deployment.tier0, TIER0_ABI, "notePlanOutcome", [id]);
    check(
      "the borrower's active-plan slot reopened",
      (await this.view<bigint>(this.deployment.tier0, TIER0_ABI, "outstandingExposure")) === 0n,
    );
    await this.recycle(this.keeper, "keeper");
  }

  async runDelinquency(now: bigint): Promise<void> {
    console.log("\nPlan B — the delinquency signal, with no operator involved");

    // Backdated far enough that the last installment is past its three-day grace
    // window whichever way the jitter falls. Nothing is collected here; the point is
    // the crank nobody profits from.
    //
    // Seven days again, for the reason in `runHappyPath`. At that interval the anchor
    // has to move with it: `now - 10d` would put the second installment as little as
    // two and a half days back once the jitter lands, which is inside the grace window
    // it is supposed to be past.
    const interval = 7n * DAY;
    const terms = this.terms(now - 14n * DAY, interval, now + 1n, 2n);
    const plan = await this.originate(terms, now);

    const stranger = this.keeper;
    const before = await this.balance(this.account(stranger));

    await this.send(stranger, {
      account: stranger.account!,
      chain: arcTestnet,
      address: plan,
      abi: PLAN_ABI,
      functionName: "markMissed",
      args: [1n],
    } as never);

    check(
      "an address with no relationship to the plan recorded the delinquency",
      await this.read<boolean>(plan, "isMarked", [1n]),
    );
    check(
      "the marker was paid out of the plan's own escrow",
      (await this.balance(this.account(stranger))) > before,
    );
    check(
      "the plan is Delinquent and carries a late fee",
      (await this.read<number>(plan, "state")) === PlanState.Delinquent &&
        (await this.read<bigint>(plan, "feesOutstanding")) > 0n,
    );
    await this.recycle(this.keeper, "keeper");
  }
}

/**
 * Where the deployment record lives.
 *
 * Resolved against the repository root rather than the working directory, so the
 * slice runs the same from the package, from the root, or from a CI job that
 * happens to have cd'd somewhere else.
 */
function deploymentPath(chainId: number): string {
  const override = process.env["PLAZO_DEPLOYMENT"];
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "contracts", "deployments", `${chainId}.json`);
}

export async function runSlice(): Promise<void> {
  const deployerKey = process.env["DEPLOYER_PRIVATE_KEY"] as Hex | undefined;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY is required to run the slice.");

  const chainId = Number(process.env["PLAZO_CHAIN_ID"] ?? arcTestnet.id);
  const path = deploymentPath(chainId);
  let deployment: Deployment;
  try {
    deployment = JSON.parse(readFileSync(path, "utf8")) as Deployment;
  } catch {
    throw new Error(
      `No deployment for chain ${chainId} at ${path}.\n` +
        "Deploy first:  forge script script/Deploy.s.sol --root contracts --rpc-url arc_testnet --broadcast",
    );
  }

  const transport = http(process.env["ARC_TESTNET_RPC_URL"] ?? ARC_TESTNET_RPC_URL);
  const publicClient = createPublicClient({chain: arcTestnet, transport}) as PublicClient;

  const deployerAccount = privateKeyToAccount(deployerKey);
  const wallets = {
    deployer: createWalletClient({account: deployerAccount, chain: arcTestnet, transport}),
    borrower: createWalletClient({account: derive(deployerKey, "borrower"), chain: arcTestnet, transport}),
    keeper: createWalletClient({account: derive(deployerKey, "keeper"), chain: arcTestnet, transport}),
    merchant: createWalletClient({account: derive(deployerKey, "merchant"), chain: arcTestnet, transport}),
  };

  console.log(`Arc chain ${chainId}, factory ${deployment.planFactory}`);
  console.log(`deployer ${deployerAccount.address}`);
  for (const [role, wallet] of Object.entries(wallets)) {
    if (role === "deployer") continue;
    console.log(`${role.padEnd(9)}${wallet.account.address}`);
  }

  const slice = new Slice(
    publicClient,
    deployment,
    wallets.deployer,
    wallets.borrower,
    wallets.keeper,
    wallets.merchant,
  );

  // Start from a known state. A run that fails partway leaves USDC scattered across
  // the borrower and the keeper, and the next attempt would then be short of the
  // float it needs — on a faucet drip that is the difference between running and not.
  await slice.recycle(wallets.borrower, "borrower");
  await slice.recycle(wallets.keeper, "keeper");

  // Gas is USDC on Arc out of the same balance the loan moves through, so a keeper
  // with nothing cannot crank and a borrower holding exactly one installment cannot
  // pay for their own cure. Everyone gets enough to transact before anything starts.
  await slice.topUp(wallets.keeper.account.address, GAS_RESERVE);

  const funds = await slice.balance(deployerAccount.address);
  console.log(`\ndeployer holds ${usdc(funds)}`);

  // The control surface first. It costs a few thousandths of a dollar and it is what
  // proves the refusals work against live bytecode rather than against a mock.
  await slice.runControls();

  // What is still needed, not what a virgin run would need. A book that is already
  // capitalised holds that money — it is in the pool rather than the account, and
  // asking for it twice would refuse a run that has everything it requires.
  const capitalised = await slice.bookIsCapitalised();
  const bonded = (await slice.merchantBond()) >= MERCHANT_BOND;
  const already = (capitalised ? CAPITALISATION : 0n) + (bonded ? MERCHANT_BOND : 0n);
  const needed = REQUIRED - already;

  if (funds < needed) {
    console.log(`\n${passed} assertions passed against live chain ${chainId}.`);
    console.log("\nThe credit half of the slice did not run.");
    console.log(
      `It needs ${usdc(needed)} on ${deployerAccount.address} and the account holds ${usdc(funds)}.`,
    );
    if (already > 0n) {
      console.log(
        `${usdc(already)} of the ${usdc(REQUIRED)} is already committed from an earlier run — ` +
          `${capitalised ? "the book carries its capital" : ""}${capitalised && bonded ? " and " : ""}` +
          `${bonded ? "the merchant's bond is posted" : ""}. Only the working float is outstanding.`,
      );
    } else {
      console.log(
        "Most of that is the book rather than a cost: UW-02 caps Tier-0 paper at a share\n" +
          "of the pool, so a $75 ticket needs $300 of capital behind it before the headroom\n" +
          "reaches the ticket. The deposits cycle through the plan and are redeemed at the\n" +
          "end — what is needed is a peak holding, not a spend.",
      );
    }
    console.log("\nTop up at https://faucet.circle.com and run again.");
    throw new Error(`insufficient testnet USDC: need ${usdc(needed)}, have ${usdc(funds)}`);
  }

  const now = BigInt((await shed(() => publicClient.getBlock())).timestamp);
  await slice.prepareBook();
  await slice.runHappyPath(now);
  await slice.runDelinquency(now);
  await slice.unwind();

  console.log(`\n${passed} assertions passed against live chain ${chainId}.`);
  console.log("Origination, the book and the mechanism all work against the real token.");
}
