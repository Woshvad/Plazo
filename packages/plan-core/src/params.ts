/**
 * The corrected Appendix A parameter set, mirrored from
 * `contracts/src/libraries/PlanParams.sol`.
 *
 * Every figure was re-derived from a measured Arc testnet gas trace rather than
 * inherited from the specification's table: Phase 1 measured a real pull at
 * **140,885 gas**, which at Arc's 21 gwei and USDC-as-gas is **$0.00296** — about
 * four times cheaper than Appendix A assumed. See `contracts/test/fork/FINDINGS.md`.
 *
 * These are here because a keeper needs to price a crank before sending it and a
 * borrower's client needs to render a schedule without asking a server. Both are
 * differential-tested against the Solidity side, so a parameter cannot drift on one
 * side of the protocol only.
 *
 * All money figures are USDC in 6-decimal ERC-20 units.
 */
import type {Hex} from "viem";

export const ONE_USDC = 1_000_000n;
export const BPS = 10_000n;

/**
 * Smallest plan the economics support.
 *
 * DEC-04 set $75 against Appendix A's $40 and the measurement confirms it — but not
 * for the reason the table assumed. At $0.00296 a pull, four collections cost about
 * a cent; gas is not what sets the floor. The keeper market is: a bounty large
 * enough that a marginal crank is worth racing for runs roughly 17× the gas it pays
 * for. Optimising the contract would move this floor by pennies. Moving the ramp
 * moves it by dollars.
 */
export const MIN_TICKET = 75n * ONE_USDC;

export const BOUNTY_START_BPS = 25n;
export const BOUNTY_END_BPS = 250n;
export const BOUNTY_FLOOR = ONE_USDC / 20n;
export const BOUNTY_CAP = (5n * ONE_USDC) / 2n;

export const MARK_BOUNTY = ONE_USDC / 10n;

export const GRACE_WINDOW = 3n * 86_400n;
export const CHARGE_OFF_AFTER = 60n * 86_400n;
export const AUTHORIZATION_WINDOW = 90n * 86_400n;
export const REVALIDATION_WINDOW = 7n * 86_400n;

/**
 * COLL-07. Earlier collections are provably third-party because the operator's
 * relayer is not allowed to fire inside this window.
 */
export const RELAYER_DELAY_FLOOR = 30n * 60n;

export const LATE_FEE_FLAT = 7n * ONE_USDC;

/**
 * Zero, deliberately. Pay-in-4 is 0% on time, so there is no interest to rebate and
 * a prepayment penalty would be a charge for behaving well. Flex carries interest
 * and therefore an actuarial rebate — Phase 8, and a rebate, never Rule-of-78s.
 */
export const EARLY_EXIT_FEE_BPS = 0n;

export const JITTER_HALF_WIDTH = 12n * 3_600n;

/**
 * Twice the mark budget: half reserved for marks, half available for `revalidate()`.
 *
 * Both cranks pay from the same pot, and a plan whose signer keeps changing could be
 * revalidated every week for the ninety days its strip stays live — enough calls to
 * empty a single-budget escrow. The delinquency signal would then fail on exactly
 * the plans most likely to need it.
 */
export function markEscrowFor(installmentCount: bigint | number): bigint {
  return BigInt(installmentCount) * MARK_BOUNTY * 2n;
}

/**
 * What `collect(index)` pays right now.
 *
 * A Dutch ramp rather than a flat fee, because the marginal collection — the one a
 * keeper is deciding not to bother with — is exactly the one that has been sitting
 * uncollected. The price rises until someone takes it, so the protocol pays the
 * least that clears the market rather than the most that would.
 */
export function collectBounty(installment: bigint, elapsed: bigint, window = GRACE_WINDOW): bigint {
  const bps =
    window === 0n || elapsed >= window
      ? BOUNTY_END_BPS
      : BOUNTY_START_BPS + ((BOUNTY_END_BPS - BOUNTY_START_BPS) * elapsed) / window;

  let bounty = (installment * bps) / BPS;
  if (bounty < BOUNTY_FLOOR) bounty = BOUNTY_FLOOR;
  if (bounty > BOUNTY_CAP) bounty = BOUNTY_CAP;
  if (bounty > installment) bounty = installment;
  return bounty;
}

/**
 * The deterministic ±12h offset applied to every installment after the first.
 *
 * `PREVRANDAO` is always zero on Arc, so there is no onchain randomness — which is
 * fortunate, because a borrower needs to be able to reproduce their own due dates
 * without asking anyone. The offset comes from `planId`.
 */
export function scheduleJitter(planId: Hex): bigint {
  const span = JITTER_HALF_WIDTH * 2n;
  return (BigInt(planId) % span) - JITTER_HALF_WIDTH;
}
