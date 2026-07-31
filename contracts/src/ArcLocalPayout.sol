// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ICrossChainPayout} from "./interfaces/ICrossChainPayout.sol";

/// @title ArcLocalPayout
/// @notice Settlement that stays on Arc. The identity case of `ICrossChainPayout`.
///
/// @dev The Phase 3 implementation of the payout seam. It pulls the funds from the
///      caller and transfers them, and it refuses any destination that is not Arc.
///
///      The refusal is the whole value of shipping this now. Phase 6 supplies CCTP v2
///      and Gateway; until then, a merchant configured for Base has to fail at
///      checkout with a legible error rather than be paid at their Arc address
///      because nobody checked. Silent domain coercion is how a settlement lands in a
///      wallet the merchant does not control.
///
///      Arc is CCTP domain 26. That number is the protocol's own identifier for this
///      chain, so it is what the seam speaks — not `block.chainid`, which CCTP does
///      not use and which would have to be translated at the Phase 6 boundary.
contract ArcLocalPayout is ICrossChainPayout {
    using SafeERC20 for IERC20;

    /// @notice Arc's CCTP domain.
    uint32 public constant ARC_DOMAIN = 26;

    event PaidOut(address indexed token, address indexed recipient, uint32 domain, uint256 amount);

    error UnsupportedDomain(uint32 domain);
    error RecipientZero();

    /// @inheritdoc ICrossChainPayout
    function localDomain() external pure returns (uint32) {
        return ARC_DOMAIN;
    }

    /// @inheritdoc ICrossChainPayout
    function supportsDomain(uint32 domain) public pure returns (bool) {
        return domain == ARC_DOMAIN;
    }

    /// @inheritdoc ICrossChainPayout
    /// @dev Pull, not push: the caller approves and this contract takes. That keeps
    ///      the funds in the caller's control until the domain check has passed,
    ///      rather than requiring a rescue path for value pushed to a payout
    ///      contract that then refused to send it.
    function payout(address token, uint32 domain, address recipient, uint256 amount) external {
        if (!supportsDomain(domain)) revert UnsupportedDomain(domain);
        if (recipient == address(0)) revert RecipientZero();
        if (amount == 0) return;

        IERC20(token).safeTransferFrom(msg.sender, recipient, amount);
        emit PaidOut(token, recipient, domain, amount);
    }
}
