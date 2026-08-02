/**
 * One real `depositForBurn` out of Arc, and what it actually did.
 *
 * Nobody had ever executed this call from Arc. The selector is in the deployed
 * `TokenMessengerV2` implementation and every view around it reads the way the
 * documentation says — but a selector in bytecode is a claim about what a
 * contract *could* do, not evidence that a burn clears, that Arc's native-USDC
 * precompile can be pulled by a third-party contract at all, or that Circle's
 * attestation service will index a domain-26 transaction. `PayoutRouter` is
 * designed around the answer, so the answer is measured before it is designed
 * around rather than after.
 *
 * It spends about one USDC of real testnet money, and it is a **one-shot control
 * on a persistent chain**. The burn cannot be un-fired; a second run burns
 * another dollar rather than re-observing the first. So the burn, the message and
 * the attestation report with `--` and are excluded from the pass count, while
 * the reproducible preconditions around them — the balance floor, the route, the
 * padding, the two Iris endpoint forms, the allowance — report `ok` and are what
 * a re-run is actually asserting. That distinction is finding 17's lesson and it
 * is the difference between a suite that keeps asking and one whose counter keeps
 * climbing while it has quietly stopped.
 *
 * The destination mint is deliberately **not** attempted. `destinationCaller` is
 * `bytes32(0)`, so anyone may complete `receiveMessage` on Base Sepolia — but
 * Plazo holds no gas token on any chain but Arc (D-12), and acquiring one to
 * close a loop the merchant closes for themselves would be building the thing the
 * decision says not to build. The message and the attestation are printed and
 * persisted; completing them is a documented manual verification.
 */
import {mkdirSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatUnits,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {arcTestnet} from "viem/chains";

import {
  ARC_CCTP_DOMAIN,
  ARC_MESSAGE_TRANSMITTER_V2,
  ARC_TESTNET_RPC_URL,
  ARC_TOKEN_MESSENGER_V2,
  ARC_USDC,
  CCTP_FINALITY_STANDARD,
  CCTP_MAX_FEE_FROM_ARC,
  IRIS_SANDBOX_BASE_URL,
  mintRecipient,
} from "@plazo/plan-core";

// `shed` and `pollIris` both live in `slice.ts` and are imported here rather than
// duplicated. Two retry wrappers is how one of them ends up with a subtly different
// pattern and starts swallowing a genuine revert; two Iris pollers is how one of them
// ends up branching on the status code and sitting on a dead URL for its whole
// timeout. The dependency runs one way — the spike reads the slice, never the reverse.
import {pollIris, shed, type IrisMessage} from "./slice.js";

const TOKEN_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

const MESSENGER_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "function remoteTokenMessengers(uint32 domain) view returns (bytes32)",
]);

const TRANSMITTER_ABI = parseAbi(["event MessageSent(bytes message)"]);

/**
 * Base Sepolia.
 *
 * Chosen because it is the destination a real merchant is most likely to name
 * first, it is a live CCTP v2 testnet domain with a non-zero
 * `remoteTokenMessengers` entry read from Arc, and it is not 26 — CCTP has no
 * self-domain route, so a spike against Arc itself would prove nothing.
 */
const DESTINATION_DOMAIN = 6;

/** One USDC at 6 decimals. Small enough to be cheap, large enough to be real. */
const SPIKE_AMOUNT = 1_000_000n;

/**
 * The floor below which the spike refuses to start.
 *
 * Two USDC: one to burn and one for gas and headroom. Refusing early with the
 * balance in the message is better than a half-run that approves and then cannot
 * afford to burn, which leaves a standing allowance to a Circle contract and no
 * measurement.
 */
const MINIMUM_BALANCE = 2_000_000n;

/** Explicit, because `eth_estimateGas` prepays its upper bound out of the same balance. */
const APPROVE_GAS = 200_000n;
const BURN_GAS = 800_000n;

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;

let passed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`FAILED: ${label}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`  ok  ${label}${detail ? ` (${detail})` : ""}`);
}

/**
 * A one-shot observation on a persistent chain.
 *
 * The burn happened once, cost real money, and cannot happen again in the same
 * sense. Counting it as a pass would make the second run's total a lie and every
 * run after that a larger one.
 */
function note(label: string, detail: string): void {
  console.log(`  --  ${label} — ${detail}`);
}

function usdc6(value: bigint): string {
  return `${formatUnits(value, 6)} USDC`;
}

/** Gas on Arc is USDC out of the native balance, which is the same balance at 18 decimals. */
function usdc18(value: bigint): string {
  return `${formatUnits(value, 18)} USDC`;
}

/** Where the spike's artefacts land. Gitignored — a tx hash is not repo content. */
function spikeDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", ".spike");
}

export async function runCctpSpike(): Promise<void> {
  const deployerKey = process.env["DEPLOYER_PRIVATE_KEY"] as Hex | undefined;
  if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY is required to run the CCTP spike.");

  const transport = http(process.env["ARC_TESTNET_RPC_URL"] ?? ARC_TESTNET_RPC_URL);
  const publicClient = createPublicClient({chain: arcTestnet, transport}) as PublicClient;
  const account = privateKeyToAccount(deployerKey);
  const wallet = createWalletClient({account, chain: arcTestnet, transport});
  const deployer = account.address;

  console.log("\nCCTP v2 spike — one real depositForBurn out of Arc");
  console.log(`deployer  ${deployer}`);
  console.log(`route     domain ${ARC_CCTP_DOMAIN} (Arc) → domain ${DESTINATION_DOMAIN} (Base Sepolia)\n`);

  // ── Preconditions. All reproducible, so all of them are checks. ────────────
  const balance = await shed(() =>
    publicClient.readContract({
      address: ARC_USDC,
      abi: TOKEN_ABI,
      functionName: "balanceOf",
      args: [deployer],
    }),
  );
  if (balance < MINIMUM_BALANCE) {
    throw new Error(
      `The deployer holds ${usdc6(balance)} and the spike needs at least ${usdc6(MINIMUM_BALANCE)} ` +
        `— one to burn, one for gas and headroom.\n` +
        `Top up ${deployer} at https://faucet.circle.com and run this again.\n` +
        `Refusing rather than half-running: an approve with no burn behind it leaves a ` +
        `standing allowance to a Circle contract and produces no measurement.`,
    );
  }
  check("deployer is funded", true, usdc6(balance));

  const route = await shed(() =>
    publicClient.readContract({
      address: ARC_TOKEN_MESSENGER_V2,
      abi: MESSENGER_ABI,
      functionName: "remoteTokenMessengers",
      args: [DESTINATION_DOMAIN],
    }),
  );
  check("destination domain is routable", route !== ZERO_BYTES32, `domain ${DESTINATION_DOMAIN} → ${route}`);

  const recipient = mintRecipient(deployer);
  check(
    "mintRecipient is left-padded",
    recipient.toLowerCase().endsWith(deployer.slice(2).toLowerCase()) &&
      /^0x0{24}/.test(recipient),
    recipient,
  );

  // Pitfall 6, asserted before it can cost five minutes of polling.
  const documentedForm = await pollIris(
    `${IRIS_SANDBOX_BASE_URL}/messages?txHash=0x${"00".repeat(32)}`,
  );
  check(
    "Circle's documented Iris form does not route",
    documentedForm.kind === "misrouted",
    documentedForm.kind === "misrouted" ? "HTML 404, not a JSON error" : `got ${documentedForm.kind}`,
  );

  const workingForm = await pollIris(
    `${IRIS_SANDBOX_BASE_URL}/messages/${ARC_CCTP_DOMAIN}?transactionHash=0x${"00".repeat(32)}`,
  );
  check(
    "the /{sourceDomain}?transactionHash= form routes",
    workingForm.kind === "pending",
    workingForm.kind === "pending" ? workingForm.detail : `got ${workingForm.kind}`,
  );

  // ── Approve. Reproducible, so still a check. ──────────────────────────────
  const approveHash = await shed(() =>
    wallet.writeContract({
      account,
      chain: arcTestnet,
      address: ARC_USDC,
      abi: TOKEN_ABI,
      functionName: "approve",
      args: [ARC_TOKEN_MESSENGER_V2, SPIKE_AMOUNT],
      gas: APPROVE_GAS,
    }),
  );
  const approveReceipt = await shed(() =>
    publicClient.waitForTransactionReceipt({hash: approveHash}),
  );
  if (approveReceipt.status !== "success") throw new Error(`approve reverted: ${approveHash}`);

  const allowance = await shed(() =>
    publicClient.readContract({
      address: ARC_USDC,
      abi: TOKEN_ABI,
      functionName: "allowance",
      args: [deployer, ARC_TOKEN_MESSENGER_V2],
    }),
  );
  check("TokenMessengerV2 is approved", allowance >= SPIKE_AMOUNT, usdc6(allowance));

  // ── The burn. One-shot, real money, reported with `--`. ───────────────────
  const startedAt = Date.now();
  let burnHash: Hex;
  try {
    burnHash = await shed(() =>
      wallet.writeContract({
        account,
        chain: arcTestnet,
        address: ARC_TOKEN_MESSENGER_V2,
        abi: MESSENGER_ABI,
        functionName: "depositForBurn",
        args: [
          SPIKE_AMOUNT,
          DESTINATION_DOMAIN,
          recipient,
          ARC_USDC,
          ZERO_BYTES32, // anyone may complete receiveMessage on the destination
          CCTP_MAX_FEE_FROM_ARC,
          CCTP_FINALITY_STANDARD,
        ],
        gas: BURN_GAS,
      }),
    );
  } catch (error) {
    // The failure is the more valuable outcome and must not be retried into
    // silence. Print it whole — the revert string is what finding 28 records and
    // what PayoutRouter is then designed around.
    console.log("\n  !!  depositForBurn did not send\n");
    console.error(error);
    throw new Error(
      "The burn failed before it reached the chain. Record the error above as finding 28 " +
        "verbatim; do not re-run until it is written down.",
    );
  }

  const receipt = await shed(() => publicClient.waitForTransactionReceipt({hash: burnHash}));
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;

  if (receipt.status !== "success") {
    note("depositForBurn REVERTED", `${burnHash}, ${receipt.gasUsed} gas`);
    throw new Error(
      `depositForBurn reverted on chain: ${burnHash}\n` +
        "This is a measurement, not a flake. Write it into finding 28 with the tx hash " +
        "before touching anything else — PayoutRouter's whole shape depends on it.",
    );
  }

  note(
    "depositForBurn",
    `${burnHash}, ${receipt.gasUsed} gas, ${usdc18(gasCost)} at ${receipt.effectiveGasPrice} wei`,
  );

  // ── MessageSent, from the transmitter and not the messenger ───────────────
  let message: Hex | undefined;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ARC_MESSAGE_TRANSMITTER_V2.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({abi: TRANSMITTER_ABI, data: log.data, topics: log.topics});
      if (decoded.eventName === "MessageSent") message = decoded.args.message;
    } catch {
      // Another event from the same address. Not an error; keep looking.
    }
  }

  if (!message) {
    throw new Error(
      `The burn succeeded but no MessageSent log was emitted by ${ARC_MESSAGE_TRANSMITTER_V2}.\n` +
        "That is the finding: a burn with no message is a dollar destroyed with nothing to " +
        "attest, and PayoutRouter cannot be built on it. Record it as finding 28.",
    );
  }

  note("MessageSent", `${(message.length - 2) / 2} bytes from ${ARC_MESSAGE_TRANSMITTER_V2}`);
  console.log(`      ${message}`);

  // ── Iris ──────────────────────────────────────────────────────────────────
  const url = `${IRIS_SANDBOX_BASE_URL}/messages/${ARC_CCTP_DOMAIN}?transactionHash=${burnHash}`;
  console.log(`\n  ..  polling ${url}`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attested: IrisMessage | undefined;
  let lastDetail = "never polled";

  while (Date.now() < deadline) {
    const poll = await pollIris(url);
    if (poll.kind === "found") {
      attested = poll.message;
      break;
    }
    if (poll.kind === "misrouted") {
      throw new Error(
        `Iris answered with a non-JSON body: ${poll.detail}\n` +
          "That is a routing miss, not a message that has yet to be indexed. The endpoint " +
          "form is wrong — it must be /v2/messages/{sourceDomain}?transactionHash=, never " +
          "the documented ?txHash=. Failing immediately rather than polling a dead URL for " +
          "five minutes and then reporting the burn as unattested.",
      );
    }
    lastDetail = poll.detail;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const elapsedMs = Date.now() - startedAt;
  const artefact = {
    chainId: arcTestnet.id,
    sourceDomain: ARC_CCTP_DOMAIN,
    destinationDomain: DESTINATION_DOMAIN,
    tokenMessenger: ARC_TOKEN_MESSENGER_V2,
    messageTransmitter: ARC_MESSAGE_TRANSMITTER_V2,
    burnToken: ARC_USDC,
    amount: SPIKE_AMOUNT.toString(),
    maxFee: CCTP_MAX_FEE_FROM_ARC.toString(),
    minFinalityThreshold: CCTP_FINALITY_STANDARD,
    depositor: deployer,
    mintRecipient: recipient,
    approveTx: approveHash,
    burnTx: burnHash,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    gasCostUsdc: formatUnits(gasCost, 18),
    message,
    attestation: attested?.attestation ?? null,
    eventNonce: attested?.eventNonce ?? null,
    status: attested?.status ?? "not-attested-within-timeout",
    elapsedMs,
    irisUrl: url,
    ranAt: new Date().toISOString(),
  };

  mkdirSync(spikeDir(), {recursive: true});
  const artefactPath = join(spikeDir(), `cctp-${burnHash}.json`);
  writeFileSync(artefactPath, `${JSON.stringify(artefact, null, 2)}\n`);

  if (!attested) {
    console.log(`\n  ..  artefact written to ${artefactPath}`);
    throw new Error(
      `No attestation within ${POLL_TIMEOUT_MS / 1_000}s. Last answer: ${lastDetail}\n` +
        `The burn is on chain at ${burnHash} and the message is in the artefact. Record the ` +
        "wait as finding 28 rather than re-running — a second burn does not make the first " +
        "one attest, and the message can still be retrieved from the same URL later.",
    );
  }

  note("attestation", `${attested.status} after ${(elapsedMs / 1_000).toFixed(1)}s`);
  console.log(`      eventNonce  ${attested.eventNonce}`);
  console.log(`      attestation ${attested.attestation}`);
  console.log(`\n  ..  artefact written to ${artefactPath}`);

  console.log(`\n${passed} reproducible checks passed; the burn and its attestation are one-shot.`);
  console.log(
    "The destination mint is not attempted here: destinationCaller is bytes32(0), so anyone\n" +
      "may call receiveMessage(message, attestation) on Base Sepolia's MessageTransmitterV2.\n" +
      "Plazo holds no gas token there by decision, and the merchant closes this leg themselves.",
  );
}
