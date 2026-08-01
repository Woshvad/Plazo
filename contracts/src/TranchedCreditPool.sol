// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ICreditPool} from "./interfaces/ICreditPool.sol";
import {IInstallmentPlan} from "./interfaces/IInstallmentPlan.sol";
import {ITransferEligibility} from "./interfaces/ITransferEligibility.sol";
import {IYieldVenue} from "./interfaces/IYieldVenue.sol";
import {ParameterRegistry} from "./ParameterRegistry.sol";
import {TrancheToken, TRANCHE_DECIMALS_OFFSET} from "./TrancheToken.sol";
import {ParameterKeys} from "./libraries/ParameterKeys.sol";
import {PlanParams} from "./libraries/PlanParams.sol";

/// @title TranchedCreditPool
/// @notice The funding book as an open credit market: senior and junior claims over a
///         first-loss reserve, priced at epoch NAV, exited through a queue.
///
/// @dev A refinement of Phase 3's `CreditPool`, in the literal sense — the same
///      accounting identity, the same `front`/`recognise` surface, the same loss
///      waterfall, with the epoch layer, the redemption queue and real share tokens
///      added. The Phase 1 `PoolInvariants` bind to it unchanged, which is the check
///      that the refinement really is one.
///
///      **It replaces rather than wraps (DEC-21).** The tempting shape is a manager
///      that becomes the sole depositor in the flat pool and implements epochs above
///      it, preserving both deployed contracts. It also puts NAV in two places, which
///      is precisely the defect Phase 3 shipped and had to fix: the merchant's
///      exposure and the pool's book were two ledgers for the same money and only one
///      of them ever came down. A capital market with two NAVs that can drift is worse
///      than a redeployment.
///
///      **Assets are booked, never weighed (POOL-11).** `totalAssets()` is
///      `reserve + junior + senior`. It is never `token.balanceOf(this)`, and the
///      contract deliberately holds three kinds of money it does not own — pending
///      deposits, escrowed redemption proceeds, and the venue position — precisely so
///      that reading its balance would give the wrong answer to anyone who tried.
///
///      **The holdings identity.** Claims equal holdings, always:
///
///          reserve + junior + senior
///              == bookedCash + deployedAssets + bookedReceivables
///                 − deferredIncome − totalProvisioned
///
///      Every function in this contract moves both sides or neither. That identity is
///      what caught the Phase 3 write-off bug and it is bound as an invariant here.
///
///      **Nothing settles inside a request (DEC-22).** A deposit at next-epoch NAV
///      cannot mint shares in the depositing transaction, because the price does not
///      exist yet. `requestDeposit` escrows into a pending bucket that is not part of
///      NAV and confers no claim; `closeEpoch` strikes one price for everyone in that
///      epoch; `claimShares` collects. A depositor may cancel before the close and get
///      back exactly what they put in.
contract TranchedCreditPool is ICreditPool, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice May front capital against a plan. `CheckoutRouter` alone.
    ///
    /// @dev Two named addresses rather than an `AccessControl` role graph, and the
    ///      reason is prosaic: this contract is within a couple of kilobytes of the
    ///      EIP-170 ceiling, and a role registry that will only ever hold two entries
    ///      is three kilobytes spent on generality nobody wants here. What is lost is
    ///      multiple simultaneous originators, which would be a second door into the
    ///      book and is exactly what Phase 3 spent a phase closing.
    address public originator;

    /// @notice May move the idle buffer between cash and a whitelisted venue.
    /// @dev Deliberately not the owner. Moving the buffer is an operational act with
    ///      no discretion in it — the venue allowlist is the decision, and that is the
    ///      owner's.
    address public treasurer;

    uint256 private constant VIRTUAL_SHARES = 10 ** TRANCHE_DECIMALS_OFFSET;
    uint256 private constant YEAR = 365 days;

    struct PlanBook {
        address plan;
        address merchant;
        bytes32 corridor;
        uint256 principal;
        uint256 carrying;
        uint256 recognisedInflow;
        uint256 deferredIncome;
        bool open;
        bool unmarked;
        /// @notice Last epoch this plan was walked by the mark phase.
        uint256 markedEpoch;
    }

    /// @notice A markdown taken against a plan, and where it came from.
    /// @dev The triple is what makes a cure release exactly what the delinquency took.
    ///      Recording only the total would mean guessing at the reversal, and the
    ///      guess would be wrong the moment the waterfall had moved underneath it.
    struct Provision {
        uint256 amount;
        uint256 epoch;
        uint256 fromReserve;
        uint256 fromJunior;
        uint256 fromSenior;
    }

    struct DepositTicket {
        uint256 epoch;
        uint256 assets;
    }

    struct RedeemTicket {
        /// @notice Cumulative queue position of the first share in this request.
        uint256 lo;
        /// @notice Cumulative position just past the last share.
        uint256 hi;
        /// @notice How far this ticket has been claimed, as a cumulative position.
        uint256 claimedTo;
        /// @notice Where in the fill log to resume from.
        uint256 cursor;
    }

    /// @notice One epoch's fill of one tranche's queue.
    struct Fill {
        /// @notice Cumulative queue position the fill line reached.
        uint256 filledTo;
        uint256 sharesFilled;
        uint256 assetsAllocated;
        uint256 epoch;
        uint256 feeBps;
    }

    // ─── Wiring ──────────────────────────────────────────────────────────────

    IERC20 public immutable token;
    ParameterRegistry public immutable parameters;

    /// @notice Which product line this book funds. POOL-01.
    bytes32 public immutable productLine;
    uint256 public immutable minInstallments;
    uint256 public immutable maxInstallments;
    uint256 public immutable minInterval;
    uint256 public immutable maxInterval;

    TrancheToken public immutable seniorShares;
    TrancheToken public immutable juniorShares;

    ITransferEligibility public eligibility;

    IYieldVenue public venue;
    mapping(address venue => bool) public venueAllowed;

    // ─── The balance sheet ───────────────────────────────────────────────────

    uint256 private _reserve;
    mapping(Tranche => uint256) private _trancheAssets;

    uint256 public bookedCash;
    uint256 public deployedAssets;
    uint256 public bookedReceivables;
    uint256 public deferredIncome;

    uint256 private _totalProvisioned;
    mapping(uint256 epoch => uint256) private _provisionedAt;
    mapping(bytes32 planId => Provision) private _provisions;

    /// @notice Assets escrowed for deposits that have not been priced yet.
    /// @dev Not part of NAV. This is the one pot the pool holds that belongs to
    ///      somebody else and has no claim attached.
    uint256 public pendingDepositAssets;
    /// @notice Redemption proceeds struck but not yet collected.
    uint256 public pendingRedemptionAssets;

    /// @notice Senior's accrued target return, still owed.
    /// @dev A priority marker on future income, not an asset. It never appears on the
    ///      claims side, so it cannot inflate NAV — it only decides who gets paid
    ///      first when there is something to pay.
    uint256 public seniorAccrued;

    // ─── Plans ───────────────────────────────────────────────────────────────

    mapping(bytes32 planId => PlanBook) private _books;
    mapping(address merchant => uint256) private _merchantExposure;
    mapping(bytes32 corridor => uint256) private _corridorExposure;

    bytes32[] private _openPlanList;
    mapping(bytes32 planId => uint256) private _openPlanSlot;

    uint256 public unmarkedDelinquencies;
    uint256 public openPlans;

    // ─── Epochs ──────────────────────────────────────────────────────────────

    uint256 private _epoch;
    uint256 public epochStartedAt;
    /// @notice Open plans walked by the mark phase in the current epoch.
    uint256 public markedThisEpoch;
    /// @notice Where the next `markEpoch` batch resumes.
    uint256 private _markCursor;

    mapping(Tranche => mapping(address => DepositTicket)) private _depositTickets;
    mapping(Tranche => mapping(uint256 epoch => uint256)) private _epochDepositAssets;
    mapping(Tranche => mapping(uint256 epoch => uint256)) private _epochDepositShares;
    mapping(Tranche => bool) public seeded;

    mapping(Tranche => mapping(address => RedeemTicket[])) private _redeemTickets;
    mapping(Tranche => uint256) private _queueTail;
    mapping(Tranche => uint256) private _queueFilled;
    mapping(Tranche => Fill[]) private _fills;
    mapping(Tranche => mapping(uint256 epoch => uint256)) private _epochRedeemRequested;

    // ─── Events ──────────────────────────────────────────────────────────────

    event DepositRequested(Tranche indexed tranche, address indexed holder, uint256 epoch, uint256 assets);
    event DepositCancelled(Tranche indexed tranche, address indexed holder, uint256 assets);
    event SharesClaimed(Tranche indexed tranche, address indexed holder, uint256 assets, uint256 shares);
    event RedeemRequested(
        Tranche indexed tranche, address indexed holder, uint256 index, uint256 shares, uint256 position
    );
    event RedemptionClaimed(Tranche indexed tranche, address indexed holder, uint256 index, uint256 assets);
    event Seeded(Tranche indexed tranche, uint256 assets, uint256 shares);
    event ReserveFunded(address indexed from, uint256 amount, uint256 balance);
    event Fronted(bytes32 indexed planId, address indexed merchant, uint256 principal, uint256 mdr);
    event Recognised(bytes32 indexed planId, uint256 inflow, uint256 principalRecovered, uint256 incomeEarned);
    event LossAbsorbed(bytes32 indexed planId, uint256 fromReserve, uint256 fromJunior, uint256 fromSenior);
    event FraudLossAbsorbed(bytes32 indexed planId, uint256 fromReserve, uint256 beyondReserve);
    event Provisioned(bytes32 indexed planId, uint256 epoch, uint256 amount, uint256 total);
    event ProvisionReleased(bytes32 indexed planId, uint256 epoch, uint256 amount, uint256 total);
    event OriginationGated(bool open, uint256 subordinationBps, uint256 reserveBps);
    event UnmarkedDelinquency(bytes32 indexed planId, bool unmarked);
    event EpochMarked(uint256 indexed epoch, uint256 marked, uint256 openPlans);
    event EpochClosed(
        uint256 indexed epoch, uint256 seniorNav, uint256 juniorNav, uint256 liquidityFeeBps
    );
    event QueueFilled(
        Tranche indexed tranche, uint256 indexed epoch, uint256 shares, uint256 assets, uint256 feeBps
    );
    event VenueChanged(address indexed previous, address indexed current);
    event VenueAllowed(address indexed venue, bool allowed);
    event BufferDeployed(address indexed venue, uint256 amount);
    event BufferRecalled(address indexed venue, uint256 amount);
    event VenueSynced(int256 delta, uint256 deployed);
    event EligibilityRegistryChanged(address indexed previous, address indexed current);
    event OriginatorSet(address indexed originator);
    event TreasurerSet(address indexed treasurer);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error NotEligible(address account);
    error PlanAlreadyFronted(bytes32 planId);
    error PlanNotFronted(bytes32 planId);
    error OriginationClosed();
    error ScheduleOutOfBand(uint256 installmentCount, uint256 interval);
    error InsufficientCash(uint256 requested, uint256 available);
    error NothingToDeposit();
    error NotSeeded(Tranche tranche);
    error AlreadySeeded(Tranche tranche);
    error TicketPending(uint256 epoch);
    error NoTicket();
    error NotYetPriced(uint256 epoch);
    error SubordinationFloor(uint256 projected, uint256 floor);
    error EpochNotOver(uint256 endsAt);
    error MarkPhaseIncomplete(uint256 marked, uint256 open);
    error UnmarkedDelinquencyOutstanding(uint256 count);
    error VenueNotAllowed(address venue);
    error VenueAssetMismatch(address expected, address provided);
    error NoVenue();
    error EligibilityZero();
    error BadTicketIndex(uint256 index);
    error NotOriginator(address caller);
    error NotTreasurer(address caller);

    struct Wiring {
        address admin;
        address token;
        address parameters;
        address eligibility;
        bytes32 productLine;
        uint256 minInstallments;
        uint256 maxInstallments;
        uint256 minInterval;
        uint256 maxInterval;
    }

    constructor(Wiring memory w) Ownable(w.admin) {
        if (w.eligibility == address(0)) revert EligibilityZero();
        treasurer = w.admin;

        token = IERC20(w.token);
        parameters = ParameterRegistry(w.parameters);
        eligibility = ITransferEligibility(w.eligibility);

        productLine = w.productLine;
        minInstallments = w.minInstallments;
        maxInstallments = w.maxInstallments;
        minInterval = w.minInterval;
        maxInterval = w.maxInterval;

        uint8 assetDecimals = IERC20Metadata(w.token).decimals();

        seniorShares =
            new TrancheToken("Plazo Senior Claim", "PLZ-S", assetDecimals, address(this), w.eligibility, 0);
        juniorShares = new TrancheToken(
            "Plazo Junior Claim",
            "PLZ-J",
            assetDecimals,
            address(this),
            w.eligibility,
            parameters.get(ParameterKeys.JUNIOR_LOCK_PERIOD)
        );

        _epoch = 1;
        epochStartedAt = block.timestamp;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The accounting identity
    // ─────────────────────────────────────────────────────────────────────────

    function totalAssets() public view returns (uint256) {
        return _reserve + _trancheAssets[Tranche.Junior] + _trancheAssets[Tranche.Senior];
    }

    function reserveBalance() external view returns (uint256) {
        return _reserve;
    }

    function trancheAssets(Tranche tranche) public view returns (uint256) {
        return _trancheAssets[tranche];
    }

    function trancheShares(Tranche tranche) public view returns (uint256) {
        return _shareToken(tranche).totalSupply();
    }

    function provisionedAt(uint256 epoch) external view returns (uint256) {
        return _provisionedAt[epoch];
    }

    function totalProvisioned() external view returns (uint256) {
        return _totalProvisioned;
    }

    function grossReceivables() external view returns (uint256) {
        return bookedReceivables;
    }

    function currentEpoch() public view returns (uint256) {
        return _epoch;
    }

    function epochEndsAt() public view returns (uint256) {
        return epochStartedAt + parameters.get(ParameterKeys.EPOCH_LENGTH);
    }

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

    function allDelinquenciesMarked() public view returns (bool) {
        return unmarkedDelinquencies == 0;
    }

    /// @notice Assets per share, scaled by 1e18.
    /// @dev The virtual-share term is POOL-12's third leg. An empty tranche prices at
    ///      exactly one asset-unit per share-unit rather than at whatever the first
    ///      depositor can make the denominator be.
    function navPerShare(Tranche tranche) public view returns (uint256) {
        uint256 shares = trancheShares(tranche);
        return ((_trancheAssets[tranche] + 1) * 1e18) / (shares + VIRTUAL_SHARES);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Gates
    // ─────────────────────────────────────────────────────────────────────────

    function originationOpen() public view returns (bool) {
        uint256 assets = totalAssets();
        if (assets == 0) return false;
        if (!allDelinquenciesMarked()) return false;
        if (subordinationBps() < parameters.get(ParameterKeys.MIN_SUBORDINATION_BPS)) return false;
        if (reserveBps() < parameters.get(ParameterKeys.RESERVE_TARGET_BPS)) return false;
        return true;
    }

    /// @notice Whether this book funds a plan of this shape. POOL-01, DEC-26.
    function acceptsSchedule(uint256 installmentCount, uint256 interval) public view returns (bool) {
        return installmentCount >= minInstallments && installmentCount <= maxInstallments
            && interval >= minInterval && interval <= maxInterval;
    }

    /// @notice The largest senior deposit that keeps subordination at its floor.
    ///
    /// @dev POOL-06's ordering, made concrete. The subordination constraint binds on
    ///      senior deposits *before* it halts origination, because a book that stops
    ///      lending while its liabilities keep running is a book in runoff — and the
    ///      thing actually diluting subordination is the senior money coming in, not
    ///      the credit going out. Refusing the dilution is the proportionate lever;
    ///      closing origination is the last one.
    ///
    ///      Junior money *pending in this epoch* counts, because it will be priced in
    ///      the same close. Without that, a book being capitalised could not take
    ///      senior and junior subscriptions in one epoch — the senior leg would be
    ///      measured against a junior tranche that had not settled yet, and the answer
    ///      would depend on which order two lenders happened to transact in.
    ///
    ///      What remains order-dependent is senior arriving before *any* junior money,
    ///      pending or settled, and that refusal is correct: you cannot be senior to
    ///      nothing.
    function maxSeniorDeposit() public view returns (uint256) {
        uint256 floor_ = parameters.get(ParameterKeys.MIN_SUBORDINATION_BPS);
        if (floor_ == 0) return type(uint256).max;

        uint256 junior = _trancheAssets[Tranche.Junior] + _epochDepositAssets[Tranche.Junior][_epoch];
        // junior / (assets + x) >= floor  ⟺  x <= junior*BPS/floor − assets
        uint256 ceiling = (junior * PlanParams.BPS) / floor_;
        uint256 assets = totalAssets() + pendingDepositAssets;
        return ceiling > assets ? ceiling - assets : 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Capital in — asynchronous (POOL-03)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Seed a tranche permanently. POOL-12's second leg.
    /// @dev Protocol money, not the first depositor's, and it is never redeemable:
    ///      the shares are minted to this contract and no path burns them except a
    ///      redemption request this contract never makes. It exists so the
    ///      "first depositor into an empty vault" case is unreachable rather than
    ///      merely expensive.
    function seed(Tranche tranche, uint256 assets) external onlyOwner {
        if (seeded[tranche]) revert AlreadySeeded(tranche);
        if (assets == 0) revert NothingToDeposit();

        token.safeTransferFrom(msg.sender, address(this), assets);

        uint256 shares = (assets * (trancheShares(tranche) + VIRTUAL_SHARES)) / (_trancheAssets[tranche] + 1);

        bookedCash += assets;
        _trancheAssets[tranche] += assets;
        _shareToken(tranche).mint(address(this), shares);
        seeded[tranche] = true;

        emit Seeded(tranche, assets, shares);
        _emitGate();
    }

    /// @notice Queue a deposit for the next epoch's NAV.
    ///
    /// @dev The assets go into `pendingDepositAssets`, which is excluded from
    ///      `totalAssets` and confers no claim. Nothing about this transaction changes
    ///      any existing holder's NAV per share — which is the whole reason the
    ///      deposit is asynchronous rather than synchronous.
    function requestDeposit(Tranche tranche, uint256 assets) external nonReentrant {
        if (assets == 0) revert NothingToDeposit();
        if (!seeded[tranche]) revert NotSeeded(tranche);
        if (!eligibility.isEligible(address(_shareToken(tranche)), msg.sender)) {
            revert NotEligible(msg.sender);
        }

        if (tranche == Tranche.Senior) {
            uint256 room = maxSeniorDeposit();
            if (assets > room) {
                revert SubordinationFloor(room, parameters.get(ParameterKeys.MIN_SUBORDINATION_BPS));
            }
        }

        DepositTicket storage ticket = _depositTickets[tranche][msg.sender];
        if (ticket.assets > 0 && ticket.epoch != _epoch) revert TicketPending(ticket.epoch);

        token.safeTransferFrom(msg.sender, address(this), assets);

        ticket.epoch = _epoch;
        ticket.assets += assets;

        pendingDepositAssets += assets;
        _epochDepositAssets[tranche][_epoch] += assets;

        emit DepositRequested(tranche, msg.sender, _epoch, assets);
    }

    /// @notice Withdraw a deposit request before it is priced.
    /// @dev Exactly what was put in, because nothing was ever done with it. A pending
    ///      deposit that could come back smaller would be a position, and the point of
    ///      the pending bucket is that it is not one.
    function cancelDeposit(Tranche tranche) external nonReentrant {
        DepositTicket storage ticket = _depositTickets[tranche][msg.sender];
        uint256 assets = ticket.assets;
        if (assets == 0) revert NoTicket();
        if (ticket.epoch != _epoch) revert NotYetPriced(ticket.epoch);

        ticket.assets = 0;
        pendingDepositAssets -= assets;
        _epochDepositAssets[tranche][_epoch] -= assets;

        token.safeTransfer(msg.sender, assets);
        emit DepositCancelled(tranche, msg.sender, assets);
    }

    /// @notice Collect the shares a settled deposit request became.
    function claimShares(Tranche tranche) public nonReentrant returns (uint256 shares) {
        DepositTicket storage ticket = _depositTickets[tranche][msg.sender];
        uint256 assets = ticket.assets;
        if (assets == 0) revert NoTicket();
        if (ticket.epoch >= _epoch) revert NotYetPriced(ticket.epoch);

        uint256 epochAssets = _epochDepositAssets[tranche][ticket.epoch];
        uint256 epochShares = _epochDepositShares[tranche][ticket.epoch];
        shares = epochAssets == 0 ? 0 : (assets * epochShares) / epochAssets;

        ticket.assets = 0;
        _shareToken(tranche).transfer(msg.sender, shares);

        emit SharesClaimed(tranche, msg.sender, assets, shares);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Capital out — the queue (POOL-08, POOL-09)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Join the redemption queue.
    ///
    /// @dev The shares are escrowed here and the position is cumulative: the ticket
    ///      owns the half-open range `(lo, hi]` of the tranche's total queued shares.
    ///      That is what makes a partial fill expressible without iterating anybody —
    ///      the pool moves one fill line forward and every ticket works out its own
    ///      share of it.
    ///
    ///      Junior's lockup is enforced by the share token on this transfer, not here.
    ///      A lock checked by the vault would be a lock the token could be moved around.
    function requestRedeem(Tranche tranche, uint256 shares) external nonReentrant returns (uint256 index) {
        if (shares == 0) revert NothingToDeposit();

        TrancheToken share = _shareToken(tranche);
        share.transferFrom(msg.sender, address(this), shares);

        uint256 lo = _queueTail[tranche];
        uint256 hi = lo + shares;
        _queueTail[tranche] = hi;

        RedeemTicket[] storage tickets = _redeemTickets[tranche][msg.sender];
        index = tickets.length;
        tickets.push(
            RedeemTicket({lo: lo, hi: hi, claimedTo: lo, cursor: _fills[tranche].length})
        );

        _epochRedeemRequested[tranche][_epoch] += shares;

        emit RedeemRequested(tranche, msg.sender, index, shares, hi);
    }

    /// @notice Collect whatever of a redemption ticket the queue has reached.
    ///
    /// @dev Walks the fill log from where this ticket left off. Bounded by `maxSteps`
    ///      and resumable, so a ticket whose fill straddled many epochs is never a
    ///      transaction that cannot fit in a block — the claimant pays for their own
    ///      patience rather than the pool carrying an unbounded loop at close.
    function claimRedemption(Tranche tranche, uint256 index, uint256 maxSteps)
        public
        nonReentrant
        returns (uint256 assets)
    {
        RedeemTicket[] storage tickets = _redeemTickets[tranche][msg.sender];
        if (index >= tickets.length) revert BadTicketIndex(index);
        RedeemTicket storage ticket = tickets[index];

        Fill[] storage fills = _fills[tranche];
        uint256 steps;

        while (ticket.cursor < fills.length && ticket.claimedTo < ticket.hi && steps < maxSteps) {
            Fill storage fill = fills[ticket.cursor];

            if (fill.filledTo <= ticket.claimedTo) {
                ticket.cursor += 1;
                steps += 1;
                continue;
            }

            uint256 upTo = fill.filledTo < ticket.hi ? fill.filledTo : ticket.hi;
            uint256 covered = upTo - ticket.claimedTo;

            assets += fill.sharesFilled == 0 ? 0 : (covered * fill.assetsAllocated) / fill.sharesFilled;
            ticket.claimedTo = upTo;

            if (fill.filledTo <= upTo) ticket.cursor += 1;
            steps += 1;
        }

        if (assets > 0) {
            pendingRedemptionAssets -= assets;
            token.safeTransfer(msg.sender, assets);
        }

        emit RedemptionClaimed(tranche, msg.sender, index, assets);
    }

    function redeemTicketCount(Tranche tranche, address holder) external view returns (uint256) {
        return _redeemTickets[tranche][holder].length;
    }

    function redeemTicketAt(Tranche tranche, address holder, uint256 index)
        external
        view
        returns (RedeemTicket memory)
    {
        return _redeemTickets[tranche][holder][index];
    }

    function depositTicketOf(Tranche tranche, address holder) external view returns (DepositTicket memory) {
        return _depositTickets[tranche][holder];
    }

    function queueDepth(Tranche tranche) external view returns (uint256 queued, uint256 filled) {
        return (_queueTail[tranche], _queueFilled[tranche]);
    }

    function fillCount(Tranche tranche) external view returns (uint256) {
        return _fills[tranche].length;
    }

    function fillAt(Tranche tranche, uint256 i) external view returns (Fill memory) {
        return _fills[tranche][i];
    }

    function epochDeposits(Tranche tranche, uint256 epoch)
        external
        view
        returns (uint256 assets, uint256 shares)
    {
        return (_epochDepositAssets[tranche][epoch], _epochDepositShares[tranche][epoch]);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The reserve
    // ─────────────────────────────────────────────────────────────────────────

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

    function front(
        bytes32 planId,
        address plan,
        address merchant,
        bytes32 corridor,
        uint256 principal,
        uint256 mdr,
        uint256 escrow,
        address merchantProceeds
    ) external onlyOriginator {
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
            unmarked: false,
            markedEpoch: _epoch
        });

        bookedCash -= cashOut;
        bookedReceivables += principal;
        deferredIncome += mdr - escrow;

        _merchantExposure[merchant] += principal;
        _corridorExposure[corridor] += principal;

        _openPlanSlot[planId] = _openPlanList.length;
        _openPlanList.push(planId);
        openPlans += 1;
        markedThisEpoch += 1;

        token.safeTransfer(plan, escrow);
        token.safeTransfer(merchantProceeds, net);

        emit Fronted(planId, merchant, principal, mdr);
        _emitGate();
    }

    /// @notice Whether this book would accept a plan of this shape right now.
    function canFront(uint256 installmentCount, uint256 interval) external view returns (bool) {
        return originationOpen() && acceptsSchedule(installmentCount, interval);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Recognition
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Book whatever a plan has done since the last crank. Permissionless.
    function recognise(bytes32 planId) public {
        PlanBook storage book = _books[planId];
        if (book.plan == address(0)) revert PlanNotFronted(planId);
        if (!book.open) return;

        IInstallmentPlan plan = IInstallmentPlan(book.plan);

        uint256 inflow = plan.forwarded() - book.recognisedInflow;
        uint256 outstanding = plan.outstandingPrincipal();
        uint256 carryingBefore = book.carrying;
        uint256 recovered = carryingBefore > outstanding ? carryingBefore - outstanding : 0;

        book.recognisedInflow += inflow;
        book.carrying = outstanding;

        bookedCash += inflow;
        bookedReceivables -= recovered;

        // MDR earns as principal is recovered, not at checkout. A fee recognised on a
        // loan nobody has begun repaying is profit the book has not made.
        //
        // **The denominator is what is still owed, not the original principal.** Found
        // by the invariant fuzzer, via `deferredIncome ≤ bookedReceivables`. Dividing by
        // the original principal compounds: a plan of 1,000 with 100 deferred recovers
        // 500 and earns 50, leaving 50 against 500 outstanding; the second 500 then
        // earns `50 × 500/1000 = 25`, and a fully repaid plan is left carrying 25 of
        // unearned income against no receivable at all. The book understates NAV for the
        // whole life of every plan and then jumps at close — which is the
        // flatter-then-correct pattern the deferral exists to prevent, running backwards.
        //
        // Against the remaining balance it amortises exactly: the last dollar of
        // principal earns the last cent of fee.
        uint256 earned = 0;
        if (recovered > 0 && carryingBefore > 0) {
            earned = (book.deferredIncome * recovered) / carryingBefore;
            if (earned > book.deferredIncome) earned = book.deferredIncome;
            book.deferredIncome -= earned;
            deferredIncome -= earned;
        }

        _reduceExposure(book, recovered);

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
        _syncProvision(planId, book, plan);

        emit Recognised(planId, inflow, recovered, earned);

        IInstallmentPlan.PlanState planState = plan.state();
        if (
            planState == IInstallmentPlan.PlanState.Repaid
                || planState == IInstallmentPlan.PlanState.Refunded
                || planState == IInstallmentPlan.PlanState.Cancelled
                || planState == IInstallmentPlan.PlanState.Defaulted
                || planState == IInstallmentPlan.PlanState.FraudReversed
        ) {
            _close(planId, book, book.carrying, planState == IInstallmentPlan.PlanState.FraudReversed);
        }

        _emitGate();
    }

    function recogniseBatch(bytes32[] calldata planIds) external {
        for (uint256 i = 0; i < planIds.length; ++i) {
            recognise(planIds[i]);
        }
    }

    /// @dev CURE-04's second half. A charged-off plan releases whatever provision it
    ///      was carrying and *then* takes a real loss, because doing both would charge
    ///      the same money twice and doing neither would let a defaulted book keep
    ///      quoting par. A provision is an estimate and reversible; a charge-off is
    ///      neither, and the two must never overlap (DEC-25).
    function _close(bytes32 planId, PlanBook storage book, uint256 writeOff, bool fraud) private {
        book.open = false;
        openPlans -= 1;
        _removeOpenPlan(planId);

        if (book.unmarked) {
            book.unmarked = false;
            unmarkedDelinquencies -= 1;
            emit UnmarkedDelinquency(planId, false);
        }

        Provision storage held = _provisions[planId];
        if (held.amount > 0) _releaseProvision(planId, held.amount);

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
            uint256 loss = writeOff - unearned;
            // POOL-14. A fraud loss is not a credit loss and does not belong in a
            // waterfall the senior tranche was sold on. It hits the reserve, which is
            // what the reserve is for; anything beyond the reserve still has to come
            // from somewhere, and the event says exactly how much did.
            if (fraud) _absorbFraudLoss(planId, loss);
            else _absorbLoss(planId, loss);
        } else if (unearned > writeOff) {
            _distribute(unearned - writeOff);
        }
    }

    function _removeOpenPlan(bytes32 planId) private {
        uint256 slot = _openPlanSlot[planId];
        uint256 last = _openPlanList.length - 1;
        if (slot != last) {
            bytes32 moved = _openPlanList[last];
            _openPlanList[slot] = moved;
            _openPlanSlot[moved] = slot;
        }
        _openPlanList.pop();
        delete _openPlanSlot[planId];

        if (_books[planId].markedEpoch == _epoch && markedThisEpoch > 0) markedThisEpoch -= 1;
    }

    function _reduceExposure(PlanBook storage book, uint256 amount) private {
        if (amount == 0) return;
        uint256 m = _merchantExposure[book.merchant];
        _merchantExposure[book.merchant] = amount > m ? 0 : m - amount;
        uint256 c = _corridorExposure[book.corridor];
        _corridorExposure[book.corridor] = amount > c ? 0 : c - amount;
    }

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
    // Provisioning (POOL-07)
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev A provision is a markdown, not a payment. It moves NAV so that a lender
    ///      depositing today does not buy into a book that is quietly worth less than
    ///      it says, and it moves back exactly on cure.
    ///
    ///      The bucket is the epoch the provision was **first raised**, not the epoch
    ///      of each adjustment. A plan whose provision straddled buckets would have no
    ///      single place to release from, and the release is the half of POOL-07 that
    ///      actually prevents the NAV oscillation.
    function _syncProvision(bytes32 planId, PlanBook storage book, IInstallmentPlan plan) private {
        IInstallmentPlan.PlanState state = plan.state();
        bool delinquent = state == IInstallmentPlan.PlanState.Delinquent;

        uint256 want = delinquent
            ? (book.carrying * parameters.get(ParameterKeys.DELINQUENT_PROVISION_BPS)) / PlanParams.BPS
            : 0;

        uint256 held = _provisions[planId].amount;
        if (want > held) _takeProvision(planId, want - held);
        else if (want < held) _releaseProvision(planId, held - want);
    }

    function _takeProvision(bytes32 planId, uint256 amount) private {
        (uint256 fromReserve, uint256 fromJunior, uint256 fromSenior) = _strike(amount);
        uint256 taken = fromReserve + fromJunior + fromSenior;
        if (taken == 0) return;

        Provision storage p = _provisions[planId];
        if (p.amount == 0) p.epoch = _epoch;
        p.amount += taken;
        p.fromReserve += fromReserve;
        p.fromJunior += fromJunior;
        p.fromSenior += fromSenior;

        _totalProvisioned += taken;
        _provisionedAt[p.epoch] += taken;

        emit Provisioned(planId, p.epoch, taken, _totalProvisioned);
    }

    function _releaseProvision(bytes32 planId, uint256 amount) private {
        Provision storage p = _provisions[planId];
        if (p.amount == 0 || amount == 0) return;
        if (amount > p.amount) amount = p.amount;

        // Reverse order: what the waterfall took last is returned first, so a partial
        // release rebuilds senior's cushion before it rebuilds the reserve.
        uint256 toSenior = (p.fromSenior * amount) / p.amount;
        uint256 toJunior = (p.fromJunior * amount) / p.amount;
        uint256 toReserve = amount - toSenior - toJunior;
        if (toReserve > p.fromReserve) {
            toReserve = p.fromReserve;
        }

        _trancheAssets[Tranche.Senior] += toSenior;
        _trancheAssets[Tranche.Junior] += toJunior;
        _reserve += toReserve;

        uint256 returned = toSenior + toJunior + toReserve;
        p.amount -= returned > p.amount ? p.amount : returned;
        p.fromSenior -= toSenior;
        p.fromJunior -= toJunior;
        p.fromReserve -= toReserve;

        _totalProvisioned -= returned > _totalProvisioned ? _totalProvisioned : returned;
        uint256 bucket = _provisionedAt[p.epoch];
        _provisionedAt[p.epoch] = returned > bucket ? 0 : bucket - returned;

        emit ProvisionReleased(planId, p.epoch, returned, _totalProvisioned);
    }

    function provisionOf(bytes32 planId) external view returns (Provision memory) {
        return _provisions[planId];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The epoch crank (POOL-04, COLL-04)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Walk up to `limit` open plans, recognising and provisioning each.
    ///
    /// @dev Phase one of two, permissionless, incremental and idempotent. It wraps
    ///      rather than running a strict cursor to the end, because `recognise` closes
    ///      plans and closing one swap-removes it from the list — a strict cursor
    ///      would step over whatever moved into the vacated slot. Wrapping plus a
    ///      per-plan `markedEpoch` guard means every open plan is walked exactly once
    ///      per epoch regardless of what closed in between, and the phase completes
    ///      when the count says so rather than when the cursor says so.
    function markEpoch(uint256 limit) external returns (uint256 walked) {
        uint256 total = _openPlanList.length;
        if (total == 0) return 0;

        for (uint256 i = 0; i < limit && markedThisEpoch < openPlans; ++i) {
            if (_markCursor >= _openPlanList.length) _markCursor = 0;
            bytes32 planId = _openPlanList[_markCursor];

            PlanBook storage book = _books[planId];
            if (book.markedEpoch < _epoch) {
                recognise(planId);
                // `recognise` may have closed and removed it; only count it if it is
                // still open, and only advance past it if it is still where it was.
                if (_books[planId].open) {
                    _books[planId].markedEpoch = _epoch;
                    markedThisEpoch += 1;
                    _markCursor += 1;
                }
            } else {
                _markCursor += 1;
            }
            walked += 1;
        }

        emit EpochMarked(_epoch, markedThisEpoch, openPlans);
    }

    function markComplete() public view returns (bool) {
        return markedThisEpoch >= openPlans;
    }

    /// @notice Strike the NAV, price the epoch's deposits, and fill the queues.
    ///
    /// @dev Phase two, permissionless. It refuses to run while any plan past
    ///      `grace + 1` is unmarked (COLL-04) — which is what makes the bountied mark
    ///      unavoidable rather than merely available. Nobody profits from cranking a
    ///      collection that cannot succeed, so the negative signal has to be paid for,
    ///      and the payment only reliably happens if the book cannot close without it.
    function closeEpoch() external nonReentrant {
        if (block.timestamp < epochEndsAt()) revert EpochNotOver(epochEndsAt());
        if (!markComplete()) revert MarkPhaseIncomplete(markedThisEpoch, openPlans);
        if (unmarkedDelinquencies != 0) revert UnmarkedDelinquencyOutstanding(unmarkedDelinquencies);

        _syncVenue();
        _accrueSenior();

        uint256 feeBps = _liquidityFeeBps();

        _settleDeposits(Tranche.Senior);
        _settleDeposits(Tranche.Junior);

        // Senior's queue fills first. Its whole claim is priority, and priority on
        // liquidity is the part of that claim a queue can actually express.
        _fillQueue(Tranche.Senior, feeBps);
        _fillQueue(Tranche.Junior, feeBps);

        emit EpochClosed(_epoch, navPerShare(Tranche.Senior), navPerShare(Tranche.Junior), feeBps);

        _epoch += 1;
        epochStartedAt = block.timestamp;
        markedThisEpoch = 0;
        _markCursor = 0;
        _emitGate();
    }

    /// @dev POOL-09, and DEC-23's whole argument in one function. The fee is struck on
    ///      the *epoch*, not on a position in the queue, so redeeming early buys
    ///      nothing. A gate would do the opposite: the threat of one is what makes a
    ///      rational holder leave first, and this pool's buffer depth is a public
    ///      gauge telling them when.
    function _liquidityFeeBps() private view returns (uint256) {
        uint256 assets = totalAssets();
        if (assets == 0) return 0;

        uint256 requested = _redemptionAssetsRequested(Tranche.Senior)
            + _redemptionAssetsRequested(Tranche.Junior);
        uint256 deposits = _epochDepositAssets[Tranche.Senior][_epoch]
            + _epochDepositAssets[Tranche.Junior][_epoch];
        if (deposits >= requested) return 0;

        uint256 net = requested - deposits;
        uint256 netBps = (net * PlanParams.BPS) / assets;
        if (netBps < parameters.get(ParameterKeys.LIQUIDITY_FEE_THRESHOLD_BPS)) return 0;
        return parameters.get(ParameterKeys.LIQUIDITY_FEE_BPS);
    }

    function _redemptionAssetsRequested(Tranche tranche) private view returns (uint256) {
        uint256 shares = _epochRedeemRequested[tranche][_epoch];
        if (shares == 0) return 0;
        return (shares * navPerShare(tranche)) / 1e18;
    }

    function _settleDeposits(Tranche tranche) private {
        uint256 assets = _epochDepositAssets[tranche][_epoch];
        if (assets == 0) return;

        uint256 shares = (assets * (trancheShares(tranche) + VIRTUAL_SHARES)) / (_trancheAssets[tranche] + 1);

        pendingDepositAssets -= assets;
        bookedCash += assets;
        _trancheAssets[tranche] += assets;
        _epochDepositShares[tranche][_epoch] = shares;

        _shareToken(tranche).mint(address(this), shares);
    }

    function _fillQueue(Tranche tranche, uint256 feeBps) private {
        uint256 queued = _queueTail[tranche] - _queueFilled[tranche];
        if (queued == 0) return;

        uint256 price = navPerShare(tranche);
        if (price == 0) return;

        uint256 spendable = bookedCash;
        uint256 own = _trancheAssets[tranche];
        if (spendable > own) spendable = own;

        // Junior leaving thins the subordination the senior tranche was sold on, so
        // the queue stops at the floor rather than through it. POOL-06's constraint
        // binds here before it ever reaches origination.
        if (tranche == Tranche.Junior) {
            uint256 floor_ = parameters.get(ParameterKeys.MIN_SUBORDINATION_BPS);
            if (floor_ > 0) {
                uint256 assets = totalAssets();
                uint256 minJunior = (assets * floor_) / PlanParams.BPS;
                uint256 room = own > minJunior ? own - minJunior : 0;
                if (spendable > room) spendable = room;
            }
        }

        if (spendable == 0) return;

        uint256 fillable = (spendable * 1e18) / price;
        uint256 shares = fillable > queued ? queued : fillable;
        if (shares == 0) return;

        uint256 gross = (shares * price) / 1e18;
        uint256 fee = (gross * feeBps) / PlanParams.BPS;
        uint256 net = gross - fee;

        _queueFilled[tranche] += shares;
        _shareToken(tranche).burn(address(this), shares);

        // Only the net leaves the book. The fee stays in the tranche, which is the
        // mechanism: the holders who did not redeem are paid by the ones who did.
        _trancheAssets[tranche] = own - net;
        bookedCash -= net;
        pendingRedemptionAssets += net;

        _fills[tranche].push(
            Fill({
                filledTo: _queueFilled[tranche],
                sharesFilled: shares,
                assetsAllocated: net,
                epoch: _epoch,
                feeBps: feeBps
            })
        );

        emit QueueFilled(tranche, _epoch, shares, net, feeBps);
    }

    /// @dev Senior's target return accrues as a claim on future income rather than as
    ///      an asset. If the book earns less than the target the shortfall carries; it
    ///      is never conjured, and it never appears in NAV before it is paid.
    function _accrueSenior() private {
        uint256 apy = parameters.get(ParameterKeys.SENIOR_TARGET_APY_BPS);
        if (apy == 0) return;
        uint256 elapsed = block.timestamp - epochStartedAt;
        if (elapsed == 0) return;
        seniorAccrued += (_trancheAssets[Tranche.Senior] * apy * elapsed) / (YEAR * PlanParams.BPS);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Income and loss
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Reserve to target, then senior's accrued target, then junior takes the
    ///      residual. This is the income waterfall and it mirrors the loss waterfall:
    ///      senior is paid first and struck last, junior is paid last and struck first.
    ///      Splitting income pro rata — which is what Phase 3's flat book did — would
    ///      have made junior a leveraged claim on losses and an unleveraged claim on
    ///      gains, which is not a tranche, it is a worse version of the same tranche.
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

        if (senior > 0 && seniorAccrued > 0) {
            uint256 toSenior = amount > seniorAccrued ? seniorAccrued : amount;
            _trancheAssets[Tranche.Senior] = senior + toSenior;
            seniorAccrued -= toSenior;
            amount -= toSenior;
            if (amount == 0) return;
        }

        if (junior > 0) {
            _trancheAssets[Tranche.Junior] = junior + amount;
            return;
        }
        if (senior > 0) {
            _trancheAssets[Tranche.Senior] += amount;
            return;
        }
        _reserve += amount;
    }

    /// @dev POOL-16. Reserve exhausts before junior is touched, junior before senior.
    function _absorbLoss(bytes32 planId, uint256 amount) private {
        (uint256 fromReserve, uint256 fromJunior, uint256 fromSenior) = _strike(amount);
        emit LossAbsorbed(planId, fromReserve, fromJunior, fromSenior);
    }

    /// @dev POOL-14. Straight to the reserve, and what the reserve cannot cover is
    ///      itemised separately rather than quietly joining the credit waterfall — a
    ///      lender whose senior tranche was struck by a fraud needs to be able to see
    ///      that it was a fraud.
    function _absorbFraudLoss(bytes32 planId, uint256 amount) private {
        uint256 fromReserve = amount > _reserve ? _reserve : amount;
        _reserve -= fromReserve;
        uint256 rest = amount - fromReserve;

        if (rest > 0) {
            (, uint256 fromJunior, uint256 fromSenior) = _strike(rest);
            rest = fromJunior + fromSenior;
        }
        emit FraudLossAbsorbed(planId, fromReserve, rest);
    }

    /// @dev The ordered strike, shared by losses and provisions. Whatever the book
    ///      cannot absorb is simply not taken — the balance sheet is already at zero
    ///      and marking it below zero would be a number, not an obligation.
    function _strike(uint256 amount)
        private
        returns (uint256 fromReserve, uint256 fromJunior, uint256 fromSenior)
    {
        fromReserve = amount > _reserve ? _reserve : amount;
        _reserve -= fromReserve;
        amount -= fromReserve;

        uint256 junior = _trancheAssets[Tranche.Junior];
        fromJunior = amount > junior ? junior : amount;
        _trancheAssets[Tranche.Junior] = junior - fromJunior;
        amount -= fromJunior;

        uint256 senior = _trancheAssets[Tranche.Senior];
        fromSenior = amount > senior ? senior : amount;
        _trancheAssets[Tranche.Senior] = senior - fromSenior;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The idle buffer (POOL-13)
    // ─────────────────────────────────────────────────────────────────────────

    function setVenueAllowed(address venue_, bool allowed) external onlyOwner {
        if (allowed && IYieldVenue(venue_).asset() != address(token)) {
            revert VenueAssetMismatch(address(token), IYieldVenue(venue_).asset());
        }
        venueAllowed[venue_] = allowed;
        emit VenueAllowed(venue_, allowed);
    }

    function setVenue(address venue_) external onlyOwner {
        if (venue_ != address(0) && !venueAllowed[venue_]) revert VenueNotAllowed(venue_);
        address previous = address(venue);
        venue = IYieldVenue(venue_);
        emit VenueChanged(previous, venue_);
    }

    /// @notice The cash the book may deploy without breaching the buffer floor.
    function deployableBuffer() public view returns (uint256) {
        uint256 floorAmount =
            (totalAssets() * parameters.get(ParameterKeys.BUFFER_FLOOR_BPS)) / PlanParams.BPS;
        uint256 keep = floorAmount + pendingRedemptionAssets;
        return bookedCash > keep ? bookedCash - keep : 0;
    }

    /// @notice Move idle cash into the savings venue. Allowance-based, per POOL-13.
    function deployBuffer(uint256 amount) external onlyTreasurer {
        if (address(venue) == address(0)) revert NoVenue();
        uint256 room = deployableBuffer();
        if (amount > room) amount = room;
        if (amount == 0) return;

        bookedCash -= amount;
        deployedAssets += amount;

        token.forceApprove(address(venue), amount);
        venue.deposit(amount);

        emit BufferDeployed(address(venue), amount);
    }

    function recallBuffer(uint256 amount) public onlyTreasurer {
        if (address(venue) == address(0)) revert NoVenue();
        uint256 got = venue.withdraw(amount);
        if (got == 0) return;

        deployedAssets -= got > deployedAssets ? deployedAssets : got;
        bookedCash += got;

        emit BufferRecalled(address(venue), got);
    }

    /// @dev The venue is booked at what it would return, never at what it was paid.
    ///      A gain is income and goes down the income waterfall; a shortfall is a loss
    ///      and goes down the loss waterfall. Either way the identity holds.
    function _syncVenue() private {
        if (address(venue) == address(0)) return;
        uint256 value = venue.redeemableValue(address(this));
        if (value == deployedAssets) return;

        if (value > deployedAssets) {
            uint256 gain = value - deployedAssets;
            deployedAssets = value;
            _distribute(gain);
            // forge-lint: disable-next-line(unsafe-typecast)
            emit VenueSynced(int256(gain), value);
        } else {
            uint256 shortfall = deployedAssets - value;
            deployedAssets = value;
            _absorbLoss(bytes32(0), shortfall);
            // forge-lint: disable-next-line(unsafe-typecast)
            emit VenueSynced(-int256(shortfall), value);
        }
    }

    function syncVenue() external {
        _syncVenue();
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

    function openPlanAt(uint256 i) external view returns (bytes32) {
        return _openPlanList[i];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Administration
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyOriginator() {
        if (msg.sender != originator) revert NotOriginator(msg.sender);
        _;
    }

    modifier onlyTreasurer() {
        if (msg.sender != treasurer) revert NotTreasurer(msg.sender);
        _;
    }

    /// @notice Name the router that may front against this book.
    function setOriginator(address originator_) external onlyOwner {
        originator = originator_;
        emit OriginatorSet(originator_);
    }

    function setTreasurer(address treasurer_) external onlyOwner {
        treasurer = treasurer_;
        emit TreasurerSet(treasurer_);
    }

    function setEligibility(address eligibility_) external onlyOwner {
        if (eligibility_ == address(0)) revert EligibilityZero();
        address previous = address(eligibility);
        eligibility = ITransferEligibility(eligibility_);
        emit EligibilityRegistryChanged(previous, eligibility_);
    }

    function _shareToken(Tranche tranche) private view returns (TrancheToken) {
        return tranche == Tranche.Senior ? seniorShares : juniorShares;
    }

    function _emitGate() private {
        emit OriginationGated(originationOpen(), subordinationBps(), reserveBps());
    }
}
