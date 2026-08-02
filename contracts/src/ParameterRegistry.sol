// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ParameterKeys} from "./libraries/ParameterKeys.sol";
import {PlanParams} from "./libraries/PlanParams.sol";

/// @title ParameterRegistry
/// @notice Every Appendix A launch hypothesis, behind a hard-coded band.
///
/// @dev GOV-01 and D10. Appendix A's loss-side numbers are hypotheses, not settled
///      truth — the whole point of the cohort recalibration track is that measured
///      testnet performance moves them. The question this contract answers is *how*
///      they move.
///
///      **The registry governs origination, never a live plan.** Every parameter a
///      plan reads is copied into the plan at initialisation and never read again;
///      that is what `termsHash` exists to make true. So nothing here can re-price a
///      deal a borrower has already signed, and nothing here is allowed to try. The
///      recalibration story is "the next cohort originates under different
///      parameters", never "outstanding plans re-price". Anyone reaching for the
///      second has misunderstood what a signed strip is.
///
///      **Bands are hard-coded and the ratchet is one-way.** Rows are seeded in the
///      constructor from the literal constants below. Governance may set a value
///      inside its band, and may permanently *narrow* a band. It can never widen
///      one, and there is no function that would let it. A governance key that can
///      set any value is a governance key that can set a usurious one, and "we would
///      never" is not a control.
///
///      **An undefined key reverts.** A registry that returned zero for a key nobody
///      configured would make a typo in a deployment script into a plan originated
///      at a zero minimum ticket with a zero MDR. Reading is total or it fails.
///
///      Timelocking the owner is GOV-02 and Phase 9. Nothing here needs to change
///      for a timelock to become the owner.
contract ParameterRegistry is Ownable {
    struct Parameter {
        uint256 value;
        uint256 min;
        uint256 max;
        bool defined;
    }

    mapping(bytes32 key => Parameter) private _parameters;

    /// @notice Every key seeded at construction, in seed order.
    /// @dev Enumerable so an operator console, an auditor or a deployment check can
    ///      read the whole configuration without knowing the key list in advance.
    bytes32[] private _keys;

    event ParameterSet(bytes32 indexed key, uint256 previous, uint256 value);
    event ParameterDefined(bytes32 indexed key, uint256 value, uint256 min, uint256 max);
    event BandNarrowed(bytes32 indexed key, uint256 min, uint256 max);

    error ParameterUndefined(bytes32 key);
    error ParameterAlreadyDefined(bytes32 key);
    error OutOfBand(bytes32 key, uint256 value, uint256 min, uint256 max);
    error BandNotNarrower(bytes32 key, uint256 min, uint256 max);
    error BandInverted(uint256 min, uint256 max);

    constructor(address governance) Ownable(governance) {
        uint256 usdc = PlanParams.ONE_USDC;

        // ─── Ticket and pricing ──────────────────────────────────────────────

        // The Phase 1 measurement, and the floor the keeper market sets.
        _define(ParameterKeys.MIN_TICKET, PlanParams.MIN_TICKET, 25 * usdc, 1000 * usdc);
        // Tier 0 never approaches this; it exists so a mis-signed attestation cannot
        // originate an arbitrarily large plan against the book.
        _define(ParameterKeys.MAX_TICKET, 2000 * usdc, 100 * usdc, 50_000 * usdc);
        // 4%. The band's ceiling is 10% because above that the product is not
        // competitive with the incumbents it is meant to displace, and a parameter
        // that can be set to a number the business would never choose is a parameter
        // whose band is doing no work.
        _define(ParameterKeys.MDR_BPS, 400, 0, 1000);

        // ─── Tier 0 ──────────────────────────────────────────────────────────

        _define(ParameterKeys.TIER0_INITIAL_LIMIT, 100 * usdc, 50 * usdc, 500 * usdc);
        // ×1.25 per cleanly completed plan. The floor of the band is 1.0 — growth can
        // be switched off, never reversed into a shrink, because a limit that falls
        // on good behaviour is a bug in every reading.
        _define(ParameterKeys.TIER0_GROWTH_BPS, 12_500, 10_000, 15_000);
        // The pseudonymous cap is what an attacker gets per wallet they are willing to
        // create. It is set to what the book can afford to lose that many times, not
        // to what a well-behaved pseudonymous borrower deserves. Raising it is the
        // single most tempting recalibration and the single most dangerous one.
        _define(ParameterKeys.TIER0_PSEUDONYMOUS_CAP, 200 * usdc, 50 * usdc, 500 * usdc);
        _define(ParameterKeys.TIER0_IDENTIFIED_CAP, 1000 * usdc, 100 * usdc, 5000 * usdc);
        // DEC-02. Tier 0 draws pool capital from day one, so this cap and the FPD
        // switch are the two things standing between an unproven scorecard and the
        // senior tranche. The band's ceiling is 25%.
        _define(ParameterKeys.TIER0_BOOK_SHARE_BPS, 1000, 100, 2500);
        // UW-10. An account whose signature validation can change is an account whose
        // strip is only as good as the last `revalidate()`.
        _define(ParameterKeys.CONTRACT_SIGNER_CAP_BPS, 5000, 1000, 10_000);
        // CHKT-05's hard onchain ceiling. An attestation can only ever lower what the
        // chain would have allowed; this is the number a stolen signing key runs into.
        _define(ParameterKeys.LIMIT_HARD_CEILING, 5000 * usdc, 100 * usdc, 100_000 * usdc);
        // Minutes, not hours. An attestation that outlives its checkout is a bearer
        // credential.
        _define(ParameterKeys.ATTESTATION_MAX_TTL, 15 minutes, 1 minutes, 24 hours);

        // ─── First-payment-default kill switch ───────────────────────────────

        // Below this many observations the switch cannot fire at all. Three defaults
        // out of five plans is noise, and a switch that fires on noise is a switch an
        // attacker can trip for the price of five plans.
        _define(ParameterKeys.FPD_MIN_COHORT, 50, 10, 10_000);
        _define(ParameterKeys.FPD_TRIGGER_BPS, 500, 100, 5000);
        _define(ParameterKeys.FPD_FULL_STOP_BPS, 2000, 200, 10_000);
        // A new wallet's default counts a quarter. New wallets are the cheap thing to
        // manufacture, so an attacker buying the throttle down has to pay for
        // *seasoned* ones — and a seasoned wallet costs real completed plans to make.
        _define(ParameterKeys.FPD_NEW_WALLET_WEIGHT_BPS, 2500, 0, 10_000);
        // Graduated, not binary: the switch outputs a throttle, and this is how far
        // down it can push. Zero means a full stop is reachable.
        _define(ParameterKeys.FPD_THROTTLE_FLOOR_BPS, 0, 0, 5000);
        _define(ParameterKeys.FPD_SEASONING_PLANS, 1, 1, 10);
        // Observations decay over this window, so a book that has run for a year is
        // not anchored by the cohort it originated in its first month. An all-time
        // rate is a rate that stops responding exactly when it needs to.
        _define(ParameterKeys.FPD_OBSERVATION_WINDOW, 30 days, 1 days, 365 days);

        // ─── Pool ────────────────────────────────────────────────────────────

        _define(ParameterKeys.MIN_SUBORDINATION_BPS, 1000, 500, 5000);
        _define(ParameterKeys.MIN_RESERVE_BPS, 200, 50, 2000);
        _define(ParameterKeys.RESERVE_TARGET_BPS, 500, 100, 5000);

        // ─── Epoch accounting ────────────────────────────────────────────────

        // A day on testnet. The band's floor is an hour, which is short enough to
        // exercise the machinery and long enough that an epoch is never a block.
        // Its ceiling is thirty days, because an LP whose deposit waits longer than a
        // month for a price is an LP holding an option they did not buy.
        _define(ParameterKeys.EPOCH_LENGTH, 1 days, 1 hours, 30 days);
        // POOL-07. Half of a delinquent plan's carrying value, marked down the moment
        // the delinquency is public rather than at charge-off. A book that waits until
        // the sixtieth day to admit a loss is a book selling shares at a price it
        // already knows is wrong.
        _define(ParameterKeys.DELINQUENT_PROVISION_BPS, 5000, 0, 10_000);
        // The share of assets kept as cash rather than deployed to the savings venue.
        // Redemptions fill from cash, so this is the difference between a queue that
        // moves every epoch and one that waits on a venue redemption.
        _define(ParameterKeys.BUFFER_FLOOR_BPS, 1000, 0, 5000);
        // POOL-09. Above this much net redemption in one epoch the liquidity fee
        // switches on. Ten percent of the book leaving in a day is not ordinary
        // runoff.
        _define(ParameterKeys.LIQUIDITY_FEE_THRESHOLD_BPS, 1000, 100, 10_000);
        // One percent, charged uniformly to everyone filled in that epoch, and it
        // stays in the pool. The point is not the revenue — it is that redeeming
        // early stops being profitable, which is the only thing that stops a run.
        _define(ParameterKeys.LIQUIDITY_FEE_BPS, 100, 0, 500);
        // POOL-10. One full Pay-in-4 tenor: four biweekly installments.
        _define(ParameterKeys.JUNIOR_LOCK_PERIOD, 56 days, 1 days, 365 days);
        // Senior's target return. It is a target and not a promise: the claim accrues
        // and is paid first out of income, and if income is short the shortfall
        // carries rather than being conjured. The band's ceiling is 30% because a
        // senior tranche demanding more than that is not senior paper.
        _define(ParameterKeys.SENIOR_TARGET_APY_BPS, 800, 0, 3000);

        // ─── Passport and servicing ──────────────────────────────────────────

        // PASS-03. Twenty-four months, and the band's floor is six because a record
        // that forgets faster than a borrower can rebuild is not a record.
        _define(ParameterKeys.PASSPORT_NEGATIVE_MARK_TTL, 730 days, 180 days, 1095 days);
        // PASS-04. A consent grant is a bearer credential for a borrower's credit
        // record; ninety days is already generous and the band says so.
        _define(ParameterKeys.PASSPORT_CONSENT_MAX_TTL, 90 days, 1 days, 365 days);
        // COLL-07. The operator's collections wait this long after `validAfter`, so
        // anything collected earlier is provably not the operator's.
        _define(ParameterKeys.RELAYER_DELAY_FLOOR, 30 minutes, 1 minutes, 24 hours);

        // ─── Merchant ────────────────────────────────────────────────────────

        // The bond scales with outstanding fronted exposure rather than being a flat
        // entry cost, because refund arbitrage is the highest-yield attack on this
        // book and a flat cost is one a well-capitalised attacker pays once.
        _define(ParameterKeys.MERCHANT_BOND_BPS, 1000, 0, 5000);
        _define(ParameterKeys.MERCHANT_BOND_FLOOR, 250 * usdc, 0, 10_000 * usdc);
        _define(ParameterKeys.MERCHANT_VESTING_WINDOW, 90 days, 0, 365 days);
        _define(ParameterKeys.MERCHANT_VESTING_BPS, 1000, 0, 3000);
        _define(ParameterKeys.MERCHANT_VELOCITY_WINDOW, 1 days, 1 hours, 30 days);
        _define(ParameterKeys.MERCHANT_VELOCITY_CAP, 5000 * usdc, 100 * usdc, 1_000_000 * usdc);

        // ─── Concentration (UW-09) ───────────────────────────────────────────

        _define(ParameterKeys.MERCHANT_CONCENTRATION_BPS, 2000, 100, 10_000);
        _define(ParameterKeys.CORRIDOR_CONCENTRATION_BPS, 5000, 100, 10_000);

        // ─── Settlement escrow (Phase 6) ─────────────────────────────────────

        // D-08's launch hypothesis for how long a merchant has to attest shipment
        // before the settlement goes back to the pool. The floor is a day because a
        // merchant who has not touched an order in twenty-four hours has not
        // necessarily abandoned it — warehouses close and weekends exist — and the
        // ceiling is thirty because capital held for a month against a shipment
        // nobody has attested is capital the pool is not earning on.
        _define(ParameterKeys.ESCROW_ATTESTATION_DEADLINE, 7 days, 1 days, 30 days);
        // D-08's other launch hypothesis: how long after attested shipment the
        // settlement sits before anyone can release it. The floor is an hour, which
        // is long enough to be a window and short enough that a digital-adjacent
        // merchant is not financed for a day; the ceiling is a fortnight, past which
        // the escrow has stopped being a fraud control and started being working
        // capital taken from the merchant. Both timers are recalibration targets on
        // the standing cohort track, like every other Appendix A value.
        _define(ParameterKeys.ESCROW_RELEASE_TIMER, 72 hours, 1 hours, 14 days);
        // D-03. The window between an arbiter opening a dispute and anyone being able
        // to reach a merchant's bond. **The floor is the security property, not a
        // default.** Twenty-four hours is the smallest window in which a merchant
        // watching the chain can see a slash coming and answer it; a compiled band is
        // what stops governance from setting this to zero and turning `SLASHER_ROLE`
        // back into an instant key over every bond on the book. A later reader trying
        // to speed up adjudication will reach for exactly this number — the band is
        // the answer, and widening it needs a redeployment.
        _define(ParameterKeys.ESCROW_DISPUTE_TIMELOCK, 72 hours, 24 hours, 30 days);
    }

    /// @notice The current value for `key`.
    /// @dev Reverts on an undefined key. See the contract note.
    function get(bytes32 key) public view returns (uint256) {
        Parameter storage p = _parameters[key];
        if (!p.defined) revert ParameterUndefined(key);
        return p.value;
    }

    /// @notice Several rows in one read.
    /// @dev Origination reads a dozen parameters in a single transaction; this keeps
    ///      that one call rather than a dozen, and keeps the call sites readable.
    function getMany(bytes32[] calldata wanted) external view returns (uint256[] memory values) {
        values = new uint256[](wanted.length);
        for (uint256 i = 0; i < wanted.length; ++i) {
            values[i] = get(wanted[i]);
        }
    }

    function parameter(bytes32 key) external view returns (Parameter memory) {
        Parameter memory p = _parameters[key];
        if (!p.defined) revert ParameterUndefined(key);
        return p;
    }

    function isDefined(bytes32 key) external view returns (bool) {
        return _parameters[key].defined;
    }

    /// @notice Every seeded key, in seed order.
    function keys() external view returns (bytes32[] memory) {
        return _keys;
    }

    function keyCount() external view returns (uint256) {
        return _keys.length;
    }

    /// @notice Move a parameter inside its band.
    function set(bytes32 key, uint256 value) external onlyOwner {
        Parameter storage p = _parameters[key];
        if (!p.defined) revert ParameterUndefined(key);
        if (value < p.min || value > p.max) revert OutOfBand(key, value, p.min, p.max);

        uint256 previous = p.value;
        p.value = value;
        emit ParameterSet(key, previous, value);
    }

    /// @notice Permanently tighten a band.
    ///
    /// @dev One-way. The new band must sit inside the old one and must still contain
    ///      the current value, so narrowing can never strand a live configuration
    ///      outside its own limits.
    ///
    ///      There is no widening function, and that is the feature. A protocol that
    ///      has learned its true risk appetite should be able to write it down
    ///      irreversibly; a protocol that can un-learn it has not written anything
    ///      down at all.
    function narrowBand(bytes32 key, uint256 min, uint256 max) external onlyOwner {
        Parameter storage p = _parameters[key];
        if (!p.defined) revert ParameterUndefined(key);
        if (min > max) revert BandInverted(min, max);
        if (min < p.min || max > p.max) revert BandNotNarrower(key, min, max);
        if (p.value < min || p.value > max) revert OutOfBand(key, p.value, min, max);

        p.min = min;
        p.max = max;
        emit BandNarrowed(key, min, max);
    }

    function _define(bytes32 key, uint256 value, uint256 min, uint256 max) private {
        if (_parameters[key].defined) revert ParameterAlreadyDefined(key);
        if (min > max) revert BandInverted(min, max);
        if (value < min || value > max) revert OutOfBand(key, value, min, max);

        _parameters[key] = Parameter({value: value, min: min, max: max, defined: true});
        _keys.push(key);
        emit ParameterDefined(key, value, min, max);
    }
}
