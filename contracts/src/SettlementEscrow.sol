// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CheckoutRouter} from "./CheckoutRouter.sol";
import {MerchantRegistry} from "./MerchantRegistry.sol";
import {ParameterRegistry} from "./ParameterRegistry.sol";
import {TranchedCreditPool} from "./TranchedCreditPool.sol";
import {ICrossChainPayout} from "./interfaces/ICrossChainPayout.sol";
import {ISettlementEscrow} from "./interfaces/ISettlementEscrow.sol";
import {ParameterKeys} from "./libraries/ParameterKeys.sol";

/// @title SettlementEscrow
/// @notice A physical-goods merchant's settlement, held until they attest shipment.
///
/// @dev MERCH-04. Two timers, two exits, and nobody in the middle.
///
///      **There is no oracle here and there must never be one (C1).** A chain cannot
///      know whether a parcel arrived. The honest design is merchant self-attestation,
///      a timeout in both directions, and the bond as recourse — so nothing in this
///      contract calls out to anything, and a later reader reaching for a carrier API
///      on the settlement path would be smuggling an oracle back into an all-dollar
///      balance sheet that was built specifically to not need one.
///
///      **This is not a CHKT-04 regression.** CHKT-04 is closed and reads "the merchant
///      is credited in full minus MDR with sub-second finality"; MERCH-04 explicitly
///      carves physical goods out of it. The money leaves the pool in the origination
///      transaction either way, and the merchant's claim on it is fixed in that same
///      transaction. What differs is whose custody it sits in until shipment: a digital
///      merchant's lands in their payout route, a physical merchant's lands here.
///
///      **Both exits are permissionless (D-07).** `release` pays the merchant once the
///      release timer has run on their attestation; `refundToPool` returns the money to
///      the pool's first-loss reserve once the attestation deadline has passed with no
///      attestation. Neither carries a role. An escrow only an operator can release is
///      an operator role on the settlement path, which is precisely what GOV-08 exists
///      to rule out — and an escrow only an operator can return is a merchant who
///      vanishes stranding the pool's capital until somebody notices.
///
///      **Both timers are `ParameterRegistry` rows, read at call time (D-08).** Plan
///      06-14 seeded `ESCROW_ATTESTATION_DEADLINE` and `ESCROW_RELEASE_TIMER` in wave 1
///      with compiled bands so that this contract has no second option: there is no
///      immutable timer here and no constant to fall back on. `get()` reverts on an
///      undefined key by design, and that revert is the intended failure mode rather
///      than something to defend against.
///
///      **The category is stamped on the row at hold time (D-06).** `MerchantRegistry`
///      is mutable and this row is not. A merchant moved to `Instant` tomorrow cannot
///      reach back into a plan that settled today, because the routing decision was
///      taken once, in `CheckoutRouter._settleMerchant`, and the row records what was
///      read at that moment.
contract SettlementEscrow is ISettlementEscrow, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Where a held settlement is in its life.
    /// @dev `Released` and `Returned` are both absorbing. There is no path from either
    ///      back into `Held`, which is what makes the two exits mutually exclusive
    ///      rather than merely unlikely to both fire.
    enum EscrowState {
        None,
        Held,
        Attested,
        Released,
        Returned
    }

    /// @notice One plan's held settlement.
    struct Escrow {
        /// @dev Who took the order. The only party who may attest shipment.
        address merchant;
        /// @dev The settlement asset, carried on the row rather than assumed, because
        ///      a corridor deployment settles more than one.
        address token;
        /// @dev The merchant's payout route as it stood at origination.
        address recipient;
        /// @dev The CCTP domain that route names. Release goes through the same payout
        ///      seam a digital merchant's settlement does, so a physical merchant on a
        ///      remote domain queues and dispatches normally.
        uint32 domain;
        /// @dev Net of MDR and of the vesting withholding. What the router was about to
        ///      pay out, held instead.
        uint256 amount;
        /// @dev When the money arrived. The attestation deadline runs from here.
        uint256 heldAt;
        /// @dev When shipment was attested. Zero means never; the release timer runs
        ///      from here, so zero is also what makes `release` impossible.
        uint256 attestedAt;
        /// @dev When the settlement went back to the pool. Zero unless `Returned`.
        uint256 returnedAt;
        /// @dev **A commitment, never a tracking number in cleartext (D-07).** A
        ///      tracking number is a delivery address by proxy: it resolves, for anyone
        ///      who asks the carrier, to where a named borrower lives. The same
        ///      salted-subject rule the Passport events follow applies, which is why
        ///      this is a `bytes32` and why no function in this contract accepts a
        ///      string.
        bytes32 carrierRef;
        /// @dev The merchant's category as it read at origination. Stamped so the row
        ///      is self-describing and a later registry change cannot reach it (D-06).
        MerchantRegistry.SettlementCategory category;
        EscrowState state;
    }

    MerchantRegistry public immutable merchants;
    ICrossChainPayout public immutable payout;
    ParameterRegistry public immutable parameters;

    /// @notice May name the router once, and may do nothing else.
    /// @dev Not an `AccessControl` role, because there is no ongoing privilege here to
    ///      hold. This address exists to close one deployment-order circularity —
    ///      `CheckoutRouter` takes this contract as a constructor immutable, so this
    ///      contract cannot take the router as one — and it is spent the first time it
    ///      is used.
    address public immutable admin;

    /// @notice The only address that may `hold`. Set once, at deployment.
    /// @dev One-way, unlike `PlanFactory.setOriginator`'s rotatable equivalent. A
    ///      rotatable router on a contract that holds merchant money would be an admin
    ///      key that can redirect where a settlement is pulled from.
    address public router;

    mapping(bytes32 planId => Escrow) private _escrows;

    /// @notice Whether a plan's settlement went back for non-attestation.
    ///
    /// @dev **The borrower's route, as wiring rather than as prose.** `refundToPool`
    ///      makes the pool whole and leaves the plan's receivable untouched, which is
    ///      correct (D-04) and is also the reason a borrower can be left paying for
    ///      goods that never shipped. Without this flag their only remedy depends on
    ///      somebody with a role noticing. `RefundEscrow.openNonAttestationDispute`
    ///      reads exactly this and is permissionless, so the route exists in code.
    ///
    ///      **It is a flag, not accounting.** Nothing in this contract writes the
    ///      pool's book beyond the `fundReserve` call in `refundToPool`, and there is
    ///      no setter for this mapping reachable from anywhere but that function.
    ///      Widening it past "the merchant provably failed to attest before an
    ///      on-chain deadline they could read in advance" would hand a slash to
    ///      circumstances nobody adjudicated.
    mapping(bytes32 planId => bool) public disputeEligible;

    event RouterSet(address indexed router);
    event SettlementHeld(bytes32 indexed planId, address indexed merchant, uint256 amount);
    event ShipmentAttested(bytes32 indexed planId, bytes32 carrierRef);
    event EscrowReleased(bytes32 indexed planId, address indexed recipient, uint32 domain, uint256 amount);
    event EscrowReturned(bytes32 indexed planId, uint256 amount);

    error NotHeld(bytes32 planId);
    error AlreadyHeld(bytes32 planId);
    error AlreadyAttested(bytes32 planId);
    error NotAttested(bytes32 planId);
    error TimerNotElapsed(bytes32 planId, uint256 readyAt);
    error OnlyMerchant(address caller, address merchant);
    error OnlyRouter(address caller);
    error OnlyAdmin(address caller);
    error RouterAlreadySet(address router);
    error RouterZero();
    error PlanNotOriginatedHere(bytes32 planId);

    constructor(address admin_, address merchants_, address payout_, address parameters_) {
        admin = admin_;
        merchants = MerchantRegistry(merchants_);
        payout = ICrossChainPayout(payout_);
        parameters = ParameterRegistry(parameters_);
    }

    /// @notice Name the router. Once.
    /// @dev The deployment handshake, mirroring `PlanFactory.setOriginator` and
    ///      `TranchedCreditPool.setOriginator`: the router takes this contract as a
    ///      constructor immutable, so the reference back has to be installed after.
    function setRouter(address router_) external {
        if (msg.sender != admin) revert OnlyAdmin(msg.sender);
        if (router_ == address(0)) revert RouterZero();
        if (router != address(0)) revert RouterAlreadySet(router);

        router = router_;
        emit RouterSet(router_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The hold
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Take a merchant's settlement into escrow. Router only.
    ///
    /// @dev Gated because an arbitrary caller who could write a row could manufacture
    ///      one against a merchant who never sold anything, wait out the attestation
    ///      deadline, and hand themselves a permissionless slash against that
    ///      merchant's bond through `RefundEscrow`. The row is the evidence, so the row
    ///      has exactly one author.
    ///
    ///      Pull, not push: the router `forceApprove`s on the line before this call, the
    ///      same shape `ICrossChainPayout` uses, so the two branches of
    ///      `_settleMerchant` differ in destination and in nothing else.
    function hold(
        bytes32 planId,
        address merchant,
        address token,
        uint32 domain,
        address recipient,
        uint256 amount
    ) external nonReentrant {
        if (msg.sender != router) revert OnlyRouter(msg.sender);

        Escrow storage existing = _escrows[planId];
        if (existing.state != EscrowState.None) revert AlreadyHeld(planId);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        _escrows[planId] = Escrow({
            merchant: merchant,
            token: token,
            recipient: recipient,
            domain: domain,
            amount: amount,
            heldAt: block.timestamp,
            attestedAt: 0,
            returnedAt: 0,
            carrierRef: bytes32(0),
            category: merchants.categoryOf(merchant),
            state: EscrowState.Held
        });

        emit SettlementHeld(planId, merchant, amount);
    }

    /// @notice Attest that the goods shipped. Merchant only.
    ///
    /// @dev The self-attestation C1 forces, and the point at which the release timer
    ///      starts. There is nothing behind it but the merchant's word and their bond,
    ///      and that is the honest design rather than a gap: the alternative is a
    ///      carrier oracle, and a carrier oracle is a third party who can stop a
    ///      merchant being paid.
    ///
    ///      `carrierRef` is a **commitment** to an off-chain record under a published
    ///      schema. It is never a tracking number in cleartext, because a tracking
    ///      number resolves to a delivery address for anybody who asks the carrier —
    ///      which makes it a borrower's home address written to a public log that no
    ///      erasure request can reach. The salted-subject rule the Passport events
    ///      follow applies here for the same reason (D-07).
    function attestShipment(bytes32 planId, bytes32 carrierRef) external {
        Escrow storage e = _escrows[planId];
        if (e.state == EscrowState.None) revert NotHeld(planId);
        if (msg.sender != e.merchant) revert OnlyMerchant(msg.sender, e.merchant);
        if (e.state == EscrowState.Attested) revert AlreadyAttested(planId);
        if (e.state != EscrowState.Held) revert NotHeld(planId);

        e.attestedAt = block.timestamp;
        e.carrierRef = carrierRef;
        e.state = EscrowState.Attested;

        emit ShipmentAttested(planId, carrierRef);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The two exits, both open to anybody
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Pay a held settlement to the merchant. Anyone may, once the timer runs.
    ///
    /// @dev No role and no modifier. The merchant is the party with the interest in
    ///      this happening and a keeper is the party with the gas, and neither should
    ///      have to ask an operator — an escrow only an operator can release is an
    ///      operator role on the settlement path (D-07, GOV-08).
    ///
    ///      It pays through the same `ICrossChainPayout` seam a digital merchant's
    ///      settlement uses, so a physical merchant whose payout route names a non-Arc
    ///      CCTP domain queues and dispatches exactly as they otherwise would. Escrow
    ///      and cross-chain compose rather than special-casing each other.
    function release(bytes32 planId) external nonReentrant {
        Escrow storage e = _escrows[planId];
        if (e.state == EscrowState.None) revert NotHeld(planId);
        if (e.state == EscrowState.Held) revert NotAttested(planId);
        if (e.state != EscrowState.Attested) revert NotHeld(planId);

        uint256 readyAt = e.attestedAt + parameters.get(ParameterKeys.ESCROW_RELEASE_TIMER);
        if (block.timestamp < readyAt) revert TimerNotElapsed(planId, readyAt);

        e.state = EscrowState.Released;

        uint256 amount = e.amount;
        IERC20(e.token).forceApprove(address(payout), amount);
        payout.payout(e.token, e.domain, e.recipient, amount);

        emit EscrowReleased(planId, e.recipient, e.domain, amount);
    }

    /// @notice Return an unattested settlement to the pool's reserve. Anyone may.
    ///
    /// @dev **What this does:** the pool's first-loss reserve is made whole for the
    ///      settlement it advanced against goods that were never shipped. **What it
    ///      does not do:** touch the plan's receivable. The borrower still owes what
    ///      they signed for, and nothing here changes that.
    ///
    ///      `fundReserve` is the entry point precisely because the pool learns what it
    ///      is owed from the plans and from nowhere else (DEC-08). The pool has no path
    ///      to un-front a receivable, and inventing one here would be a second write
    ///      path for the same money — the exact defect Phase 3 shipped and DEC-21 was
    ///      written to prevent. `fundReserve` is permissionless and books into
    ///      `bookedCash` as well as `_reserve`, so this is a cash entry the pool's own
    ///      accounting identity already accounts for, not a donation and not a ledger.
    ///
    ///      That leaves a borrower on the hook for goods that never arrived, which is
    ///      why the last thing this function does is set `disputeEligible`. Without it
    ///      the pool is whole, the merchant kept nothing, and the borrower keeps paying
    ///      until an operator notices — so the flag is not a convenience, it is the
    ///      difference between a remedy that exists and a remedy somebody has to
    ///      remember. `RefundEscrow.openNonAttestationDispute` needs no role and reads
    ///      exactly this.
    ///
    ///      Permissionless because a merchant who vanishes must not be able to strand
    ///      the pool's capital here (D-07).
    function refundToPool(bytes32 planId) external nonReentrant {
        Escrow storage e = _escrows[planId];
        if (e.state == EscrowState.None) revert NotHeld(planId);
        if (e.state == EscrowState.Attested) revert AlreadyAttested(planId);
        if (e.state != EscrowState.Held) revert NotHeld(planId);

        uint256 readyAt = e.heldAt + parameters.get(ParameterKeys.ESCROW_ATTESTATION_DEADLINE);
        if (block.timestamp < readyAt) revert TimerNotElapsed(planId, readyAt);

        address poolAddress = CheckoutRouter(router).poolOf(planId);
        if (poolAddress == address(0)) revert PlanNotOriginatedHere(planId);

        e.state = EscrowState.Returned;
        e.returnedAt = block.timestamp;
        disputeEligible[planId] = true;

        uint256 amount = e.amount;
        IERC20(e.token).forceApprove(poolAddress, amount);
        TranchedCreditPool(poolAddress).fundReserve(amount);

        emit EscrowReturned(planId, amount);
        emit SettlementReturnedForNonAttestation(planId, e.merchant, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    function escrowOf(bytes32 planId) external view returns (Escrow memory) {
        return _escrows[planId];
    }

    /// @inheritdoc ISettlementEscrow
    /// @dev Zero across all three fields for a plan that was never returned, which is
    ///      the behaviour the interface documents. A caller checks `disputeEligible`;
    ///      a zero `amount` is not a sentinel, because a returned settlement of zero is
    ///      not a thing that can happen.
    function returnedSettlementOf(bytes32 planId) external view returns (ReturnedSettlement memory) {
        Escrow storage e = _escrows[planId];
        if (e.state != EscrowState.Returned) {
            return ReturnedSettlement({merchant: address(0), amount: 0, returnedAt: 0});
        }
        return ReturnedSettlement({merchant: e.merchant, amount: e.amount, returnedAt: e.returnedAt});
    }

    /// @notice When `release` becomes callable. Zero when nothing was attested.
    /// @dev Reads the registry row now, not at attestation time, so a governance move
    ///      inside the compiled band moves this answer for rows already open.
    function releasableAt(bytes32 planId) external view returns (uint256) {
        Escrow storage e = _escrows[planId];
        if (e.attestedAt == 0) return 0;
        return e.attestedAt + parameters.get(ParameterKeys.ESCROW_RELEASE_TIMER);
    }

    /// @notice When `refundToPool` becomes callable. Zero once the row has left `Held`.
    function returnableAt(bytes32 planId) external view returns (uint256) {
        Escrow storage e = _escrows[planId];
        if (e.state != EscrowState.Held) return 0;
        return e.heldAt + parameters.get(ParameterKeys.ESCROW_ATTESTATION_DEADLINE);
    }
}
