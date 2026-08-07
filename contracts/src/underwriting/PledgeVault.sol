// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {InstallmentPlan} from "../InstallmentPlan.sol";
import {IInstallmentPlan} from "../interfaces/IInstallmentPlan.sol";
import {ParameterRegistry} from "../ParameterRegistry.sol";
import {ParameterKeys} from "../libraries/ParameterKeys.sol";
import {PlanParams} from "../libraries/PlanParams.sol";

/// @title PledgeVault
/// @notice UW-06. A Tier-2 limit issued instantly against a pledged dollar asset that
///         keeps earning its native yield for as long as it is locked.
///
/// @dev **The mechanism is not a choice: it is `approve` + `transferFrom`, and it can
///      never be a check strip.** USYC at `0xe9185F0c…` has no EIP-3009 — permit and
///      `DOMAIN_SEPARATOR` only, re-verified live in finding 32 where
///      `transferWithAuthorization` and `receiveWithAuthorization` were both watched to
///      revert. A pledge path that took a signature would compile locally against a mock
///      and revert on chain against the real token, which is the worst available failure
///      mode: green in CI, dead in production. DEC-28 settled the same question for the
///      idle buffer — "the buffer moves by allowance, because USYC is permit-only" — and
///      this contract is the second instance of that fact, not a second opinion about it.
///
///      **"Keeps earning its native yield while locked" is custody plus honest share
///      accounting, not a clever lock.** USYC accrues by price rather than by rebase, so
///      a holder keeps the yield by holding. The vault holds, tracks per-holder shares
///      against `_totalAssets`, and hands the accrual back on release. A binding moves
///      `lockedOf`; it does not move a share, and it does not move the asset. That is why
///      a pledge backing a live plan still accrues — and it is asserted, not assumed.
///
///      The share arithmetic is `ParkedYieldVenue`'s, reused verbatim including
///      `VIRTUAL_SHARES` and the `+1` / `+VIRTUAL_SHARES` inflation guard. Reused rather
///      than re-derived, because a second copy of a first-depositor rounding guard is a
///      second chance to get it subtly wrong, and this one has invariant tests behind it.
///
///      **One new role, and it is not on the collection path.** `BINDER_ROLE` belongs to
///      the `TieredUnderwriter`, the only thing allowed to lock somebody's capital
///      against a plan. `pledge`, `release`, `payYield`, `unbindPlan` and `seize` are all
///      unroled and deliberately so — GOV-08's standard is that with every operator role
///      at the zero address the loop still works, and a Tier-2 default whose collateral
///      only an operator can seize is a Tier-2 default nobody can collect.
contract PledgeVault is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice May lock a pledge against a plan. Held by `TieredUnderwriter`.
    /// @dev The only roled write in this contract. `seize` and `unbindPlan` are
    ///      deliberately not gated: see the contract header.
    bytes32 public constant BINDER_ROLE = keccak256("PLAZO.PLEDGE_BINDER");

    /// @notice The whitelisted dollar asset this vault takes. USYC on Arc.
    IERC20 public immutable asset;

    /// @notice Read at call time, never compiled. DEC-07 in the small.
    ParameterRegistry public immutable parameters;

    uint256 private constant VIRTUAL_SHARES = 1e3;

    /// @notice What a pledge is standing behind.
    /// @dev `amount` is par, in asset units — the principal the limit bought, not a
    ///      share count. A share count would drift against the obligation every time
    ///      yield landed, and the thing that must not move is the size of the promise.
    struct Binding {
        address pledger;
        address plan;
        uint256 amount;
        bool active;
    }

    mapping(address holder => uint256) private _shares;
    uint256 private _totalShares;
    uint256 private _totalAssets;

    mapping(bytes32 planId => Binding) private _bindings;

    /// @notice Par value a pledger may not withdraw, summed over every live binding.
    mapping(address pledger => uint256) public lockedOf;

    event Pledged(address indexed pledger, uint256 amount, uint256 shares);
    event Released(address indexed pledger, uint256 amount, uint256 shares);
    event YieldPaid(address indexed from, uint256 amount, uint256 totalAssets);
    event PledgeBound(bytes32 indexed planId, address indexed pledger, uint256 amount);
    event PledgeUnbound(bytes32 indexed planId, address indexed pledger, uint256 amount);
    event PledgeSeized(bytes32 indexed planId, address indexed pledger, address indexed to, uint256 amount);

    error NothingToPledge();
    error NoPosition(address pledger);
    error PlanAlreadyBound(bytes32 planId);
    error NoBinding(bytes32 planId);
    error InsufficientFreePledge(uint256 requested, uint256 free);
    error PlanNotDefaulted(bytes32 planId, uint8 state);
    error PlanNotTerminal(bytes32 planId, uint8 state);

    constructor(address admin, address asset_, address parameters_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        asset = IERC20(asset_);
        parameters = ParameterRegistry(parameters_);
    }

    // ─── Custody ─────────────────────────────────────────────────────────────

    /// @notice Pledge `amount` of the asset and take a position in the vault.
    ///
    /// @dev **There is no permit path and no EIP-3009 path here, and adding one would be
    ///      a defect rather than a convenience.** Finding 32 measured USYC's surface on
    ///      Arc: no `receiveWithAuthorization`, no `transferWithAuthorization`. The
    ///      pledger calls `approve` on the token and then this. That is the whole
    ///      ceremony, and it is one more click than a check strip precisely because the
    ///      asset cannot be pulled by signature.
    function pledge(uint256 amount) external nonReentrant returns (uint256 shares) {
        if (amount == 0) revert NothingToPledge();
        asset.safeTransferFrom(msg.sender, address(this), amount);

        shares = (amount * (_totalShares + VIRTUAL_SHARES)) / (_totalAssets + 1);
        _shares[msg.sender] += shares;
        _totalShares += shares;
        _totalAssets += amount;

        emit Pledged(msg.sender, amount, shares);
    }

    /// @notice Withdraw up to `amount`, bounded by what is not locked.
    ///
    /// @dev **Bounded by `freeOf`, never by `pledgedValueOf`, and that single word is the
    ///      whole release control.** A pledge is per-wallet capital and a limit is
    ///      per-person credit; without this bound a pledger could back a plan, watch it
    ///      originate, and withdraw the collateral before the first due date — an
    ///      unsecured loan wearing a secured loan's paperwork.
    ///
    ///      A request above the free balance takes the free balance rather than
    ///      reverting, which is `ParkedYieldVenue.withdraw`'s shape. The emitted amount is
    ///      what actually moved, so a caller who asked for more learns it from the event
    ///      and the return value rather than from a failed transaction.
    function release(uint256 amount) external nonReentrant returns (uint256 taken) {
        uint256 held = pledgedValueOf(msg.sender);
        if (held == 0) revert NoPosition(msg.sender);

        uint256 free = freeOf(msg.sender);
        taken = amount > free ? free : amount;

        uint256 liquid = asset.balanceOf(address(this));
        if (taken > liquid) taken = liquid;
        if (taken == 0) return 0;

        uint256 shares = _burnFor(msg.sender, taken);
        asset.safeTransfer(msg.sender, taken);
        emit Released(msg.sender, taken, shares);
    }

    /// @notice Pay yield to every pledger, pro rata. Permissionless.
    ///
    /// @dev Unroled on purpose. A yield payment can only ever increase what holders may
    ///      withdraw, so a `FUNDER_ROLE` here would buy nothing and would cost a live
    ///      operator role on the accrual path — which is the one path GOV-08 says must
    ///      still work when every operator is gone. `ParkedYieldVenue` gates its
    ///      equivalent because the pool books that venue's position as its liquidity
    ///      buffer; nothing books this one.
    function payYield(uint256 amount) external {
        asset.safeTransferFrom(msg.sender, address(this), amount);
        _totalAssets += amount;
        emit YieldPaid(msg.sender, amount, _totalAssets);
    }

    // ─── Valuation: par minus a governed haircut, and nothing else ───────────

    /// @notice What a pledger's shares are worth at par, accrual included.
    function pledgedValueOf(address pledger) public view returns (uint256) {
        uint256 shares = _shares[pledger];
        if (shares == 0) return 0;
        return (shares * (_totalAssets + 1)) / (_totalShares + VIRTUAL_SHARES);
    }

    /// @notice The Tier-2 limit this pledge supports.
    ///
    /// @dev **Par minus a governed haircut, and never a mark.** USYC's Teller exposes an
    ///      `oracle()` at `0x52b56c76…` whose `latestRoundData()` answers on Arc today
    ///      (finding 32). Reading it to size a limit would be a price-feed dependency,
    ///      which CLAUDE.md forbids flatly on an all-dollar balance sheet, and
    ///      `tools/check-no-oracle.mjs` carries both that address and the selector so the
    ///      prohibition is a build failure rather than a promise (C1).
    ///
    ///      `TIER2_PLEDGE_HAIRCUT_BPS` absorbs NAV uncertainty *and* seizure slippage in
    ///      one governed number, recalibrated inside its compiled band like every other
    ///      Appendix A hypothesis. The observable difference between a haircut and a mark
    ///      is that this figure does not move when nothing but time passes.
    ///
    ///      This is gross capacity. It is deliberately not netted against `lockedOf`:
    ///      `bindPlan` is the enforcement and it refuses anything above `freeOf`, so a
    ///      second plan drawn against an already-committed pledge fails at the lock
    ///      rather than at the quote. `TieredUnderwriter` composes the two.
    function limitFor(address pledger) public view returns (uint256) {
        uint256 haircut = parameters.get(ParameterKeys.TIER2_PLEDGE_HAIRCUT_BPS);
        return (pledgedValueOf(pledger) * (PlanParams.BPS - haircut)) / PlanParams.BPS;
    }

    /// @notice Par value above every live binding — the only thing `release` may take.
    function freeOf(address pledger) public view returns (uint256) {
        uint256 value = pledgedValueOf(pledger);
        uint256 locked = lockedOf[pledger];
        return value > locked ? value - locked : 0;
    }

    function bindingOf(bytes32 planId) external view returns (Binding memory) {
        return _bindings[planId];
    }

    function totalAssets() external view returns (uint256) {
        return _totalAssets;
    }

    // ─── Binding: the lock that stops a pledge leaving while its credit is live ──

    /// @notice Lock `amount` of `pledger`'s free balance behind `plan`.
    /// @dev The one roled write. Refuses to lock what is already locked, and refuses to
    ///      bind a `planId` twice — a second binding on one id would make `unbindPlan`
    ///      and `seize` disagree about which obligation they were closing.
    function bindPlan(
        bytes32 planId,
        address plan,
        address pledger,
        uint256 amount
    ) external onlyRole(BINDER_ROLE) {
        if (_bindings[planId].active) revert PlanAlreadyBound(planId);

        uint256 free = freeOf(pledger);
        if (amount > free) revert InsufficientFreePledge(amount, free);

        _bindings[planId] = Binding({pledger: pledger, plan: plan, amount: amount, active: true});
        lockedOf[pledger] += amount;

        emit PledgeBound(planId, pledger, amount);
    }

    /// @notice Free a pledge once the plan it backed has terminated without defaulting.
    ///
    /// @dev **No modifier.** A pledger whose plan is repaid must be able to free their own
    ///      collateral without an operator being alive to authorise it; the alternative is
    ///      capital stranded by an absence. What makes that safe is that the condition is
    ///      read off the plan rather than supplied by the caller: only `Repaid`,
    ///      `Cancelled`, `Refunded` and `SettledWithFeeOutstanding` release the lock.
    ///      `SettledWithFeeOutstanding` is included because principal is cleared there —
    ///      the state exists so payoff is never blocked on a fee dispute, and holding
    ///      collateral against an outstanding fee would re-block it.
    function unbindPlan(bytes32 planId) external {
        Binding memory binding = _bindings[planId];
        if (!binding.active) revert NoBinding(planId);

        IInstallmentPlan.PlanState state = IInstallmentPlan(binding.plan).state();
        bool terminal = state == IInstallmentPlan.PlanState.Repaid
            || state == IInstallmentPlan.PlanState.Cancelled || state == IInstallmentPlan.PlanState.Refunded
            || state == IInstallmentPlan.PlanState.SettledWithFeeOutstanding;
        if (!terminal) revert PlanNotTerminal(planId, uint8(state));

        lockedOf[binding.pledger] -= binding.amount;
        delete _bindings[planId];

        emit PledgeUnbound(planId, binding.pledger, binding.amount);
    }

    /// @notice Take a defaulted plan's collateral and forward it to the plan's own
    ///         settlement recipient. Callable by anyone.
    ///
    /// @dev **No modifier, and the destination is not the caller's to choose.**
    ///      `InstallmentPlan.settlementRecipient` is a public state variable set at
    ///      `initialize` from `params.detail.settlementRecipient` — the borrower's own
    ///      signed terms — so it is unforgeable by whoever happens to send this
    ///      transaction. That is what makes permissionlessness safe here, and it is the
    ///      same "forward along the disclosed waterfall" property CURE-09 already
    ///      guarantees on the collection path.
    ///
    ///      The gate is `Defaulted`, which is charge-off at sixty days past due, and not
    ///      `Delinquent`. Seizing at delinquency would take collateral from a borrower who
    ///      still has a cure path, which is precisely what CURE-08/09 exist to protect.
    ///
    ///      **What this does not do: it does not convert.** The seized asset is USYC and
    ///      the book's accounting token is not. `TranchedCreditPool.fundReserve` takes the
    ///      pool's own `token` and would refuse this transfer, so routing USYC through it
    ///      would be a fabricated recovery path — a loss reported as recovered. What
    ///      `seize` guarantees is narrower and true: the collateral leaves the pledger's
    ///      claim and arrives at the address the borrower's signed terms named, with no
    ///      operator, no role and no caller-supplied destination. Converting it is a
    ///      separate, access-gated step through the USYC Teller, whose Entitlements
    ///      contract at `0xcc205224…` is a strong signal that mint and redeem are
    ///      permissioned (A5). A stated limit is worth more than a claimed leg.
    function seize(bytes32 planId) external nonReentrant {
        Binding memory binding = _bindings[planId];
        if (!binding.active) revert NoBinding(planId);

        IInstallmentPlan.PlanState state = IInstallmentPlan(binding.plan).state();
        if (state != IInstallmentPlan.PlanState.Defaulted) revert PlanNotDefaulted(planId, uint8(state));

        address to = InstallmentPlan(binding.plan).settlementRecipient();

        uint256 take = binding.amount;
        uint256 held = pledgedValueOf(binding.pledger);
        if (take > held) take = held;
        uint256 liquid = asset.balanceOf(address(this));
        if (take > liquid) take = liquid;

        lockedOf[binding.pledger] -= binding.amount;
        delete _bindings[planId];

        if (take > 0) {
            _burnFor(binding.pledger, take);
            asset.safeTransfer(to, take);
        }

        emit PledgeSeized(planId, binding.pledger, to, take);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    /// @dev `ParkedYieldVenue.withdraw`'s share burn, lifted whole. The `+1` and the
    ///      `+VIRTUAL_SHARES` are the first-depositor inflation guard and the clamp to
    ///      `owned` is what stops a rounding step burning shares a holder does not have.
    function _burnFor(address holder, uint256 take) private returns (uint256 shares) {
        shares = (take * (_totalShares + VIRTUAL_SHARES)) / (_totalAssets + 1);
        uint256 owned = _shares[holder];
        if (shares > owned) shares = owned;

        _shares[holder] = owned - shares;
        _totalShares -= shares;
        _totalAssets -= take;
    }
}
