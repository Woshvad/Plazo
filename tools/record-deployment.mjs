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
  creditPool: "CreditPool",
  killSwitch: "FirstPaymentDefaultSwitch",
  tier0: "Tier0Underwriter",
  pauses: "OriginationPause",
  installmentPlan: "InstallmentPlan",
  planFactory: "PlanFactory",
  checkoutRouter: "CheckoutRouter",
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

const dir = join(ROOT, "contracts", "deployments");
mkdirSync(dir, {recursive: true});
const out = join(dir, `${chainId}.json`);
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);

console.log(`Wrote ${out}`);
for (const [key, value] of Object.entries(record)) console.log(`  ${key.padEnd(21)} ${value}`);
console.log("\nSet PLAZO_PLAN_FACTORY_ADDRESS and PLAZO_START_BLOCK for the indexer from this file.");
