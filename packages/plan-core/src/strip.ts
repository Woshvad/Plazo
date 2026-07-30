/**
 * The dated authorization strip, built from terms alone.
 *
 * A borrower signs `installmentCount` EIP-3009 authorizations plus one typed
 * acceptance, and everything they sign is derived here. That matters more than it
 * looks: `packages/plan-core` has no network, server or database dependency, so a
 * borrower — or an auditor, or a keeper, or anyone holding a strip — can recompute
 * every digest without Plazo's cooperation. If verifying the deal needed our server,
 * "the signed bytes commit to the disclosed deal" would be a claim rather than a
 * property.
 *
 * Mirrors `contracts/src/libraries/{TermsDetail,PlanAcceptance,PlanParams}.sol` and
 * the schedule arithmetic in `InstallmentPlan`. A differential corpus generated from
 * Solidity asserts every value here matches bit for bit.
 */
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";

import {checkNonce, derivePlanId, predictPlanAddress, type PlanTerms} from "./plan-id.js";
import {AUTHORIZATION_WINDOW, scheduleJitter} from "./params.js";

// ─── The disclosed detail behind `termsHash` ───────────────────────────────────

/**
 * Whose signature validates the strip.
 *
 * An EOA's validation logic is its address and cannot change. A contract account can
 * change its validation logic at any moment, which retroactively invalidates every
 * outstanding check it signed — so a contract signer carries the reduced unsecured
 * cap unless a recent `revalidate()` says otherwise.
 */
export const SignerClass = {EOA: 0, Contract: 1} as const;
export type SignerClass = (typeof SignerClass)[keyof typeof SignerClass];

export interface TermsDetail {
  /** Selects the jurisdiction parameter set: late-fee cap, APR cap, cadence, window. */
  jurisdiction: Hex;
  /** Commitment to the disclosed basket. Hashed off-chain; never published onchain. */
  lineItemsHash: Hex;
  mdrBps: bigint;
  /** The late fee shown to the borrower, before the jurisdiction ceiling. */
  lateFeeFlat: bigint;
  signerClass: SignerClass;
  settlementRecipient: Address;
  /** The currency-normalization router. Identity in v1. */
  fxRouter: Address;
}

export const TERMS_DETAIL_TYPE_STRING =
  "TermsDetail(bytes32 jurisdiction,bytes32 lineItemsHash,uint256 mdrBps,uint256 lateFeeFlat,uint8 signerClass,address settlementRecipient,address fxRouter)";

export const TERMS_DETAIL_TYPEHASH: Hex = keccak256(toHex(TERMS_DETAIL_TYPE_STRING));

const TERMS_DETAIL_PARAMETERS = parseAbiParameters(
  "bytes32, bytes32, bytes32, uint256, uint256, uint8, address, address",
);

/**
 * The `termsHash` a plan's identity commits to.
 *
 * The `planId` preimage is frozen and carries no jurisdiction, recipient or router
 * field, so everything that can move value rides inside this hash instead. Changing
 * any of it changes `termsHash`, which changes `planId`, which changes every
 * authorization nonce *and* the CREATE2 payee address — a strip signed against one
 * set of terms simply stops being payable anywhere that will ever hold code.
 */
export function hashTermsDetail(detail: TermsDetail): Hex {
  return keccak256(
    encodeAbiParameters(TERMS_DETAIL_PARAMETERS, [
      TERMS_DETAIL_TYPEHASH,
      detail.jurisdiction,
      detail.lineItemsHash,
      detail.mdrBps,
      detail.lateFeeFlat,
      detail.signerClass,
      getAddress(detail.settlementRecipient),
      getAddress(detail.fxRouter),
    ]),
  );
}

// ─── Schedule ─────────────────────────────────────────────────────────────────

/**
 * When installment `index` falls due.
 *
 * The jitter applies from installment 1 onward. The down payment is due at checkout
 * and there is no wave to spread; what needs breaking up is the recurring schedule,
 * where a cohort originated on one afternoon would otherwise all come due in the
 * same block and every keeper's pull would be a race it usually loses.
 *
 * Uniform across those installments rather than per-installment, so two adjacent due
 * dates can never cross — "past due" is the predicate every collection and
 * provisioning decision keys off.
 */
export function dueDate(planId: Hex, terms: PlanTerms, index: number | bigint): bigint {
  const i = BigInt(index);
  if (i === 0n) return terms.firstDueDate;
  return terms.firstDueDate + i * terms.interval + scheduleJitter(planId);
}

export function dueDates(planId: Hex, terms: PlanTerms): bigint[] {
  return Array.from({length: Number(terms.installmentCount)}, (_, i) => dueDate(planId, terms, i));
}

/**
 * Face value of installment `index`.
 *
 * The division remainder rides on installment 0, which settles at checkout, so every
 * installment the borrower has left to pay is the uniform figure the merchant page
 * advertised.
 */
export function installmentAmount(terms: PlanTerms, index: number | bigint): bigint {
  const principal = BigInt(terms.principal);
  const base = principal / terms.installmentCount;
  return BigInt(index) === 0n ? base + (principal % terms.installmentCount) : base;
}

export function installmentAmounts(terms: PlanTerms): bigint[] {
  return Array.from({length: Number(terms.installmentCount)}, (_, i) => installmentAmount(terms, i));
}

// ─── The authorizations ───────────────────────────────────────────────────────

export interface CheckAuthorization {
  index: number;
  from: Address;
  /** The plan's CREATE2 address. Holds no code until origination. */
  to: Address;
  value: bigint;
  /**
   * One second before the due date.
   *
   * The token's check is a strict `now > validAfter`, so without the offset an
   * installment due at `T` would not be collectible until `T + 1` — and the down
   * payment, due at checkout, could not be taken in the transaction that originated
   * the plan.
   */
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/**
 * Every authorization in the strip, in installment order.
 *
 * These are the arguments to `receiveWithAuthorization`. The typed-data payload the
 * wallet actually signs is built by `receiveWithAuthorizationTypedData`, against the
 * token's own domain — which is read from the chain, never hardcoded, because it
 * embeds `chainId` and `verifyingContract` and both change on mainnet.
 */
export function buildStrip(terms: PlanTerms, planId?: Hex): CheckAuthorization[] {
  const id = planId ?? derivePlanId(terms);
  const payee = predictPlanAddress({
    deployer: terms.factory,
    implementation: terms.implementation,
    planId: id,
  });

  return Array.from({length: Number(terms.installmentCount)}, (_, index) => {
    const due = dueDate(id, terms, index);
    return {
      index,
      from: getAddress(terms.borrower),
      to: payee,
      value: installmentAmount(terms, index),
      validAfter: due - 1n,
      validBefore: due + AUTHORIZATION_WINDOW,
      nonce: checkNonce(id, index),
    };
  });
}

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    {name: "from", type: "address"},
    {name: "to", type: "address"},
    {name: "value", type: "uint256"},
    {name: "validAfter", type: "uint256"},
    {name: "validBefore", type: "uint256"},
    {name: "nonce", type: "bytes32"},
  ],
} as const;

/** The EIP-712 payload a wallet signs for one check. */
export function receiveWithAuthorizationTypedData(
  domain: TypedDataDomain,
  authorization: CheckAuthorization,
) {
  return {
    domain,
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    },
  } as const;
}

// ─── The acceptance ───────────────────────────────────────────────────────────

export interface PlanAcceptance {
  planId: Hex;
  borrower: Address;
  merchant: Address;
  token: Address;
  principal: bigint;
  installmentCount: bigint;
  firstInstallment: bigint;
  laterInstallment: bigint;
  firstDueDate: bigint;
  finalDueDate: bigint;
  interval: bigint;
  termsHash: Hex;
  validUntil: bigint;
}

export const PLAN_ACCEPTANCE_TYPES = {
  PlanAcceptance: [
    {name: "planId", type: "bytes32"},
    {name: "borrower", type: "address"},
    {name: "merchant", type: "address"},
    {name: "token", type: "address"},
    {name: "principal", type: "uint256"},
    {name: "installmentCount", type: "uint256"},
    {name: "firstInstallment", type: "uint256"},
    {name: "laterInstallment", type: "uint256"},
    {name: "firstDueDate", type: "uint256"},
    {name: "finalDueDate", type: "uint256"},
    {name: "interval", type: "uint256"},
    {name: "termsHash", type: "bytes32"},
    {name: "validUntil", type: "uint256"},
  ],
} as const;

export const PLAN_ACCEPTANCE_TYPE_STRING =
  "PlanAcceptance(bytes32 planId,address borrower,address merchant,address token,uint256 principal,uint256 installmentCount,uint256 firstInstallment,uint256 laterInstallment,uint256 firstDueDate,uint256 finalDueDate,uint256 interval,bytes32 termsHash,uint256 validUntil)";

export const PLAN_ACCEPTANCE_TYPEHASH: Hex = keccak256(toHex(PLAN_ACCEPTANCE_TYPE_STRING));

/**
 * Build the acceptance for a set of terms.
 *
 * This is what a wallet's typed-data screen renders. Four EIP-3009 authorizations
 * show up as four unrelated transfers to a contract holding no code; nothing in them
 * says what the total is, when the last payment falls, or who the merchant is. The
 * acceptance carries all of it, and the plan verifies it onchain against `planId`,
 * so the deal the borrower was shown and the deal the contract enforces are the same
 * bytes rather than the same intention.
 */
export function buildAcceptance(
  terms: PlanTerms,
  validUntil: bigint,
  planId?: Hex,
): PlanAcceptance {
  const id = planId ?? derivePlanId(terms);
  return {
    planId: id,
    borrower: getAddress(terms.borrower),
    merchant: getAddress(terms.merchant),
    token: getAddress(terms.token),
    principal: BigInt(terms.principal),
    installmentCount: terms.installmentCount,
    firstInstallment: installmentAmount(terms, 0),
    laterInstallment: installmentAmount(terms, 1),
    firstDueDate: dueDate(id, terms, 0),
    finalDueDate: dueDate(id, terms, terms.installmentCount - 1n),
    interval: terms.interval,
    termsHash: terms.termsHash,
    validUntil,
  };
}

/**
 * The acceptance's EIP-712 domain.
 *
 * `verifyingContract` is the plan's own CREATE2 address, derivable by anyone before
 * the clone holds code. Binding it there means an acceptance signed for one plan
 * cannot originate another, even if every other field were replayed.
 */
export function acceptanceDomain(chainId: bigint | number, plan: Address): TypedDataDomain {
  return {
    name: "Plazo",
    version: "1",
    chainId: Number(chainId),
    verifyingContract: getAddress(plan),
  };
}

export function acceptanceTypedData(
  chainId: bigint | number,
  plan: Address,
  acceptance: PlanAcceptance,
) {
  return {
    domain: acceptanceDomain(chainId, plan),
    types: PLAN_ACCEPTANCE_TYPES,
    primaryType: "PlanAcceptance",
    message: acceptance,
  } as const;
}

// ─── Everything a checkout needs, in one call ─────────────────────────────────

export interface PreparedPlan {
  planId: Hex;
  /** The payee every authorization names, and the acceptance's verifying contract. */
  address: Address;
  dueDates: bigint[];
  amounts: bigint[];
  strip: CheckAuthorization[];
  acceptance: PlanAcceptance;
}

export function preparePlan(terms: PlanTerms, validUntil: bigint): PreparedPlan {
  const planId = derivePlanId(terms);
  return {
    planId,
    address: predictPlanAddress({
      deployer: terms.factory,
      implementation: terms.implementation,
      planId,
    }),
    dueDates: dueDates(planId, terms),
    amounts: installmentAmounts(terms),
    strip: buildStrip(terms, planId),
    acceptance: buildAcceptance(terms, validUntil, planId),
  };
}
