// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IYieldVenue} from "./interfaces/IYieldVenue.sol";

/// @title ParkedYieldVenue
/// @notice A savings venue that holds the asset and accrues whatever it is paid.
///
/// @dev The concrete `IYieldVenue` for Arc today, and the shape a USYC adapter takes
///      when the Teller integration lands. It is deliberately not a yield *source*: it
///      holds deposits, tracks per-holder shares, and grows every holder's redeemable
///      value when a funder pays yield into it.
///
///      That is honest about what exists. USYC is deployed on Arc and its Teller is at
///      `0x9fdF14c5…`, but minting and redeeming through it is a Phase 7 integration
///      gated on the same access track as StableFX. Shipping a contract that claimed to
///      earn treasury yield while doing nothing would be worse than shipping one that
///      says what it is.
///
///      What is real here is the *mechanism* POOL-13 asks for: allowance-based
///      transfers, a whitelisted venue, a position the pool books at redeemable value
///      rather than at cost, and a `maxWithdraw` the pool respects. Swapping the
///      implementation changes a constructor argument.
contract ParkedYieldVenue is IYieldVenue, AccessControl {
    using SafeERC20 for IERC20;

    /// @notice May pay yield into the venue.
    bytes32 public constant FUNDER_ROLE = keccak256("PLAZO.VENUE_FUNDER");

    IERC20 public immutable token;

    uint256 private constant VIRTUAL_SHARES = 1e3;

    mapping(address holder => uint256) private _shares;
    uint256 private _totalShares;
    uint256 private _totalAssets;

    event Deposited(address indexed holder, uint256 assets, uint256 shares);
    event Withdrawn(address indexed holder, uint256 assets, uint256 shares);
    event YieldPaid(address indexed from, uint256 amount, uint256 totalAssets);

    error NothingToDeposit();
    error NoPosition(address holder);

    constructor(address admin, address token_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FUNDER_ROLE, admin);
        token = IERC20(token_);
    }

    function asset() external view returns (address) {
        return address(token);
    }

    function deposit(uint256 amount) external returns (uint256) {
        if (amount == 0) revert NothingToDeposit();
        token.safeTransferFrom(msg.sender, address(this), amount);

        uint256 shares = (amount * (_totalShares + VIRTUAL_SHARES)) / (_totalAssets + 1);
        _shares[msg.sender] += shares;
        _totalShares += shares;
        _totalAssets += amount;

        emit Deposited(msg.sender, amount, shares);
        return amount;
    }

    function withdraw(uint256 amount) external returns (uint256) {
        uint256 held = redeemableValue(msg.sender);
        if (held == 0) revert NoPosition(msg.sender);

        uint256 take = amount > held ? held : amount;
        uint256 available = maxWithdraw(msg.sender);
        if (take > available) take = available;
        if (take == 0) return 0;

        uint256 shares = (take * (_totalShares + VIRTUAL_SHARES)) / (_totalAssets + 1);
        uint256 owned = _shares[msg.sender];
        if (shares > owned) shares = owned;

        _shares[msg.sender] = owned - shares;
        _totalShares -= shares;
        _totalAssets -= take;

        token.safeTransfer(msg.sender, take);
        emit Withdrawn(msg.sender, take, shares);
        return take;
    }

    function redeemableValue(address holder) public view returns (uint256) {
        uint256 shares = _shares[holder];
        if (shares == 0) return 0;
        return (shares * (_totalAssets + 1)) / (_totalShares + VIRTUAL_SHARES);
    }

    /// @dev Bounded by what the venue actually holds. A venue that promised more than
    ///      its balance would make the pool's buffer gauge a fiction.
    function maxWithdraw(address holder) public view returns (uint256) {
        uint256 value = redeemableValue(holder);
        uint256 liquid = token.balanceOf(address(this));
        return value > liquid ? liquid : value;
    }

    /// @notice Pay yield to every holder, pro rata.
    function payYield(uint256 amount) external onlyRole(FUNDER_ROLE) {
        token.safeTransferFrom(msg.sender, address(this), amount);
        _totalAssets += amount;
        emit YieldPaid(msg.sender, amount, _totalAssets);
    }

    function totalAssets() external view returns (uint256) {
        return _totalAssets;
    }
}
