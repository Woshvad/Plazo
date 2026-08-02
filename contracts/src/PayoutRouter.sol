// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ICrossChainPayout} from "./interfaces/ICrossChainPayout.sol";
import {ITokenMessengerV2} from "./interfaces/ITokenMessengerV2.sol";

/// @title PayoutRouter
/// @notice Settlement to any CCTP domain. Arc inline, everywhere else by burn.
///
/// @dev The Phase 6 implementation of the payout seam, and the successor to
///      `ArcLocalPayout` — whose refusal semantics survive here unchanged, because the
///      thing that made shipping the identity case worthwhile was that it said no
///      legibly rather than paying the wrong address on the wrong network.
///
///      **Settle first, dispatch second.** `payout()` is called from inside
///      `CheckoutRouter._settleMerchant`, which is inside `originate()`. It must never
///      call CCTP. Circle holds three kill switches Plazo does not — the message
///      transmitter's pause, the token minter's pause, and the messenger's own denylist
///      — and any one of them makes `depositForBurn` revert. If that call sat inside the
///      settlement, a Circle pause would revert the whole origination and CHKT-04 ("the
///      merchant is credited in full minus MDR with sub-second finality") would quietly
///      become a claim about Circle's uptime rather than about Arc's. So a non-Arc
///      destination credits an internal balance in the origination block and the bridge
///      happens afterwards, from a separate call anyone may make. A Circle outage
///      degrades to "payout queued". It does not break a checkout. (D-10.)
///
///      **Permissive by default, with a ratchet.** `supportsDomain` reads CCTP's own
///      routing table off the chain rather than mirroring it into an allowlist, so a new
///      CCTP domain works with no Plazo deployment (D-11). The escape hatch, for a domain
///      that turns out to be a bad idea, is a one-way deny list.
///
///      **Nothing here is keyed on a CCTP nonce, and that is not an omission.** The
///      message a burn emits carries an all-zero nonce; the real identifier —
///      `eventNonce` — is assigned by Circle's attestation service, not by the chain
///      (finding 28, measured on a real burn out of Arc). A dispatching contract cannot
///      know, derive or emit the id its own burn will be tracked by. The join key between
///      Plazo's ledger and Circle's is the transaction hash, and that join is off-chain
///      by construction.
contract PayoutRouter is ICrossChainPayout, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Arc's CCTP domain.
    /// @dev CCTP's own identifier for this chain, not `block.chainid`, which CCTP does
    ///      not use.
    uint32 public constant ARC_DOMAIN = 26;

    /// @notice May add a domain to the deny list, and may do nothing else.
    /// @dev An escape hatch, not a gate. The default posture is permissive — every
    ///      domain CCTP acknowledges is payable — and this role exists only for the case
    ///      where a specific destination turns out to be a bad idea. It cannot un-deny,
    ///      it cannot dispatch, it cannot touch a queued balance, and it cannot stop a
    ///      payout that is already queued from being pushed across. A curator who could
    ///      strand a merchant's money would be an operator on the settlement path, which
    ///      is the thing GOV-08 exists to rule out.
    bytes32 public constant DOMAIN_CURATOR_ROLE = keccak256("PLAZO.DOMAIN_CURATOR");

    /// @notice Circle's CCTP v2 `TokenMessengerV2` on Arc.
    ITokenMessengerV2 public immutable messenger;

    /// @notice Settlement credited on Arc and not yet bridged.
    /// @dev Keyed by destination domain as well as by token and recipient. The domain is
    ///      part of the key rather than an argument the dispatcher chooses, because
    ///      `dispatch` is permissionless: with a two-key queue a stranger could push a
    ///      merchant's balance to a domain the merchant never named, and an address the
    ///      merchant controls on Arc is not necessarily an address they control on
    ///      Arbitrum. The burn is irreversible and the mint has no recovery path, so the
    ///      destination has to be fixed by the party who was owed the money at the moment
    ///      they were owed it.
    mapping(address token => mapping(address recipient => mapping(uint32 domain => uint256))) public queued;

    /// @notice Domains this deployment refuses to settle to.
    mapping(uint32 domain => bool) public denied;

    event PaidOut(address indexed token, address indexed recipient, uint32 domain, uint256 amount);
    event PayoutQueued(address indexed token, address indexed recipient, uint32 domain, uint256 amount);
    event PayoutDispatched(address indexed token, address indexed recipient, uint32 domain, uint256 amount);
    event DomainDenied(uint32 indexed domain, address indexed by);

    error UnsupportedDomain(uint32 domain);
    error RecipientZero();
    error NothingQueued();
    error DomainAlreadyDenied(uint32 domain);

    constructor(address admin, address messenger_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        messenger = ITokenMessengerV2(messenger_);
    }

    // ─── The seam ────────────────────────────────────────────────────────────

    /// @inheritdoc ICrossChainPayout
    function localDomain() external pure returns (uint32) {
        return ARC_DOMAIN;
    }

    /// @inheritdoc ICrossChainPayout
    /// @dev Arc is tested **first**, before the routing table is consulted at all.
    ///      `remoteTokenMessengers(26)` returns `bytes32(0)` on Arc — CCTP has no
    ///      self-domain route — so a table-first implementation would refuse the one
    ///      destination this chain can always pay.
    function supportsDomain(uint32 domain) public view returns (bool) {
        if (denied[domain]) return false;
        if (domain == ARC_DOMAIN) return true;
        return messenger.remoteTokenMessengers(domain) != bytes32(0);
    }

    /// @inheritdoc ICrossChainPayout
    /// @dev Pull, not push: the caller approves and this contract takes. That keeps the
    ///      funds in the caller's control until the domain check has passed, rather than
    ///      requiring a rescue path for value pushed to a payout contract that then
    ///      refused to send it. `CheckoutRouter` calls `forceApprove` on the line before
    ///      this one, so a push design would break the caller.
    ///
    ///      **No CCTP call happens here, ever.** See the contract docstring: this
    ///      function runs inside `originate()` and Circle's three kill switches must not
    ///      be able to reach it.
    function payout(address token, uint32 domain, address recipient, uint256 amount) external nonReentrant {
        if (!supportsDomain(domain)) revert UnsupportedDomain(domain);
        if (recipient == address(0)) revert RecipientZero();
        if (amount == 0) return;

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        if (domain == ARC_DOMAIN) {
            IERC20(token).safeTransfer(recipient, amount);
            emit PaidOut(token, recipient, domain, amount);
        } else {
            queued[token][recipient][domain] += amount;
            emit PayoutQueued(token, recipient, domain, amount);
        }
    }

    // ─── The bridge ──────────────────────────────────────────────────────────

    /// @notice Push a queued payout across to its destination. Anyone may call this.
    ///
    /// @dev No role, no modifier, no bounty. GOV-08 asserts a stranger can call it, and
    ///      there is nobody but the merchant with an interest in it happening — a
    ///      dispatch costs about 0.0044 USDC of Arc gas end to end (finding 28), which is
    ///      less than a single `collect()`, so there is nothing here to subsidise.
    ///
    ///      The deny list is deliberately **not** consulted. Denying a domain stops new
    ///      settlement being queued for it; it must not strand settlement that is already
    ///      owed, because that would hand the curator role the power to freeze a
    ///      merchant's money.
    ///
    ///      The queued balance is zeroed before the external call, and `nonReentrant`
    ///      sits over the top of that. Neither is redundant: the ordering is the property,
    ///      and the guard is what makes it hold if the ordering is ever edited.
    function dispatch(address token, address recipient, uint32 domain) external nonReentrant {
        uint256 amount = queued[token][recipient][domain];
        if (amount == 0) revert NothingQueued();
        queued[token][recipient][domain] = 0;

        IERC20(token).forceApprove(address(messenger), amount);
        messenger.depositForBurn(
            // The same 6-decimal ERC-20 figure `CheckoutRouter` computed. Arc USDC holds
            // balances at 18 decimals natively and shows them at 6; nothing in this
            // contract scales anything, and a scale factor introduced here would be
            // invisible until it minted 10^12 times too much on a destination chain.
            amount,
            domain,
            // LEFT-padded. CCTP addresses non-EVM domains too, so the recipient is a
            // `bytes32`; a right-padded address mints to an address nobody holds a key
            // for, on a chain with no recovery path.
            bytes32(uint256(uint160(recipient))),
            token,
            // Anyone may complete `receiveMessage` on the destination. Plazo holds no gas
            // token on any chain but Arc and deploys no contract on one (D-12), so the
            // destination leg has to be closeable by the merchant themselves.
            bytes32(0),
            // Measured zero out of Arc to every domain, as a balance delta rather than as
            // a quote from the fee oracle.
            0,
            // Standard finality. Fast is priced identically from Arc and Arc finalises in
            // ~0.514 s regardless, so a toggle would be a control with no effect.
            2000
        );

        emit PayoutDispatched(token, recipient, domain, amount);
    }

    // ─── The ratchet ─────────────────────────────────────────────────────────

    /// @notice Refuse all future settlement to `domain`.
    ///
    /// @dev One way, on purpose. There is no `allowDomain`: a deny that can be quietly
    ///      undone is a change nobody sees, whereas a ratchet leaves the decision in the
    ///      log where it can be read. Re-opening a denied domain is a redeployment, which
    ///      is the right amount of ceremony for reversing a decision that was made because
    ///      a destination was judged unsafe.
    function denyDomain(uint32 domain) external onlyRole(DOMAIN_CURATOR_ROLE) {
        if (denied[domain]) revert DomainAlreadyDenied(domain);
        denied[domain] = true;
        emit DomainDenied(domain, msg.sender);
    }
}
