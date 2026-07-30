// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title PlanParams
/// @notice The corrected Appendix A parameter set, re-derived from a measured
///         Arc testnet gas trace rather than inherited from the specification's
///         table.
///
/// @dev Appendix A was written against an assumed collection cost of ~$0.013 per
///      transaction. The Phase 1 fork spike measured a real pull at **140,885 gas**,
///      which at Arc's 21 gwei and USDC-as-gas is **$0.00296** — off by roughly 4×
///      in the protocol's favour. Every figure below is derived from that
///      measurement; see `test/fork/FINDINGS.md`.
///
///      These are constants in Phase 2 and become `ParameterRegistry` rows with
///      `require()` bands in Phase 3. They are stated here as the launch
///      hypothesis, not as settled truth: the loss-side numbers are recalibrated
///      from measured testnet cohorts, and the registry is the mechanism that
///      does it without a redeployment.
///
///      All money figures are USDC in **6-decimal ERC-20 units**. Arc USDC is
///      18-decimal natively over the same balance, but EIP-3009 `value` is the
///      6-decimal figure and so is everything in this protocol's accounting.
library PlanParams {
    /// @notice One dollar, in the units everything here is denominated in.
    uint256 internal constant ONE_USDC = 1e6;

    // ─── Ticket size ─────────────────────────────────────────────────────────

    /// @notice Smallest plan the economics support.
    ///
    /// @dev DEC-04 set $75 against Appendix A's $40, and the measurement confirms
    ///      it — but not for the reason the table assumed. At $0.00296 a pull, gas
    ///      is not what sets the floor: four collections cost about a cent. The
    ///      floor is set by the **keeper market**, because a bounty large enough to
    ///      make a marginal crank worth racing for is ~17× the gas it pays for.
    ///      Total servicing on a four-check plan is roughly $0.60 at the ramp start
    ///      and $2.30 if every check runs to the end of its grace window; $75 holds
    ///      a 21% margin against the stress case. Optimising the contract's gas
    ///      would move this floor by pennies. Moving the ramp moves it by dollars.
    uint256 internal constant MIN_TICKET = 75 * ONE_USDC;

    // ─── Keeper market: the collect bounty ───────────────────────────────────

    /// @notice Bounty at `validAfter`, in basis points of the installment.
    uint256 internal constant BOUNTY_START_BPS = 25;

    /// @notice Bounty at the end of the grace window, in basis points.
    /// @dev A Dutch ramp rather than a flat fee because the marginal collection —
    ///      the one a keeper is deciding not to bother with — is exactly the one
    ///      that has been sitting uncollected. The price rises until someone takes
    ///      it, so the protocol pays the least that clears the market rather than
    ///      the most that would.
    uint256 internal constant BOUNTY_END_BPS = 250;

    /// @notice Absolute floor. Binds below a $20 installment.
    /// @dev ≈17× the measured pull cost. Below this a keeper is working for the
    ///      difference between two rounding errors and will not run.
    uint256 internal constant BOUNTY_FLOOR = ONE_USDC / 20;

    /// @notice Absolute cap.
    /// @dev Without it, 250 bp of a $5,000 B2B installment is a $125 bounty for
    ///      the same 140k gas. Five basis points on that leg is already ample.
    uint256 internal constant BOUNTY_CAP = (5 * ONE_USDC) / 2;

    // ─── Keeper market: the mark bounty ──────────────────────────────────────

    /// @notice Paid for recording a missed or expired installment.
    ///
    /// @dev Flat, because the work is flat, and unconditional, because this is the
    ///      one crank nobody profits from. A failed pull moves no money, so a
    ///      bounty taken from the pull would be zero exactly when the negative
    ///      signal matters most. Grace transitions, Passport marks, NAV
    ///      provisioning, the subordination gate and the first-payment-default kill
    ///      switch are all fed by an event that, unpaid, nobody creates.
    uint256 internal constant MARK_BOUNTY = ONE_USDC / 10;

    /// @notice Escrow a plan is funded with at origination to pay its own cranks.
    ///
    /// @dev Twice the mark budget: `count × MARK_BOUNTY` reserved for marks, and the
    ///      same again available for `revalidate()`.
    ///
    ///      The split matters. Both cranks pay from the same pot, and a plan whose
    ///      signer keeps changing could be revalidated once a week for ninety days —
    ///      enough calls to drain a single-budget escrow completely. The delinquency
    ///      signal would then fail exactly on the plans most likely to need it, which
    ///      is the failure mode the escrow exists to prevent. So the mark budget is
    ///      reserved: observation spends only the surplus.
    ///
    ///      $0.80 on a four-check plan — 0.8% of a $100 ticket. D2 called this "the
    ///      ops budget", but an operator-funded budget contradicts GOV-08's
    ///      requirement that the whole loop run with every operator role at the zero
    ///      address. Per-plan prefunding keeps the signal unconditional.
    function markEscrowFor(uint256 installmentCount) internal pure returns (uint256) {
        return installmentCount * MARK_BOUNTY * 2;
    }

    // ─── Clocks ──────────────────────────────────────────────────────────────

    /// @notice How long after a due date a borrower may cure before delinquency.
    uint256 internal constant GRACE_WINDOW = 3 days;

    /// @notice Days past due at which the plan charges off and the loss flows.
    uint256 internal constant CHARGE_OFF_AFTER = 60 days;

    /// @notice How long an authorization stays valid past its due date.
    /// @dev Sets `validBefore`. Long enough that a bounced check can still be
    ///      cured by a keeper the moment the borrower's balance covers it, short
    ///      enough that a signature does not hang over a wallet indefinitely.
    uint256 internal constant AUTHORIZATION_WINDOW = 90 days;

    /// @notice How long a `revalidate()` result is trusted for a contract signer.
    /// @dev The freshness half of D1. A contract account can change its validation
    ///      logic, so a strip it signed is only as good as the last time someone
    ///      checked it still validates. This is the observation the vendor webhook
    ///      was supposed to provide — except anyone can perform it and the result
    ///      is onchain.
    uint256 internal constant REVALIDATION_WINDOW = 7 days;

    /// @notice Minimum delay after `validAfter` before the operator relayer may crank.
    /// @dev COLL-07. The constant lives here so the claim "earlier collections are
    ///      provably third-party" is a number in the protocol rather than a policy
    ///      in an operator's config file. The relayer itself is Phase 4.
    uint256 internal constant RELAYER_DELAY_FLOOR = 30 minutes;

    // ─── Fees ────────────────────────────────────────────────────────────────

    /// @notice Flat late fee on delinquency, before the jurisdiction cap.
    uint256 internal constant LATE_FEE_FLAT = 7 * ONE_USDC;

    /// @notice Prepayment fee. Zero, deliberately.
    /// @dev Pay-in-4 is 0% on time. There is no interest to rebate, so a
    ///      prepayment penalty would be a charge for behaving well. Flex carries
    ///      interest and therefore an actuarial rebate; that is Phase 8, and it is
    ///      a rebate, never Rule-of-78s.
    uint256 internal constant EARLY_EXIT_FEE_BPS = 0;

    // ─── Schedule ────────────────────────────────────────────────────────────

    /// @notice Half-width of the due-date jitter window.
    ///
    /// @dev ±12h. A cohort originated on the same afternoon would otherwise all
    ///      come due in the same block, producing a collection wave that competes
    ///      with itself for gas and makes every keeper's pull a race it usually
    ///      loses. `PREVRANDAO` is always zero on Arc, so the offset is derived
    ///      deterministically from `planId` — which also means a borrower can
    ///      reproduce their own due dates without asking anyone.
    uint256 internal constant JITTER_HALF_WIDTH = 12 hours;

    uint256 internal constant BPS = 10_000;

    /// @notice The collect bounty for an installment, at a point in the ramp.
    /// @param installment The installment's face value, 6-decimal.
    /// @param elapsed Seconds since the installment came due.
    /// @param window The ramp's length — the grace window.
    function collectBounty(
        uint256 installment,
        uint256 elapsed,
        uint256 window
    ) internal pure returns (uint256) {
        uint256 bps;
        if (window == 0 || elapsed >= window) {
            bps = BOUNTY_END_BPS;
        } else {
            bps = BOUNTY_START_BPS + ((BOUNTY_END_BPS - BOUNTY_START_BPS) * elapsed) / window;
        }

        uint256 bounty = (installment * bps) / BPS;
        if (bounty < BOUNTY_FLOOR) bounty = BOUNTY_FLOOR;
        if (bounty > BOUNTY_CAP) bounty = BOUNTY_CAP;

        // A bounty can never exceed what it is paid out of. The clamp only binds on
        // an installment smaller than the floor, which the minimum ticket already
        // forbids — but the invariant that a collection nets non-negative to the
        // book should not depend on a parameter staying sane.
        if (bounty > installment) bounty = installment;
        return bounty;
    }

    /// @notice The deterministic due-date offset for a plan.
    /// @dev Uniform across the plan's installments, so the schedule stays exactly
    ///      `interval`-spaced and strictly increasing. Jittering each installment
    ///      independently would let two adjacent due dates cross.
    function jitter(bytes32 planId) internal pure returns (int256) {
        uint256 span = JITTER_HALF_WIDTH * 2;
        // Both operands are at most 24 hours in seconds. Nothing here can truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return int256(uint256(planId) % span) - int256(JITTER_HALF_WIDTH);
    }
}
