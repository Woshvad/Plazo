// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {ICreditPool} from "./interfaces/ICreditPool.sol";
import {IInstallmentPlan} from "./interfaces/IInstallmentPlan.sol";
import {ITransferEligibility} from "./interfaces/ITransferEligibility.sol";
import {ParameterRegistry} from "./ParameterRegistry.sol";
import {ParameterKeys} from "./libraries/ParameterKeys.sol";
import {PlanParams} from "./libraries/PlanParams.sol";

/// @title CreditPool
/// @notice The funding book: it fronts the merchant and carries the receivable.
///
/// @dev The Phase 3 shape — flat, synchronous, two tranche buckets and no epochs.
///      Phase 5 refines it into a CDO core with async vaults, epoch NAV, a
///      redemption queue and bucketed provisioning. Every refinement is additive
///      because the accounting identity below is the one Phase 1's `PoolInvariants`
///      were written against, and those were written before any pool existed
///      precisely so the vault design could not quietly define its own correctness.
///
///      **Assets are booked, never weighed (POOL-11).** `totalAssets()` is
///      `reserve + junior + senior`, three accumulators this contract maintains. It
///      is never `token.balanceOf(this)`. A donation to this address moves the
///      balance and moves nothing else — which is half of the first-depositor
///      inflation attack neutralised by construction rather than by a decimals
///      offset.
///
///      **The book learns from the plans, not from its balance (DEC-08).** A plan
///      settles by a bare `transfer` and notifies nobody. Reconciling by balance
///      delta would satisfy POOL-11's letter and break its intent, so `recognise()`
///      reads the plan's own accumulators — `forwarded()` for cash received,
///      `outstandingPrincipal()` for what is left — and books exactly the delta while
///      moving nothing. It is permissionless and idempotent, because a book that can
///      only be updated by an operator is a book whose NAV is an operator's opinion.
///
///      **Origination is NAV-neutral.** The pool pays the merchant `principal − MDR`,
///      funds the plan's mark escrow, and books a receivable of `principal`. The MDR
///      net of that escrow becomes *deferred* income that releases as principal is
///      actually recovered. Recognising the whole fee at checkout would book profit
///      on a loan before anyone has demonstrated they will repay it, which is how a
///      book flatters itself into a loss.
contract CreditPool is ICreditPool, AccessControl {
    using SafeERC20 for IERC20;

    /// @notice May front capital against a plan.
    /// @dev `CheckoutRouter` alone. This is the only role that can move money out of
    ///      the book other than a redemption.
    bytes32 public constant ORIGINATOR_ROLE = keccak256("PLAZO.POOL_ORIGINATOR");

    /// @dev Virtual shares, OZ's mitigation in miniature. POOL-12's full treatment —
    ///      decimals offset, permanent seed deposit and internal accounting together
    ///      — is Phase 5, when the junior tranche is a real transferable share and
    ///      the attack is worth mounting. This much costs nothing now and means the
    ///      first junior depositor is not standing on an empty vault.
    uint256 private constant VIRTUAL_SHARES = 1e3;

    struct PlanBook {
        address plan;
        address merchant;
        bytes32 corridor;
        /// @notice Face value at origination.
        uint256 principal;
        /// @notice Principal still expected. Mirrors the plan.
        uint256 carrying;
        /// @notice Cash the plan has forwarded and this book has counted.
        uint256 recognisedInflow;
        /// @notice MDR not yet earned.
        uint256 deferredIncome;
        bool open;
        /// @notice Whether the last crank saw a past-grace installment unmarked.
        bool unmarked;
    }

    IERC20 public immutable token;
    ParameterRegistry public immutable parameters;

    ITransferEligibility public eligibility;

    // ─── The balance sheet ───────────────────────────────────────────────────

    uint256 private _reserve;
    mapping(Tranche => uint256) private _trancheAssets;
    mapping(Tranche => uint256) private _trancheShares;
    mapping(Tranche => mapping(address => uint256)) private _shares;

    /// @notice Cash this book believes it holds. Not a balance read.
    uint256 public bookedCash;
    /// @notice Principal outstanding across every open plan, as last recognised.
    uint256 public bookedReceivables;
    /// @notice MDR booked but not yet earned.
    uint256 public deferredIncome;

    mapping(bytes32 planId => PlanBook) private _books;
    mapping(address merchant => uint256) private _merchantExposure;
    mapping(bytes32 corridor => uint256) private _corridorExposure;

    /// @notice Plans a crank has seen past grace with no mark recorded.
    uint256 public unmarkedDelinquencies;
    uint256 public openPlans;

    event Deposited(Tranche indexed tranche, address indexed holder, uint256 assets, uint256 shares);
    event Redeemed(Tranche indexed tranche, address indexed holder, uint256 shares, uint256 assets);
    event ReserveFunded(address indexed from, uint256 amount, uint256 balance);
    event Fronted(bytes32 indexed planId, address indexed merchant, uint256 principal, uint256 mdr);
    event Recognised(
        bytes32 indexed planId, uint256 inflow, uint256 principalRecovered, uint256 incomeEarned
    );
    event LossAbsorbed(
        bytes32 indexed planId, uint256 fromReserve, uint256 fromJunior, uint256 fromSenior
    );
    event OriginationGated(bool open, uint256 subordinationBps, uint256 reserveBps);
    event UnmarkedDelinquency(bytes32 indexed planId, bool unmarked);
    event EligibilityRegistryChanged(address indexed previous, address indexed current);

    error NotEligible(address account);
    error PlanAlreadyFronted(bytes32 planId);
    error PlanNotFronted(bytes32 planId);
    error OriginationClosed();
    error InsufficientCash(uint256 requested, uint256 available);
    error InsufficientShares(uint256 requested, uint256 held);
    error NothingToDeposit();
    error EligibilityZero();

    constructor(address admin, address token_, address parameters_, address eligibility_) {
        if (eligibility_ == address(0)) revert EligibilityZero();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        token = IERC20(token_);
        parameters = ParameterRegistry(parameters_);
        eligibility = ITransferEligibility(eligibility_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The accounting identity
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc ICreditPool
    function totalAssets() public view returns (uint256) {
        return _reserve + _trancheAssets[Tranche.Junior] + _trancheAssets[Tranche.Senior];
    }

    /// @inheritdoc ICreditPool
    function reserveBalance() external view returns (uint256) {
        return _reserve;
    }

    /// @inheritdoc ICreditPool
    function trancheAssets(Tranche tranche) external view returns (uint256) {
        return _trancheAssets[tranche];
    }

    /// @inheritdoc ICreditPool
    function trancheShares(Tranche tranche) external view returns (uint256) {
        return _trancheShares[tranche];
    }

    function sharesOf(Tranche tranche, address holder) external view returns (uint256) {
        return _shares[tranche][holder];
    }

    /// @inheritdoc ICreditPool
    /// @dev Zero in Phase 3. Provisioning is POOL-07 and lands with the epoch
    ///      accountant in Phase 5; the interface carries it now so the invariant
    ///      suite binds to one shape across both.
    function provisionedAt(uint256) external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc ICreditPool
    function totalProvisioned() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc ICreditPool
    function currentEpoch() external pure returns (uint256) {
        return 0;
    }

    /// @inheritdoc ICreditPool
    function subordinationBps() public view returns (uint256) {
        uint256 assets = totalAssets();
        if (assets == 0) return 0;
        return (_trancheAssets[Tranche.Junior] * PlanParams.BPS) / assets;
    }

    function reserveBps() public view returns (uint256) {
        uint256 assets = totalAssets();
        if (assets == 0) return 0;
        return (_reserve * PlanParams.BPS) / assets;
    }

    /// @inheritdoc ICreditPool
    /// @dev As good as the last crank, and that is stated rather than hidden.
    ///      `recognise()` is what discovers an unmarked delinquency, and Phase 5's
    ///      epoch close is what makes cranking every open plan mandatory before the
    ///      book can close. Until then this answers "is anything known to be
    ///      unrecognised", which is the question the origination gate needs.
    function allDelinquenciesMarked() public view returns (bool) {
        return unmarkedDelinquencies == 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The gate
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc ICreditPool
    ///
    /// @dev POOL-05's "prefunded to target before origination opens" is enforced
    ///      against the *target*, not the floor. A reserve that only has to reach its
    ///      minimum before lending starts is a reserve that starts its life one bad
    ///      week from being breached.
    function originationOpen() public view returns (bool) {
        uint256 assets = totalAssets();
        if (assets == 0) return false;
        if (!allDelinquenciesMarked()) return false;
        if (subordinationBps() < parameters.get(ParameterKeys.MIN_SUBORDINATION_BPS)) return false;
        if (reserveBps() < parameters.get(ParameterKeys.RESERVE_TARGET_BPS)) return false;
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Capital in and out
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Add capital to a tranche.
    /// @dev Eligibility-gated from the first deposit. POOL-02 makes the tranche
    ///      shares transfer-restricted ERC-20s in Phase 5; gating the entry now means
    ///      the holder set is correct from the beginning rather than needing a
    ///      snapshot and a migration when the shares become transferable.
    function deposit(Tranche tranche, uint256 assets) external returns (uint256 shares) {
        if (assets == 0) revert NothingToDeposit();
        if (!eligibility.isEligible(address(this), msg.sender)) revert NotEligible(msg.sender);

        token.safeTransferFrom(msg.sender, address(this), assets);

        shares = _sharesForAssets(tranche, assets);

        bookedCash += assets;
        _trancheAssets[tranche] += assets;
        _trancheShares[tranche] += shares;
        _shares[tranche][msg.sender] += shares;

        emit Deposited(tranche, msg.sender, assets, shares);
        _emitGate();
    }

    /// @notice Redeem shares for assets, synchronously.
    /// @dev Phase 3 only. POOL-03 makes entry and exit asynchronous at next-epoch
    ///      NAV and POOL-08 adds the pro-rata queue; both are Phase 5, and both are
    ///      refinements of this rather than replacements — the share maths does not
    ///      change, only when it is struck and how a shortfall is shared.
    ///
    ///      Bounded by cash on the book, because the alternative is a redemption that
    ///      sells a receivable at whatever price is available in a hurry. A redeemer
    ///      who cannot be paid today waits; Phase 5 gives them a queue position and
    ///      an ETA instead of a revert.
    function redeem(Tranche tranche, uint256 shares) external returns (uint256 assets) {
        uint256 held = _shares[tranche][msg.sender];
        if (shares > held) revert InsufficientShares(shares, held);

        assets = _assetsForShares(tranche, shares);
        if (assets > bookedCash) revert InsufficientCash(assets, bookedCash);

        _shares[tranche][msg.sender] = held - shares;
        _trancheShares[tranche] -= shares;
        _trancheAssets[tranche] -= assets;
        bookedCash -= assets;

        token.safeTransfer(msg.sender, assets);
        emit Redeemed(tranche, msg.sender, shares, assets);
        _emitGate();
    }

    /// @notice Fund the first-loss reserve.
    /// @dev POOL-05. Permissionless — the reserve is the protocol's own money and
    ///      anyone willing to add to it is doing every tranche holder a favour. It
    ///      issues no shares and confers no claim, which is what makes it first-loss
    ///      rather than another tranche.
    function fundReserve(uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
        _reserve += amount;
        bookedCash += amount;
        emit ReserveFunded(msg.sender, amount, _reserve);
        _emitGate();
    }

    function reserveTarget() public view returns (uint256) {
        return (totalAssets() * parameters.get(ParameterKeys.RESERVE_TARGET_BPS)) / PlanParams.BPS;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Origination
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Front a plan: pay the merchant, fund the escrow, book the receivable.
    ///
    /// @param planId The plan being funded.
    /// @param plan Its deployed address.
    /// @param merchant Whose exposure this is.
    /// @param corridor The concentration bucket. `keccak256(token)` in v1; the FX
    ///        pair from Phase 7.
    /// @param principal Face value of the receivable.
    /// @param mdr The merchant discount, already deducted from what they receive.
    /// @param escrow Funded into the plan so it can pay for its own delinquency mark.
    /// @param merchantProceeds Where the merchant's net settlement is sent — the
    ///        payout router, which forwards it on the merchant's chosen domain.
    ///
    /// @dev NAV-neutral by construction. Cash out is `principal − mdr + escrow`,
    ///      the receivable booked is `principal`, and the difference — `mdr − escrow`
    ///      — is parked as deferred income rather than recognised. Nothing about this
    ///      transaction makes the book look richer.
    function front(
        bytes32 planId,
        address plan,
        address merchant,
        bytes32 corridor,
        uint256 principal,
        uint256 mdr,
        uint256 escrow,
        address merchantProceeds
    ) external onlyRole(ORIGINATOR_ROLE) {
        if (_books[planId].plan != address(0)) revert PlanAlreadyFronted(planId);
        if (!originationOpen()) revert OriginationClosed();

        uint256 net = principal - mdr;
        uint256 cashOut = net + escrow;
        if (cashOut > bookedCash) revert InsufficientCash(cashOut, bookedCash);

        _books[planId] = PlanBook({
            plan: plan,
            merchant: merchant,
            corridor: corridor,
            principal: principal,
            carrying: principal,
            recognisedInflow: 0,
            deferredIncome: mdr - escrow,
            open: true,
            unmarked: false
        });

        bookedCash -= cashOut;
        bookedReceivables += principal;
        deferredIncome += mdr - escrow;

        _merchantExposure[merchant] += principal;
        _corridorExposure[corridor] += principal;
        openPlans += 1;

        // The escrow goes to the plan, the net goes to the merchant's payout route.
        // Two transfers rather than one because they are two different obligations
        // and netting them would make a failed payout look like a funded escrow.
        token.safeTransfer(plan, escrow);
        token.safeTransfer(merchantProceeds, net);

        emit Fronted(planId, merchant, principal, mdr);
        _emitGate();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Recognition
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Book whatever a plan has done since the last crank.
    ///
    /// @dev Permissionless, idempotent, and it moves no money — every dollar it books
    ///      has already arrived. Calling it twice in a block does nothing the second
    ///      time; never calling it leaves the book stale and, once a delinquency is
    ///      outstanding, closed to new origination. That is the pressure that makes
    ///      someone run it.
    ///
    ///      What it reads: `forwarded()` for cash the plan has sent this book, and
    ///      `outstandingPrincipal()` for what the receivable is still worth. Both are
    ///      the plan's own accounting, which is the only thing that knows the answer.
    function recognise(bytes32 planId) public {
        PlanBook storage book = _books[planId];
        if (book.plan == address(0)) revert PlanNotFronted(planId);
        if (!book.open) return;

        IInstallmentPlan plan = IInstallmentPlan(book.plan);

        uint256 inflow = plan.forwarded() - book.recognisedInflow;
        uint256 outstanding = plan.outstandingPrincipal();
        uint256 recovered = book.carrying > outstanding ? book.carrying - outstanding : 0;

        book.recognisedInflow += inflow;
        book.carrying = outstanding;

        bookedCash += inflow;
        bookedReceivables -= recovered;

        // MDR earns as principal is recovered, not at checkout. A fee recognised on a
        // loan nobody has begun repaying is profit the book has not made.
        uint256 earned = 0;
        if (recovered > 0 && book.principal > 0) {
            earned = (book.deferredIncome * recovered) / book.principal;
            if (earned > book.deferredIncome) earned = book.deferredIncome;
            book.deferredIncome -= earned;
            deferredIncome -= earned;
        }

        _reduceExposure(book, recovered);

        // The book's assets moved by the cash that arrived, less the receivable that
        // was retired, plus the fee that was earned. The keeper's bounty is the
        // difference between the installment and the cash — a servicing cost the book
        // carries, exactly as `InstallmentPlan` documents.
        // Every operand is a USDC figure bounded by the book, so nothing here comes
        // within thirty orders of magnitude of `int256`'s range.
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 delta = int256(inflow) - int256(recovered) + int256(earned);
        if (delta > 0) {
            // forge-lint: disable-next-line(unsafe-typecast)
            _distribute(uint256(delta));
        } else if (delta < 0) {
            // forge-lint: disable-next-line(unsafe-typecast)
            _absorbLoss(planId, uint256(-delta));
        }

        _syncMarkState(planId, book, plan);

        emit Recognised(planId, inflow, recovered, earned);

        // Every terminal state closes the book the same way, and the write-off is
        // whatever is still carried. A repaid or fully refunded plan carries nothing,
        // so nothing is written off; a defaulted or cancelled one carries what will
        // never arrive. Branching on the label rather than on the number would mean
        // deciding that a cancellation is not a loss, and money that is not coming is
        // a loss whatever it is called.
        IInstallmentPlan.PlanState planState = plan.state();
        if (
            planState == IInstallmentPlan.PlanState.Repaid
                || planState == IInstallmentPlan.PlanState.Refunded
                || planState == IInstallmentPlan.PlanState.Cancelled
                || planState == IInstallmentPlan.PlanState.Defaulted
        ) {
            _close(planId, book, book.carrying);
        }

        _emitGate();
    }

    function recogniseBatch(bytes32[] calldata planIds) external {
        for (uint256 i = 0; i < planIds.length; ++i) {
            recognise(planIds[i]);
        }
    }

    /// @dev A closing plan writes off whatever it is still carrying, net of the fee
    ///      it never earned. POOL-16's ordering is the whole claim the senior tranche
    ///      was sold on, so this is the only place a loss is taken.
    ///
    ///      **The unearned fee offsets the loss rather than being cancelled.** Found
    ///      by the invariant fuzzer, and it is an accounting question rather than a
    ///      slip. At origination the pool paid the merchant `principal − mdr` and
    ///      booked a receivable of `principal`; the difference was parked as deferred
    ///      income precisely so nothing was recognised early. When the plan defaults,
    ///      that fee was indeed never earned — but it also never left the building.
    ///      The pool's true loss is what it actually paid out, which is the carrying
    ///      value *minus* the unearned fee. Simply dropping the deferral would have
    ///      written off money the book still had, and the balance sheet identity —
    ///      claims equal holdings — was what caught it.
    function _close(bytes32 planId, PlanBook storage book, uint256 writeOff) private {
        book.open = false;
        openPlans -= 1;

        if (book.unmarked) {
            book.unmarked = false;
            unmarkedDelinquencies -= 1;
            emit UnmarkedDelinquency(planId, false);
        }

        _reduceExposure(book, book.carrying);

        uint256 unearned = book.deferredIncome;
        if (unearned > 0) {
            deferredIncome -= unearned;
            book.deferredIncome = 0;
        }

        if (writeOff > 0) {
            bookedReceivables -= writeOff > bookedReceivables ? bookedReceivables : writeOff;
            book.carrying = 0;
        }

        if (writeOff > unearned) {
            _absorbLoss(planId, writeOff - unearned);
        } else if (unearned > writeOff) {
            // A plan that repaid in full leaves the rounding remainder of its fee
            // here. It is earned by definition — the principal all came back.
            _distribute(unearned - writeOff);
        }
    }

    function _reduceExposure(PlanBook storage book, uint256 amount) private {
        if (amount == 0) return;
        uint256 m = _merchantExposure[book.merchant];
        _merchantExposure[book.merchant] = amount > m ? 0 : m - amount;
        uint256 c = _corridorExposure[book.corridor];
        _corridorExposure[book.corridor] = amount > c ? 0 : c - amount;
    }

    /// @dev Whether this plan is sitting past grace with nothing recorded. The mark
    ///      is bountied precisely because nobody profits from cranking a collection
    ///      that cannot succeed; this is the other half of that design — the book
    ///      refuses to originate while a delinquency it can see is unrecognised, so
    ///      somebody always has a reason to pay for the crank.
    function _syncMarkState(bytes32 planId, PlanBook storage book, IInstallmentPlan plan) private {
        bool unmarked = false;
        uint256 count = plan.installmentCount();
        for (uint256 i = 0; i < count; ++i) {
            IInstallmentPlan.InstallmentStatus status = plan.installmentStatus(i);
            bool live = status == IInstallmentPlan.InstallmentStatus.Pending
                || status == IInstallmentPlan.InstallmentStatus.Bounced;
            if (live && block.timestamp > plan.graceEndsAt(i)) {
                unmarked = true;
                break;
            }
        }

        if (unmarked == book.unmarked) return;
        book.unmarked = unmarked;
        if (unmarked) unmarkedDelinquencies += 1;
        else unmarkedDelinquencies -= 1;
        emit UnmarkedDelinquency(planId, unmarked);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Income and loss
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Income tops the reserve back to target first, then splits pro rata by
    ///      tranche assets. POOL-05's "replenishes from protocol fees" is this: the
    ///      reserve is refilled by the book's earnings rather than by someone
    ///      remembering to.
    function _distribute(uint256 amount) private {
        uint256 target = reserveTarget();
        if (_reserve < target) {
            uint256 top = target - _reserve;
            uint256 toReserve = amount > top ? top : amount;
            _reserve += toReserve;
            amount -= toReserve;
            if (amount == 0) return;
        }

        uint256 junior = _trancheAssets[Tranche.Junior];
        uint256 senior = _trancheAssets[Tranche.Senior];
        uint256 total = junior + senior;

        if (total == 0) {
            _reserve += amount;
            return;
        }

        uint256 juniorShare = (amount * junior) / total;
        _trancheAssets[Tranche.Junior] = junior + juniorShare;
        _trancheAssets[Tranche.Senior] = senior + (amount - juniorShare);
    }

    /// @dev POOL-16. Reserve exhausts before junior is touched, junior before senior.
    ///      Senior's entire claim is that it is struck last, and the ordering here is
    ///      the evidence — itemised in the event, because "we allocate losses
    ///      correctly" is a sentence and `LossAbsorbed(planId, x, y, z)` is a fact.
    function _absorbLoss(bytes32 planId, uint256 amount) private {
        uint256 fromReserve = amount > _reserve ? _reserve : amount;
        _reserve -= fromReserve;
        amount -= fromReserve;

        uint256 junior = _trancheAssets[Tranche.Junior];
        uint256 fromJunior = amount > junior ? junior : amount;
        _trancheAssets[Tranche.Junior] = junior - fromJunior;
        amount -= fromJunior;

        uint256 senior = _trancheAssets[Tranche.Senior];
        uint256 fromSenior = amount > senior ? senior : amount;
        _trancheAssets[Tranche.Senior] = senior - fromSenior;

        emit LossAbsorbed(planId, fromReserve, fromJunior, fromSenior);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Concentration (UW-09)
    // ─────────────────────────────────────────────────────────────────────────

    function merchantExposure(address merchant) external view returns (uint256) {
        return _merchantExposure[merchant];
    }

    function corridorExposure(bytes32 corridor) external view returns (uint256) {
        return _corridorExposure[corridor];
    }

    /// @notice Whether adding `principal` would breach a concentration cap.
    /// @dev Both caps are a share of the book rather than an absolute, so they scale
    ///      with the capital that has to absorb the loss. A fixed limit becomes
    ///      either irrelevant or binding as the book grows, and nobody notices which
    ///      until it is one of them.
    function concentrationHeadroom(address merchant, bytes32 corridor)
        external
        view
        returns (uint256 merchantRoom, uint256 corridorRoom)
    {
        uint256 assets = totalAssets();
        uint256 merchantCap =
            (assets * parameters.get(ParameterKeys.MERCHANT_CONCENTRATION_BPS)) / PlanParams.BPS;
        uint256 corridorCap =
            (assets * parameters.get(ParameterKeys.CORRIDOR_CONCENTRATION_BPS)) / PlanParams.BPS;

        uint256 m = _merchantExposure[merchant];
        uint256 c = _corridorExposure[corridor];
        merchantRoom = merchantCap > m ? merchantCap - m : 0;
        corridorRoom = corridorCap > c ? corridorCap - c : 0;
    }

    function bookOf(bytes32 planId) external view returns (PlanBook memory) {
        return _books[planId];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Administration
    // ─────────────────────────────────────────────────────────────────────────

    function setEligibility(address eligibility_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (eligibility_ == address(0)) revert EligibilityZero();
        address previous = address(eligibility);
        eligibility = ITransferEligibility(eligibility_);
        emit EligibilityRegistryChanged(previous, eligibility_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Share maths
    // ─────────────────────────────────────────────────────────────────────────

    function _sharesForAssets(Tranche tranche, uint256 assets) private view returns (uint256) {
        uint256 shares = _trancheShares[tranche];
        uint256 backing = _trancheAssets[tranche];
        return (assets * (shares + VIRTUAL_SHARES)) / (backing + 1);
    }

    function _assetsForShares(Tranche tranche, uint256 shares) private view returns (uint256) {
        uint256 outstanding = _trancheShares[tranche];
        uint256 backing = _trancheAssets[tranche];
        return (shares * (backing + 1)) / (outstanding + VIRTUAL_SHARES);
    }

    function _emitGate() private {
        emit OriginationGated(originationOpen(), subordinationBps(), reserveBps());
    }
}
