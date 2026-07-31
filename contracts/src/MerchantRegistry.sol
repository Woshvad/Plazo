// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {ParameterRegistry} from "./ParameterRegistry.sol";
import {ParameterKeys} from "./libraries/ParameterKeys.sol";
import {PlanParams} from "./libraries/PlanParams.sol";

/// @title MerchantRegistry
/// @notice Merchant standing, exposure, and the bond that scales with it.
///
/// @dev MERCH-01 and MERCH-06. The fraud posture for the whole book is set here, and
///      it is set against one specific attack: **refund arbitrage**. A merchant sells
///      to a confederate on credit, the pool fronts the full amount, the merchant
///      "refunds" to a different address, and the pool holds a receivable against a
///      borrower who will never pay for goods that never moved. It is the
///      highest-yield attack on a BNPL book because the attacker is paid before
///      anyone can observe anything.
///
///      A flat entry bond does not price that. A well-capitalised attacker pays it
///      once and then runs unbounded volume. So the bond here is a **function of
///      outstanding fronted exposure**: it grows as the protocol's money goes out
///      and shrinks as it comes back, which means the merchant's own skin is always
///      proportional to what they could currently walk away with.
///
///      **Vesting is a withholding, not a discount schedule (DEC-09).** MERCH-06 says
///      "MDR vesting delays apply to new merchants". Read as a rate that improves
///      over time, that is a pricing gimmick. Read as a withholding, it is the
///      control the fraud model needs — and it makes the exposure-scaled bond
///      *self-funding*: a fraction of every settlement to a new merchant goes into
///      their own bond rather than out of the door, so the bond grows in lockstep
///      with exposure automatically instead of requiring the merchant to predict how
///      much capital to lock up on day one. The merchant most likely to run refund
///      arbitrage is the one who just onboarded, which is exactly who this binds.
///
///      **Velocity is a leaky bucket, not a fixed window.** A fixed window lets a new
///      merchant run two full caps back to back across the boundary, which on a
///      daily cap is a two-day fraud budget spent in ten minutes.
contract MerchantRegistry is AccessControl {
    using SafeERC20 for IERC20;

    /// @notice May attest that a merchant passed KYB.
    /// @dev The KYB itself is off-chain and always will be. What is on-chain is that
    ///      a named key asserted it, and when — so a merchant onboarded without one
    ///      is visible rather than merely undocumented.
    bytes32 public constant KYB_ROLE = keccak256("PLAZO.KYB");

    /// @notice May move exposure and withhold from settlement.
    /// @dev Held by `CheckoutRouter` and by the pool's recognition crank. Nothing
    ///      else may write exposure, because exposure is what the bond is priced off.
    bytes32 public constant BOOKKEEPER_ROLE = keccak256("PLAZO.MERCHANT_BOOKKEEPER");

    /// @notice May take a merchant's bond.
    /// @dev Unheld in Phase 3. Phase 6's `RefundEscrow` is what earns it: slashing is
    ///      only defensible when there is an adjudicated refund dispute to slash
    ///      against, and there is not one yet. The role exists so granting it later
    ///      is a deliberate act rather than a new deployment.
    bytes32 public constant SLASHER_ROLE = keccak256("PLAZO.SLASHER");

    struct Merchant {
        bool registered;
        bool kybVerified;
        uint64 registeredAt;
        /// @notice Where settlement is sent, and on which CCTP domain.
        address payoutRecipient;
        uint32 payoutDomain;
        /// @notice USDC posted plus USDC withheld from settlement.
        uint256 bond;
        /// @notice The part of `bond` that arrived by withholding rather than deposit.
        uint256 withheld;
        /// @notice Principal the pool has fronted and not yet recovered.
        uint256 outstandingFronted;
        /// @notice Leaky-bucket state for the velocity cap.
        uint256 bucket;
        uint64 bucketAt;
        /// @notice Per-merchant override. Zero means "use the policy default".
        uint256 velocityCapOverride;
    }

    IERC20 public immutable token;
    ParameterRegistry public immutable parameters;

    mapping(address merchant => Merchant) private _merchants;

    /// @notice Total principal fronted across every merchant, not yet recovered.
    /// @dev The denominator for UW-09's per-merchant concentration cap.
    uint256 public totalFronted;

    event MerchantRegistered(address indexed merchant, uint256 bond);
    event KybAttested(address indexed merchant, bool verified, address indexed attestor);
    event BondPosted(address indexed merchant, address indexed from, uint256 amount, uint256 total);
    event BondWithheld(address indexed merchant, bytes32 indexed planId, uint256 amount, uint256 total);
    event BondReleased(address indexed merchant, uint256 amount, uint256 total);
    event BondSlashed(address indexed merchant, address indexed to, uint256 amount);
    event PayoutRouteChanged(address indexed merchant, address recipient, uint32 domain);
    event ExposureChanged(address indexed merchant, uint256 outstanding, uint256 requiredBond);
    event VelocityCapOverridden(address indexed merchant, uint256 cap);

    error AlreadyRegistered(address merchant);
    error NotRegistered(address merchant);
    error NotKybVerified(address merchant);
    error RecipientZero();
    error OnlyMerchant(address caller, address merchant);
    error BondBelowRequirement(uint256 held, uint256 required);
    error VelocityCapExceeded(uint256 attempted, uint256 cap);
    error ExposureUnderflow(uint256 outstanding, uint256 reduction);
    error NothingToRelease();

    constructor(address admin, address token_, address parameters_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        token = IERC20(token_);
        parameters = ParameterRegistry(parameters_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Onboarding
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Register as a merchant.
    /// @dev Self-serve and permissionless. Registration is not permission to
    ///      originate — that needs a KYB attestation and a bond — so gating this too
    ///      would only mean an operator has to be online for a merchant to fill in a
    ///      form. MERCH-05's sandbox is built on exactly this being open.
    function register(address payoutRecipient, uint32 payoutDomain) external {
        Merchant storage m = _merchants[msg.sender];
        if (m.registered) revert AlreadyRegistered(msg.sender);
        if (payoutRecipient == address(0)) revert RecipientZero();

        m.registered = true;
        m.registeredAt = uint64(block.timestamp);
        m.payoutRecipient = payoutRecipient;
        m.payoutDomain = payoutDomain;
        m.bucketAt = uint64(block.timestamp);

        emit MerchantRegistered(msg.sender, 0);
        emit PayoutRouteChanged(msg.sender, payoutRecipient, payoutDomain);
    }

    function attestKyb(address merchant, bool verified) external onlyRole(KYB_ROLE) {
        if (!_merchants[merchant].registered) revert NotRegistered(merchant);
        _merchants[merchant].kybVerified = verified;
        emit KybAttested(merchant, verified, msg.sender);
    }

    function setPayoutRoute(address payoutRecipient, uint32 payoutDomain) external {
        Merchant storage m = _merchants[msg.sender];
        if (!m.registered) revert NotRegistered(msg.sender);
        if (payoutRecipient == address(0)) revert RecipientZero();
        m.payoutRecipient = payoutRecipient;
        m.payoutDomain = payoutDomain;
        emit PayoutRouteChanged(msg.sender, payoutRecipient, payoutDomain);
    }

    function setVelocityCapOverride(address merchant, uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!_merchants[merchant].registered) revert NotRegistered(merchant);
        _merchants[merchant].velocityCapOverride = cap;
        emit VelocityCapOverridden(merchant, cap);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Bond
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Add to a merchant's bond. Anyone may fund it.
    /// @dev A merchant's underwriter, their PSP, or the merchant themselves. The bond
    ///      belongs to the merchant either way; who paid it in is not a property the
    ///      protocol needs to track, and tracking it would create a claim on
    ///      withdrawal that the protocol would then have to adjudicate.
    function postBond(address merchant, uint256 amount) external {
        Merchant storage m = _merchants[merchant];
        if (!m.registered) revert NotRegistered(merchant);

        token.safeTransferFrom(msg.sender, address(this), amount);
        m.bond += amount;
        emit BondPosted(merchant, msg.sender, amount, m.bond);
    }

    /// @notice Withdraw bond down to the requirement.
    /// @dev The requirement moves with exposure, so a merchant winding down recovers
    ///      their bond as their plans repay — without an operator having to decide
    ///      when. A merchant with live exposure cannot withdraw beneath it, which is
    ///      the entire mechanism.
    function withdrawBond(uint256 amount) external {
        Merchant storage m = _merchants[msg.sender];
        if (!m.registered) revert NotRegistered(msg.sender);

        uint256 required = requiredBond(msg.sender);
        if (m.bond < amount || m.bond - amount < required) {
            revert BondBelowRequirement(m.bond < amount ? m.bond : m.bond - amount, required);
        }

        m.bond -= amount;
        // Withheld capital is released first: it is the merchant's own settlement
        // money that was held back, and returning deposited capital while holding
        // withheld earnings would be the protocol keeping the wrong dollars.
        uint256 fromWithheld = amount > m.withheld ? m.withheld : amount;
        m.withheld -= fromWithheld;

        token.safeTransfer(msg.sender, amount);
        emit BondReleased(msg.sender, amount, m.bond);
    }

    /// @notice The bond `merchant` must hold at their current exposure.
    function requiredBond(address merchant) public view returns (uint256) {
        Merchant storage m = _merchants[merchant];
        if (!m.registered) return 0;

        uint256 scaled =
            (m.outstandingFronted * parameters.get(ParameterKeys.MERCHANT_BOND_BPS)) / PlanParams.BPS;
        uint256 floor_ = parameters.get(ParameterKeys.MERCHANT_BOND_FLOOR);
        return scaled > floor_ ? scaled : floor_;
    }

    /// @notice Take bond. Phase 6.
    function slash(address merchant, address to, uint256 amount) external onlyRole(SLASHER_ROLE) {
        Merchant storage m = _merchants[merchant];
        if (m.bond < amount) revert BondBelowRequirement(m.bond, amount);
        m.bond -= amount;
        uint256 fromWithheld = amount > m.withheld ? m.withheld : amount;
        m.withheld -= fromWithheld;
        token.safeTransfer(to, amount);
        emit BondSlashed(merchant, to, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Exposure and settlement
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice What fraction of a settlement is withheld into bond right now.
    /// @dev Zero once the merchant is seasoned. The window is wall-clock rather than
    ///      plan-count because the risk being priced is "this merchant has no track
    ///      record", and a merchant who ran one plan in ninety days has no more track
    ///      record than one who ran none.
    function vestingBpsFor(address merchant) public view returns (uint256) {
        Merchant storage m = _merchants[merchant];
        if (!m.registered) return 0;
        uint256 window = parameters.get(ParameterKeys.MERCHANT_VESTING_WINDOW);
        if (block.timestamp >= uint256(m.registeredAt) + window) return 0;
        return parameters.get(ParameterKeys.MERCHANT_VESTING_BPS);
    }

    function isSeasoned(address merchant) external view returns (bool) {
        return vestingBpsFor(merchant) == 0 && _merchants[merchant].registered;
    }

    /// @notice The velocity cap in force for `merchant`.
    function velocityCapFor(address merchant) public view returns (uint256) {
        Merchant storage m = _merchants[merchant];
        if (m.velocityCapOverride != 0) return m.velocityCapOverride;
        if (vestingBpsFor(merchant) == 0) return type(uint256).max;
        return parameters.get(ParameterKeys.MERCHANT_VELOCITY_CAP);
    }

    /// @notice Volume already counted against the cap, after decay.
    function velocityUsed(address merchant) public view returns (uint256) {
        Merchant storage m = _merchants[merchant];
        uint256 window = parameters.get(ParameterKeys.MERCHANT_VELOCITY_WINDOW);
        uint256 elapsed = block.timestamp - m.bucketAt;
        if (elapsed >= window) return 0;
        return m.bucket - (m.bucket * elapsed) / window;
    }

    /// @notice Whether `merchant` could originate `principal` right now.
    /// @dev A view so a quote can answer "would this go through" without attempting
    ///      it. CHKT-01's quote is worth nothing if it can be contradicted at the
    ///      moment of signing.
    function canOriginate(address merchant, uint256 principal)
        external
        view
        returns (bool ok, string memory reason)
    {
        Merchant storage m = _merchants[merchant];
        if (!m.registered) return (false, "merchant not registered");
        if (!m.kybVerified) return (false, "merchant not KYB verified");
        if (velocityUsed(merchant) + principal > velocityCapFor(merchant)) {
            return (false, "merchant velocity cap");
        }

        uint256 bondAfter = m.bond + (principal * vestingBpsFor(merchant)) / PlanParams.BPS;
        uint256 requiredAfter = _requiredBondAt(m.outstandingFronted + principal);
        if (bondAfter < requiredAfter) return (false, "merchant bond below requirement");

        return (true, "");
    }

    /// @notice Record an origination against `merchant`.
    /// @dev Router-only. Checks velocity and the post-origination bond requirement in
    ///      the same call that increments exposure, so there is no window in which
    ///      exposure has moved and the requirement has not been tested. The router
    ///      posts the settlement withholding through `postWithheld` first, so the
    ///      bond that funds the requirement is already here when it is tested.
    function noteOrigination(address merchant, uint256 principal) external onlyRole(BOOKKEEPER_ROLE) {
        Merchant storage m = _merchants[merchant];
        if (!m.registered) revert NotRegistered(merchant);
        if (!m.kybVerified) revert NotKybVerified(merchant);

        uint256 used = velocityUsed(merchant);
        uint256 cap = velocityCapFor(merchant);
        if (used + principal > cap) revert VelocityCapExceeded(used + principal, cap);
        m.bucket = used + principal;
        m.bucketAt = uint64(block.timestamp);

        m.outstandingFronted += principal;
        totalFronted += principal;

        uint256 required = requiredBond(merchant);
        if (m.bond < required) revert BondBelowRequirement(m.bond, required);

        emit ExposureChanged(merchant, m.outstandingFronted, required);
    }

    /// @notice Record that fronted principal came back.
    /// @dev Bookkeeper-only, and saturating rather than reverting on an over-report.
    ///      Exposure is a risk gauge, not an accounting identity — the pool's booked
    ///      accumulator is the identity. A recognition crank that would drive this
    ///      below zero should reduce the bond requirement to nothing, not brick the
    ///      crank that reduces every other merchant's too.
    function noteRecovered(address merchant, uint256 amount) external onlyRole(BOOKKEEPER_ROLE) {
        Merchant storage m = _merchants[merchant];
        uint256 reduction = amount > m.outstandingFronted ? m.outstandingFronted : amount;
        m.outstandingFronted -= reduction;
        totalFronted -= reduction > totalFronted ? totalFronted : reduction;
        emit ExposureChanged(merchant, m.outstandingFronted, requiredBond(merchant));
    }

    /// @notice Post a withholding taken out of a settlement.
    ///
    /// @dev DEC-09, and the mechanism that makes the exposure-scaled bond
    ///      self-funding. The router holds the merchant's net settlement for the
    ///      length of one transaction and sends this fraction of it here instead of
    ///      onward. The merchant's own earnings capitalise their own bond, so the
    ///      bond grows in lockstep with exposure rather than requiring a new merchant
    ///      to predict on day one how much capital to lock up.
    ///
    ///      Bookkeeper-gated because it is an accounting entry with a transfer
    ///      attached: anyone may `postBond`, but only the router may declare that a
    ///      given dollar was withheld from a given plan's settlement.
    function postWithheld(address merchant, bytes32 planId, uint256 amount)
        external
        onlyRole(BOOKKEEPER_ROLE)
    {
        Merchant storage m = _merchants[merchant];
        if (!m.registered) revert NotRegistered(merchant);

        token.safeTransferFrom(msg.sender, address(this), amount);
        m.bond += amount;
        m.withheld += amount;
        emit BondWithheld(merchant, planId, amount, m.bond);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    function merchantOf(address merchant) external view returns (Merchant memory) {
        return _merchants[merchant];
    }

    function isRegistered(address merchant) external view returns (bool) {
        return _merchants[merchant].registered;
    }

    function isKybVerified(address merchant) external view returns (bool) {
        return _merchants[merchant].kybVerified;
    }

    function bondOf(address merchant) external view returns (uint256) {
        return _merchants[merchant].bond;
    }

    function outstandingFrontedFor(address merchant) external view returns (uint256) {
        return _merchants[merchant].outstandingFronted;
    }

    function payoutRouteOf(address merchant) external view returns (address recipient, uint32 domain) {
        Merchant storage m = _merchants[merchant];
        return (m.payoutRecipient, m.payoutDomain);
    }

    function _requiredBondAt(uint256 exposure) private view returns (uint256) {
        uint256 scaled = (exposure * parameters.get(ParameterKeys.MERCHANT_BOND_BPS)) / PlanParams.BPS;
        uint256 floor_ = parameters.get(ParameterKeys.MERCHANT_BOND_FLOOR);
        return scaled > floor_ ? scaled : floor_;
    }
}
