/**
 * The Plazo event schema, version 2.
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
 *
 * The same rule caught a real leak in Phase 3. `Tier0Underwriter` originally emitted
 * a `personId` — and a pseudonymous person id is `keccak256("PLAZO.PSEUDONYMOUS",
 * wallet)`, which anyone can compute from a wallet address. An indexed `personId` is
 * an indexed wallet wearing a hash, and indexing the stream on it would rebuild the
 * exact diary this rule exists to prevent. The field was removed from the events
 * rather than merely de-indexed, because unindexed log data is still log data.
 *
 * ## What changed in v2
 *
 * The origination plane. Phase 3 introduced the checkout router, the funding book,
 * the merchant registry, Tier 0, the kill switch, the parameter registry and the
 * pause plane; nineteen events describe them. Nothing in v1 was removed or
 * renamed — every historical row still decodes — so the migration for a v1 consumer
 * is to ignore contracts it does not know, and a bump was taken rather than a silent
 * append because a committed hash that only changes when someone remembers is not a
 * commitment.
 */
import {keccak256, toHex} from "viem";

export const SCHEMA_VERSION = 2 as const;

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

/**
 * Origination. Added in v2 — the checkout router, the funding book, Tier 0, the
 * kill switch, the parameter registry and the pause plane.
 */
const ORIGINATION_EVENTS: EventDefinition[] = [
  {
    name: "LimitAttested",
    contract: "CheckoutRouter",
    fields: [
      field("sessionId", "bytes32", true),
      field("band", "uint8"),
      field("attestor", "address", true),
    ],
    purpose:
      "The credit decision, as a band and never a figure. Enough for an operator to spot an anomalous distribution from a compromised signing key and for an LP to see the book's shape; not enough to reconstruct a borrower's exact credit line from a public log.",
  },
  {
    name: "OriginationCompleted",
    contract: "CheckoutRouter",
    fields: [
      field("planId", "bytes32", true),
      field("merchant", "address", true),
      field("principal", "uint256"),
      field("mdr", "uint256"),
      field("withheld", "uint256"),
    ],
    purpose:
      "A plan exists and the merchant has been paid, in one transaction. `withheld` is the vesting fraction diverted into the merchant's own bond — the settlement facts a merchant reconciles against.",
  },
  {
    name: "ReceivableMinted",
    contract: "ReceivableToken",
    fields: [
      field("planId", "bytes32", true),
      field("to", "address", true),
      field("principal", "uint256"),
    ],
    purpose:
      "The transfer-restricted receivable, minted at the first origination rather than in a later compliance phase. `tokenId` is the `planId`.",
  },
  {
    name: "Fronted",
    contract: "CreditPool",
    fields: [
      field("planId", "bytes32", true),
      field("merchant", "address", true),
      field("principal", "uint256"),
      field("mdr", "uint256"),
    ],
    purpose:
      "Capital out. NAV-neutral by construction: the fee net of the plan's delinquency escrow is deferred rather than recognised, so no origination makes the book look richer.",
  },
  {
    name: "Recognised",
    contract: "CreditPool",
    fields: [
      field("planId", "bytes32", true),
      field("inflow", "uint256"),
      field("principalRecovered", "uint256"),
      field("incomeEarned", "uint256"),
    ],
    purpose:
      "The permissionless book crank. Moves no money — it reads the plan's own accumulators and books the delta, so a donation to the pool never reaches NAV.",
  },
  {
    name: "UnmarkedDelinquency",
    contract: "CreditPool",
    fields: [field("planId", "bytes32", true), field("unmarked", "bool")],
    purpose:
      "The book has seen a delinquency nobody recorded, and origination is shut until someone does. What makes the bountied mark unavoidable rather than merely available.",
  },
  {
    name: "Deposited",
    contract: "CreditPool",
    fields: [
      field("tranche", "uint8", true),
      field("holder", "address", true),
      field("assets", "uint256"),
      field("shares", "uint256"),
    ],
    purpose:
      "Capital in. `holder` is indexed because a lender is an institutional counterparty, not a data subject with an erasure right.",
  },
  {
    name: "Redeemed",
    contract: "CreditPool",
    fields: [
      field("tranche", "uint8", true),
      field("holder", "address", true),
      field("shares", "uint256"),
      field("assets", "uint256"),
    ],
    purpose: "Capital out, at the tranche's own share price.",
  },
  {
    name: "ReserveFunded",
    contract: "CreditPool",
    fields: [
      field("from", "address", true),
      field("amount", "uint256"),
      field("balance", "uint256"),
    ],
    purpose:
      "The first-loss reserve. Issues no shares and confers no claim, which is what makes it first-loss rather than another tranche.",
  },
  {
    name: "KybAttested",
    contract: "MerchantRegistry",
    fields: [
      field("merchant", "address", true),
      field("verified", "bool"),
      field("attestor", "address", true),
    ],
    purpose:
      "The KYB itself is off-chain and always will be. What is on-chain is that a named key asserted it and when, so a merchant onboarded without one is visible rather than merely undocumented.",
  },
  {
    name: "BondPosted",
    contract: "MerchantRegistry",
    fields: [
      field("merchant", "address", true),
      field("from", "address", true),
      field("amount", "uint256"),
      field("total", "uint256"),
    ],
    purpose: "Merchant capital in. Anyone may fund a merchant's bond.",
  },
  {
    name: "BondWithheld",
    contract: "MerchantRegistry",
    fields: [
      field("merchant", "address", true),
      field("planId", "bytes32", true),
      field("amount", "uint256"),
      field("total", "uint256"),
    ],
    purpose:
      "A new merchant's own settlement capitalising their own bond. What makes the exposure-scaled requirement self-funding rather than an entry cost a well-capitalised attacker pays once.",
  },
  {
    name: "ExposureChanged",
    contract: "MerchantRegistry",
    fields: [
      field("merchant", "address", true),
      field("outstanding", "uint256"),
      field("requiredBond", "uint256"),
    ],
    purpose:
      "Fronted principal not yet recovered, and the bond it demands. The pair is the whole fraud posture: skin in the game proportional to what could be walked away with.",
  },
  {
    name: "PlanNoted",
    contract: "Tier0Underwriter",
    fields: [field("planId", "bytes32", true), field("principal", "uint256")],
    purpose:
      "A borrower's active-plan slot closing. Carries no person id: a pseudonymous one is computable from a wallet, so emitting it would rebuild the purchase diary the whole schema is keyed to avoid.",
  },
  {
    name: "PlanSettled",
    contract: "Tier0Underwriter",
    fields: [field("planId", "bytes32", true), field("clean", "bool")],
    purpose:
      "The slot reopening, and whether the plan finished with no missed installment. `clean` is derived from the plan contract, never reported — a caller-supplied outcome would be a limit increase anybody could mint.",
  },
  {
    name: "FirstPaymentObserved",
    contract: "FirstPaymentDefaultSwitch",
    fields: [
      field("planId", "bytes32", true),
      field("defaulted", "bool"),
      field("seasoned", "bool"),
      field("observer", "address", true),
    ],
    purpose:
      "The kill switch's only input, read off the plan by anyone. `seasoned` is frozen at origination because seasoning at the time of the decision is what was priced.",
  },
  {
    name: "ThrottleChanged",
    contract: "FirstPaymentDefaultSwitch",
    fields: [
      field("throttleBps", "uint256"),
      field("fpdBps", "uint256"),
      field("cohortSize", "uint256"),
    ],
    purpose:
      "Graduated rather than binary. A book that stops originating entirely while its liabilities keep running is a book in runoff, and a switch with only two settings gets left on the wrong one.",
  },
  {
    name: "ParameterSet",
    contract: "ParameterRegistry",
    fields: [field("key", "bytes32", true), field("previous", "uint256"), field("value", "uint256")],
    purpose:
      "Every Appendix A recalibration, with what it was. The bands are hard-coded and cannot be widened, so this is the complete record of governance's reach.",
  },
  {
    name: "GlobalPauseSet",
    contract: "OriginationPause",
    fields: [field("paused", "bool"), field("by", "address", true)],
    purpose:
      "New credit stopped, or restarted. Cannot reach a live plan: repayment and every cure path are unpausable by construction, so no setting here can manufacture a default.",
  },
  {
    name: "CorridorPauseSet",
    contract: "OriginationPause",
    fields: [
      field("corridor", "bytes32", true),
      field("paused", "bool"),
      field("by", "address", true),
    ],
    purpose: "One corridor closed without closing the protocol.",
  },
];

export const EVENT_SCHEMA: readonly EventDefinition[] = Object.freeze([
  ...PLAN_EVENTS,
  ...POOL_EVENTS,
  ...MERCHANT_EVENTS,
  ...PASSPORT_EVENTS,
  ...ORIGINATION_EVENTS,
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

export const CHECKOUT_ROUTER_ABI = [
  "event LimitAttested(bytes32 indexed sessionId, uint8 band, address indexed attestor)",
  "event OriginationCompleted(bytes32 indexed planId, address indexed merchant, uint256 principal, uint256 mdr, uint256 withheld)",
] as const;

export const RECEIVABLE_TOKEN_ABI = [
  "event ReceivableMinted(bytes32 indexed planId, address indexed to, uint256 principal)",
] as const;

export const CREDIT_POOL_ABI = [
  "event LossAbsorbed(bytes32 indexed planId, uint256 fromReserve, uint256 fromJunior, uint256 fromSenior)",
  "event OriginationGated(bool open, uint256 subordinationBps, uint256 reserveBps)",
  "event Fronted(bytes32 indexed planId, address indexed merchant, uint256 principal, uint256 mdr)",
  "event Recognised(bytes32 indexed planId, uint256 inflow, uint256 principalRecovered, uint256 incomeEarned)",
  "event UnmarkedDelinquency(bytes32 indexed planId, bool unmarked)",
  "event Deposited(uint8 indexed tranche, address indexed holder, uint256 assets, uint256 shares)",
  "event Redeemed(uint8 indexed tranche, address indexed holder, uint256 shares, uint256 assets)",
  "event ReserveFunded(address indexed from, uint256 amount, uint256 balance)",
] as const;

export const MERCHANT_REGISTRY_ABI = [
  "event MerchantRegistered(address indexed merchant, uint256 bond)",
  "event KybAttested(address indexed merchant, bool verified, address indexed attestor)",
  "event BondPosted(address indexed merchant, address indexed from, uint256 amount, uint256 total)",
  "event BondWithheld(address indexed merchant, bytes32 indexed planId, uint256 amount, uint256 total)",
  "event ExposureChanged(address indexed merchant, uint256 outstanding, uint256 requiredBond)",
] as const;

export const TIER0_UNDERWRITER_ABI = [
  "event PlanNoted(bytes32 indexed planId, uint256 principal)",
  "event PlanSettled(bytes32 indexed planId, bool clean)",
] as const;

export const KILL_SWITCH_ABI = [
  "event FirstPaymentObserved(bytes32 indexed planId, bool defaulted, bool seasoned, address indexed observer)",
  "event ThrottleChanged(uint256 throttleBps, uint256 fpdBps, uint256 cohortSize)",
] as const;

export const PARAMETER_REGISTRY_ABI = [
  "event ParameterSet(bytes32 indexed key, uint256 previous, uint256 value)",
] as const;

export const ORIGINATION_PAUSE_ABI = [
  "event GlobalPauseSet(bool paused, address indexed by)",
  "event CorridorPauseSet(bytes32 indexed corridor, bool paused, address indexed by)",
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
  "0x4407b0ce57e557bf9f9c1232ddca2ee5edab6c4465b0d67e568a84a267f4295e";

/**
 * Every prior schema hash, newest first.
 *
 * Kept so a migration can be verified rather than asserted: an indexer replaying
 * history knows exactly which schema each block range was written under, and a
 * reviewer can tell a deliberate bump from an accidental one. v1 is
 * `0x84a83a60…3663d` — Phases 1 and 2.
 */
export const PRIOR_SCHEMA_HASHES: readonly `0x${string}`[] = Object.freeze([
  "0x84a83a60587bb9269844f7ec68d3ca09fd1e50a18d7dad7dad3e4e251af3663d",
]);
