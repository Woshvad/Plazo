// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IFxVenue} from "../interfaces/IFxVenue.sol";

/// @notice The canonical constant-product router surface, and nothing more.
/// @dev Declared here rather than in `interfaces/` on purpose: this is a foreign
///      ABI this adapter happens to speak, not a seam of Plazo's. Promoting it would
///      imply the protocol has decided something about AMMs that it has not.
interface IConstantProductRouter {
    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @title AmmVenue
/// @notice The AMM fallback FX-05 names — pointed at a router that does not exist yet.
///
/// @dev **The shipped configuration is `router == address(0)`, and that is a
///      measurement rather than a placeholder.** Plan 07-01 probed seven candidate
///      routers on Arc testnet — the canonical constant-product and stableswap
///      deployments a standard fork reuses — and recorded finding 34: **zero of them
///      hold bytecode**. No DEX appears in Arc's official contract-address reference
///      either, and the three names research surfaced publish no Arc-testnet address
///      at all. So there is nothing to point this adapter at, and the deployment sets
///      the constructor argument to zero.
///
///      That makes the zero-router branch the *tested, shipped* behaviour rather than
///      a failure path, and `test_ammVenueWithZeroRouterRefuses` is the assertion.
///      **The consequence has to be said plainly: FX-05's guard ships unexercised
///      against real liquidity.** It is proven against a test double that fills
///      badly on demand, which is the strongest evidence obtainable on a chain with
///      no venue — and it is a weaker claim than "the guard has refused a real bad
///      fill". The alternative was to invent a liquidity assumption, name a candidate
///      address as though it were the answer, and ship a guard whose correctness
///      rested on a fiction. An unexercised guard on a stub venue is still the
///      audited artefact the requirement asks for; a guard built against a fabricated
///      venue is not.
///
///      **No address literal appears in this file (E-04).** The router and both tokens
///      are constructor arguments. A candidate address written into the tree would
///      read as a decision the chain does not support, and the same argument that
///      forbids compiling an FxEscrow `verifyingContract` forbids compiling this.
///
///      **The non-zero path speaks the ABI 07-01's probe assumed**, `getAmountsOut`
///      and `swapExactTokensForTokens`, so that if a venue with real USDC/EURC
///      liquidity does appear, wiring it is a deployment argument. Nothing on Arc
///      implements that ABI today. When something does, the fill it produces must be
///      re-measured before this path is trusted — an adapter that compiles is not an
///      adapter that has traded.
contract AmmVenue is IFxVenue {
    using SafeERC20 for IERC20;

    /// @notice The external router. Zero until a venue with real liquidity exists.
    address public immutable router;

    address public immutable tokenA;
    address public immutable tokenB;

    /// @notice This venue cannot act — no router, or not this pair.
    /// @dev One error for both, because `supportsPair` already distinguishes them
    ///      without reverting and a caller that skipped the question is being told the
    ///      same operationally useful thing either way: do not route here.
    error VenueUnavailable();

    constructor(address router_, address tokenA_, address tokenB_) {
        router = router_;
        tokenA = tokenA_;
        tokenB = tokenB_;
    }

    /// @inheritdoc IFxVenue
    function supportsPair(address fromToken, address toToken) public view returns (bool) {
        if (router == address(0)) return false;
        return _isPair(fromToken, toToken);
    }

    /// @inheritdoc IFxVenue
    function quote(
        address fromToken,
        address toToken,
        uint256 amountIn
    ) external view returns (uint256 amountOut) {
        if (!supportsPair(fromToken, toToken)) revert VenueUnavailable();

        uint256[] memory amounts =
            IConstantProductRouter(router).getAmountsOut(amountIn, _path(fromToken, toToken));
        return amounts[amounts.length - 1];
    }

    /// @inheritdoc IFxVenue
    /// @dev The return value is the recipient's measured balance delta, not the
    ///      router's reported one. This adapter applies to its own venue the rule
    ///      `FxDeviationGuard` applies to this adapter: what was received is a fact
    ///      about a balance, and what was reported is a claim.
    function settle(
        address fromToken,
        address toToken,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 amountOut) {
        if (!supportsPair(fromToken, toToken)) revert VenueUnavailable();

        IERC20(fromToken).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(fromToken).forceApprove(router, amountIn);

        uint256 before = IERC20(toToken).balanceOf(recipient);
        IConstantProductRouter(router)
            .swapExactTokensForTokens(amountIn, minOut, _path(fromToken, toToken), recipient, block.timestamp);
        amountOut = IERC20(toToken).balanceOf(recipient) - before;

        IERC20(fromToken).forceApprove(router, 0);
    }

    function _isPair(address fromToken, address toToken) private view returns (bool) {
        if (fromToken == tokenA && toToken == tokenB) return true;
        return fromToken == tokenB && toToken == tokenA;
    }

    function _path(address fromToken, address toToken) private pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = fromToken;
        path[1] = toToken;
    }
}
