// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title IYieldVenue
/// @notice Where the pool's idle buffer earns while it waits.
///
/// @dev POOL-13, and the interface is allowance-based because the venue Plazo
///      actually intends to use makes it so. USYC on Arc — the tokenised
///      treasury-bill fund at `0xe918…b86C` — implements `permit` and has no EIP-3009
///      at all. It cannot be moved by a dated check the way every other value transfer
///      in this protocol is. So the buffer moves by `approve`/`transferFrom`, which is
///      the requirement's own wording and not a workaround.
///
///      **The pool books the position at what it can get back, not at what it paid.**
///      `redeemableValue` is the only figure the accounting reads. A venue that
///      reported cost basis would let a book that had lost money in its savings asset
///      keep quoting par on it, which is the same failure as valuing a delinquent
///      receivable at face.
///
///      **No venue may be a credit position.** The buffer exists so a redemption queue
///      moves; parking it somewhere that can itself gate withdrawals converts a
///      liquidity buffer into a second illiquid book. `maxWithdraw` is how a venue
///      admits that, and the pool never assumes more than it.
interface IYieldVenue {
    /// @notice The asset this venue accepts. Must match the pool's.
    function asset() external view returns (address);

    /// @notice Pull `amount` from the caller and open or increase their position.
    /// @return deposited What was actually taken.
    function deposit(uint256 amount) external returns (uint256 deposited);

    /// @notice Return up to `amount` of the caller's position.
    /// @return withdrawn What was actually returned.
    function withdraw(uint256 amount) external returns (uint256 withdrawn);

    /// @notice What `holder` would receive if they withdrew everything right now.
    function redeemableValue(address holder) external view returns (uint256);

    /// @notice The most `holder` could withdraw in this transaction.
    /// @dev Less than `redeemableValue` when the venue itself is illiquid. The pool
    ///      treats the difference as unavailable rather than as a failed withdrawal.
    function maxWithdraw(address holder) external view returns (uint256);
}
