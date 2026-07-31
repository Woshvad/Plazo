/**
 * Indexing handlers for the origination plane.
 *
 * Everything the checkout router, the funding book, the merchant registry, Tier 0,
 * the kill switch, the parameter registry and the pause plane emit.
 *
 * The same two rules as the plan handlers apply and are worth restating, because
 * they are what the whole storage split rests on.
 *
 * **No handler writes a borrower address, and none could.** Not one origination
 * event carries one. `Tier0Underwriter` deliberately does not emit a `personId`
 * either: a pseudonymous person id is `keccak256("PLAZO.PSEUDONYMOUS", wallet)`, so
 * indexing it would be indexing the wallet and would rebuild the purchase diary the
 * whole schema is keyed to avoid.
 *
 * **What is stored is what was emitted.** The credit band, never a limit. An indexer
 * that resolved the band back into a figure by reading the chain would be
 * reconstructing the exact disclosure the banding exists to prevent, and it would do
 * it in a database an operator can be compelled to produce.
 */
import {ponder} from "ponder:registry";
import {
  attestation,
  bookEntry,
  firstPaymentObservation,
  gateReading,
  merchant,
  origination,
  parameterChange,
  pauseEvent,
  throttleReading,
} from "ponder:schema";

const cohortOf = (timestamp: number): string => {
  const date = new Date(timestamp * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

const eventId = (event: {block: {number: bigint}; log: {logIndex: number}}): string =>
  `${event.block.number}-${event.log.logIndex}`;

const ZERO_HASH = `0x${"00".repeat(32)}` as const;

// ─── Checkout ─────────────────────────────────────────────────────────────────

/**
 * The credit decision, kept apart from the plan it authorised.
 *
 * Not joined to `origination`, and that is the design rather than an omission. The
 * band exists so an operator can spot a signing key issuing an anomalous
 * distribution; it does not need to say which borrower got which band, and a table
 * that could answer that is a table an operator could be compelled to produce.
 */
ponder.on("CheckoutRouter:LimitAttested", async ({event, context}) => {
  await context.db
    .insert(attestation)
    .values({
      sessionId: event.args.sessionId,
      band: event.args.band,
      attestor: event.args.attestor,
      blockNumber: event.block.number,
      timestamp: Number(event.block.timestamp),
    })
    .onConflictDoNothing();
});

ponder.on("CheckoutRouter:OriginationCompleted", async ({event, context}) => {
  const timestamp = Number(event.block.timestamp);

  await context.db
    .insert(origination)
    .values({
      planId: event.args.planId,
      merchant: event.args.merchant,
      principal: event.args.principal,
      mdr: event.args.mdr,
      withheld: event.args.withheld,
      blockNumber: event.block.number,
      timestamp,
      cohort: cohortOf(timestamp),
    })
    .onConflictDoUpdate(() => ({
      merchant: event.args.merchant,
      principal: event.args.principal,
      mdr: event.args.mdr,
      withheld: event.args.withheld,
    }));

  await context.db
    .insert(merchant)
    .values({
      address: event.args.merchant,
      registeredAt: timestamp,
      originations: 1,
      principalOriginated: event.args.principal,
    })
    .onConflictDoUpdate((row) => ({
      originations: row.originations + 1,
      principalOriginated: row.principalOriginated + event.args.principal,
    }));
});

// ─── The funding book ─────────────────────────────────────────────────────────

ponder.on("CreditPool:Fronted", async ({event, context}) => {
  await context.db
    .insert(bookEntry)
    .values({
      planId: event.args.planId,
      merchant: event.args.merchant,
      principal: event.args.principal,
    })
    .onConflictDoNothing();
});

ponder.on("CreditPool:Recognised", async ({event, context}) => {
  await context.db
    .insert(bookEntry)
    .values({
      planId: event.args.planId,
      merchant: ZERO_HASH.slice(0, 42) as `0x${string}`,
      principal: 0n,
      recognisedInflow: event.args.inflow,
      principalRecovered: event.args.principalRecovered,
      incomeEarned: event.args.incomeEarned,
      lastRecognisedAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate((row) => ({
      recognisedInflow: row.recognisedInflow + event.args.inflow,
      principalRecovered: row.principalRecovered + event.args.principalRecovered,
      incomeEarned: row.incomeEarned + event.args.incomeEarned,
      lastRecognisedAt: Number(event.block.timestamp),
    }));
});

ponder.on("CreditPool:LossAbsorbed", async ({event, context}) => {
  const total = event.args.fromReserve + event.args.fromJunior + event.args.fromSenior;

  await context.db
    .insert(bookEntry)
    .values({
      planId: event.args.planId,
      merchant: ZERO_HASH.slice(0, 42) as `0x${string}`,
      principal: 0n,
      lossAbsorbed: total,
      fromReserve: event.args.fromReserve,
      fromJunior: event.args.fromJunior,
      fromSenior: event.args.fromSenior,
    })
    .onConflictDoUpdate((row) => ({
      lossAbsorbed: row.lossAbsorbed + total,
      fromReserve: row.fromReserve + event.args.fromReserve,
      fromJunior: row.fromJunior + event.args.fromJunior,
      fromSenior: row.fromSenior + event.args.fromSenior,
    }));
});

ponder.on("CreditPool:UnmarkedDelinquency", async ({event, context}) => {
  await context.db
    .insert(bookEntry)
    .values({
      planId: event.args.planId,
      merchant: ZERO_HASH.slice(0, 42) as `0x${string}`,
      principal: 0n,
      unmarked: event.args.unmarked,
    })
    .onConflictDoUpdate(() => ({unmarked: event.args.unmarked}));
});

/**
 * The gate, every time it moved.
 *
 * Emitted on every state-changing pool call, so this table is chatty by design. It
 * is the only way to answer "when was the book closed, and for how long" after the
 * fact, and that is the question an allocator asks.
 */
ponder.on("CreditPool:OriginationGated", async ({event, context}) => {
  await context.db.insert(gateReading).values({
    id: eventId(event),
    open: event.args.open,
    subordinationBps: event.args.subordinationBps,
    reserveBps: event.args.reserveBps,
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
  });
});

// ─── Merchants ────────────────────────────────────────────────────────────────

ponder.on("MerchantRegistry:MerchantRegistered", async ({event, context}) => {
  await context.db
    .insert(merchant)
    .values({
      address: event.args.merchant,
      bond: event.args.bond,
      registeredAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate(() => ({registeredAt: Number(event.block.timestamp)}));
});

ponder.on("MerchantRegistry:KybAttested", async ({event, context}) => {
  await context.db
    .insert(merchant)
    .values({
      address: event.args.merchant,
      kybVerified: event.args.verified,
      registeredAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate(() => ({kybVerified: event.args.verified}));
});

ponder.on("MerchantRegistry:BondPosted", async ({event, context}) => {
  await context.db
    .insert(merchant)
    .values({
      address: event.args.merchant,
      bond: event.args.total,
      registeredAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate(() => ({bond: event.args.total}));
});

ponder.on("MerchantRegistry:BondWithheld", async ({event, context}) => {
  await context.db
    .insert(merchant)
    .values({
      address: event.args.merchant,
      bond: event.args.total,
      withheld: event.args.amount,
      registeredAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate((row) => ({
      bond: event.args.total,
      withheld: row.withheld + event.args.amount,
    }));
});

ponder.on("MerchantRegistry:ExposureChanged", async ({event, context}) => {
  await context.db
    .insert(merchant)
    .values({
      address: event.args.merchant,
      outstandingFronted: event.args.outstanding,
      requiredBond: event.args.requiredBond,
      registeredAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate(() => ({
      outstandingFronted: event.args.outstanding,
      requiredBond: event.args.requiredBond,
    }));
});

// ─── The kill switch ──────────────────────────────────────────────────────────

ponder.on("FirstPaymentDefaultSwitch:FirstPaymentObserved", async ({event, context}) => {
  const timestamp = Number(event.block.timestamp);

  await context.db
    .insert(firstPaymentObservation)
    .values({
      planId: event.args.planId,
      defaulted: event.args.defaulted,
      seasoned: event.args.seasoned,
      observer: event.args.observer,
      blockNumber: event.block.number,
      timestamp,
      cohort: cohortOf(timestamp),
    })
    .onConflictDoNothing();
});

ponder.on("FirstPaymentDefaultSwitch:ThrottleChanged", async ({event, context}) => {
  await context.db.insert(throttleReading).values({
    id: eventId(event),
    throttleBps: event.args.throttleBps,
    fpdBps: event.args.fpdBps,
    cohortSize: event.args.cohortSize,
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
  });
});

// ─── Governance ───────────────────────────────────────────────────────────────

ponder.on("ParameterRegistry:ParameterSet", async ({event, context}) => {
  await context.db.insert(parameterChange).values({
    id: eventId(event),
    key: event.args.key,
    previous: event.args.previous,
    value: event.args.value,
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
  });
});

ponder.on("OriginationPause:GlobalPauseSet", async ({event, context}) => {
  await context.db.insert(pauseEvent).values({
    id: eventId(event),
    corridor: ZERO_HASH,
    paused: event.args.paused,
    by: event.args.by,
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
  });
});

ponder.on("OriginationPause:CorridorPauseSet", async ({event, context}) => {
  await context.db.insert(pauseEvent).values({
    id: eventId(event),
    corridor: event.args.corridor,
    paused: event.args.paused,
    by: event.args.by,
    blockNumber: event.block.number,
    timestamp: Number(event.block.timestamp),
  });
});
