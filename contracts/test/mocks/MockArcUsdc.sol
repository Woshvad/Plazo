// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title MockArcUsdc
/// @notice A faithful local stand-in for Arc USDC.
///
/// @dev This mock is on the critical path, and that is a finding rather than a
///      convenience. Arc USDC's token movement runs through a native precompile at
///      `0x1800…` whose onchain code is a single byte; Foundry cannot execute it, so
///      **no fork test can complete a transfer**. Every invariant, every waterfall
///      assertion and every keeper-market property is therefore checked against
///      this contract. If it lies, the whole local suite lies with it — which is why
///      the deviations from the real token below are enumerated rather than left to
///      be discovered.
///
///      Reproduced faithfully:
///
///      - **Balances are 18-decimal natively and 6-decimal over ERC-20, on one
///        balance.** `balanceOf` returns the native figure over 10¹². This is why
///        `deal(token, …)` finds no slot on a fork, and it is why gas and the loan
///        are literally the same money: a borrower holding exactly one installment
///        cannot pay for their own cure.
///      - The three EIP-3009 typehashes, byte-identical to the canonical FiatToken
///        values read live from chain 5042002.
///      - A domain separator built from `("USDC", "2", chainId, address(this))` —
///        note `"USDC"`, not `"USD Coin"` — and derived rather than stored, exactly
///        as the real token does it.
///      - `receiveWithAuthorization` enforcing `to == msg.sender`, which is what
///        makes a signed check un-griefable.
///      - The strict comparisons: `now > validAfter` and `now < validBefore`. Not
///        `>=` and `<=`. An off-by-one here would make the plan's expiry handling
///        look correct locally and bounce with the wrong reason on Arc.
///      - Revert strings matching the live token's, because the plan's `catch`
///        arm is the last line of defence and it should be exercised against the
///        strings it will actually see.
///      - ERC-1271 contract signers, single-use nonces, cancellation, blocklist and
///        pause.
///
///      Deliberately not reproduced: the native-transfer precompile dispatch, the
///      Circle proxy, the minter/controller hierarchy, and any of the fee or rescue
///      machinery. None of them are reachable from the protocol's call graph.
contract MockArcUsdc is IERC20 {
    string public constant name = "USDC";
    string public constant symbol = "USDC";
    string public constant version = "2";
    uint8 public constant decimals = 6;

    /// @notice Arc holds balances at 18 decimals and shows them at 6.
    uint256 internal constant NATIVE_SCALE = 1e12;

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @notice Native-precision balances. `balanceOf` is this over 10¹².
    mapping(address account => uint256) public nativeBalanceOf;
    mapping(address owner => mapping(address spender => uint256)) private _allowance;
    mapping(address authorizer => mapping(bytes32 nonce => bool)) private _authorizationStates;
    mapping(address account => bool) public isBlacklisted;

    uint256 private _totalSupplyNative;
    bool public paused;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    event Blacklisted(address indexed account);
    event UnBlacklisted(address indexed account);
    event Pause();
    event Unpause();

    // ─── Test controls ───────────────────────────────────────────────────────

    function mint(address to, uint256 amount) external {
        _totalSupplyNative += amount * NATIVE_SCALE;
        nativeBalanceOf[to] += amount * NATIVE_SCALE;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Drain an account, as a borrower spending their balance elsewhere does.
    function burnAll(address from) external {
        uint256 amount = nativeBalanceOf[from];
        nativeBalanceOf[from] = 0;
        _totalSupplyNative -= amount;
        emit Transfer(from, address(0), amount / NATIVE_SCALE);
    }

    function setPaused(bool value) external {
        paused = value;
        if (value) emit Pause();
        else emit Unpause();
    }

    function setBlacklisted(address account, bool value) external {
        isBlacklisted[account] = value;
        if (value) emit Blacklisted(account);
        else emit UnBlacklisted(account);
    }

    // ─── ERC-20 ──────────────────────────────────────────────────────────────

    function totalSupply() external view returns (uint256) {
        return _totalSupplyNative / NATIVE_SCALE;
    }

    function balanceOf(address account) public view returns (uint256) {
        return nativeBalanceOf[account] / NATIVE_SCALE;
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowance[owner][spender];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = _allowance[from][msg.sender];
        require(allowed >= amount, "ERC20: insufficient allowance");
        if (allowed != type(uint256).max) _allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(!paused, "Pausable: paused");
        require(!isBlacklisted[from], "Blacklistable: account is blacklisted");
        require(!isBlacklisted[to], "Blacklistable: account is blacklisted");

        uint256 native = amount * NATIVE_SCALE;
        require(nativeBalanceOf[from] >= native, "ERC20: transfer amount exceeds balance");
        unchecked {
            nativeBalanceOf[from] -= native;
        }
        nativeBalanceOf[to] += native;
        emit Transfer(from, to, amount);
    }

    // ─── EIP-712 ─────────────────────────────────────────────────────────────

    /// @dev Derived on every call from the four domain fields, exactly as the live
    ///      token does. It embeds `chainId` and `verifyingContract`; a stored value
    ///      would be silently wrong the moment either changed, and every outstanding
    ///      strip would stop validating with no error anyone could read.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }

    // ─── EIP-3009 ────────────────────────────────────────────────────────────

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        _verify(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature
        );
        _markUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @notice The collection primitive.
    /// @dev The payee check is what makes a signed check un-griefable: without it a
    ///      third party could submit someone else's authorization to a payee that is
    ///      not them, burning the single-use nonce and leaving the borrower unable
    ///      to pay the installment at all.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        _verify(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature
        );
        _markUsed(from, nonce);
        _transfer(from, to, value);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) external {
        require(!_authorizationStates[authorizer][nonce], "FiatTokenV2: authorization is used or canceled");
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        require(
            SignatureChecker.isValidSignatureNow(authorizer, digest, signature),
            "FiatTokenV2: invalid signature"
        );

        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _requireValidAuthorization(
        address authorizer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore
    ) internal view {
        // Strict, both ends. Matching the live token exactly matters more here than
        // anywhere else in this file: an off-by-one would make the plan's expiry
        // handling pass locally and bounce with the wrong reason on Arc.
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!_authorizationStates[authorizer][nonce], "FiatTokenV2: authorization is used or canceled");
    }

    function _verify(
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) internal view {
        bytes32 structHash = keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        // Handles both ECDSA and ERC-1271. The Phase 1 fork spike proved the live
        // token completes an ERC-1271 authorization end to end, so a mock that only
        // accepted ECDSA would silently drop the signing path the product depends on.
        require(
            SignatureChecker.isValidSignatureNow(from, digest, signature), "FiatTokenV2: invalid signature"
        );
    }

    function _markUsed(address authorizer, bytes32 nonce) internal {
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationUsed(authorizer, nonce);
    }
}
