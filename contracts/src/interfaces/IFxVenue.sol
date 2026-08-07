// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title IFxVenue
/// @notice The onchain execution seam. Where a currency crossing actually happens.
///
/// @dev `IFXRouter` is the *accounting* seam — it says what an amount in one currency
///      counts as in the pool's. This is the *execution* seam: it moves the money. The
///      two are deliberately separate, because normalization must stay a `view` the
///      waterfall can call and a settlement cannot.
///
///      An identity adapter that is actually invoked is a seam; an interface with no
///      call site is a promise. `FxDeviationGuard` is this interface's call site and
///      it exists in the same commit, so the seam is real on the day it lands even
///      though the venue behind it is not.
///
///      Three rules a later implementation could break in silence, so each is written
///      down rather than assumed:
///
///      **`settle` takes and gives in one transaction.** It pulls `amountIn` from
///      `msg.sender` with `safeTransferFrom` and sends `amountOut` to `recipient`
///      before it returns. A venue that holds value across a transaction boundary —
///      an order book, a queued fill, a settlement that lands next block — is a
///      custody contract, and C3 forbids custody. Such a venue does not belong behind
///      this interface at all; it belongs behind a different one, with its own
///      analysis of who bears the risk while the money is in flight.
///
///      **`quote` is advisory and nothing may treat it as binding.** It exists so a
///      caller can size a request and choose between venues. The guard measures what
///      `settle` returned, never what `quote` promised, and that gap is the entire
///      reason FX-05's guard is onchain rather than in the quoting service: a venue
///      that quotes honestly and fills badly is invisible to anything checking the
///      quote. `FxDeviationGuard` never calls `quote`.
///
///      **A venue that cannot price a pair reverts.** It never returns a plausible
///      number, never falls back to par, never returns zero and lets the caller decide
///      what that meant. `IdentityFXRouter` exists for exactly this reason on the
///      accounting side and the argument is stronger here, because a fabricated FX
///      rate is not a stale display value — it is a wrong price on a real loan that a
///      borrower will repay in four installments.
///
///      **The guard is not a chokepoint on the venue.** A venue is a public contract
///      and anyone may call it directly; doing so moves only the caller's own funds
///      and is not the protocol's risk. What the protocol controls is that its *own*
///      crossings go through `FxDeviationGuard`, which is the only address
///      `CheckoutRouter` is wired to. No reader should assume this interface is
///      permissioned, because nothing here makes it so.
interface IFxVenue {
    /// @notice Whether this venue is willing and able to trade the pair right now.
    /// @dev A question, not an assertion, and it must answer rather than revert —
    ///      including when the venue is unavailable. A caller enumerating venues to
    ///      pick one has to be able to ask without the ask itself failing.
    function supportsPair(address fromToken, address toToken) external view returns (bool);

    /// @notice What the venue believes `amountIn` would fetch. Advisory only.
    /// @dev Reverts when the pair is unsupported or the venue is unavailable. See the
    ///      contract note: nothing in this protocol may treat the return value as
    ///      binding, and the deviation guard does not read it at all.
    function quote(
        address fromToken,
        address toToken,
        uint256 amountIn
    ) external view returns (uint256 amountOut);

    /// @notice Cross the currency now, in one transaction.
    /// @param minOut The least the caller will accept. The venue must revert rather
    ///        than fill below it — and the caller must still check the return value,
    ///        because a venue that would lie about the fill would lie about this too.
    /// @return amountOut What `recipient` actually received.
    function settle(
        address fromToken,
        address toToken,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 amountOut);
}
