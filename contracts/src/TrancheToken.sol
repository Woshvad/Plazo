// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ITransferEligibility} from "./interfaces/ITransferEligibility.sol";

// Extra precision share units carry over the underlying asset. File-level so the
// pool's share maths and the token's `decimals()` are the same number by
// construction — two constants that must agree are one constant.
uint8 constant TRANCHE_DECIMALS_OFFSET = 3;

/// @title TrancheToken
/// @notice A senior or junior claim on a credit pool, as a transfer-restricted ERC-20.
///
/// @dev POOL-02 and DEC-01. A plain ERC-20 rather than an ERC-4626 share, because the
///      vault above it is asynchronous: shares are struck at *next-epoch* NAV, and
///      ERC-4626's `deposit` promises a synchronous conversion this pool cannot make.
///      The token is a claim; the pool is the accountant. Keeping them separate is
///      what lets the pool answer "how many shares will this become" with "ask me
///      after the epoch closes" instead of lying.
///
///      **Default deny on every movement, including the mint.** Reg D restricts who
///      may hold these; a restriction the primary distribution can bypass is a
///      restriction on the secondary market only, and the primary distribution is
///      exactly where an ineligible holder gets created.
///
///      **Decimals carry the offset (POOL-12).** Shares are `assetDecimals + 3`, so a
///      first depositor's dollar becomes a thousand share-units. Combined with the
///      pool's internal accounting — which never reads `balanceOf` — and the permanent
///      seed the pool mints itself, the three legs of the inflation defence are
///      independent: the offset makes the rounding attack unprofitable, the seed makes
///      the empty-vault case unreachable, and the booked accounting makes a donation
///      move nothing at all. Any one of them alone has a known bypass.
///
///      **The lockup is stamped on the share, not on the holder (DEC-29).** POOL-10
///      locks junior for a full product tenor. Measured per holder that is defeated by
///      transferring to a fresh address, which has no history and therefore no clock.
///      Measured per receipt — every inbound movement pushes the recipient's unlock
///      time forward, never back — a transfer can only ever make the lock later.
contract TrancheToken is ERC20 {
    /// @notice Extra precision over the underlying asset. POOL-12's decimals offset.
    uint8 public constant DECIMALS_OFFSET = TRANCHE_DECIMALS_OFFSET;

    /// @notice The pool that mints, burns and holds escrowed redemptions.
    /// @dev Immutable and singular. A tranche token with two accountants has two
    ///      opinions about what a share is worth.
    address public immutable pool;

    ITransferEligibility public immutable eligibility;

    uint8 private immutable _decimals;

    /// @notice How long a receipt locks the recipient. Zero for senior.
    uint256 public immutable lockPeriod;

    /// @notice Earliest time a holder may move shares out.
    mapping(address holder => uint256) public unlockAt;

    event LockExtended(address indexed holder, uint256 unlockAt);

    error OnlyPool(address caller);
    error TransferNotPermitted(address from, address to);
    error SharesLocked(address holder, uint256 unlockAt);
    error PoolZero();
    error EligibilityZero();

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 assetDecimals,
        address pool_,
        address eligibility_,
        uint256 lockPeriod_
    ) ERC20(name_, symbol_) {
        if (pool_ == address(0)) revert PoolZero();
        if (eligibility_ == address(0)) revert EligibilityZero();
        pool = pool_;
        eligibility = ITransferEligibility(eligibility_);
        _decimals = assetDecimals + DECIMALS_OFFSET;
        lockPeriod = lockPeriod_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool(msg.sender);
        _;
    }

    function mint(address to, uint256 shares) external onlyPool {
        _mint(to, shares);
    }

    function burn(address from, uint256 shares) external onlyPool {
        _burn(from, shares);
    }

    /// @dev One override for mint, transfer and burn, for the reason `ReceivableToken`
    ///      gives: a check `transferFrom` performs and `_mint` does not is a check the
    ///      primary distribution walks straight past.
    ///
    ///      The pool is exempt in both directions. It has to be: a redemption request
    ///      escrows shares here and the fill burns them, and a vault that could not
    ///      receive its own shares back could not have a queue at all.
    function _update(address from, address to, uint256 value) internal override {
        bool poolLeg = from == pool || to == pool;

        if (!poolLeg && from != address(0) && to != address(0)) {
            if (!eligibility.isTransferPermitted(address(this), from, to)) {
                revert TransferNotPermitted(from, to);
            }
        }

        // A mint still has to name an eligible recipient. The pool is the one address
        // allowed to hold shares without being screened, because it holds them on
        // behalf of a redeemer who already was.
        if (from == address(0) && to != pool) {
            if (!eligibility.isEligible(address(this), to)) revert TransferNotPermitted(from, to);
        }

        // Moving out — a transfer or a redemption request. Burns are exempt because a
        // burn is the pool retiring a share it already holds, and a lock that survived
        // into the burn would strand the queue.
        if (from != address(0) && to != address(0) && from != pool) {
            uint256 until = unlockAt[from];
            if (block.timestamp < until) revert SharesLocked(from, until);
        }

        super._update(from, to, value);

        if (lockPeriod > 0 && to != address(0) && to != pool) {
            uint256 stamped = block.timestamp + lockPeriod;
            if (stamped > unlockAt[to]) {
                unlockAt[to] = stamped;
                emit LockExtended(to, stamped);
            }
        }
    }
}
