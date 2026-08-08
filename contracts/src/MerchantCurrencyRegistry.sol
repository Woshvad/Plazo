// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MerchantCurrencyRegistry
/// @notice Which currency a merchant wants to be paid in. MERCH-07's currency half.
///
/// @dev **Why this is a side-car and not a field on `MerchantRegistry`.** That contract
///      custodies merchant capital — posted collateral plus the fraction withheld out of
///      settlement — and it exposes no setter for a field it does not already declare.
///      Adding one is therefore a redeployment, and a redeployment of a contract holding
///      merchant capital strands that capital on the superseded address: 06-13 did exactly
///      this and left 46 USDC behind at `0xcbab6e5e…`, where the merchant's own withdrawal
///      function is still the only route to it. Doing it a second time for a *preference
///      field* would be paying the highest price in the codebase for the cheapest feature
///      in the phase. A second registry that custodies nothing costs a deployment and a
///      role grant, and MERCH-07's currency half does not earn more than that.
///
///      **Nothing here holds value, and that is a checkable property rather than an
///      intention.** This contract has no token reference, no balance, no movement of any
///      asset, and a grep gate on the plan's acceptance criteria asserts as much. The blast
///      radius of a mistake in this file is therefore one settlement being routed into the
///      wrong currency through a guard that still applies its own floor — never a claim on
///      anybody's capital.
///
///      **Election is self-serve; the allowlist is governance's.** `setPayoutCurrency` is
///      keyed on `msg.sender` for the same reason `MerchantRegistry.setPayoutRoute` is: a
///      payout preference is the merchant's own business, and gating it would only mean an
///      operator has to be awake for a merchant to change their mind. What is *not* the
///      merchant's own business is which ERC-20s the protocol will approve a venue against.
///      Without `allowCurrency` a merchant could name any token — one with a transfer hook,
///      one that reverts on receipt, one that is a proxy they control — and the router would
///      approve a settlement venue to move real value into it. So the set of nameable
///      currencies is a risk control and lives with the curator, exactly as
///      `MerchantRegistry.setCategory` lives with `KYB_ROLE` while `setPayoutRoute` does not.
///
///      **Zero means "pay in the plan's own currency", and that default is the security
///      property.** Every merchant registered before this contract existed reads zero, so
///      no existing merchant's settlement moves by one wei on the day this deploys. A
///      non-zero answer is always an affirmative act by the merchant themselves. The
///      alternative default — some configured base currency — would silently re-route the
///      entire existing book on a deployment, which is the kind of change that is only
///      discovered by the merchant who reconciles.
///
///      **A revoked allowance stops routing, and the election survives.** `payoutCurrencyOf`
///      is the *effective* answer and it re-checks the allowlist on every read, so a currency
///      governance has withdrawn falls back to zero — which is to say, back to the plan's
///      own currency, which is always payable and always safe. This is deliberately not a
///      revert: a merchant whose elected currency is withdrawn should keep getting paid, not
///      have their checkout stop. And it is deliberately not a stale pass-through either,
///      because an allowlist that cannot be un-set is a control that only ever works before
///      anybody needs it. `electedCurrencyOf` still reports what the merchant chose, so the
///      election is recoverable the moment the allowance returns and governance can see
///      exactly who a revocation affects.
contract MerchantCurrencyRegistry is AccessControl {
    /// @notice May decide which currencies a merchant is permitted to name.
    /// @dev Named for what it curates rather than for this contract, so a role audit
    ///      reading the Phase 9 governance graph sees the authority and not the file.
    bytes32 public constant CURATOR_ROLE = keccak256("PLAZO.CURRENCY_CURATOR");

    /// @notice What each merchant asked to be paid in. Zero for everybody by default.
    mapping(address merchant => address) private _payoutCurrency;

    /// @notice Which currencies may be named at all.
    mapping(address currency => bool) private _allowed;

    event PayoutCurrencySet(address indexed merchant, address indexed currency);
    event CurrencyAllowed(address indexed currency, bool allowed, address indexed by);

    error CurrencyNotAllowed(address currency);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CURATOR_ROLE, admin);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The merchant's own preference
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Elect the currency this merchant is paid in.
    ///
    /// @dev Self-serve on `msg.sender`, with no merchant argument and no role, because a
    ///      payout currency is a preference. Passing `address(0)` clears the election and
    ///      returns the merchant to being paid in whatever currency each plan is
    ///      denominated in — which is why zero is never checked against the allowlist.
    ///      Un-electing must never be refusable; a merchant who cannot get back to the
    ///      default is a merchant a withdrawn allowance could strand.
    function setPayoutCurrency(address currency) external {
        if (currency != address(0) && !_allowed[currency]) revert CurrencyNotAllowed(currency);

        _payoutCurrency[msg.sender] = currency;
        emit PayoutCurrencySet(msg.sender, currency);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Governance's allowlist
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Permit or withdraw a currency merchants may name.
    /// @dev Reversible on purpose, unlike `PoolRegistry.register`. A product line's book
    ///      cannot be repointed because outstanding plans settle to it; an allowlist entry
    ///      has no outstanding claim behind it, so the only cost of withdrawing one is that
    ///      elections naming it stop taking effect — which is the entire point of having it.
    function allowCurrency(address currency, bool allowed) external onlyRole(CURATOR_ROLE) {
        _allowed[currency] = allowed;
        emit CurrencyAllowed(currency, allowed, msg.sender);
    }

    function isAllowed(address currency) external view returns (bool) {
        return _allowed[currency];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The currency to pay `merchant` in, or `address(0)` for the plan's own.
    ///
    /// @dev **This is the reader the router uses, and it is the effective answer rather
    ///      than the recorded one.** Zero is returned in three cases and they are all the
    ///      same case from a settlement's point of view: the merchant never elected
    ///      anything, the merchant elected the plan's own currency explicitly, or the
    ///      merchant's election names a currency governance has since withdrawn. In each
    ///      the correct behaviour is to pay in the currency the plan is denominated in,
    ///      which is the currency the pool already holds.
    function payoutCurrencyOf(address merchant) external view returns (address) {
        address elected = _payoutCurrency[merchant];
        if (elected == address(0) || !_allowed[elected]) return address(0);
        return elected;
    }

    /// @notice What `merchant` actually asked for, allowed or not.
    /// @dev Separate from `payoutCurrencyOf` so a withdrawn allowance is visible as a
    ///      withdrawn allowance rather than as an election nobody made. A merchant app
    ///      showing this next to `isAllowed` can tell its user why their settlements went
    ///      back to dollars, which the effective reader alone could not.
    function electedCurrencyOf(address merchant) external view returns (address) {
        return _payoutCurrency[merchant];
    }

    /// @notice Whether this merchant has made an affirmative election.
    /// @dev Reads the recorded election, not the effective one: a merchant whose currency
    ///      was withdrawn is still configured, and rediscovering that is what makes the
    ///      allowance's return restore their preference rather than lose it.
    function isConfigured(address merchant) external view returns (bool) {
        return _payoutCurrency[merchant] != address(0);
    }
}
