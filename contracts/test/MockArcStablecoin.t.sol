// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {MockArcEurc} from "./mocks/MockArcEurc.sol";
import {MockArcUsdc} from "./mocks/MockArcUsdc.sol";

/// @notice The two currencies are one EIP-3009 implementation, and a strip signed
///         against one of them cannot be replayed against the other.
///
/// @dev Phase 7 needs a EURC mock. The cheap way to get one is to copy `MockArcUsdc`,
///      and the reason not to is that the copy nobody exercises drifts — surfacing
///      much later as a signature that verifies locally and is rejected on chain.
///      `MockArcEurc` is therefore the same contract with a different constructor
///      argument, and this file is what keeps that claim honest: without it,
///      `MockArcEurc` would have no call site at all until 07-03 and its header would
///      be an assertion nothing checks.
///
///      The separated-domain property is the load-bearing one. A EURC separator
///      differs from a USDC separator only through `name` and `verifyingContract`,
///      and that difference is what a corridor test relies on when it asserts a
///      borrower's euro strip cannot be collected in dollars.
contract MockArcStablecoinTest is Test {
    MockArcUsdc internal usdc;
    MockArcEurc internal eurc;

    uint256 internal borrowerKey = 0xB0110E;
    address internal borrower;
    address internal payee = address(0xFEE0);

    function setUp() public {
        usdc = new MockArcUsdc();
        eurc = new MockArcEurc();
        borrower = vm.addr(borrowerKey);
    }

    /// @notice Both tokens carry finding 31's measured shape.
    /// @dev Read live from chain 5042002 in plan 07-01: EURC is 6 decimals, version
    ///      "2", and all three typehashes byte-identical to USDC's. `version` and
    ///      `decimals` are `constant` in the base for exactly that reason.
    function test_bothCurrenciesCarryTheMeasuredShape() public view {
        assertEq(usdc.decimals(), 6);
        assertEq(eurc.decimals(), 6);
        assertEq(usdc.version(), "2");
        assertEq(eurc.version(), "2");

        assertEq(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), eurc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH());
        assertEq(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), eurc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH());
        assertEq(usdc.CANCEL_AUTHORIZATION_TYPEHASH(), eurc.CANCEL_AUTHORIZATION_TYPEHASH());

        assertEq(eurc.name(), "EURC");
        assertEq(eurc.symbol(), "EURC");
        assertEq(usdc.name(), "USDC");
    }

    /// @notice The separators differ, and they differ through `name` rather than only
    ///         through the address.
    ///
    /// @dev Two instances at different addresses would produce different separators
    ///      even if `name` were hardcoded, so the address half proves nothing on its
    ///      own. The four-field derivation is therefore reproduced here against
    ///      EURC's own address twice — once with its real name and once with USDC's —
    ///      holding `chainId` and `verifyingContract` fixed. The first has to match
    ///      what the contract returns and the second has to differ from it, which is
    ///      only true if `name` is genuinely in the digest.
    function test_theNameIsWhatSeparatesTheTwoDomains() public view {
        assertTrue(usdc.DOMAIN_SEPARATOR() != eurc.DOMAIN_SEPARATOR(), "the two domains collide");

        bytes32 asEuros = _deriveSeparator("EURC", address(eurc));
        bytes32 asDollars = _deriveSeparator("USDC", address(eurc));

        assertEq(asEuros, eurc.DOMAIN_SEPARATOR(), "the four-field derivation does not reproduce EURC's");
        assertTrue(asEuros != asDollars, "the name is not in the domain");
    }

    /// @dev The canonical four-field EIP-712 domain, rebuilt outside the contract so
    ///      the test does not read the value it is checking from the thing it is
    ///      checking.
    function _deriveSeparator(
        string memory name_,
        address verifyingContract
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name_)),
                keccak256(bytes("2")),
                block.chainid,
                verifyingContract
            )
        );
    }

    /// @notice A check signed against EURC cannot be collected in USDC.
    ///
    /// @dev The corridor property, stated as a test rather than as a comment. Both
    ///      tokens accept the *same* struct hash; what separates them is the domain
    ///      the digest is built over. So the euro strip presented to the dollar token
    ///      recovers a different address, and the dollar token rejects it with the
    ///      live token's own revert string.
    function test_aEurcCheckIsNotCollectibleInUsdc() public {
        usdc.mint(borrower, 100e6);
        eurc.mint(borrower, 100e6);

        uint256 validAfter = vm.getBlockTimestamp() - 1;
        uint256 validBefore = vm.getBlockTimestamp() + 1 days;
        bytes32 nonce = keccak256("plazo.test.corridor.nonce");

        bytes32 structHash = keccak256(
            abi.encode(
                eurc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                borrower,
                payee,
                uint256(25e6),
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 eurDigest = keccak256(abi.encodePacked("\x19\x01", eurc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerKey, eurDigest);
        bytes memory euroCheck = abi.encodePacked(r, s, v);

        vm.prank(payee);
        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.receiveWithAuthorization(borrower, payee, 25e6, validAfter, validBefore, nonce, euroCheck);

        // And the same bytes clear against the token they were signed for, so the
        // rejection above is the domain and not a malformed signature.
        vm.prank(payee);
        eurc.receiveWithAuthorization(borrower, payee, 25e6, validAfter, validBefore, nonce, euroCheck);
        assertEq(eurc.balanceOf(payee), 25e6, "the euro check did not clear against EURC");
        assertEq(usdc.balanceOf(payee), 0, "dollars moved on a euro authorization");
    }
}
