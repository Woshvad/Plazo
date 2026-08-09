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
 *
 * ## Three routers now, and two ways to lose a vintage
 *
 * Phase 7 redeploys the router again, so 06-13's router becomes legacy in its turn and
 * there are three addresses to carry:
 *
 * - `PLAZO_CHECKOUT_ROUTER_ADDRESS` — the current, Phase 7 corridor-aware router. It
 *   pairs with the Phase 7 rewire block, which is `PLAZO_START_BLOCK`.
 * - `PLAZO_CHECKOUT_ROUTER_ADDRESS_LEGACY` — 06-13's merchant-plane router, the one that
 *   originated every plan between the 06-13 rewire and the Phase 7 one.
 * - `PLAZO_CHECKOUT_ROUTER_ADDRESS_LEGACY2` — vintage 3's router, from before the
 *   merchant plane. 06-13 set `…_LEGACY` to this address; Phase 7 shifts it down one.
 *
 * **Leaving either legacy variable unset loses that vintage's origination history in
 * silence** — not as an error, not as an empty table, but as an indexer that reports
 * those plans were never originated. There are now two of them to forget instead of one,
 * and shifting `…_LEGACY` down to `…_LEGACY2` without setting `…_LEGACY` to 06-13's
 * router loses the middle vintage while looking like a completed migration.
 *
 * Phase 7 adds one more of the same class:
 *
 * - `PLAZO_INFLOW_START_BLOCK` — where the EIP-7708 native-transfer sweep begins.
 *
 * **Leaving it unset means the stream indexes from `latest` and Tier 1 has no
 * history**, which is not an error, an empty table or a warning at quote time — it is
 * a borrower whose verified income is zero and whose limit is therefore zero, for a
 * reason nothing in the request can see. `INFLOW_LOOKBACK` defaults to 90 days, which
 * at 0.514 s per block is roughly 15.1 million blocks; set this to
 * `head - 15_100_000` or to whatever earlier block the operator's own record begins
 * at. The variable is a block number rather than an address, which is exactly why the
 * emitter's address is written in this file beside it (DEC-55) — the address was
 * never the thing that varies.
 *
 * ## The backfill blocker this file must state rather than let someone discover
 *
 * The sweep this variable enables has never completed. Measured on 2026-08-02 against
 * the live deployment: **390 blocks of a 194,092-block range in nine minutes, with 641
 * shed responses escaping the transport's retries.** CLAUDE.md's prescribed escape —
 * Envio HyperRPC — became **token-gated behind an interactive signup the same day**, so
 * it is an access-acquisition item and not a configuration change. Until an endpoint
 * exists that will answer, a ninety-day inflow backfill against the public RPC is not
 * achievable, and the honest consequence is that Tier 1 proposes **zero** rather than a
 * plausible number. `services/origination/src/tier1.ts` defaults to exactly that.
 *
 * ## The corridor and the credit ladder (Phase 7)
 *
 * Six more sources, every one registered through `watch` or `watchAll` so that an address
 * and a start block stay one decision (DEC-54):
 *
 * - `PLAZO_FX_GUARD_ADDRESS` — the FX deviation guard (07-03)
 * - `PLAZO_PLEDGE_VAULT_ADDRESS` — pledged dollar collateral (07-04)
 * - `PLAZO_TIERED_UNDERWRITER_ADDRESS` — the tier composite (07-07)
 * - `PLAZO_MERCHANT_CURRENCY_ADDRESS` — payout-currency elections (07-09)
 * - `PLAZO_EURC_POOL_ADDRESS` — **the second `TranchedCreditPool`**, joined to the USDC
 *   book under one `TranchedCreditPool` key through `watchAll`. Both books emit the same
 *   ABI; what tells their rows apart is `event.log.address`, which is why every pool
 *   table now carries `pool`.
 * - `PLAZO_CHECKOUT_ROUTER_ADDRESS_LEGACY2` — the third router, above.
 *
 * And one address that is deliberately **not** a source:
 *
 * - `PLAZO_PAYROLL_SWEEPER_ADDRESS` — the payroll sweeper (07-05). Its three events all
 *   carry the plan's counterparty as an indexed address beside a `planId`, so schema v5
 *   declines to list them and there is nothing here to subscribe to. The address is still
 *   needed, as a **comparison**: a sweep settles its installment through
 *   `InstallmentPlan.repay`, so the plan emits `CheckCleared(…, keeper)` with this address
 *   in `keeper`, and that equality is the whole of "this was payroll". It lives in this
 *   file rather than in `.env.example` for DEC-55's reason, which is about where an
 *   address is written down and not about whether it is watched.
 */
import {createConfig, factory} from "ponder";
import {parseAbi, parseAbiItem} from "viem";

import {
  ARC_MAX_LOG_RANGE,
  ARC_NATIVE_TRANSFER_EMITTER,
  ARC_TESTNET_CHAIN_ID,
} from "@plazo/plan-core";
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
  FX_DEVIATION_GUARD_ABI,
  MERCHANT_CURRENCY_REGISTRY_ABI,
  PLEDGE_VAULT_ABI,
  TIERED_UNDERWRITER_ABI,
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
const watch = (name: string, fixed?: `0x${string}`) => {
  const configured = process.env[name];
  const address = fixed ?? at(name);
  // For a Plazo deployment `name` holds the address, and the whole stack shares one
  // `PLAZO_START_BLOCK` because it was all deployed together. For a **network
  // constant** — the EIP-7708 system emitter, which is not ours to deploy and whose
  // address is written into this file — `name` holds the block to start from instead,
  // because the address was never the variable and the start block is. Either way the
  // pairing is the rule: a source is registered with a start block or not at all.
  if (!configured) return {address, startBlock: "latest" as const};
  return {address, startBlock: fixed ? Number(configured) : startBlock};
};

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

/**
 * The system emitter's whole surface: one canonical ERC-20 `Transfer`.
 *
 * Written here rather than taken from `@plazo/events`, which versions the *protocol's*
 * event schema and freezes it against a hash. This is not a Plazo event — it is Arc's,
 * it is the standard signature every ERC-20 has emitted since 2015, and putting it
 * behind a schema-version bump would tie a network constant to a governance artefact.
 */
const NATIVE_TRANSFER_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
] as const;

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
      // All three vintages. See `atAll` and the header: the current corridor-aware
      // router, 06-13's merchant-plane router, and vintage 3's from before it. Either
      // legacy left unset is that vintage's origination history reported as never having
      // happened.
      ...watchAll(
        "PLAZO_CHECKOUT_ROUTER_ADDRESS",
        "PLAZO_CHECKOUT_ROUTER_ADDRESS_LEGACY",
        "PLAZO_CHECKOUT_ROUTER_ADDRESS_LEGACY2",
      ),
    },
    // **Two books under one key.** Phase 7 deploys a second pool for the EURC corridor
    // and both emit `TRANCHED_CREDIT_POOL_ABI`, so they are one Ponder source with two
    // addresses rather than two sources — Ponder allows one contract entry per ABI, and
    // splitting them would give the same event name two handler registrations.
    //
    // What keeps their rows apart is `event.log.address`. Every handler in `capital.ts`
    // reads it, and every pool table carries `pool`, because an epoch number is a
    // per-book counter and both books start at one.
    TranchedCreditPool: {
      chain: "arcTestnet",
      abi: parseAbi(TRANCHED_CREDIT_POOL_ABI),
      ...watchAll("PLAZO_CREDIT_POOL_ADDRESS", "PLAZO_EURC_POOL_ADDRESS"),
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
    // The inflow stream (Phase 7). Not a Plazo deployment: this is Arc's own EIP-7708
    // system emitter, which logs a canonical ERC-20 `Transfer` for every native
    // movement because USDC is the gas token. Its address is a network constant and
    // therefore lives here rather than in a deployment record (DEC-55); what varies is
    // the block to begin at, and the header says what leaving it unset costs.
    //
    // **Its values are 18-decimal.** The USDC contract's own `Transfer` for the same
    // movement is 6-decimal, and that contract is deliberately not registered as a
    // second source for this stream. See `src/inflow.ts` and E-08.
    NativeTransferEmitter: {
      chain: "arcTestnet",
      abi: parseAbi(NATIVE_TRANSFER_ABI),
      ...watch("PLAZO_INFLOW_START_BLOCK", ARC_NATIVE_TRANSFER_EMITTER),
    },
    // The corridor and the credit ladder (Phase 7). `PayrollSweeper` is absent by
    // decision and the header says why — it is a comparison, not a source.
    FxDeviationGuard: {
      chain: "arcTestnet",
      abi: parseAbi(FX_DEVIATION_GUARD_ABI),
      ...watch("PLAZO_FX_GUARD_ADDRESS"),
    },
    PledgeVault: {
      chain: "arcTestnet",
      abi: parseAbi(PLEDGE_VAULT_ABI),
      ...watch("PLAZO_PLEDGE_VAULT_ADDRESS"),
    },
    TieredUnderwriter: {
      chain: "arcTestnet",
      abi: parseAbi(TIERED_UNDERWRITER_ABI),
      ...watch("PLAZO_TIERED_UNDERWRITER_ADDRESS"),
    },
    MerchantCurrencyRegistry: {
      chain: "arcTestnet",
      abi: parseAbi(MERCHANT_CURRENCY_REGISTRY_ABI),
      ...watch("PLAZO_MERCHANT_CURRENCY_ADDRESS"),
    },
  },
});

/**
 * The `PayrollSweeper`, for comparison rather than for subscription.
 *
 * Exported so `src/underwriting.ts` reads the address from the same place every other
 * address is written (DEC-55) instead of reaching into `process.env` beside it. Unset
 * yields the zero address, which no `keeper` will ever equal — so an unconfigured sweeper
 * produces an empty sweep stream rather than a stream that claims every collection was
 * payroll.
 */
export const PAYROLL_SWEEPER = at("PLAZO_PAYROLL_SWEEPER_ADDRESS");
