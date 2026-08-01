#!/usr/bin/env node
/**
 * Turn a broadcast into a deployment record.
 *
 * This exists because of a mistake worth keeping. `Deploy.s.sol` originally wrote
 * the record itself — and `forge script` executes its body locally before
 * broadcasting, so a run that failed at the *send* step still produced a file naming
 * four addresses that hold no code. The indexer, the keeper and the slice runner all
 * read that file. A deployment record that can be written by a deployment that did
 * not happen is worse than no record.
 *
 * Foundry's broadcast artefact is written from receipts, so it cannot claim a
 * transaction that was never mined. This reads that, verifies every receipt
 * succeeded, and only then writes `contracts/deployments/<chainId>.json`.
 *
 *     node tools/record-deployment.mjs 5042002
 */
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";

const chainId = process.argv[2];
if (!chainId) {
  console.error("usage: node tools/record-deployment.mjs <chainId>");
  process.exit(2);
}

const ROOT = join(import.meta.dirname, "..");
const broadcastPath = join(ROOT, "contracts", "broadcast", "Deploy.s.sol", chainId, "run-latest.json");

let run;
try {
  run = JSON.parse(readFileSync(broadcastPath, "utf8"));
} catch {
  console.error(`No broadcast for chain ${chainId} at ${broadcastPath}.`);
  console.error("Run the deploy with --broadcast first.");
  process.exit(1);
}

const receipts = new Map((run.receipts ?? []).map((r) => [r.transactionHash, r]));
const deployed = {};

for (const tx of run.transactions ?? []) {
  if (tx.transactionType !== "CREATE") continue;
  const receipt = receipts.get(tx.hash);
  if (!receipt) {
    console.error(`No receipt for ${tx.contractName} (${tx.hash}). The broadcast did not complete.`);
    process.exit(1);
  }
  // Foundry writes status as "0x1"/"0x0" or 1/0 depending on the version.
  const status = String(receipt.status);
  if (status !== "0x1" && status !== "1") {
    console.error(`${tx.contractName} reverted (${tx.hash}).`);
    process.exit(1);
  }
  // The address comes from the transaction, never from the receipt.
  //
  // In Foundry's artefact the receipts array is written with `transactionHash` in
  // mining order and `contractAddress` in submission order, so a receipt row can
  // carry one transaction's hash beside another's deployed address. With four
  // contracts the two orders happened to coincide and Phase 2's record was right by
  // luck; with fifteen they did not, and preferring `receipt.contractAddress`
  // produced a record in which the receivable token and the FX router shared an
  // address. Every consumer of that file — the indexer, the keeper, the slice runner
  // — would have believed it.
  //
  // The receipt is still what proves the deployment happened; it is just not what
  // says where.
  deployed[tx.contractName] = tx.contractAddress;
}

/**
 * Every contract the record must name.
 *
 * Listed rather than inferred, so a deployment that silently skipped one fails here
 * instead of producing a record whose missing key surfaces as `undefined` in the
 * indexer three days later.
 */
const CONTRACTS = {
  jurisdictionRegistry: "JurisdictionRegistry",
  parameterRegistry: "ParameterRegistry",
  eligibilityRegistry: "EligibilityRegistry",
  compliance: "AllowlistCompliance",
  fxRouter: "IdentityFXRouter",
  payout: "ArcLocalPayout",
  receivable: "ReceivableToken",
  merchantRegistry: "MerchantRegistry",
  poolRegistry: "PoolRegistry",
  creditPool: "TranchedCreditPool",
  yieldVenue: "ParkedYieldVenue",
  passport: "PlazoPassport",
  attestationSchemas: "AttestationSchemaRegistry",
  relayerGate: "RelayerGate",
  killSwitch: "FirstPaymentDefaultSwitch",
  tier0: "Tier0Underwriter",
  pauses: "OriginationPause",
  installmentPlan: "InstallmentPlan",
  planFactory: "PlanFactory",
  checkoutRouter: "CheckoutRouter",
};

/**
 * Contracts a parent deploys with `new`, which never appear as their own CREATE
 * transaction.
 *
 * `TranchedCreditPool` constructs both tranche tokens, so their addresses are known
 * only to the chain. They are read back rather than inferred, because a record that
 * guessed at them would be a record naming an address nobody has checked holds code —
 * which is the failure this whole script exists to prevent.
 */
const NESTED = {
  seniorShares: {of: "creditPool", selector: "0x33e83c59"},
  juniorShares: {of: "creditPool", selector: "0x5379c262"},
};

const missing = Object.values(CONTRACTS).filter((name) => !deployed[name]);
if (missing.length > 0) {
  console.error(`The broadcast is missing: ${missing.join(", ")}`);
  process.exit(1);
}

const record = {
  chainId: Number(chainId),
  block: Number(run.receipts?.[0]?.blockNumber ?? 0),
  token: process.env.PLAZO_TOKEN ?? "0x3600000000000000000000000000000000000000",
  ...Object.fromEntries(Object.entries(CONTRACTS).map(([key, name]) => [key, deployed[name]])),
};

const rpc = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.io";

/**
 * Arc's public RPC sheds roughly a quarter of requests regardless of pacing, and this
 * script found out the same way `arc-verify`, the indexer and the keeper each did: two
 * identical reads, the first succeeded and the second came back empty. It is not rate
 * limiting — spacing them does not help — so the only thing that works is asking again.
 */
async function call(to, selector) {
  for (let attempt = 0; attempt < 6; ++attempt) {
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{to, data: selector}, "latest"],
        }),
      });
      const {result, error} = await response.json();
      if (!error && result && result !== "0x") return result;
    } catch {
      // A dropped connection is the same failure wearing a different coat.
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  return null;
}

for (const [key, {of, selector}] of Object.entries(NESTED)) {
  const result = await call(record[of], selector);
  if (!result) {
    console.error(`Could not read ${key} from ${of} (${record[of]}) after six attempts.`);
    process.exit(1);
  }
  record[key] = `0x${result.slice(-40)}`;
}

const dir = join(ROOT, "contracts", "deployments");
mkdirSync(dir, {recursive: true});
const out = join(dir, `${chainId}.json`);
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);

console.log(`Wrote ${out}`);
for (const [key, value] of Object.entries(record)) console.log(`  ${key.padEnd(21)} ${value}`);
console.log("\nSet PLAZO_PLAN_FACTORY_ADDRESS and PLAZO_START_BLOCK for the indexer from this file.");
