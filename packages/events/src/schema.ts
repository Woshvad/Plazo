/**
 * The Plazo event schema, version 1.
 *
 * The schema is the API. Four surfaces, an indexer, a merchant SDK and every LP
 * report read it, so changing it after they exist is a full-stack refactor rather
 * than a contract edit. It is therefore frozen: `SCHEMA_HASH` is committed, CI
 * recomputes it, and a change without a version bump fails the build.
 *
 * ## Privacy is a schema decision, not a policy
 *
 * No event below carries a borrower address in an indexed position, and most carry
 * no borrower address at all. Plan events keyed by wallet would let anyone index
 * the log stream into a wallet-keyed purchase history — a permanent, public,
 * uncorrectable credit file. That is a worse exposure than the Passport record it
 * feeds, and no erasure request can reach it.
 *
 * Everything is keyed by `planId` instead. The plan-to-borrower mapping lives in
 * the operator's private database schema, behind the consent gate, where a
 * correction or a deletion can actually be honoured.
 */
import {keccak256, toHex} from "viem";

export const SCHEMA_VERSION = 1 as const;

export interface EventField {
  name: string;
  type: string;
  /** Indexed fields are queryable — and permanently, publicly correlatable. */
  indexed: boolean;
}

export interface EventDefinition {
  name: string;
  contract: string;
  fields: EventField[];
  /** Why this event exists and who consumes it. */
  purpose: string;
}

const field = (name: string, type: string, indexed = false): EventField => ({name, type, indexed});

/**
 * Plan lifecycle. Emitted by `PlanFactory` and each `InstallmentPlan` clone.
 */
const PLAN_EVENTS: EventDefinition[] = [
  {
    name: "PlanDeployed",
    contract: "PlanFactory",
    fields: [
      field("planId", "bytes32", true),
      field("plan", "address", true),
      field("implementation", "address", true),
    ],
    purpose:
      "Origination. The indexer's anchor for a plan. Carries no borrower — the payee address is derivable from planId by anyone, and the borrower is not.",
  },
  {
    name: "CheckCleared",
    contract: "InstallmentPlan",
    fields: [
      field("planId", "bytes32", true),
      field("index", "uint256", true),
      field("amount", "uint256"),
      field("keeper", "address"),
    ],
    purpose:
      "A collection succeeded. `keeper` is unindexed but present: the share of collections cranked by non-operator addresses is the measurable claim that the keeper market is real.",
  },
  {
    name: "CheckBounced",
    contract: "InstallmentPlan",
    fields: [
      field("planId", "bytes32", true),
      field("index", "uint256", true),
      field("reason", "uint8"),
    ],
    purpose:
      "A pull failed without reverting. `reason` distinguishes InsufficientFunds, Blocked, Halted and SignerInvalid — they carry opposite Passport and provisioning treatments, and only the first is a credit event. Collapsing them would make the loss data unreadable.",
  },
  {
    name: "CheckMissed",
    contract: "InstallmentPlan",
    fields: [
      field("planId", "bytes32", true),
      field("index", "uint256", true),
      field("marker", "address"),
    ],
    purpose:
      "The paid negative signal. Nobody profits from cranking a collection that cannot succeed, so without a bountied mark the delinquency is never recorded and NAV provisioning has no input.",
  },
  {
    name: "CheckExpired",
    contract: "InstallmentPlan",
    fields: [
      field("planId", "bytes32", true),
      field("index", "uint256", true),
      field("marker", "address"),
    ],
    purpose: "An authorization passed validBefore uncollected.",
  },
  {
    name: "PlanStateChanged",
    contract: "InstallmentPlan",
    fields: [field("planId", "bytes32", true), field("from", "uint8"), field("to", "uint8")],
    purpose: "The state machine transition log. Drives every surface's plan view.",
  },
  {
    name: "PlanCured",
    contract: "InstallmentPlan",
    fields: [field("planId", "bytes32", true), field("index", "uint256", true)],
    purpose: "A bounced installment cleared. Releases the provision the delinquency raised.",
  },
  {
    name: "PlanDelinquent",
    contract: "InstallmentPlan",
    fields: [field("planId", "bytes32", true), field("lateFee", "uint256")],
    purpose: "Grace expired uncured. Provisions 50% of NAV in the same epoch.",
  },
  {
    name: "PlanRepaid",
    contract: "InstallmentPlan",
    fields: [field("planId", "bytes32", true), field("total", "uint256")],
    purpose: "Terminal. Feeds the Passport limit growth multiplier.",
  },
  {
    name: "PlanChargedOff",
    contract: "InstallmentPlan",
    fields: [field("planId", "bytes32", true), field("outstanding", "uint256")],
    purpose: "Terminal at 60 days past due. Flows the loss down the tranche waterfall.",
  },
  {
    name: "RefundCredited",
    contract: "InstallmentPlan",
    fields: [field("planId", "bytes32", true), field("amount", "uint256")],
    purpose:
      "A merchant refund applied as a plan-level credit. Fixed-value checks cannot be reduced, and mandatory re-signing fails whenever the borrower is offline.",
  },
];

/**
 * Pool and capital-market events. Phase 5 implements them; the schema is frozen now
 * so the indexer and the yield surface are not built twice.
 */
const POOL_EVENTS: EventDefinition[] = [
  {
    name: "EpochClosed",
    contract: "EpochAccountant",
    fields: [
      field("epoch", "uint256", true),
      field("totalAssets", "uint256"),
      field("provisioned", "uint256"),
    ],
    purpose: "NAV struck. Deposits and redemptions in the epoch price against this.",
  },
  {
    name: "ProvisionRaised",
    contract: "EpochAccountant",
    fields: [
      field("epoch", "uint256", true),
      field("planId", "bytes32", true),
      field("amount", "uint256"),
    ],
    purpose:
      "Bucketed by epoch, so a cure releases exactly what the delinquency took. Un-bucketed release is a harvestable NAV oscillation.",
  },
  {
    name: "ProvisionReleased",
    contract: "EpochAccountant",
    fields: [
      field("epoch", "uint256", true),
      field("planId", "bytes32", true),
      field("amount", "uint256"),
    ],
    purpose: "The cure round trip. Must exactly reverse a ProvisionRaised in the same bucket.",
  },
  {
    name: "LossAbsorbed",
    contract: "CreditPool",
    fields: [
      field("planId", "bytes32", true),
      field("fromReserve", "uint256"),
      field("fromJunior", "uint256"),
      field("fromSenior", "uint256"),
    ],
    purpose:
      "The waterfall, itemised. Senior was sold on being struck last; this is the evidence it was.",
  },
  {
    name: "OriginationGated",
    contract: "CreditPool",
    fields: [field("open", "bool"), field("subordinationBps", "uint256"), field("reserveBps", "uint256")],
    purpose: "The subordination and reserve floors binding. Visible to LPs in real time.",
  },
  {
    name: "RedemptionQueued",
    contract: "RedemptionQueue",
    fields: [
      field("tranche", "uint8", true),
      field("position", "uint256"),
      field("shares", "uint256"),
    ],
    purpose:
      "Cumulative queue position. Deliberately carries no holder address — queue depth is public, queue membership is not.",
  },
  {
    name: "LiquidityFeeApplied",
    contract: "RedemptionQueue",
    fields: [field("epoch", "uint256", true), field("feeBps", "uint256")],
    purpose:
      "Uniform across every redeemer in an over-threshold epoch. A gate's threat is itself what causes the run, so the fee replaces it.",
  },
];

/**
 * Merchant plane. Phase 3 and Phase 6.
 */
const MERCHANT_EVENTS: EventDefinition[] = [
  {
    name: "MerchantSettled",
    contract: "PayoutRouter",
    fields: [
      field("planId", "bytes32", true),
      field("merchant", "address", true),
      field("net", "uint256"),
      field("mdr", "uint256"),
    ],
    purpose:
      "Settlement within one block of checkout. `merchant` is indexed because a merchant is a business counterparty, not a data subject with an erasure right.",
  },
  {
    name: "MerchantRegistered",
    contract: "MerchantRegistry",
    fields: [field("merchant", "address", true), field("bond", "uint256")],
    purpose: "The bond scales with outstanding fronted exposure — refund arbitrage is the highest-yield attack on this book.",
  },
  {
    name: "RefundEscrowed",
    contract: "RefundEscrow",
    fields: [field("planId", "bytes32", true), field("amount", "uint256")],
    purpose: "A merchant refund before it reaches the plan.",
  },
];

/**
 * Passport. Commitments only — never a readable record.
 */
const PASSPORT_EVENTS: EventDefinition[] = [
  {
    name: "PassportCommitted",
    contract: "Passport",
    fields: [field("commitment", "bytes32", true), field("recordVersion", "uint256")],
    purpose:
      "keccak256(recordVersion ‖ salt). Not the record, and not the subject. A soulbound readable credit record cannot satisfy FCRA correction, NYDFS deletion or GDPR erasure — you cannot unpublish a chain.",
  },
  {
    name: "PassportSaltRotated",
    contract: "Passport",
    fields: [field("oldCommitment", "bytes32", true), field("newCommitment", "bytes32", true)],
    purpose: "Erasure. Rotating the salt orphans the old commitment without rewriting history.",
  },
];

export const EVENT_SCHEMA: readonly EventDefinition[] = Object.freeze([
  ...PLAN_EVENTS,
  ...POOL_EVENTS,
  ...MERCHANT_EVENTS,
  ...PASSPORT_EVENTS,
]);

/** Solidity event signature, e.g. `CheckCleared(bytes32,uint256,uint256,address)`. */
export function eventSignature(definition: EventDefinition): string {
  return `${definition.name}(${definition.fields.map((f) => f.type).join(",")})`;
}

/** `topic0` for a log filter. */
export function eventTopic(definition: EventDefinition): `0x${string}` {
  return keccak256(toHex(eventSignature(definition)));
}

/** Human-readable ABI line, as viem and abitype consume it. */
export function humanReadableAbi(definition: EventDefinition): string {
  const args = definition.fields
    .map((f) => `${f.type}${f.indexed ? " indexed" : ""} ${f.name}`)
    .join(", ");
  return `event ${definition.name}(${args})`;
}

export const ABI: readonly string[] = Object.freeze(EVENT_SCHEMA.map(humanReadableAbi));

/**
 * The human-readable ABI for one contract's events.
 *
 * The indexer configures contracts individually, and it reads them from here rather
 * than from a generated artefact so that the schema stays the single definition of
 * what a surface is allowed to see. A contract that emits an event this file does
 * not list is a contract the indexer will not index — which is the intended
 * behaviour, not an oversight: adding an event is a version bump and a migration.
 */
export function abiForContract(contract: string): string[] {
  return EVENT_SCHEMA.filter((d) => d.contract === contract).map(humanReadableAbi);
}

/**
 * Const-typed views of the same definitions.
 *
 * `abiForContract` returns `string[]`, and a `string[]` carries no compile-time
 * information — viem's `parseAbi` degrades to a bare `Abi`, and every consumer that
 * relies on inference (Ponder's event names, wagmi's hooks, abitype's argument
 * tuples) loses it. These literals restore it.
 *
 * They are duplication, and the duplication is checked: `test/schema.test.ts` asserts
 * each one equals `abiForContract` for its contract, so the definitions above stay
 * the single source of truth and a drift is a failing build rather than a UI that
 * reads a field the chain stopped emitting.
 */
export const PLAN_FACTORY_ABI = [
  "event PlanDeployed(bytes32 indexed planId, address indexed plan, address indexed implementation)",
] as const;

export const INSTALLMENT_PLAN_ABI = [
  "event CheckCleared(bytes32 indexed planId, uint256 indexed index, uint256 amount, address keeper)",
  "event CheckBounced(bytes32 indexed planId, uint256 indexed index, uint8 reason)",
  "event CheckMissed(bytes32 indexed planId, uint256 indexed index, address marker)",
  "event CheckExpired(bytes32 indexed planId, uint256 indexed index, address marker)",
  "event PlanStateChanged(bytes32 indexed planId, uint8 from, uint8 to)",
  "event PlanCured(bytes32 indexed planId, uint256 indexed index)",
  "event PlanDelinquent(bytes32 indexed planId, uint256 lateFee)",
  "event PlanRepaid(bytes32 indexed planId, uint256 total)",
  "event PlanChargedOff(bytes32 indexed planId, uint256 outstanding)",
  "event RefundCredited(bytes32 indexed planId, uint256 amount)",
] as const;

/**
 * Canonical hash over the whole schema.
 *
 * Covers every name, type, indexed flag and field order — everything an indexer or
 * a UI could break on. Not the purpose strings: prose should be improvable without
 * a version bump.
 */
export function computeSchemaHash(): `0x${string}` {
  const canonical = EVENT_SCHEMA.map(
    (d) =>
      `${d.contract}.${d.name}(${d.fields.map((f) => `${f.type}${f.indexed ? ":indexed" : ""} ${f.name}`).join(",")})`,
  ).join("\n");
  return keccak256(toHex(`plazo-events/v${SCHEMA_VERSION}\n${canonical}`));
}

/**
 * The committed hash.
 *
 * If CI fails against this, the schema changed. That is not a merge conflict to
 * resolve by pasting the new value — it means an indexer, four surfaces and every
 * historical row are now describing something else. Bump `SCHEMA_VERSION`, write
 * the migration, then update this.
 */
export const SCHEMA_HASH: `0x${string}` =
  "0x84a83a60587bb9269844f7ec68d3ca09fd1e50a18d7dad7dad3e4e251af3663d";
