/**
 * The Plazo event schema, version 3.
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
 *
 * ## What changed in v3, and why this one is not additive
 *
 * The capital plane and the Passport, and unlike v2 this bump **rewrites** entries
 * rather than appending to them.
 *
 * Phases 1 and 2 wrote the pool and Passport definitions *before* those contracts
 * existed — deliberately, because the schema was frozen first so the contracts would
 * have to satisfy it. Mostly that worked. Where it did not is that the placeholder
 * entries named contracts that were never built (`EpochAccountant`,
 * `RedemptionQueue`, `Passport`) and guessed at field lists. Phase 5 built one
 * `TranchedCreditPool` rather than three contracts, because splitting the balance
 * sheet across three would have put one NAV in three places.
 *
 * Those entries are corrected here rather than carried. A schema describing contracts
 * that do not exist is worse than one that is out of date: an indexer configured
 * against it silently receives nothing, and nobody finds out until an LP asks why the
 * NAV chart is empty. **No event that was ever emitted has been changed** — the
 * rewritten entries had no emitters, which is exactly what made them safe to fix and
 * is why the migration for a v2 consumer is still "ignore what you do not know".
 *
 * Two substantive changes, both of which reverse an earlier note on purpose:
 *
 * **The redemption queue carries its holder.** v1 said it deliberately did not,
 * because "queue depth is public, queue membership is not". POOL-02 then made the
 * tranche shares transfer-restricted ERC-20s, and an ERC-20's holder set is public by
 * construction — every `Transfer` reveals it. Withholding the holder here would
 * protect nothing while making a lender unable to see their own queue position without
 * an archive query.
 *
 * **Every Passport event is keyed by a salted subject rather than by the wallet.**
 * This is the reverse trade and it is the more important one. `keccak256(prefix ‖ salt
 * ‖ borrower)`, with the salt readable only by the borrower and the operator, so the
 * stream is indexable by whoever is entitled to read it and is not enumerable by
 * somebody holding a list of wallet addresses. It also makes erasure free: rotating the
 * salt orphans the entire prior stream. The first draft of `PlazoPassport` indexed the
 * borrower directly, which would have made the credit record itself a permanent public
 * file — the same leak Phase 3 caught in `Tier0Underwriter`'s `personId`, one layer up.
 */
import {keccak256, toHex} from "viem";

export const SCHEMA_VERSION = 3 as const;

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
    contract: "TranchedCreditPool",
    fields: [
      field("epoch", "uint256", true),
      field("seniorNav", "uint256"),
      field("juniorNav", "uint256"),
      field("liquidityFeeBps", "uint256"),
    ],
    purpose:
      "NAV struck. Every deposit and redemption in the epoch prices against this one number per tranche, which is what makes being first through the door worth nothing.",
  },
  {
    name: "EpochMarked",
    contract: "TranchedCreditPool",
    fields: [
      field("epoch", "uint256", true),
      field("marked", "uint256"),
      field("openPlans", "uint256"),
    ],
    purpose:
      "The mark phase's progress. An LP watching an epoch that will not close can see whether the crank is behind or the book is blocked on an unmarked delinquency.",
  },
  {
    name: "Provisioned",
    contract: "TranchedCreditPool",
    fields: [
      field("planId", "bytes32", true),
      field("epoch", "uint256"),
      field("amount", "uint256"),
      field("total", "uint256"),
    ],
    purpose:
      "Bucketed by the epoch that raised it, so a cure releases exactly what the delinquency took. Un-bucketed release is a harvestable NAV oscillation and junior wears it.",
  },
  {
    name: "ProvisionReleased",
    contract: "TranchedCreditPool",
    fields: [
      field("planId", "bytes32", true),
      field("epoch", "uint256"),
      field("amount", "uint256"),
      field("total", "uint256"),
    ],
    purpose: "The cure round trip. Must exactly reverse a Provisioned in the same bucket.",
  },
  {
    name: "LossAbsorbed",
    contract: "TranchedCreditPool",
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
    name: "FraudLossAbsorbed",
    contract: "TranchedCreditPool",
    fields: [
      field("planId", "bytes32", true),
      field("fromReserve", "uint256"),
      field("beyondReserve", "uint256"),
    ],
    purpose:
      "POOL-14. A fraud is not a credit loss and does not belong in the waterfall senior was sold on. A separate event so a lender can tell the two apart in their own performance data.",
  },
  {
    name: "OriginationGated",
    contract: "TranchedCreditPool",
    fields: [field("open", "bool"), field("subordinationBps", "uint256"), field("reserveBps", "uint256")],
    purpose: "The subordination and reserve floors binding. Visible to LPs in real time.",
  },
  {
    name: "DepositRequested",
    contract: "TranchedCreditPool",
    fields: [
      field("tranche", "uint8", true),
      field("holder", "address", true),
      field("epoch", "uint256"),
      field("assets", "uint256"),
    ],
    purpose:
      "Money escrowed against a price that does not exist yet. Confers no claim and is excluded from NAV until the epoch closes.",
  },
  {
    name: "SharesClaimed",
    contract: "TranchedCreditPool",
    fields: [
      field("tranche", "uint8", true),
      field("holder", "address", true),
      field("assets", "uint256"),
      field("shares", "uint256"),
    ],
    purpose: "A settled deposit collected. The pair of DepositRequested, one epoch later.",
  },
  {
    name: "RedeemRequested",
    contract: "TranchedCreditPool",
    fields: [
      field("tranche", "uint8", true),
      field("holder", "address", true),
      field("index", "uint256"),
      field("shares", "uint256"),
      field("position", "uint256"),
    ],
    purpose:
      "A cumulative queue position. It carries the holder, reversing a v1 note: POOL-02 made the shares transfer-restricted ERC-20s, whose holder set is already public in every Transfer, so withholding it here would protect nothing and would stop a lender seeing their own position.",
  },
  {
    name: "QueueFilled",
    contract: "TranchedCreditPool",
    fields: [
      field("tranche", "uint8", true),
      field("epoch", "uint256", true),
      field("shares", "uint256"),
      field("assets", "uint256"),
      field("feeBps", "uint256"),
    ],
    purpose:
      "One fill per tranche per epoch, at one rate. POOL-09's uniformity is checkable from the log alone: two rates in one epoch would be visible here.",
  },
  {
    name: "RedemptionClaimed",
    contract: "TranchedCreditPool",
    fields: [
      field("tranche", "uint8", true),
      field("holder", "address", true),
      field("index", "uint256"),
      field("assets", "uint256"),
    ],
    purpose: "Proceeds collected from a filled ticket.",
  },
  {
    name: "ReserveFunded",
    contract: "TranchedCreditPool",
    fields: [field("from", "address", true), field("amount", "uint256"), field("balance", "uint256")],
    purpose:
      "The first-loss reserve. Permissionless — it issues no shares and confers no claim, which is what makes it first-loss rather than another tranche.",
  },
  {
    name: "Seeded",
    contract: "TranchedCreditPool",
    fields: [field("tranche", "uint8", true), field("assets", "uint256"), field("shares", "uint256")],
    purpose:
      "POOL-12's permanent seed. Protocol money, never redeemable, and the reason the first-depositor-into-an-empty-vault case is unreachable rather than merely expensive.",
  },
  {
    name: "VenueSynced",
    contract: "TranchedCreditPool",
    fields: [field("delta", "int256"), field("deployed", "uint256")],
    purpose:
      "POOL-13. The buffer position marked to what it would return rather than to what it cost. A gain goes down the income waterfall; a shortfall goes down the loss waterfall.",
  },
  {
    name: "Fronted",
    contract: "TranchedCreditPool",
    fields: [
      field("planId", "bytes32", true),
      field("merchant", "address", true),
      field("principal", "uint256"),
      field("mdr", "uint256"),
    ],
    purpose: "Capital leaving the book against a receivable. NAV-neutral by construction.",
  },
  {
    name: "Recognised",
    contract: "TranchedCreditPool",
    fields: [
      field("planId", "bytes32", true),
      field("inflow", "uint256"),
      field("principalRecovered", "uint256"),
      field("incomeEarned", "uint256"),
    ],
    purpose:
      "The permissionless crank that keeps NAV honest. The pool learns from the plan's own accounting, never from its token balance.",
  },
  {
    name: "UnmarkedDelinquency",
    contract: "TranchedCreditPool",
    fields: [field("planId", "bytes32", true), field("unmarked", "bool")],
    purpose:
      "What blocks an epoch from closing. The reason somebody always has a motive to pay for a mark nobody profits from cranking.",
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
 * Passport. Commitments and counters — never a readable record, and never a wallet.
 *
 * Every event is keyed by `subject` = `keccak256(prefix | salt | borrower)`. The salt is
 * readable only by the borrower and the operator, so this stream is indexable by whoever
 * is entitled to read it and is not enumerable by somebody holding a list of addresses.
 * Rotating the salt on erasure orphans the whole prior stream.
 */
const PASSPORT_EVENTS: EventDefinition[] = [
  {
    name: "OutcomeNoted",
    contract: "PlazoPassport",
    fields: [
      field("subject", "bytes32", true),
      field("clean", "bool"),
      field("completions", "uint32"),
      field("negativesEver", "uint32"),
    ],
    purpose:
      "How a plan ended, written by a permissionless self-verifying path. The counters are what the tier is a pure function of, which is what makes PASS-06 checkable rather than believable.",
  },
  {
    name: "NegativeNoted",
    contract: "PlazoPassport",
    fields: [field("subject", "bytes32", true), field("at", "uint64"), field("negativesEver", "uint32")],
    purpose:
      "A delinquency, recorded when it happens rather than when the plan terminates — otherwise the tier always describes a borrower's position several weeks ago.",
  },
  {
    name: "CommitmentWritten",
    contract: "PlazoPassport",
    fields: [
      field("subject", "bytes32", true),
      field("version", "uint64"),
      field("commitment", "bytes32"),
      field("schemaId", "bytes32"),
    ],
    purpose:
      "keccak256(version | salt | recordHash). Not the record, and not the subject. A soulbound readable credit record cannot satisfy FCRA correction, NYDFS deletion or GDPR erasure — you cannot unpublish a chain.",
  },
  {
    name: "SaltRotated",
    contract: "PlazoPassport",
    fields: [
      field("previousSubject", "bytes32", true),
      field("subject", "bytes32", true),
      field("version", "uint64"),
    ],
    purpose:
      "Erasure. Both subjects appear together once, here and nowhere else, so a borrower can prove continuity to a counterparty they choose while nobody else can follow the chain.",
  },
  {
    name: "CorrectionRequested",
    contract: "PlazoPassport",
    fields: [
      field("subject", "bytes32", true),
      field("disputed", "bytes32", true),
      field("reason", "string"),
    ],
    purpose:
      "PASS-07. The borrower's own transaction, so the request is on the chain rather than in a support queue only the operator can see.",
  },
  {
    name: "ConsentGranted",
    contract: "PlazoPassport",
    fields: [
      field("subject", "bytes32", true),
      field("reader", "address", true),
      field("schemaId", "bytes32", true),
      field("validUntil", "uint256"),
    ],
    purpose:
      "PASS-04. The reader is indexed because a reader is a business counterparty who needs to enumerate the grants they hold; the borrower stays behind the salt.",
  },
  {
    name: "ConsentRevoked",
    contract: "PlazoPassport",
    fields: [
      field("subject", "bytes32", true),
      field("reader", "address", true),
      field("schemaId", "bytes32", true),
    ],
    purpose: "Effective immediately. A revocation that took effect at the next renewal would be an expiry.",
  },
  {
    name: "SchemaPublished",
    contract: "AttestationSchemaRegistry",
    fields: [
      field("schemaId", "bytes32", true),
      field("version", "uint64", true),
      field("contentHash", "bytes32"),
      field("uri", "string"),
    ],
    purpose:
      "PASS-05. A commitment means nothing without a published schema, and a schema that could change under a commitment would make every historical record unverifiable.",
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

/**
 * Servicing. Added in v3 — the relayer gate and the pool registry.
 */
const SERVICING_EVENTS: EventDefinition[] = [
  {
    name: "Collected",
    contract: "RelayerGate",
    fields: [
      field("plan", "address", true),
      field("index", "uint256", true),
      field("cleared", "bool"),
      field("reason", "uint8"),
    ],
    purpose:
      "COLL-07. Every collection the operator makes comes through this one address and every one of them is late, so COLL-10's share of third-party cranks is measurable from the chain rather than from the operator's own count.",
  },
  {
    name: "PoolRegistered",
    contract: "PoolRegistry",
    fields: [field("productLine", "bytes32", true), field("pool", "address", true)],
    purpose:
      "POOL-01. One book per product line, registered once. A line whose pool could be repointed would settle outstanding plans to yesterday's book while today's lenders think they own the receivable.",
  },
];

export const EVENT_SCHEMA: readonly EventDefinition[] = Object.freeze([
  ...PLAN_EVENTS,
  ...POOL_EVENTS,
  ...MERCHANT_EVENTS,
  ...PASSPORT_EVENTS,
  ...ORIGINATION_EVENTS,
  ...SERVICING_EVENTS,
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

export const TRANCHED_CREDIT_POOL_ABI = [
  "event EpochClosed(uint256 indexed epoch, uint256 seniorNav, uint256 juniorNav, uint256 liquidityFeeBps)",
  "event EpochMarked(uint256 indexed epoch, uint256 marked, uint256 openPlans)",
  "event Provisioned(bytes32 indexed planId, uint256 epoch, uint256 amount, uint256 total)",
  "event ProvisionReleased(bytes32 indexed planId, uint256 epoch, uint256 amount, uint256 total)",
  "event LossAbsorbed(bytes32 indexed planId, uint256 fromReserve, uint256 fromJunior, uint256 fromSenior)",
  "event FraudLossAbsorbed(bytes32 indexed planId, uint256 fromReserve, uint256 beyondReserve)",
  "event OriginationGated(bool open, uint256 subordinationBps, uint256 reserveBps)",
  "event DepositRequested(uint8 indexed tranche, address indexed holder, uint256 epoch, uint256 assets)",
  "event SharesClaimed(uint8 indexed tranche, address indexed holder, uint256 assets, uint256 shares)",
  "event RedeemRequested(uint8 indexed tranche, address indexed holder, uint256 index, uint256 shares, uint256 position)",
  "event QueueFilled(uint8 indexed tranche, uint256 indexed epoch, uint256 shares, uint256 assets, uint256 feeBps)",
  "event RedemptionClaimed(uint8 indexed tranche, address indexed holder, uint256 index, uint256 assets)",
  "event ReserveFunded(address indexed from, uint256 amount, uint256 balance)",
  "event Seeded(uint8 indexed tranche, uint256 assets, uint256 shares)",
  "event VenueSynced(int256 delta, uint256 deployed)",
  "event Fronted(bytes32 indexed planId, address indexed merchant, uint256 principal, uint256 mdr)",
  "event Recognised(bytes32 indexed planId, uint256 inflow, uint256 principalRecovered, uint256 incomeEarned)",
  "event UnmarkedDelinquency(bytes32 indexed planId, bool unmarked)",
] as const;

export const PLAZO_PASSPORT_ABI = [
  "event OutcomeNoted(bytes32 indexed subject, bool clean, uint32 completions, uint32 negativesEver)",
  "event NegativeNoted(bytes32 indexed subject, uint64 at, uint32 negativesEver)",
  "event CommitmentWritten(bytes32 indexed subject, uint64 version, bytes32 commitment, bytes32 schemaId)",
  "event SaltRotated(bytes32 indexed previousSubject, bytes32 indexed subject, uint64 version)",
  "event CorrectionRequested(bytes32 indexed subject, bytes32 indexed disputed, string reason)",
  "event ConsentGranted(bytes32 indexed subject, address indexed reader, bytes32 indexed schemaId, uint256 validUntil)",
  "event ConsentRevoked(bytes32 indexed subject, address indexed reader, bytes32 indexed schemaId)",
] as const;

export const ATTESTATION_SCHEMA_REGISTRY_ABI = [
  "event SchemaPublished(bytes32 indexed schemaId, uint64 indexed version, bytes32 contentHash, string uri)",
] as const;

export const RELAYER_GATE_ABI = [
  "event Collected(address indexed plan, uint256 indexed index, bool cleared, uint8 reason)",
] as const;

export const POOL_REGISTRY_ABI = [
  "event PoolRegistered(bytes32 indexed productLine, address indexed pool)",
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
  "0x5805e5cae7e607b0a68c13886383207e5053bebe5de18c59be7561c1cc6212a9";

/**
 * Every prior schema hash, newest first.
 *
 * Kept so a migration can be verified rather than asserted: an indexer replaying
 * history knows exactly which schema each block range was written under, and a
 * reviewer can tell a deliberate bump from an accidental one. v2 is
 * `0x4407b0ce…4295e` — Phase 3's origination plane. v1 is `0x84a83a60…3663d` —
 * Phases 1 and 2.
 *
 * v3 is the first bump that is not additive, so this list is load-bearing rather than
 * courteous: a consumer replaying history has to decode blocks written under v2 with
 * v2's definitions, because six of them named a contract that no longer exists.
 */
export const PRIOR_SCHEMA_HASHES: readonly `0x${string}`[] = Object.freeze([
  "0x4407b0ce57e557bf9f9c1232ddca2ee5edab6c4465b0d67e568a84a267f4295e",
  "0x84a83a60587bb9269844f7ec68d3ca09fd1e50a18d7dad7dad3e4e251af3663d",
]);
