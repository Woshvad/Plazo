/**
 * The capital plane and the Passport, indexed.
 *
 * Two streams with opposite privacy postures, which is why they share a file — the
 * contrast is the point and it should be visible in one screen.
 *
 * **The capital plane names everybody.** A tranche share is a transfer-restricted
 * ERC-20 whose holder set is already public in every `Transfer`, the holders are
 * accredited institutions rather than data subjects, and a lender who cannot see their
 * own queue position has been given a worse product for no privacy gain.
 *
 * **The Passport names nobody.** Every row is keyed by `keccak256(prefix ‖ salt ‖
 * borrower)`. The operator holds the salt in its own private schema and joins there,
 * behind the consent gate, where a correction or a deletion can be honoured. There is no
 * wallet column in this file, and adding one would rebuild the enumerable credit file
 * the salt exists to prevent.
 */
import {ponder} from "ponder:registry";

import {poolPositionId, poolTicketId} from "./pools.js";

import {
  consentEvent,
  epoch,
  lenderPosition,
  passportMark,
  passportRecord,
  provision,
  queueFill,
  redemptionTicket,
  relayedCollection,
} from "ponder:schema";

/** A log's unique coordinates. Ponder gives no synthetic id, and reorgs do not exist here. */
const eventId = (event: {block: {number: bigint}; log: {logIndex: number}}) =>
  `${event.block.number}-${event.log.logIndex}`;

/**
 * The emitting pool, which every handler below now reads.
 *
 * There are two `TranchedCreditPool` instances from Phase 7 and neither is "the" pool.
 * `event.log.address` is the only thing in a log that tells them apart, and it is what
 * every key and every row in this file is now qualified by.
 */
const poolOf = (event: {log: {address: `0x${string}`}}) => event.log.address;

// ─────────────────────────────────────────────────────────────────────────────
// Epochs
// ─────────────────────────────────────────────────────────────────────────────

ponder.on("TranchedCreditPool:EpochClosed", async ({event, context}) => {
  await context.db
    .insert(epoch)
    .values({
      pool: poolOf(event),
      number: event.args.epoch,
      seniorNav: event.args.seniorNav,
      juniorNav: event.args.juniorNav,
      liquidityFeeBps: event.args.liquidityFeeBps,
      closedAt: Number(event.block.timestamp),
      blockNumber: event.block.number,
    })
    .onConflictDoNothing();
});

// ─────────────────────────────────────────────────────────────────────────────
// Provisioning (POOL-07)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `raised` and `released` accumulate separately rather than netting.
 *
 * The round trip is the property D11 asks for, and a net of zero cannot distinguish
 * "nothing happened" from "a provision was released against a different bucket than the
 * one that took it". Keeping both means the check is a subtraction rather than a
 * belief.
 */
ponder.on("TranchedCreditPool:Provisioned", async ({event, context}) => {
  await context.db
    .insert(provision)
    .values({
      planId: event.args.planId,
      pool: poolOf(event),
      epoch: event.args.epoch,
      raised: event.args.amount,
      outstanding: event.args.amount,
      updatedAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate((row) => ({
      raised: row.raised + event.args.amount,
      outstanding: row.outstanding + event.args.amount,
      updatedAt: Number(event.block.timestamp),
    }));
});

ponder.on("TranchedCreditPool:ProvisionReleased", async ({event, context}) => {
  await context.db
    .insert(provision)
    .values({
      planId: event.args.planId,
      pool: poolOf(event),
      epoch: event.args.epoch,
      released: event.args.amount,
      updatedAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate((row) => ({
      released: row.released + event.args.amount,
      outstanding: row.outstanding > event.args.amount ? row.outstanding - event.args.amount : 0n,
      updatedAt: Number(event.block.timestamp),
    }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Lenders
// ─────────────────────────────────────────────────────────────────────────────

ponder.on("TranchedCreditPool:DepositRequested", async ({event, context}) => {
  await context.db
    .insert(lenderPosition)
    .values({
      id: poolPositionId(poolOf(event), event.args.tranche, event.args.holder),
      pool: poolOf(event),
      tranche: event.args.tranche,
      holder: event.args.holder,
      depositedAssets: event.args.assets,
      updatedAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate((row) => ({
      depositedAssets: row.depositedAssets + event.args.assets,
      updatedAt: Number(event.block.timestamp),
    }));
});

ponder.on("TranchedCreditPool:SharesClaimed", async ({event, context}) => {
  await context.db
    .insert(lenderPosition)
    .values({
      id: poolPositionId(poolOf(event), event.args.tranche, event.args.holder),
      pool: poolOf(event),
      tranche: event.args.tranche,
      holder: event.args.holder,
      claimedShares: event.args.shares,
      updatedAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate((row) => ({
      claimedShares: row.claimedShares + event.args.shares,
      updatedAt: Number(event.block.timestamp),
    }));
});

ponder.on("TranchedCreditPool:RedeemRequested", async ({event, context}) => {
  await context.db.insert(redemptionTicket).values({
    id: poolTicketId(poolOf(event), event.args.tranche, event.args.holder, event.args.index),
    pool: poolOf(event),
    tranche: event.args.tranche,
    holder: event.args.holder,
    index: event.args.index,
    shares: event.args.shares,
    position: event.args.position,
    requestedAt: Number(event.block.timestamp),
  });

  await context.db
    .insert(lenderPosition)
    .values({
      id: poolPositionId(poolOf(event), event.args.tranche, event.args.holder),
      pool: poolOf(event),
      tranche: event.args.tranche,
      holder: event.args.holder,
      redeemedShares: event.args.shares,
      updatedAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate((row) => ({
      redeemedShares: row.redeemedShares + event.args.shares,
      updatedAt: Number(event.block.timestamp),
    }));
});

/**
 * One fill per tranche per epoch, at one rate.
 *
 * POOL-09's uniformity is checkable from this table alone: two rows for one
 * `(tranche, epoch)` pair, or two different `feeBps` inside one epoch, would mean a
 * redeemer's price depended on something other than which epoch they were in — which is
 * the gate the fee replaced, wearing a different name.
 */
ponder.on("TranchedCreditPool:QueueFilled", async ({event, context}) => {
  await context.db.insert(queueFill).values({
    id: eventId(event),
    pool: poolOf(event),
    tranche: event.args.tranche,
    epoch: event.args.epoch,
    shares: event.args.shares,
    assets: event.args.assets,
    feeBps: event.args.feeBps,
    filledAt: Number(event.block.timestamp),
  });
});

ponder.on("TranchedCreditPool:RedemptionClaimed", async ({event, context}) => {
  await context.db
    .insert(redemptionTicket)
    .values({
      id: poolTicketId(poolOf(event), event.args.tranche, event.args.holder, event.args.index),
      pool: poolOf(event),
      tranche: event.args.tranche,
      holder: event.args.holder,
      index: event.args.index,
      shares: 0n,
      position: 0n,
      claimedAssets: event.args.assets,
      requestedAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate((row) => ({
      claimedAssets: row.claimedAssets + event.args.assets,
    }));

  await context.db
    .insert(lenderPosition)
    .values({
      id: poolPositionId(poolOf(event), event.args.tranche, event.args.holder),
      pool: poolOf(event),
      tranche: event.args.tranche,
      holder: event.args.holder,
      redeemedAssets: event.args.assets,
      updatedAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate((row) => ({
      redeemedAssets: row.redeemedAssets + event.args.assets,
      updatedAt: Number(event.block.timestamp),
    }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Passport — keyed by subject, never by wallet
// ─────────────────────────────────────────────────────────────────────────────

ponder.on("PlazoPassport:OutcomeNoted", async ({event, context}) => {
  await context.db
    .insert(passportRecord)
    .values({
      subject: event.args.subject,
      completions: event.args.completions,
      negativesEver: event.args.negativesEver,
      updatedAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate(() => ({
      completions: event.args.completions,
      negativesEver: event.args.negativesEver,
      updatedAt: Number(event.block.timestamp),
    }));

  if (!event.args.clean) {
    await context.db.insert(passportMark).values({
      id: eventId(event),
      subject: event.args.subject,
      markedAt: Number(event.block.timestamp),
    });
  }
});

/**
 * Marks are stored individually, not counted.
 *
 * PASS-03's ageing is a property of the read — a mark stops counting once it is older
 * than the window. A stored count could not express that, so it would have to be
 * recomputed by a job, and a job that stops running is a borrower who keeps being
 * penalised for something that expired.
 */
ponder.on("PlazoPassport:NegativeNoted", async ({event, context}) => {
  await context.db.insert(passportMark).values({
    id: eventId(event),
    subject: event.args.subject,
    markedAt: Number(event.args.at),
  });

  await context.db
    .insert(passportRecord)
    .values({
      subject: event.args.subject,
      negativesEver: event.args.negativesEver,
      updatedAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate(() => ({
      negativesEver: event.args.negativesEver,
      updatedAt: Number(event.block.timestamp),
    }));
});

ponder.on("PlazoPassport:CommitmentWritten", async ({event, context}) => {
  await context.db
    .insert(passportRecord)
    .values({
      subject: event.args.subject,
      commitment: event.args.commitment,
      schemaId: event.args.schemaId,
      version: BigInt(event.args.version),
      updatedAt: Number(event.block.timestamp),
    })
    .onConflictDoUpdate(() => ({
      commitment: event.args.commitment,
      schemaId: event.args.schemaId,
      version: BigInt(event.args.version),
      updatedAt: Number(event.block.timestamp),
    }));
});

/**
 * Erasure. The old subject's rows are deleted from the indexed view.
 *
 * The chain still holds the logs and always will — nothing here pretends otherwise. What
 * this does is stop the operator's own serving layer from being the thing that keeps a
 * rotated record joinable, which is the part the operator actually controls and the part
 * a regulator will ask about.
 */
ponder.on("PlazoPassport:SaltRotated", async ({event, context}) => {
  await context.db.delete(passportRecord, {subject: event.args.previousSubject});
});

ponder.on("PlazoPassport:ConsentGranted", async ({event, context}) => {
  await context.db.insert(consentEvent).values({
    id: eventId(event),
    subject: event.args.subject,
    reader: event.args.reader,
    schemaId: event.args.schemaId,
    granted: true,
    validUntil: event.args.validUntil,
    at: Number(event.block.timestamp),
  });
});

ponder.on("PlazoPassport:ConsentRevoked", async ({event, context}) => {
  await context.db.insert(consentEvent).values({
    id: eventId(event),
    subject: event.args.subject,
    reader: event.args.reader,
    schemaId: event.args.schemaId,
    granted: false,
    at: Number(event.block.timestamp),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COLL-10 — the operator's own share
// ─────────────────────────────────────────────────────────────────────────────

ponder.on("RelayerGate:Collected", async ({event, context}) => {
  await context.db.insert(relayedCollection).values({
    id: eventId(event),
    plan: event.args.plan,
    index: event.args.index,
    cleared: event.args.cleared,
    reason: event.args.reason,
    at: Number(event.block.timestamp),
  });
});
