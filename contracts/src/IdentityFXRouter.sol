// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IFXRouter} from "./interfaces/IFXRouter.sol";

/// @title IdentityFXRouter
/// @notice The no-op adapter behind the currency-normalization seam.
///
/// @dev FX-01 and FX-06. There is exactly one reason this contract exists: the
///      call site. `_settle` normalizes before the waterfall runs, from the first
///      release, so that when Phase 7 supplies the EURC corridor the ordering is
///      already audited and the core does not have to be re-opened to install it.
///
///      An interface with no implementation and no call site is a promise. An
///      identity adapter that is actually invoked on every settlement is a seam.
///
///      It normalizes only the accounting currency and reverts on anything else,
///      rather than passing an unknown token through unchanged. A router that
///      silently treats one EURC as one USDC is worse than no router: it produces
///      a plausible number, and the waterfall has no way to tell that the number
///      is a currency error rather than a payment.
contract IdentityFXRouter is IFXRouter {
    /// @notice The pool's accounting currency. USDC on Arc.
    address public immutable accountingToken;

    error UnsupportedCurrency(address fromToken);
    error AccountingTokenZero();

    constructor(address accountingToken_) {
        if (accountingToken_ == address(0)) revert AccountingTokenZero();
        accountingToken = accountingToken_;
    }

    /// @inheritdoc IFXRouter
    function normalize(address fromToken, uint256 amount) external view returns (uint256) {
        if (fromToken != accountingToken) revert UnsupportedCurrency(fromToken);
        return amount;
    }

    /// @inheritdoc IFXRouter
    function isSupported(address fromToken) external view returns (bool) {
        return fromToken == accountingToken;
    }
}
