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

function broadcastPathFor(script) {
  return join(ROOT, "contracts", "broadcast", script, chainId, "run-latest.json");
}

function readBroadcast(script, {required}) {
  const path = broadcastPathFor(script);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    if (!required) return null;
    console.error(`No broadcast for chain ${chainId} at ${path}.`);
    console.error("Run the deploy with --broadcast first.");
    process.exit(1);
  }
}

const run = readBroadcast("Deploy.s.sol", {required: true});

/**
 * Plan 06-13's rewire, if it has run.
 *
 * Optional on purpose: a chain that has only ever seen `Deploy.s.sol` produces
 * exactly the record it produced before this file learned about the rewire, and a
 * chain that has seen both produces one record naming the live addresses and the
 * superseded ones side by side. The rewire replaces four contracts and adds three,
 * and the ones it replaces have to stay named — the indexer decodes vintage-3
 * origination history off the old `CheckoutRouter`, and the variable being unset is
 * not neutral, it is silent loss of that history.
 */
const rewire = readBroadcast("Rewire.s.sol", {required: false});

/**
 * Every `CREATE` in a broadcast, keyed by contract name.
 *
 * One function rather than two loops, because the rewire's broadcast has to be read
 * exactly the way the deploy's is — including the receipt check. A second copy of
 * this loop is how one of them ends up trusting `receipt.contractAddress`.
 */
function createdIn(broadcast, label) {
  const byHash = new Map((broadcast.receipts ?? []).map((r) => [r.transactionHash, r]));
  const created = {};

  for (const tx of broadcast.transactions ?? []) {
    if (tx.transactionType !== "CREATE") continue;
    const receipt = byHash.get(tx.hash);
    if (!receipt) {
      console.error(`No receipt for ${tx.contractName} (${tx.hash}) in ${label}. The broadcast did not complete.`);
      process.exit(1);
    }
    // Foundry writes status as "0x1"/"0x0" or 1/0 depending on the version.
    const status = String(receipt.status);
    if (status !== "0x1" && status !== "1") {
      console.error(`${tx.contractName} reverted (${tx.hash}) in ${label}.`);
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
    created[tx.contractName] = tx.contractAddress;
  }

  return created;
}

const deployed = createdIn(run, "Deploy.s.sol");

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

/**
 * The rewire overlay: what plan 06-13 replaced, and what it superseded.
 *
 * `to` is where the new address lands; `legacy` is where the address it replaced is
 * kept. A replaced contract is renamed rather than dropped, because the ones this
 * rewire supersedes are still callable and still hold state somebody needs —
 * `poolOf[planId]` for every vintage-3 plan lives on the old `CheckoutRouter`, and the
 * old `MerchantRegistry` still holds a merchant's standing bond. Nothing is revoked
 * from any of them (D-24).
 *
 * `payout` becomes `payoutLegacy` and the live seam is `payoutRouter`, so there is one
 * name for one thing. Two keys carrying the same address is how they later disagree.
 */
const REWIRED = {
  MerchantRegistry: {to: "merchantRegistry", legacy: "merchantRegistryLegacy"},
  PayoutRouter: {to: "payoutRouter", legacy: null, replaces: "payout", as: "payoutLegacy"},
  ParameterRegistry: {to: "escrowParameterRegistry", legacy: null},
  SettlementEscrow: {to: "settlementEscrow", legacy: null},
  CheckoutRouter: {to: "checkoutRouter", legacy: "checkoutRouterLegacy"},
  RefundEscrow: {to: "refundEscrow", legacy: null},
};

if (rewire) {
  const created = createdIn(rewire, "Rewire.s.sol");

  const absent = Object.keys(REWIRED).filter((name) => !created[name]);
  if (absent.length > 0) {
    console.error(`The rewire broadcast is missing: ${absent.join(", ")}`);
    process.exit(1);
  }

  for (const [name, {to, legacy, replaces, as}] of Object.entries(REWIRED)) {
    if (legacy) record[legacy] = record[to];
    if (replaces) {
      record[as] = record[replaces];
      delete record[replaces];
    }
    record[to] = created[name];
  }

  record.rewireBlock = Number(rewire.receipts?.[0]?.blockNumber ?? 0);
}

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
if (record.checkoutRouterLegacy) {
  console.log(
    "This chain has been rewired. PLAZO_CHECKOUT_ROUTER_ADDRESS_LEGACY must be set to\n" +
      `  ${record.checkoutRouterLegacy}\n` +
      "or vintage-3 origination history is silently not indexed — an unset legacy address\n" +
      "is not neutral, it is the loss of every plan the old router originated.",
  );
}
