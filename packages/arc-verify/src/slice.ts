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
  fxRouter: Address;
  installmentPlan: Address;
  planFactory: Address;
}

let passed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`FAILED: ${label}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`  ok  ${label}${detail ? ` (${detail})` : ""}`);
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
      mdrBps: 450n,
      lateFeeFlat: 7_000_000n,
      signerClass: SignerClass.EOA,
      // The funding account, so collected installments come back and can fund the
      // next one. See `topUp`.
      settlementRecipient: this.account(this.deployer),
      fxRouter: this.deployment.fxRouter,
    };
  }

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

    const escrow = markEscrowFor(terms.installmentCount);
    await this.send(this.deployer, {
      account: this.deployer.account!,
      chain: arcTestnet,
      address: this.deployment.token,
      abi: TOKEN_ABI,
      functionName: "approve",
      args: [this.deployment.planFactory, escrow],
    } as never);

    await this.send(
      this.deployer,
      {
        account: this.deployer.account!,
        chain: arcTestnet,
        address: this.deployment.planFactory,
        abi: FACTORY_ABI,
        functionName: "originate",
      args: [
        {
          terms,
          detail: {...this.detail(), signerClass: this.detail().signerClass},
          acceptance: prepared.acceptance,
          acceptanceSignature,
          strip,
        },
      ],
      } as never,
      4_000_000n,
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
    console.log("\nPlan A — origination, third-party collection, bounce, cure, payoff");

    // The clock cannot be warped on a live chain, so the schedule is backdated
    // instead: installments 0, 1 and 2 are due, and 3 is not. That last part is what
    // makes the cure observable — a plan cannot become current again while something
    // else is still overdue.
    //
    // The jitter is ±12h and is not known until `planId` is derived, so the anchor
    // has to work for either extreme. With a two-day interval, `now - 4d - 13h`
    // leaves installment 2 due by at least an hour and installment 3 at least eleven
    // hours away, whichever way the jitter falls.
    const interval = 2n * DAY;
    const terms = this.terms(now - 4n * DAY - 13n * 3_600n, interval, now);
    const plan = await this.originate(terms, now);

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
  }

  async runDelinquency(now: bigint): Promise<void> {
    console.log("\nPlan B — the delinquency signal, with no operator involved");

    // Backdated far enough that the last installment is past its three-day grace
    // window whichever way the jitter falls. Nothing is collected here; the point is
    // the crank nobody profits from.
    const interval = 2n * DAY;
    const terms = this.terms(now - 10n * DAY, interval, now + 1n, 2n);
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

  // Two plans at the $75 minimum, an installment of working float, two mark escrows
  // and gas for four accounts. The float recycles — the settlement recipient is the
  // funding account — so this is a peak requirement rather than a total spend.
  const REQUIRED = INSTALLMENT + markEscrowFor(4n) + 2n * GAS_RESERVE;

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
  if (funds < REQUIRED) {
    throw new Error(
      `The slice needs at least ${usdc(REQUIRED)} on ${deployerAccount.address}. ` +
        "Fund it at https://faucet.circle.com and run again.",
    );
  }

  const now = BigInt((await shed(() => publicClient.getBlock())).timestamp);
  await slice.runHappyPath(now);
  await slice.runDelinquency(now);

  console.log(`\n${passed} assertions passed against live chain ${chainId}.`);
  console.log("The mechanism works against the real token, not only against the mock.");
}
