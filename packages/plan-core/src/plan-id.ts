/**
 * Plan identity derivation — the TypeScript half of the parity pair.
 *
 * This mirrors `contracts/src/libraries/PlanId.sol` and
 * `contracts/src/libraries/CloneAddress.sol`. A differential test regenerates a
 * corpus from the Solidity side and asserts every field here matches bit for bit.
 * The two implementations change together or CI fails.
 *
 * Nothing in this module talks to a network, a Plazo server or a database. That is
 * the point: a borrower holding a signed strip must be able to recompute the plan
 * id, the payee address and every authorization nonce from the disclosed terms
 * alone. If verifying the deal required Plazo's cooperation, "the signed bytes
 * commit to the disclosed deal" would be a claim rather than a property.
 */
import {
  concatHex,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  keccak256,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
} from "viem";

import type {Usdc6} from "./units.js";

/**
 * Field ordering is part of the ABI. Changing it after any strip has been signed
 * is a migration, not a refactor.
 */
export const PLAN_TYPE_STRING =
  "Plan(uint256 chainId,address factory,address implementation,address borrower,address merchant,address token,uint256 principal,uint256 installmentCount,uint256 firstDueDate,uint256 interval,uint256 originationNonce,bytes32 termsHash)";

export const PLAN_ID_TYPEHASH: Hex = keccak256(toHex(PLAN_TYPE_STRING));

/** Canonical EIP-1167, unmodified. 20-byte prefix, 20-byte implementation, 15-byte suffix. */
export const ERC1167_CREATION_PREFIX: Hex = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
export const ERC1167_RUNTIME_SUFFIX: Hex = "0x5af43d82803e903d91602b57fd5bf3";

export interface PlanTerms {
  chainId: bigint;
  /** Always `PlanFactory`. Never the shared permissionless CREATE2 deployer. */
  factory: Address;
  /**
   * The plan implementation this vintage clones. In the preimage, so a new vintage
   * cannot reinterpret an outstanding strip.
   */
  implementation: Address;
  borrower: Address;
  merchant: Address;
  token: Address;
  /** ERC-20 scale. EIP-3009 signs this figure. */
  principal: Usdc6 | bigint;
  installmentCount: bigint;
  firstDueDate: bigint;
  interval: bigint;
  /**
   * Separates two originations with otherwise identical terms.
   *
   * Without it, a borrower buying the same item twice — or retrying a checkout
   * that timed out — derives the same plan id, and therefore the same
   * authorization nonces. EIP-3009 nonces are single-use and `cancelAuthorization`
   * burns them permanently, so the second plan would be unsignable forever.
   */
  originationNonce: bigint;
  /** Commitment to the disclosed deal: line items, MDR, jurisdiction set, fees. */
  termsHash: Hex;
}

const PLAN_ABI_PARAMETERS = parseAbiParameters(
  "bytes32, uint256, address, address, address, address, address, uint256, uint256, uint256, uint256, uint256, bytes32",
);

/** Derive the plan identity. Total — any terms hash to something. */
export function derivePlanId(terms: PlanTerms): Hex {
  return keccak256(
    encodeAbiParameters(PLAN_ABI_PARAMETERS, [
      PLAN_ID_TYPEHASH,
      terms.chainId,
      getAddress(terms.factory),
      getAddress(terms.implementation),
      getAddress(terms.borrower),
      getAddress(terms.merchant),
      getAddress(terms.token),
      BigInt(terms.principal),
      terms.installmentCount,
      terms.firstDueDate,
      terms.interval,
      terms.originationNonce,
      terms.termsHash,
    ]),
  );
}

/**
 * The EIP-3009 nonce for one installment.
 *
 * `keccak256(planId ‖ index)` over two fixed-width words. Deriving the nonce from
 * the plan is what makes a check non-transferable between plans: a signature
 * carrying this nonce can only ever credit the plan whose id produced it.
 */
export function checkNonce(planId: Hex, index: number | bigint): Hex {
  return keccak256(encodePacked(["bytes32", "uint256"], [planId, BigInt(index)]));
}

/** Every nonce in the strip, in installment order. */
export function checkNonces(planId: Hex, installmentCount: number | bigint): Hex[] {
  const count = Number(installmentCount);
  return Array.from({length: count}, (_, i) => checkNonce(planId, i));
}

/** The 55-byte EIP-1167 creation code for `implementation`. */
export function cloneCreationCode(implementation: Address): Hex {
  return concatHex([
    ERC1167_CREATION_PREFIX,
    getAddress(implementation).toLowerCase() as Hex,
    ERC1167_RUNTIME_SUFFIX,
  ]);
}

export function cloneInitCodeHash(implementation: Address): Hex {
  return keccak256(cloneCreationCode(implementation));
}

/**
 * Predict the CREATE2 address of a plan clone.
 *
 * `deployer` is always `PlanFactory`. The shared permissionless deployer at
 * `0x4e59b448…` is callable by anyone, so a strip signed against an address
 * derived from it could be front-run: a third party deploys arbitrary code there
 * first and receives checks the borrower intended for a plan.
 */
export function predictPlanAddress(args: {
  deployer: Address;
  implementation: Address;
  planId: Hex;
}): Address {
  const hash = keccak256(
    concatHex([
      "0xff",
      getAddress(args.deployer).toLowerCase() as Hex,
      args.planId,
      cloneInitCodeHash(args.implementation),
    ]),
  );
  return getAddress(`0x${hash.slice(-40)}`);
}

/** Everything a checkout needs to build and verify a strip, from terms alone. */
export interface DerivedPlan {
  planId: Hex;
  /** The payee named by every authorization in the strip. */
  address: Address;
  nonces: Hex[];
}

export function derivePlan(terms: PlanTerms): DerivedPlan {
  const planId = derivePlanId(terms);
  return {
    planId,
    address: predictPlanAddress({
      deployer: terms.factory,
      implementation: terms.implementation,
      planId,
    }),
    nonces: checkNonces(planId, terms.installmentCount),
  };
}
