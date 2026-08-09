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
 * Plan 07-12's corridor deployment, if it has run.
 *
 * Optional for the same reason the rewire is: a chain that has seen only the earlier
 * scripts produces exactly the record it produced before this file learned about the
 * corridor. What is different here is that **one broadcast creates two instances of
 * three different contracts** — two `ParameterRegistry`, two `TieredUnderwriter`, and a
 * `Tier0Underwriter` beside one that already exists. Keying by contract name alone would
 * silently collapse each pair onto whichever came last, so the corridor overlay resolves
 * every ambiguous name **off the chain**, from the getters of the router it just
 * deployed. A record derived from what the contracts say about each other cannot name the
 * dollar registry as the euro one.
 */
const corridor = readBroadcast("DeployCorridor.s.sol", {required: false});

/**
 * Every `CREATE` in a broadcast, keyed by contract name.
 *
 * One function rather than two loops, because the rewire's broadcast has to be read
 * exactly the way the deploy's is — including the receipt check. A second copy of
 * this loop is how one of them ends up trusting `receipt.contractAddress`.
 *
 * Returns the **first** address for each name. `createdCounts` reports how many there
 * were, because 07-12's broadcast creates two of three different contracts and a caller
 * that silently took the last one would produce a record naming the euro registry as the
 * dollar one. Callers that face duplicates resolve them from the chain instead.
 */
const createdCounts = new Map();

function createdIn(broadcast, label) {
  const byHash = new Map((broadcast.receipts ?? []).map((r) => [r.transactionHash, r]));
  const created = {};
  const counts = {};

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
    counts[tx.contractName] = (counts[tx.contractName] ?? 0) + 1;
    if (created[tx.contractName] === undefined) created[tx.contractName] = tx.contractAddress;
  }

  createdCounts.set(label, counts);
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

// ─── Plan 07-12: the corridor overlay ────────────────────────────────────────

/**
 * How many of each contract `DeployCorridor.s.sol` creates, asserted rather than assumed.
 *
 * Three names appear twice, which is the whole reason this overlay does not key by name:
 * two `ParameterRegistry` (the dollar corridor's and the EURC book's, B-2a) and two
 * `TieredUnderwriter` (one per book). `Tier0Underwriter` appears **once**, because the
 * dollar book's is already deployed and is reused. `TrancheToken` appears **zero** times
 * — the pool constructs both, so they are read back from the chain like the dollar
 * book's are.
 *
 * A count that does not match means the script changed and this mapping has not, which
 * is the moment to fail rather than to write a plausible record.
 */
const CORRIDOR_CREATES = {
  ParameterRegistry: 2,
  IdentityFXRouter: 1,
  TranchedCreditPool: 1,
  FxDeviationGuard: 1,
  AmmVenue: 1,
  StableFxVenueStub: 1,
  PledgeVault: 1,
  PayrollSweeper: 1,
  PartnerUnderwriterStub: 1,
  TieredUnderwriter: 2,
  Tier0Underwriter: 1,
  MerchantCurrencyRegistry: 1,
  SettlementEscrow: 1,
  CheckoutRouter: 1,
  RefundEscrow: 1,
};

/** `keccak256("plazo.line.payin4.eurc")` — the second product line (POOL-01). */
const PAY_IN_4_EURC = "0x454f9b7b3a6554c11a46723d7587e4097b4a5367d81858df51648a15814773aa";

const word = (hex) => `0x${hex.slice(-40)}`;

/**
 * `corridorConfigOf(token)` returns three words: fxRouter, parameters, underwriter.
 * Split rather than re-read three times, because the three are one fact —
 * `CorridorIncomplete` refuses a half-configured corridor and the record must not be able
 * to describe one.
 */
function splitCorridorConfig(result) {
  const body = result.slice(2);
  return {
    fxRouter: `0x${body.slice(24, 64)}`,
    parameters: `0x${body.slice(88, 128)}`,
    underwriter: `0x${body.slice(152, 192)}`,
  };
}

if (corridor) {
  const created = createdIn(corridor, "DeployCorridor.s.sol");
  const counts = createdCounts.get("DeployCorridor.s.sol") ?? {};

  const wrong = Object.entries(CORRIDOR_CREATES)
    .map(([name, want]) => [name, want, counts[name] ?? 0])
    .filter(([, want, got]) => want !== got);
  if (wrong.length > 0) {
    for (const [name, want, got] of wrong) {
      console.error(`DeployCorridor.s.sol created ${got} ${name}, expected ${want}.`);
    }
    console.error("The script and CORRIDOR_CREATES disagree. Fix the mapping before writing a record.");
    process.exit(1);
  }

  const router = created.CheckoutRouter;

  /** Read `to.selector(args)` or die naming what could not be read. */
  async function must(label, to, data) {
    const result = await call(to, data);
    if (!result) {
      console.error(`Could not read ${label} from ${to} after six attempts.`);
      console.error("The corridor record is written from the chain, not from the broadcast order.");
      process.exit(1);
    }
    return result;
  }

  const pad = (address) => address.toLowerCase().replace("0x", "").padStart(64, "0");
  const usdcCorridor = splitCorridorConfig(await must("corridorConfigOf(USDC)", router, `0xe66f6273${pad(record.token)}`));
  const eurc = process.env.PLAZO_EURC ?? "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
  const eurcCorridor = splitCorridorConfig(await must("corridorConfigOf(EURC)", router, `0xe66f6273${pad(eurc)}`));

  const eurcPool = word(await must("poolFor(PAY_IN_4_EURC)", record.poolRegistry, `0xbde541a0${PAY_IN_4_EURC.slice(2)}`));

  record.checkoutRouterLegacyV2 = record.checkoutRouter;
  record.settlementEscrowLegacy = record.settlementEscrow;
  record.refundEscrowLegacy = record.refundEscrow;

  record.checkoutRouter = router;
  record.settlementEscrow = word(await must("settlementEscrow()", router, "0x88328b75"));
  record.refundEscrow = created.RefundEscrow;

  record.fxParameterRegistry = usdcCorridor.parameters;
  record.eurcParameterRegistry = eurcCorridor.parameters;
  record.fxRouterEurc = eurcCorridor.fxRouter;
  record.tieredUnderwriter = usdcCorridor.underwriter;
  record.eurcTieredUnderwriter = eurcCorridor.underwriter;
  record.eurcTier0Underwriter = word(await must("tier0()", eurcCorridor.underwriter, "0x60485188"));

  record.eurcPool = eurcPool;
  record.eurcSeniorShares = word(await must("seniorShares()", eurcPool, "0x33e83c59"));
  record.eurcJuniorShares = word(await must("juniorShares()", eurcPool, "0x5379c262"));

  record.fxDeviationGuard = word(await must("fxGuard()", router, "0x81b043c2"));
  record.ammVenue = word(await must("fxVenue()", router, "0x4e3ed70a"));
  record.stableFxVenueStub = created.StableFxVenueStub;
  record.merchantCurrencyRegistry = word(await must("currencies()", router, "0xb6bb5ac6"));

  record.pledgeVault = word(await must("pledges()", usdcCorridor.underwriter, "0x5ad22905"));
  record.payrollSweeper = word(await must("sweeper()", usdcCorridor.underwriter, "0x9189a59e"));
  record.partnerUnderwriterStub = word(await must("partner()", usdcCorridor.underwriter, "0xbe10862b"));

  /**
   * The sweeper is one vintage's, and the record has to say whose (DEC-100).
   *
   * `PayrollSweeper`'s constructor takes the `PlanFactory` and `sweep` binds its
   * caller-supplied plan to `factory.predictAddress(planId)` before any value moves. A
   * second factory means a second sweeper and a second indexer variable, in the same way
   * and for the same reason as the routers.
   */
  record.payrollSweeperFactory = record.planFactory;

  /**
   * Which currency each registry answers in.
   *
   * Four instances now answer the same key, two of them in a different currency, and
   * their values can differ: the live registry carries governed values a fresh instance
   * does not inherit. A reconciliation that omits the unit is the second-order hazard
   * `ParameterRegistry`'s own header names.
   */
  record.registryCurrencies = {
    parameterRegistry: "USDC",
    escrowParameterRegistry: "USDC",
    fxParameterRegistry: "USDC",
    eurcParameterRegistry: "EURC",
  };

  record.rewireBlock2 = Number(corridor.receipts?.[0]?.blockNumber ?? 0);
}

const dir = join(ROOT, "contracts", "deployments");
mkdirSync(dir, {recursive: true});
const out = join(dir, `${chainId}.json`);
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);

console.log(`Wrote ${out}`);
for (const [key, value] of Object.entries(record)) {
  console.log(`  ${key.padEnd(24)} ${typeof value === "object" ? JSON.stringify(value) : value}`);
}
console.log("\nSet PLAZO_PLAN_FACTORY_ADDRESS and PLAZO_START_BLOCK for the indexer from this file.");
if (record.checkoutRouterLegacy) {
  console.log(
    "This chain has been rewired. PLAZO_CHECKOUT_ROUTER_ADDRESS_LEGACY must be set to\n" +
      `  ${record.checkoutRouterLegacy}\n` +
      "or vintage-3 origination history is silently not indexed — an unset legacy address\n" +
      "is not neutral, it is the loss of every plan the old router originated.",
  );
}

/**
 * The corridor rewire's operator instructions, each with the reason it matters.
 *
 * Printed rather than documented, because the failure mode of every one of these is a
 * variable that is unset — and an unset variable produces a stack that starts, indexes,
 * and quietly reports less than the truth. There is no error to read.
 */
if (record.checkoutRouterLegacyV2) {
  console.log(
    "\n=== The Phase 7 corridor is live. Five variables, and none of them is optional. ===\n" +
      "\n1. PLAZO_CHECKOUT_ROUTER_ADDRESS_LEGACY2 must be set to\n" +
      `     ${record.checkoutRouterLegacyV2}\n` +
      "   This is 06-13's router, demoted here. `checkoutRouter` is now the Phase 7 one.\n" +
      "   Unset is not neutral — it is the silent loss of every plan that router originated,\n" +
      "   and nothing was revoked from it (D-24) so it is still answering.\n" +
      "\n2. PLAZO_CHECKOUT_ROUTER_ADDRESS_LEGACY must STILL be set to\n" +
      `     ${record.checkoutRouterLegacy}\n` +
      "   Shifting LEGACY down to LEGACY2 without refilling LEGACY loses the middle vintage\n" +
      "   while looking like a completed migration. Three routers, three variables.\n" +
      "\n3. PLAZO_EURC_POOL_ADDRESS must be set to\n" +
      `     ${record.eurcPool}\n` +
      "   It joins TranchedCreditPool through `watchAll`, so an unset value silently narrows\n" +
      "   the indexer to one book rather than failing.\n" +
      "\n4. PLAZO_PAYROLL_SWEEPER_ADDRESS must be set to\n" +
      `     ${record.payrollSweeper}\n` +
      `   It serves PlanFactory ${record.payrollSweeperFactory} and only that vintage (DEC-100).\n` +
      "   Unset is not an error, just a sweep table nobody ever fills.\n" +
      "\n5. PLAZO_ORIGINATION_PAUSE_ADDRESS must be set to\n" +
      `     ${record.pauses}\n` +
      "   Until it is, `composeFxService` reports `canPause: false` and the depeg breaker\n" +
      "   composes DETECTING-ONLY (DEC-117). That is a worse state than having no breaker,\n" +
      "   because it looks armed: a poll that finds nothing wrong is indistinguishable from\n" +
      "   a poll that could not act. The role is the existing PAUSER_ROLE on this contract —\n" +
      "   no second pauser was created (DEC-94).\n" +
      "\nAnd the indexer needs a FRESH database: `epoch`'s primary key changed and seven\n" +
      "tables gained a NOT NULL column, so an existing indexed database cannot be\n" +
      "reconciled to the v5 schema in place.\n",
  );
}
