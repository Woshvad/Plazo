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

  async balance(who: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.deployment.token,
      abi: TOKEN_ABI,
      functionName: "balanceOf",
      args: [who],
    });
  }

  private async send(wallet: WalletClient, request: Parameters<WalletClient["writeContract"]>[0]) {
    const hash = await wallet.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({hash});
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

  detail(): TermsDetail {
    return {
      jurisdiction: keccak256(toHex("PLAZO.DEFAULT")),
      lineItemsHash: keccak256(toHex("slice basket")),
      mdrBps: 450n,
      lateFeeFlat: 7_000_000n,
      signerClass: SignerClass.EOA,
      settlementRecipient: this.account(this.merchant),
      fxRouter: this.deployment.fxRouter,
    };
  }

  terms(firstDueDate: bigint, interval: bigint, nonce: bigint): PlanTerms {
    const detail = this.detail();
    return {
      chainId: BigInt(this.deployment.chainId),
      factory: this.deployment.planFactory,
      implementation: this.deployment.installmentPlan,
      borrower: this.account(this.borrower),
      merchant: this.account(this.merchant),
      token: this.deployment.token,
      principal: 100_000_000n,
      installmentCount: 4n,
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

    const onchain = await this.publicClient.readContract({
      address: this.deployment.planFactory,
      abi: FACTORY_ABI,
      functionName: "predictAddress",
      args: [prepared.planId],
    });
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

    await this.send(this.deployer, {
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
    } as never);

    const code = await this.publicClient.getCode({address: prepared.address});
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
    return this.publicClient.readContract({
      address: plan,
      abi: PLAN_ABI,
      functionName: fn,
      args,
    } as never) as Promise<T>;
  }

  async runHappyPath(now: bigint): Promise<void> {
    console.log("\nPlan A — origination, third-party collection, bounce, cure, payoff");

    // Installments 0, 1 and 2 are already past their grace windows; 3 is ten days
    // out. The clock cannot be warped on a live chain, so the schedule is backdated
    // instead — which is also what lets the cure be observed, because a plan cannot
    // become current again while something else is still overdue.
    const interval = 14n * 86_400n;
    const terms = this.terms(now - 32n * 86_400n, interval, now);
    const plan = await this.originate(terms, now);

    const borrower = this.account(this.borrower);
    const keeper = this.account(this.keeper);
    const before = await this.balance(borrower);

    await this.collect(this.deployer, plan, 0);
    check(
      "the down payment cleared and debited exactly one installment",
      (await this.balance(borrower)) === before - 25_000_000n,
    );
    check(
      "a quarter of the principal retired",
      (await this.read<bigint>(plan, "outstandingPrincipal")) === 75_000_000n,
    );

    const quoted = await this.read<bigint>(plan, "bountyFor", [1n]);
    const keeperBefore = await this.balance(keeper);
    await this.collect(this.keeper, plan, 1);
    check(
      "a third-party keeper collected and was paid the quoted bounty",
      (await this.balance(keeper)) === keeperBefore + quoted,
      usdc(quoted),
    );

    // Drain the borrower, exactly as spending the balance somewhere else would.
    const remaining = await this.balance(borrower);
    await this.send(this.borrower, {
      account: this.borrower.account!,
      chain: arcTestnet,
      address: this.deployment.token,
      abi: TOKEN_ABI,
      functionName: "transfer",
      args: [this.account(this.deployer), remaining - 1_000_000n],
    } as never);

    await this.collect(this.keeper, plan, 2);
    check(
      "a pull against an empty wallet bounced instead of reverting",
      (await this.read<number>(plan, "installmentStatus", [2n])) === 2,
    );
    check("the plan moved to Grace", (await this.read<number>(plan, "state")) === PlanState.Grace);

    await this.fund(borrower, 60_000_000n);
    await this.collect(this.keeper, plan, 2);
    check("the same check cleared once funds arrived", (await this.read<number>(plan, "installmentStatus", [2n])) === 1);
    check("the plan cured", (await this.read<number>(plan, "state")) === PlanState.Active);

    const payoff = await this.read<bigint>(plan, "payoffAmount");
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

    // Everything past grace, so the mark is reachable inside one run.
    const interval = 14n * 86_400n;
    const terms = this.terms(now - 46n * 86_400n, interval, now + 1n);
    const plan = await this.originate(terms, now);

    const stranger = this.keeper;
    const before = await this.balance(this.account(stranger));

    await this.send(stranger, {
      account: stranger.account!,
      chain: arcTestnet,
      address: plan,
      abi: PLAN_ABI,
      functionName: "markMissed",
      args: [3n],
    } as never);

    check("an address with no relationship to the plan recorded the delinquency", await this.read<boolean>(plan, "isMarked", [3n]));
    check(
      "the marker was paid out of the plan's own escrow",
      (await this.balance(this.account(stranger))) > before,
    );
    check(
      "the plan is Delinquent and carries a late fee",
      (await this.read<number>(plan, "state")) === PlanState.Delinquent &&
        (await this.read<bigint>(plan, "feesOutstanding")) > 0n,
    );
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

  const funds = await slice.balance(deployerAccount.address);
  console.log(`\ndeployer holds ${usdc(funds)}`);
  if (funds < 400_000_000n) {
    throw new Error(
      `The slice needs at least 400 USDC on ${deployerAccount.address}. ` +
        "Fund it at https://faucet.circle.com and run again.",
    );
  }

  // Gas is USDC on Arc, so a keeper with no balance cannot crank and a borrower with
  // exactly one installment cannot cure. Everyone gets a working balance first.
  await slice.fund(wallets.borrower.account.address, 150_000_000n);
  await slice.fund(wallets.keeper.account.address, 20_000_000n);

  const now = BigInt((await publicClient.getBlock()).timestamp);
  await slice.runHappyPath(now);
  await slice.runDelinquency(now);

  console.log(`\n${passed} assertions passed against live chain ${chainId}.`);
  console.log("The mechanism works against the real token, not only against the mock.");
}
