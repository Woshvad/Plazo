/**
 * Ponder configuration for Arc.
 *
 * Reorg handling — Ponder's hardest problem on other chains — is free here. Arc has
 * deterministic single-slot finality under Malachite BFT and zero reorgs, so there
 * is no rollback path to get wrong.
 *
 * What is not free is the RPC. See `src/transport.ts`: the public endpoint sheds a
 * quarter of requests and caps `eth_getLogs` at 10,000 blocks.
 *
 * `startBlock` is the deployment block, never genesis. Arc is past 54 million
 * blocks at roughly half a second each; a genesis backfill would sweep years of
 * unrelated history to find nothing.
 *
 * ## The environment this file reads
 *
 * Every address lives here and **not** in `.env.example`, which scopes itself to the
 * operator database and says why: a variable listed in two places is a variable one of
 * the two lists eventually gets wrong, and the wrong one is silent. The merchant plane
 * (Phase 6) adds four:
 *
 * - `PLAZO_PAYOUT_ROUTER_ADDRESS` — the settlement adapter (plan 06-05)
 * - `PLAZO_REFUND_ESCROW_ADDRESS` — refunds, voids and the rebate reserve (06-08)
 * - `PLAZO_SETTLEMENT_ESCROW_ADDRESS` — settlement held against shipment (06-09)
 * - `PLAZO_CHECKOUT_ROUTER_ADDRESS_LEGACY` — the router the merchant plane replaces
 *
 * The last one is the one worth reading twice. It is optional, and leaving it unset is
 * not neutral: it is the difference between an indexer that carries vintage-3
 * origination history and one that reports those originations never happened. See
 * `atAll`.
 */
import {createConfig, factory} from "ponder";
import {parseAbi, parseAbiItem} from "viem";

import {ARC_MAX_LOG_RANGE, ARC_TESTNET_CHAIN_ID} from "@plazo/plan-core";
import {
  CHECKOUT_ROUTER_ABI,
  TRANCHED_CREDIT_POOL_ABI,
  PLAZO_PASSPORT_ABI,
  ATTESTATION_SCHEMA_REGISTRY_ABI,
  RELAYER_GATE_ABI,
  POOL_REGISTRY_ABI,
  INSTALLMENT_PLAN_ABI,
  KILL_SWITCH_ABI,
  MERCHANT_REGISTRY_ABI,
  ORIGINATION_PAUSE_ABI,
  PARAMETER_REGISTRY_ABI,
  PAYOUT_ROUTER_ABI,
  PLAN_FACTORY_ABI,
  RECEIVABLE_TOKEN_ABI,
  REFUND_ESCROW_ABI,
  SETTLEMENT_ESCROW_ABI,
  TIER0_UNDERWRITER_ABI,
} from "@plazo/events";

import {arcTransport} from "./src/transport.js";

const PLAN_FACTORY = process.env["PLAZO_PLAN_FACTORY_ADDRESS"] as `0x${string}` | undefined;
const START_BLOCK = process.env["PLAZO_START_BLOCK"];

/**
 * An origination-plane address, or the zero address if it is not configured yet.
 *
 * Unset contracts index nothing rather than failing the process. A deployment where
 * only the plan factory is configured is exactly the Phase 2 shape, and the indexer
 * should keep serving it — an operator adding contracts as they deploy should not
 * have to take the indexer down between steps.
 */
const at = (name: string): `0x${string}` =>
  (process.env[name] as `0x${string}` | undefined) ?? "0x0000000000000000000000000000000000000000";

/**
 * Every address a contract has ever been deployed at, newest first.
 *
 * A redeployment does not erase the log stream of the address it replaced. DEC-15
 * already cost this project one forced vintage; the router is redeployed again for the
 * merchant plane, and an indexer configured against only the new address would report
 * that vintage-3 originations never happened rather than that it stopped watching them.
 *
 * The zero address is filtered out rather than passed through: an unconfigured legacy
 * address should mean "there is no earlier deployment", not "index the null contract".
 */
const atAll = (...names: string[]): `0x${string}`[] => {
  const addresses = names
    .map((name) => process.env[name] as `0x${string}` | undefined)
    .filter((address): address is `0x${string}` => Boolean(address) && !/^0x0+$/.test(address!));
  return addresses.length > 0 ? addresses : ["0x0000000000000000000000000000000000000000"];
};

if (!PLAN_FACTORY) {
  console.warn(
    "PLAZO_PLAN_FACTORY_ADDRESS is unset — indexing no contracts.\n" +
      "Set it to the address printed by `forge script Deploy`.",
  );
}

const ADDRESS = PLAN_FACTORY ?? "0x0000000000000000000000000000000000000000";
const startBlock = START_BLOCK ? Number(START_BLOCK) : ("latest" as const);

/**
 * An address **and** the block to start watching it from, because the two are one
 * decision.
 *
 * `at` alone was not enough, and a live run is what showed it. An unconfigured contract
 * gets the zero address, which never emits — but Ponder does not know that, so it
 * backfills the zero address exactly as diligently as a real one. A measured run against
 * the Arc testnet deployment on 2026-08-02 spent **486 of its logged `eth_getLogs`
 * calls, around 30%, on `0x0000…0000`**, over a 192,786-block range, on a public
 * endpoint that sheds a quarter of what it is asked and then rate-limits. The
 * `at` docstring's claim that an unset contract "indexes nothing" was true about not
 * crashing and false about not costing anything, and this plan made it three contracts
 * worse.
 *
 * So an unconfigured contract starts at `latest`: no history to sweep, nothing to
 * decode, and the process still comes up and still serves. That is what "indexes
 * nothing" was always supposed to mean.
 */
const watch = (name: string) => ({
  address: at(name),
  startBlock: process.env[name] ? startBlock : ("latest" as const),
});

/** The same, for a contract that has been deployed more than once. See `atAll`. */
const watchAll = (...names: string[]) => ({
  address: atAll(...names),
  startBlock: names.some((name) => process.env[name]) ? startBlock : ("latest" as const),
});

/**
 * Plans are discovered from the factory's own event stream rather than configured.
 *
 * Every plan is a CREATE2 clone deployed by `PlanFactory`, and there will be one per
 * origination — so an address list would need a deployment to update it, and the
 * indexer would silently stop seeing new plans the moment someone forgot. The
 * factory pattern makes discovery a property of the chain instead.
 */
const PLAN_DEPLOYED = parseAbiItem(
  "event PlanDeployed(bytes32 indexed planId, address indexed plan, address indexed implementation)",
);

export default createConfig({
  chains: {
    arcTestnet: {
      id: ARC_TESTNET_CHAIN_ID,
      rpc: arcTransport(),
      // The public endpoint sheds under load, so ask for less than it will take.
      maxRequestsPerSecond: 5,
      /**
       * Arc's measured `eth_getLogs` ceiling, told to Ponder rather than discovered.
       *
       * This is a **cap, not a target**, and saying so is the point — it was added
       * expecting it to fix a slow backfill and it did not, so the comment says what
       * was measured rather than what was hoped.
       *
       * What it buys: Ponder never issues a request Arc will reject with `-32614`,
       * which is otherwise discovered by having one fail. `ARC_MAX_LOG_RANGE` is the
       * limit `@plazo/arc-verify` asserts on every CI run, so if Arc widens or narrows
       * it this number follows the gate rather than a comment. One less than the limit,
       * for the same reason `chunkBlockRange` is: the boundary was measured as "rejects
       * above", never read from documentation.
       *
       * What it does **not** buy: throughput. Ponder ramps up from a small range and
       * backs off on any error, and on Arc almost every error is `-32011` — the
       * endpoint shedding load, which it does to roughly a quarter of requests
       * regardless of pacing. So the range never grows towards this cap. Measured on
       * 2026-08-02 against the live deployment: 641 shed responses escaped the
       * transport's retries in nine minutes, requests stayed at **26 blocks**, and the
       * sweep covered 390 blocks of a 194,092-block range. The binding constraint is
       * the shed rate against a 45-fragment fan-out, not the range, and the fix for it
       * is a better endpoint rather than a better guess. See the SUMMARY for 06-11.
       */
      ethGetLogsBlockRange: ARC_MAX_LOG_RANGE - 1,
    },
  },
  contracts: {
    PlanFactory: {
      chain: "arcTestnet",
      abi: parseAbi(PLAN_FACTORY_ABI),
      address: ADDRESS,
      startBlock,
    },
    InstallmentPlan: {
      chain: "arcTestnet",
      abi: parseAbi(INSTALLMENT_PLAN_ABI),
      address: factory({address: ADDRESS, event: PLAN_DEPLOYED, parameter: "plan"}),
      startBlock,
    },
    // The origination plane, written out rather than generated from a table.
    // `Object.fromEntries` erases the literal keys, and with them every event name
    // `ponder:registry` would otherwise infer — which is precisely the compile-time
    // safety the const-typed ABIs in `@plazo/events` exist to preserve.
    CheckoutRouter: {
      chain: "arcTestnet",
      abi: parseAbi(CHECKOUT_ROUTER_ABI),
      // Both the current router and the one it replaced. See `atAll`.
      ...watchAll("PLAZO_CHECKOUT_ROUTER_ADDRESS", "PLAZO_CHECKOUT_ROUTER_ADDRESS_LEGACY"),
    },
    TranchedCreditPool: {
      chain: "arcTestnet",
      abi: parseAbi(TRANCHED_CREDIT_POOL_ABI),
      ...watch("PLAZO_CREDIT_POOL_ADDRESS"),
    },
    PlazoPassport: {
      chain: "arcTestnet",
      abi: parseAbi(PLAZO_PASSPORT_ABI),
      ...watch("PLAZO_PASSPORT_ADDRESS"),
    },
    AttestationSchemaRegistry: {
      chain: "arcTestnet",
      abi: parseAbi(ATTESTATION_SCHEMA_REGISTRY_ABI),
      ...watch("PLAZO_SCHEMAS_ADDRESS"),
    },
    RelayerGate: {
      chain: "arcTestnet",
      abi: parseAbi(RELAYER_GATE_ABI),
      ...watch("PLAZO_RELAYER_ADDRESS"),
    },
    PoolRegistry: {
      chain: "arcTestnet",
      abi: parseAbi(POOL_REGISTRY_ABI),
      ...watch("PLAZO_POOL_REGISTRY_ADDRESS"),
    },
    MerchantRegistry: {
      chain: "arcTestnet",
      abi: parseAbi(MERCHANT_REGISTRY_ABI),
      ...watch("PLAZO_MERCHANT_REGISTRY_ADDRESS"),
    },
    ReceivableToken: {
      chain: "arcTestnet",
      abi: parseAbi(RECEIVABLE_TOKEN_ABI),
      ...watch("PLAZO_RECEIVABLE_ADDRESS"),
    },
    Tier0Underwriter: {
      chain: "arcTestnet",
      abi: parseAbi(TIER0_UNDERWRITER_ABI),
      ...watch("PLAZO_TIER0_ADDRESS"),
    },
    FirstPaymentDefaultSwitch: {
      chain: "arcTestnet",
      abi: parseAbi(KILL_SWITCH_ABI),
      ...watch("PLAZO_KILL_SWITCH_ADDRESS"),
    },
    ParameterRegistry: {
      chain: "arcTestnet",
      abi: parseAbi(PARAMETER_REGISTRY_ABI),
      ...watch("PLAZO_PARAMETERS_ADDRESS"),
    },
    OriginationPause: {
      chain: "arcTestnet",
      abi: parseAbi(ORIGINATION_PAUSE_ABI),
      ...watch("PLAZO_PAUSE_ADDRESS"),
    },
    // The merchant plane (Phase 6). All three are unconfigured until plan 06-13
    // redeploys the stack, and an unconfigured contract indexes nothing rather than
    // failing the process — see `at`.
    PayoutRouter: {
      chain: "arcTestnet",
      abi: parseAbi(PAYOUT_ROUTER_ABI),
      ...watch("PLAZO_PAYOUT_ROUTER_ADDRESS"),
    },
    RefundEscrow: {
      chain: "arcTestnet",
      abi: parseAbi(REFUND_ESCROW_ABI),
      ...watch("PLAZO_REFUND_ESCROW_ADDRESS"),
    },
    SettlementEscrow: {
      chain: "arcTestnet",
      abi: parseAbi(SETTLEMENT_ESCROW_ABI),
      ...watch("PLAZO_SETTLEMENT_ESCROW_ADDRESS"),
    },
  },
});
