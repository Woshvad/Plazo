/**
 * The GOV-08 live witness, and the funding precondition that decides whether it runs.
 *
 * **This is not GOV-08's gate.** `forge test --root contracts --mt test_operatorFreeLoop`
 * is. That test drives the twelve rows against `OperatorFreeFixture` — ten Class-B
 * roles revoked, `DEFAULT_ADMIN_ROLE` gone from fourteen contracts, three `Ownable`s
 * renounced — and row 12, the negative control, asserts that origination reverts,
 * which is the row that makes the other eleven mean anything. It is green and it is
 * the evidence of record. What lives here is a best-effort extra: the same sequence
 * against real Arc USDC, on a deployment built to be thrown away.
 *
 * ---
 *
 * **D-25 is the reason this file exists as a separate script rather than as a slice
 * phase.** Renouncing `EligibilityRegistry` ownership permanently freezes the
 * eligible-holder set: no lender can ever be accredited again, `TrancheToken._update`
 * refuses every future mint under DEC-01's Reg D restrictions, and there is no path
 * back. That is finding 16 — a book nobody on earth may deposit into — made permanent
 * instead of fixable, on a pool holding real tranche positions.
 *
 * So the witness deploys its own stack and this script is **structurally incapable** of
 * renouncing on the shared one, in two independent ways:
 *
 *   1. Every renounce target comes from the `Stack` this process deployed, never from
 *      a record, a constant or an environment variable. There is no code path by which
 *      a shared address can reach `renounceOwnership`.
 *   2. `assertThrowaway` reads `contracts/deployments/<chainId>.json` and refuses, by
 *      throwing, if the address about to be renounced appears anywhere in it. Belt on
 *      top of braces, because (1) is a property of the code as written and (2) is a
 *      property that survives the code being edited.
 *
 * The second one is exported and demonstrated firing rather than asserted to exist.
 * A guard nobody has watched refuse is a guard nobody has tested.
 *
 * ---
 *
 * **Widening the Tier-0 band so a live run fits the deployer's balance is forbidden.**
 * UW-02 caps Tier-0 paper at a share of the book and the compiled band's ceiling is
 * 25%, so the protocol's own minimum ticket needs four times its value in pool capital
 * behind it (finding 13). That is why this run is expensive, and the expense is the
 * control working. DEC-02 put Tier 0 on pool capital from day one against a research
 * recommendation for a shadow book, with the risk accepted knowingly, and the cap is
 * one of the two things standing between an unproven scorecard and the senior tranche.
 *
 * Making a parameter smaller so a sentence becomes true is the failure mode this
 * project has already named and written down, and it would additionally corrupt the
 * bond worked example below, which reads the same registry. If a future reader is
 * here because the funding gap is annoying: the answer is the faucet, not the band.
 */
import {
  createPublicClient,
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

import {ARC_TESTNET_RPC_URL} from "@plazo/plan-core";

import {loadDeployment, REQUIRED, shed} from "./slice.js";

/**
 * What Circle's faucet hands one address, measured across the twenty drips that funded
 * the first credit run. Used only to turn a shortfall into a number of visits, which
 * is the unit the gap is actually paid in.
 */
const FAUCET_DRIP = 20_000_000n;

const REGISTRY_ABI = parseAbi([
  "function get(bytes32 key) view returns (uint256)",
  "function isDefined(bytes32 key) view returns (bool)",
]);

/** `ParameterRegistry` keys. Dotted names, hashed — see `ParameterKeys.sol`. */
const key = (name: string): Hex => keccak256(toHex(name));

function usdc(value: bigint): string {
  return `${formatUnits(value, 6)} USDC`;
}

function bps(value: bigint): string {
  return `${value} bp (${Number(value) / 100}%)`;
}

/**
 * Refuse to renounce anything the shared deployment names.
 *
 * Exported because it is demonstrated firing, not merely asserted to exist. Pointing
 * it at the live `EligibilityRegistry` and watching it throw is the whole test, and it
 * needs no capital — which is why it is the one D-25 control that lands on either
 * funding branch.
 *
 * The message names the address, the key it matched and what the call would have cost,
 * because a guard that says only "refused" teaches the next reader to disable it.
 */
export function assertThrowaway(label: string, address: Address, chainId: number): void {
  let record: Record<string, unknown>;
  try {
    record = loadDeployment(chainId) as unknown as Record<string, unknown>;
  } catch {
    // No record means no shared book on this chain, so there is nothing to protect.
    // Failing open here is correct and failing closed would make the witness
    // unrunnable on a fresh chain, which is the one place it is unambiguously safe.
    return;
  }

  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== "string") continue;
    if (value.toLowerCase() !== address.toLowerCase()) continue;

    throw new Error(
      `REFUSED: ${label} would renounce ${address}, which is \`${name}\` in the shared ` +
        `deployment record for chain ${chainId}.\n\n` +
        "D-25. The GOV-08 witness renounces ownership irreversibly, and the live book\n" +
        "holds real tranche positions. Renouncing `EligibilityRegistry` there freezes the\n" +
        "eligible-holder set for good: no lender can ever be accredited again,\n" +
        "`TrancheToken._update` refuses every future mint under DEC-01's Reg D\n" +
        "restrictions, and there is no path back — finding 16 made permanent instead of\n" +
        "fixable.\n\n" +
        "The witness deploys its own throwaway stack. If this fired, something is passing\n" +
        "it a shared address, and the fix is to stop doing that rather than to widen this\n" +
        "check.",
    );
  }
}

/**
 * How the merchant bond stands against one velocity-cap window of fronted exposure.
 *
 * Every input is read from the live `ParameterRegistry` and quoted, because a worked
 * example whose inputs are typed in from a table is an example of the table. Nothing
 * here writes: the registry is read before and after and the two reads are compared,
 * so "no parameter was moved to make the sentence read better" is a check rather than
 * a promise.
 */
export interface BondExample {
  bondBps: bigint;
  bondFloor: bigint;
  vestingBps: bigint;
  vestingWindow: bigint;
  velocityCap: bigint;
  velocityWindow: bigint;
  mdrBps: bigint;
  /** Principal a day-one merchant can front inside one velocity window. */
  fronted: bigint;
  /** What the pool actually paid out: principal less MDR. */
  paidOut: bigint;
  /** Bond the merchant must hold once that exposure is on the book. */
  requiredBond: bigint;
  /** Bond capitalised out of the merchant's own settlements (DEC-09). */
  withheld: bigint;
  /** The merchant's own capital at risk: what withholding did not cover. */
  ownCapital: bigint;
  /** The borrower's first installment, cleared at checkout. */
  downPayment: bigint;
  /** Pool loss if the confederate pays the down payment and nothing else. */
  realisticLoss: bigint;
  /** Pool loss if nothing at all comes back. */
  worstLoss: bigint;
  covers: boolean;
}

export async function readBondExample(
  publicClient: PublicClient,
  parameters: Address,
): Promise<BondExample> {
  const get = (name: string) =>
    shed(() =>
      publicClient.readContract({
        address: parameters,
        abi: REGISTRY_ABI,
        functionName: "get",
        args: [key(name)],
      }),
    ) as Promise<bigint>;

  const bondBps = await get("plazo.merchant.bondBps");
  const bondFloor = await get("plazo.merchant.bondFloor");
  const vestingBps = await get("plazo.merchant.vestingBps");
  const vestingWindow = await get("plazo.merchant.vestingWindow");
  const velocityCap = await get("plazo.merchant.velocityCap");
  const velocityWindow = await get("plazo.merchant.velocityWindow");
  const mdrBps = await get("plazo.origination.mdrBps");

  const BPS = 10_000n;

  // One full window of a day-one merchant's allowance. `noteOrigination` refuses the
  // origination that would cross the cap, so this is the ceiling rather than an
  // estimate — and none of it is recovered inside the window, because
  // `TranchedCreditPool`'s `minInterval` is an immutable seven days and the first
  // installment after checkout cannot fall sooner.
  const fronted = velocityCap;
  const paidOut = fronted - (fronted * mdrBps) / BPS;

  // The bond is enforced at origination against the exposure standing at that moment,
  // so at the end of the window it is exactly this. `bondFloor` is the entry cost and
  // reads zero on this deployment, which is a setting inside its band rather than a
  // widening of one — the exposure-scaled term is what is being exercised.
  const scaled = (fronted * bondBps) / BPS;
  const requiredBond = scaled > bondFloor ? scaled : bondFloor;

  // DEC-09. A slice of each settlement capitalises the bond as the merchant trades, so
  // the requirement is satisfiable by the business being done rather than only by
  // capital locked up in advance. `postWithheld` runs before `noteOrigination` in
  // `_settleMerchant`, so the current settlement's withholding counts toward the
  // requirement the current settlement creates.
  const withheld = (paidOut * vestingBps) / BPS;
  const ownCapital = requiredBond > withheld ? requiredBond - withheld : 0n;

  // Pay-in-4. Check #1 clears at checkout, so a confederate who pays nothing further
  // still leaves the down payment behind.
  const downPayment = fronted / 4n;
  const realisticLoss = paidOut - downPayment;
  const worstLoss = paidOut;

  return {
    bondBps,
    bondFloor,
    vestingBps,
    vestingWindow,
    velocityCap,
    velocityWindow,
    mdrBps,
    fronted,
    paidOut,
    requiredBond,
    withheld,
    ownCapital,
    downPayment,
    realisticLoss,
    worstLoss,
    covers: requiredBond >= realisticLoss,
  };
}

function printBondExample(e: BondExample): void {
  const pct = (part: bigint, whole: bigint) =>
    `${((Number(part) / Number(whole)) * 100).toFixed(1)}%`;

  console.log("\nThe refund-arbitrage bond, as arithmetic");
  console.log("  read live from the ParameterRegistry, and quoted:");
  console.log(`    MERCHANT_BOND_BPS         ${bps(e.bondBps)}`);
  console.log(`    MERCHANT_BOND_FLOOR       ${usdc(e.bondFloor)}`);
  console.log(`    MERCHANT_VESTING_BPS      ${bps(e.vestingBps)}`);
  console.log(`    MERCHANT_VESTING_WINDOW   ${Number(e.vestingWindow) / 86_400} days`);
  console.log(`    MERCHANT_VELOCITY_CAP     ${usdc(e.velocityCap)}`);
  console.log(`    MERCHANT_VELOCITY_WINDOW  ${Number(e.velocityWindow) / 3_600} hours`);
  console.log(`    MDR_BPS                   ${bps(e.mdrBps)}`);
  console.log("");
  console.log(`  one velocity-cap window of fronted principal   ${usdc(e.fronted)}`);
  console.log(`  the pool actually pays out (less MDR)          ${usdc(e.paidOut)}`);
  console.log(`  bond the merchant must hold against it         ${usdc(e.requiredBond)}`);
  console.log(`    of which withheld from their own settlements ${usdc(e.withheld)}`);
  console.log(`    of which their own capital                   ${usdc(e.ownCapital)}`);
  console.log(`  the confederate's down payment (check #1)      ${usdc(e.downPayment)}`);
  console.log(`  pool loss — ships nothing, pays nothing more   ${usdc(e.realisticLoss)}`);
  console.log(`  pool loss — nothing comes back at all          ${usdc(e.worstLoss)}`);
  console.log("");
  console.log(
    `  The bond covers ${pct(e.requiredBond, e.realisticLoss)} of a realistic ` +
      `refund-arbitrage loss and ${pct(e.requiredBond, e.paidOut)} of what the pool fronted.`,
  );
  console.log(
    e.covers
      ? "  It covers one velocity-cap window of fronted exposure."
      : "  It does NOT cover one velocity-cap window of fronted exposure, and it is not\n" +
          "  designed to: the bond is priced as a share of exposure, so it can only ever be\n" +
          "  that share. What bounds this loss is the velocity cap itself and MERCH-04's\n" +
          "  escrow, not the bond.",
  );
}

/**
 * The throwaway deployment and the twelve rows.
 *
 * **Deliberately unwritten, and this is a stub declared as one.** The precondition
 * below has never been met on this chain, so every line of a deployment-and-loop
 * implementation here would be code that has never executed against Arc — and the
 * standing lesson from the funded slice runs is that un-run live code is where the
 * defects are: five failures found one at a time, then a preflight audit of the un-run
 * half that turned up eight more, one of which would have bricked the pool
 * permanently while reporting success.
 *
 * Writing four hundred lines of unverifiable deployment code so that a file looks
 * complete, and then having a funded operator run it blind, is the specific hazard
 * that audit exists to prevent. So this throws, and what it must do is written down
 * instead:
 *
 *   - Deploy the full `Deploy.s.sol` stack plus `Rewire.s.sol`'s six — its own
 *     `ParameterRegistry`, `EligibilityRegistry`, `TranchedCreditPool`, `PlanFactory`,
 *     `CheckoutRouter`, `PayoutRouter`, `RefundEscrow` and `SettlementEscrow`. Nothing
 *     shared. Contract creation moves no tokens, so `forge script` can do it (finding
 *     10 exempts creation); everything after it must run through viem.
 *   - Capitalise it, accredit the lender (finding 16 — the deployment accredits
 *     nobody, correctly), onboard and bond the merchant, and originate one plan.
 *   - Call `assertThrowaway` on each of the three `Ownable` addresses, then perform
 *     `OperatorFreeFixture._goOperatorFree`'s sequence: ten Class-B revocations,
 *     `DEFAULT_ADMIN_ROLE` off fourteen contracts, and the three renounces. Class A —
 *     every role held by a contract — is left alone; revoking it would prove the
 *     protocol stops working when taken apart, which nobody doubted.
 *   - Drive the twelve rows. Rows reproducible on a fresh throwaway stack use a
 *     counted assertion. Rows that depend on a timer a live chain cannot warp — the
 *     grace window, the epoch window, the escrow release timer — are reported and not
 *     counted. Row 8 asserts the lender's **balance** rose, not that a ticket existed
 *     (finding 27). **Row 12, the negative control, must be counted**: origination
 *     reverting with `UNDERWRITER_ROLE` and `KYB_ROLE` revoked is reproducible on
 *     every run, and its typed error is `ScreenStale` rather than
 *     `AttestationSignerUnauthorized`, because `originate()` screens before it
 *     authorises and `SCREEN_FRESHNESS` is seven days (DEC-45).
 *   - Anchor the schedule to the band rather than the reverse: `minInterval` is seven
 *     days and immutable (finding 18).
 */
function runTheLoop(): never {
  throw new Error(
    "The GOV-08 live loop is not implemented. It has never been fundable on this chain,\n" +
      "and shipping an un-run implementation of it is the hazard the preflight audit in\n" +
      "findings 20-27 exists to prevent. Its specification is in this function's docstring.\n" +
      "GOV-08's proof of record is `forge test --root contracts --mt test_operatorFreeLoop`.",
  );
}

export async function runGov08(): Promise<void> {
  if (process.env["PLAZO_GOV08"] !== "1") {
    console.log(
      "The GOV-08 live witness is opt-in. Set PLAZO_GOV08=1 to run it.\n\n" +
        "GOV-08 itself is proven by `forge test --root contracts --mt test_operatorFreeLoop`,\n" +
        "which is the gate. This is a best-effort live witness on a throwaway deployment.",
    );
    return;
  }

  const deployerKey = process.env["DEPLOYER_PRIVATE_KEY"] as Hex | undefined;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY is required to run the GOV-08 witness.");

  const chainId = Number(process.env["PLAZO_CHAIN_ID"] ?? arcTestnet.id);
  const transport = http(process.env["ARC_TESTNET_RPC_URL"] ?? ARC_TESTNET_RPC_URL);
  const publicClient = createPublicClient({chain: arcTestnet, transport}) as PublicClient;
  const deployer = privateKeyToAccount(deployerKey).address;

  const deployment = loadDeployment(chainId);

  // ── The precondition, first, and the branch it decides ─────────────────────
  //
  // Before anything is deployed. A run that capitalises half a book and then stops is
  // worse than one that refuses to start: the money is committed, the assertions did
  // not happen, and the next attempt inherits a deployment nobody can describe.
  const held = (await shed(() => publicClient.getBalance({address: deployer}))) / 1_000_000_000_000n;
  const needed = REQUIRED;
  const funded = held >= needed;

  console.log("GOV-08 live witness — chain", chainId);
  console.log(`  deployer          ${deployer}`);
  console.log(`  held              ${usdc(held)}`);
  console.log(`  peak requirement  ${usdc(needed)}`);
  console.log(`  branch            ${funded ? "FUNDED — the witness will run" : "UNFUNDED — deferred"}`);

  if (!funded) {
    const shortfall = needed - held;
    const visits = (shortfall + FAUCET_DRIP - 1n) / FAUCET_DRIP;

    console.log("");
    console.log(`  shortfall         ${usdc(shortfall)}`);
    console.log(`  faucet visits     ${visits} at ~${usdc(FAUCET_DRIP)} per address`);
    console.log("");
    console.log(
      "The witness needs a virgin book, and a virgin book is expensive by design: UW-02\n" +
        "caps Tier-0 paper at a share of the pool and the compiled band's ceiling is 25%,\n" +
        "so the protocol's own $75 minimum ticket needs $300 of capital behind it before\n" +
        "the headroom reaches it (finding 13). That is the control working.\n\n" +
        "Widening the Tier-0 band to make this fit is forbidden. DEC-02 put Tier 0 on pool\n" +
        "capital from day one on the understanding that the cap was real, and making a\n" +
        "parameter smaller so a sentence becomes true is the failure mode this project has\n" +
        "already named. Top up at https://faucet.circle.com.\n\n" +
        "This is a precondition that was not met, not a failure. GOV-08's proof of record\n" +
        "is `forge test --root contracts --mt test_operatorFreeLoop`, which is green, and\n" +
        "the live witness is a best-effort extra recorded as a manual verification in\n" +
        "06-VALIDATION.md.",
    );

    // The D-25 guard needs reads, not capital, so it lands on this branch too — and it
    // is demonstrated firing rather than asserted to exist. The live `EligibilityRegistry`
    // is the address whose renouncement would be unrecoverable, so it is the one worth
    // watching the guard refuse.
    console.log("\nThe D-25 renounce guard, demonstrated against the live book");
    try {
      assertThrowaway("EligibilityRegistry.renounceOwnership", deployment.eligibilityRegistry, chainId);
      throw new Error(
        "FAILED: the guard accepted the live EligibilityRegistry. That address is in the\n" +
          "deployment record and renouncing it would freeze every tranche holder for good.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("REFUSED:")) throw error;
      console.log(message.split("\n").map((line) => `  ${line}`).join("\n"));
    }

    // The worked example needs reads, not capital. It lands either way, and the same
    // registry it reads is the one a widened band would have corrupted.
    const before = await readBondExample(publicClient, deployment.parameterRegistry);
    printBondExample(before);

    const after = await readBondExample(publicClient, deployment.parameterRegistry);
    const moved = (Object.keys(before) as (keyof BondExample)[]).filter(
      (name) => before[name] !== after[name],
    );
    console.log(
      moved.length === 0
        ? "\n  Registry reads are identical before and after this run — no parameter moved."
        : `\n  PARAMETERS MOVED DURING THIS RUN: ${moved.join(", ")}`,
    );
    if (moved.length > 0) throw new Error("a ParameterRegistry value changed during the run");

    return;
  }

  console.log("\nThe D-25 renounce guard, before anything is deployed");
  assertThrowaway("EligibilityRegistry.renounceOwnership", deployment.eligibilityRegistry, chainId);

  const before = await readBondExample(publicClient, deployment.parameterRegistry);
  printBondExample(before);

  runTheLoop();
}
