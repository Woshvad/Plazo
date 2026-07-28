// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title IERC3009
/// @notice The subset of Arc USDC the protocol depends on.
///
/// @dev Every member below was read or exercised against the live token at
///      `0x3600000000000000000000000000000000000000` on chain 5042002. The
///      typehashes are byte-identical to canonical FiatToken values and the domain
///      separator reconstructs exactly from `("USDC", "2", 5042002, 0x3600…)` —
///      note the name is `"USDC"`, not `"USD Coin"`.
///
///      `DOMAIN_SEPARATOR` is read, never hardcoded. It embeds `chainId` and
///      `verifyingContract`; both change on mainnet, and a baked-in value would
///      make every outstanding strip silently fail to validate the day the config
///      flips.
interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    /// @notice The collection primitive.
    /// @dev Enforces `to == msg.sender`, which is what makes a signed check
    ///      un-griefable: a third party cannot burn the nonce by submitting the
    ///      authorization to a payee that is not them. Live reverts with
    ///      `FiatTokenV2: caller must be the payee`.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function CANCEL_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function version() external view returns (string memory);
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function paused() external view returns (bool);
    function isBlacklisted(address account) external view returns (bool);
}
