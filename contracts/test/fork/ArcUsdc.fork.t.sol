// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {IERC3009} from "../../src/interfaces/IERC3009.sol";

/// @notice Always-valid ERC-1271 signer.
/// @dev The narrowest possible test of the branch: if a contract that accepts every
///      signature cannot get an authorization validated, no smart account can, and
///      one-ceremony signing is off the table.
contract AlwaysValidSigner {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}

/// @notice Rejects everything. Proves the token actually consults the signer rather
///         than short-circuiting on `from.code.length > 0`.
contract AlwaysInvalidSigner {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0xffffffff;
    }
}

/// @notice Stands in for Arc's native-balance precompile.
///
/// @dev Arc USDC has no balance storage. `balanceOf` reads the account's native
///      balance divided by 10^12, and a transfer is dispatched to a precompile at
///      `0x1800…` whose on-chain code is the single byte `0x01` — a marker so that
///      `EXTCODESIZE` is non-zero while the node implements the behaviour internally.
///
///      Foundry's EVM has no such implementation, so it executes `0x01` as ADD and
///      dies with StackUnderflow. Etching this mock in its place lets the rest of the
///      path run for real: real proxy, real implementation, real signature checker,
///      real ERC-1271 callback. What the mock replaces is the balance mutation, which
///      is Arc's node behaviour rather than the protocol's.
contract NativeTransferPrecompileMock {
    struct Call {
        address from;
        address to;
        uint256 value;
    }

    Call[] public calls;

    /// @dev Returns `true`. The token checks the return value, so a mock that
    ///      returned nothing would make every transfer revert — which looks
    ///      identical to the precompile being missing.
    function transfer(address from, address to, uint256 value) external returns (bool) {
        calls.push(Call(from, to, value));
        return true;
    }

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function lastCall() external view returns (Call memory) {
        return calls[calls.length - 1];
    }
}

/// @title Arc USDC fork spike — Phase 1 open questions
///
/// @notice Settles what Phase 1 owns, against real Arc bytecode at a live block.
///
/// @dev Run against a fork rather than a funded testnet account deliberately. The
///      faucet needs a Circle developer account, which is operator-gated, but every
///      question here is about what the deployed token does, not about whether we
///      hold its tokens.
///
///      What a fork CANNOT do is complete a USDC transfer — see the precompile mock
///      above. That is a constraint on the whole test strategy, not a quirk of this
///      file: local Solidity tests get a mock token, and the Phase 2 vertical slice's
///      value-movement assertions have to run against funded testnet accounts. There
///      is no third option.
///
///      Skips rather than fails when no fork is available, so the default
///      `forge test` stays hermetic and CI opts in.
contract ArcUsdcForkTest is Test {
    IERC3009 internal constant USDC = IERC3009(0x3600000000000000000000000000000000000000);

    /// @dev Arc's native-balance transfer precompile. Code is the single byte 0x01.
    address internal constant NATIVE_TRANSFER_PRECOMPILE =
        0x1800000000000000000000000000000000000000;

    bytes32 internal constant RECEIVE_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;

    /// @dev Circle's FiatTokenProxy predates EIP-1967.
    bytes32 internal constant ZEPPELINOS_IMPL_SLOT =
        0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3;

    /// @dev Arc: 20 gwei base fee floor, 21 gwei gas price, USDC 18-decimal natively.
    uint256 internal constant GAS_PRICE_GWEI = 21;

    bool internal forked;
    bytes32 internal domainSeparator;
    NativeTransferPrecompileMock internal precompile;

    address internal payee = makeAddr("payee");

    function setUp() public {
        string memory rpc = vm.envOr("ARC_TESTNET_RPC_URL", string("https://rpc.testnet.arc.io"));
        try vm.createSelectFork(rpc) {
            forked = true;
            domainSeparator = USDC.DOMAIN_SEPARATOR();
        } catch {
            forked = false;
        }
    }

    modifier onlyForked() {
        if (!forked) {
            console.log("SKIP: no Arc fork available");
            return;
        }
        _;
    }

    /// @dev Install the precompile stand-in. Opt-in per test so the tests that
    ///      assert reverts see the real (unexecutable) precompile and cannot pass
    ///      for the wrong reason.
    function _installPrecompileMock() internal {
        precompile = new NativeTransferPrecompileMock();
        vm.etch(NATIVE_TRANSFER_PRECOMPILE, address(precompile).code);
        precompile = NativeTransferPrecompileMock(NATIVE_TRANSFER_PRECOMPILE);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The question the product's UX depends on.
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice ERC-1271: a contract signer's authorization validates and settles.
    ///
    /// @dev Part 0 research proved the branch is *reached* — a call trace showed the
    ///      staticcall to `isValidSignature`. It did not prove an authorization
    ///      completes, because the traced call used a zero signature and was never
    ///      expected to move funds.
    ///
    ///      This closes it. The real `SignatureChecker` at `0xfcFf98B6…` calls the
    ///      contract's `isValidSignature`, accepts the magic value, the token marks
    ///      the nonce used, and dispatches the transfer with the correct parties and
    ///      the correct 6→18 decimal widening.
    ///
    ///      Consequence: one-ceremony signing via a merkle-wrapped ERC-1271 signature
    ///      is mechanically available on Arc. Flex's twelve-check strip does not need
    ///      re-scoping, and the EOA fallback stays a fallback.
    function test_erc1271SignerAuthorizationCompletes() public onlyForked {
        _installPrecompileMock();

        AlwaysValidSigner signer = new AlwaysValidSigner();
        uint256 value = 1_000_000; // 1.00 USDC at ERC-20 scale
        _fund(address(signer), value * 2);

        bytes32 nonce = keccak256("erc1271-spike");

        vm.prank(payee);
        USDC.receiveWithAuthorization(
            address(signer), payee, value, 0, type(uint256).max, nonce, hex"deadbeef"
        );

        assertTrue(USDC.authorizationState(address(signer), nonce), "nonce was not consumed");
        assertEq(precompile.callCount(), 1, "no transfer was dispatched");

        NativeTransferPrecompileMock.Call memory moved = precompile.lastCall();
        assertEq(moved.from, address(signer), "debited the wrong account");
        assertEq(moved.to, payee, "credited the wrong account");
        assertEq(moved.value, value * 1e12, "6 to 18 decimal widening is wrong");

        console.log("ERC-1271 contract signer: authorization VALIDATED and settled");
    }

    /// @notice The token really consults the signer.
    /// @dev Without this, the test above would also pass on a token that skipped
    ///      validation for contract accounts entirely — a far worse finding dressed
    ///      up as a good one.
    function test_erc1271RejectingSignerIsRefused() public onlyForked {
        _installPrecompileMock();

        AlwaysInvalidSigner signer = new AlwaysInvalidSigner();
        _fund(address(signer), 10_000_000);

        vm.prank(payee);
        vm.expectRevert();
        USDC.receiveWithAuthorization(
            address(signer), payee, 1_000_000, 0, type(uint256).max, keccak256("rejected"), hex"deadbeef"
        );

        assertEq(precompile.callCount(), 0, "a rejected signature still dispatched a transfer");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The EOA path — the fallback, and what Pay-in-4 ships on by default.
    // ─────────────────────────────────────────────────────────────────────────

    function test_eoaSignerAuthorizationCompletes() public onlyForked {
        _installPrecompileMock();

        (address borrower, uint256 key) = makeAddrAndKey("borrower");
        uint256 value = 25_000_000;
        _fund(borrower, value * 2);

        bytes32 nonce = keccak256("eoa-spike");
        bytes memory signature = _signReceive(key, borrower, payee, value, 0, type(uint256).max, nonce);

        vm.prank(payee);
        USDC.receiveWithAuthorization(borrower, payee, value, 0, type(uint256).max, nonce, signature);

        assertTrue(USDC.authorizationState(borrower, nonce));
        assertEq(precompile.lastCall().value, value * 1e12);
    }

    /// @notice Payee enforcement — the anti-griefing property.
    /// @dev Without it a third party could submit a borrower's authorization naming
    ///      themselves, burning the nonce and making that installment permanently
    ///      uncollectable.
    function test_onlyPayeeMaySubmit() public onlyForked {
        _installPrecompileMock();

        (address borrower, uint256 key) = makeAddrAndKey("borrower-grief");
        _fund(borrower, 100_000_000);

        bytes32 nonce = keccak256("griefed");
        bytes memory signature =
            _signReceive(key, borrower, payee, 1_000_000, 0, type(uint256).max, nonce);

        vm.prank(makeAddr("griefer"));
        vm.expectRevert();
        USDC.receiveWithAuthorization(
            borrower, payee, 1_000_000, 0, type(uint256).max, nonce, signature
        );

        assertFalse(USDC.authorizationState(borrower, nonce), "griefer burned the nonce");
    }

    /// @notice A nonce cannot clear twice.
    function test_nonceIsSingleUse() public onlyForked {
        _installPrecompileMock();

        (address borrower, uint256 key) = makeAddrAndKey("borrower-replay");
        uint256 value = 5_000_000;
        _fund(borrower, value * 4);

        bytes32 nonce = keccak256("replay");
        bytes memory signature = _signReceive(key, borrower, payee, value, 0, type(uint256).max, nonce);

        vm.prank(payee);
        USDC.receiveWithAuthorization(borrower, payee, value, 0, type(uint256).max, nonce, signature);

        vm.prank(payee);
        vm.expectRevert();
        USDC.receiveWithAuthorization(borrower, payee, value, 0, type(uint256).max, nonce, signature);

        assertEq(precompile.callCount(), 1, "the replay moved value");
    }

    /// @notice Post-dating and self-expiry, on the real token.
    function test_validityWindowIsEnforced() public onlyForked {
        _installPrecompileMock();

        (address borrower, uint256 key) = makeAddrAndKey("borrower-window");
        _fund(borrower, 100_000_000);

        uint256 future = block.timestamp + 30 days;
        bytes32 notYet = keccak256("not-yet");
        vm.prank(payee);
        vm.expectRevert();
        USDC.receiveWithAuthorization(
            borrower,
            payee,
            1_000_000,
            future,
            type(uint256).max,
            notYet,
            _signReceive(key, borrower, payee, 1_000_000, future, type(uint256).max, notYet)
        );

        uint256 past = block.timestamp - 1;
        bytes32 stale = keccak256("stale");
        vm.prank(payee);
        vm.expectRevert();
        USDC.receiveWithAuthorization(
            borrower,
            payee,
            1_000_000,
            0,
            past,
            stale,
            _signReceive(key, borrower, payee, 1_000_000, 0, past, stale)
        );

        assertEq(precompile.callCount(), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The failure mode the entire collection design turns on.
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice An underfunded pull reverts.
    ///
    /// @dev It emits nothing, changes nothing and pays nobody. That is why
    ///      `collect()` has to wrap the pull in `try/catch`, and why a separately
    ///      bountied `markMissed()` is needed on top: the specification's claim that
    ///      "the failure is the signal" describes an event that, left to the token,
    ///      nobody ever creates. Grace transitions, Passport marks, NAV provisioning
    ///      and the first-payment-default kill switch are all fed by it.
    ///
    ///      Deliberately runs against the real precompile — this path must revert
    ///      before reaching it, and a mock would hide the difference.
    function test_insufficientFundsReverts() public onlyForked {
        (address borrower, uint256 key) = makeAddrAndKey("borrower-broke");
        _fund(borrower, 1_000_000);

        bytes32 nonce = keccak256("insufficient");
        bytes memory signature =
            _signReceive(key, borrower, payee, 50_000_000, 0, type(uint256).max, nonce);

        vm.prank(payee);
        vm.expectRevert();
        USDC.receiveWithAuthorization(
            borrower, payee, 50_000_000, 0, type(uint256).max, nonce, signature
        );

        // The nonce survives, so a cure can still clear this installment later.
        assertFalse(USDC.authorizationState(borrower, nonce), "a failed pull burned the nonce");
    }

    /// @notice `cancelAuthorization` burns a nonce permanently.
    /// @dev This is why `originationNonce` is in the `planId` preimage. Once a
    ///      borrower cancels, that check can never be re-signed for that plan, so two
    ///      originations with identical terms must not derive identical nonces.
    function test_cancelBurnsNoncePermanently() public onlyForked {
        (address borrower, uint256 key) = makeAddrAndKey("borrower-cancel");
        _fund(borrower, 100_000_000);

        bytes32 nonce = keccak256("cancelled");
        USDC.cancelAuthorization(borrower, nonce, _signCancel(key, borrower, nonce));
        assertTrue(USDC.authorizationState(borrower, nonce), "cancel did not consume the nonce");

        vm.prank(payee);
        vm.expectRevert();
        USDC.receiveWithAuthorization(
            borrower,
            payee,
            1_000_000,
            0,
            type(uint256).max,
            nonce,
            _signReceive(key, borrower, payee, 1_000_000, 0, type(uint256).max, nonce)
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Measured cost. Feeds the corrected minimum ticket rather than inheriting it.
    // ─────────────────────────────────────────────────────────────────────────

    function test_measurePullGas() public onlyForked {
        _installPrecompileMock();

        (address borrower, uint256 key) = makeAddrAndKey("borrower-gas");
        _fund(borrower, 100_000_000);

        bytes32 nonce = keccak256("gas-measure");
        bytes memory signature =
            _signReceive(key, borrower, payee, 18_750_000, 0, type(uint256).max, nonce);

        vm.prank(payee);
        uint256 before = gasleft();
        USDC.receiveWithAuthorization(
            borrower, payee, 18_750_000, 0, type(uint256).max, nonce, signature
        );
        uint256 used = before - gasleft();

        // 1 gas = 21 gwei = 2.1e-8 USDC. Expressed in micro-USDC (1e-6) for
        // readability: gas * 21 / 1000.
        console.log("EOA pull gas (mocked precompile):", used);
        console.log("cost, micro-USDC:", (used * GAS_PRICE_GWEI) / 1_000);
        console.log("note: excludes the native-transfer precompile's own cost");

        assertLt(used, 200_000, "bare pull cost far more than the ops budget models");
    }

    function test_recordEnvironment() public view onlyForked {
        console.log("block:", block.number);
        console.log("USDC implementation:", address(uint160(uint256(vm.load(address(USDC), ZEPPELINOS_IMPL_SLOT)))));
        console.log("native transfer precompile code size:", NATIVE_TRANSFER_PRECOMPILE.code.length);
        console.logBytes32(domainSeparator);
    }

    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Fund an account with `amount` USDC at ERC-20 (6-decimal) scale.
    ///
    /// @dev Not `deal(token, …)`. That cheatcode probes for a balance mapping and
    ///      finds none, because Arc USDC has no balance storage: `balanceOf` reads
    ///      the account's native balance and divides by 10^12. Measured on a fork —
    ///      `vm.deal(a, 5 ether)` makes `balanceOf(a)` read `5_000_000`.
    ///
    ///      This is the concrete form of "gas and the loan share one balance". Every
    ///      transaction a borrower sends reduces what a check can collect, so a
    ///      borrower holding exactly one installment cannot pay for their own cure.
    ///      Paymaster sponsorship of borrower-side transactions is a functional
    ///      requirement, not a UX nicety.
    function _fund(address account, uint256 amount) internal {
        vm.deal(account, amount * 1e12);
    }

    function _signReceive(
        uint256 key,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signCancel(uint256 key, address authorizer, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash =
            keccak256(abi.encode(USDC.CANCEL_AUTHORIZATION_TYPEHASH(), authorizer, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
