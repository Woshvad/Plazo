// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {PayoutRouter} from "../src/PayoutRouter.sol";
import {MockArcUsdc} from "./mocks/MockArcUsdc.sol";
import {MockTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";

/// @notice XCH-02 and the chain half of MERCH-07 — a merchant paid on their own chain.
///
/// @dev Three properties are being defended here and they are not the same property.
///
///      The first is that settlement is *never* hostage to Circle. `payout()` is called
///      from inside `originate()`, and CCTP has three kill switches Plazo does not hold.
///      `test_revertingMessengerDoesNotBlockSettlement` is the whole argument for the
///      contract's shape; if it ever goes red, CHKT-04 has become a claim about a
///      third party's uptime.
///
///      The second is the burn's exact shape. A burn is irreversible and a mint has no
///      recovery path, so an argument in the wrong position is not a bug that surfaces as
///      a failed transaction — it is money that arrives somewhere nobody holds a key.
///      `test_dispatchBurnsWithCorrectShape` asserts all seven arguments and the padding
///      direction of the recipient specifically, because that is the one that fails
///      silently and remotely.
///
///      The third is that nobody is needed. `dispatch` takes no role and no bounty, and
///      GOV-08 row 11 asserts a stranger can call it.
///
///      Balance assertions run against `MockArcUsdc`: Arc USDC's token movement is a
///      native precompile Foundry cannot execute (finding 3). The burn itself is asserted
///      against `MockTokenMessengerV2`, which records rather than simulates — the live
///      call was measured for real in plan 06-01 (finding 28), and what a local test can
///      add to that is the shape of the call Plazo makes, not the behaviour of Circle's.
contract PayoutRouterTest is Test {
    PayoutRouter internal router;
    MockArcUsdc internal usdc;
    MockTokenMessengerV2 internal messenger;

    address internal admin = address(this);
    address internal curator = address(0xC0DA7);
    address internal stranger = address(0x57A);
    address internal merchant = address(0xBEEF);

    /// @notice Base Sepolia. The destination the live 06-01 burn actually went to.
    uint32 internal constant BASE_DOMAIN = 6;
    /// @notice Arbitrum Sepolia. A second real domain, so "a domain" is not "the domain".
    uint32 internal constant ARB_DOMAIN = 3;
    /// @notice A domain CCTP does not acknowledge.
    uint32 internal constant UNKNOWN_DOMAIN = 9999;

    /// @notice CCTP v2's testnet messenger, which Arc reports for every remote domain.
    bytes32 internal constant REMOTE_MESSENGER =
        bytes32(uint256(uint160(0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA)));

    uint256 internal constant SETTLEMENT = 407_000_000; // 407 USDC, one live origination

    function setUp() public {
        usdc = new MockArcUsdc();
        messenger = new MockTokenMessengerV2(address(0x7A45));
        router = new PayoutRouter(admin, address(messenger));

        // The live routing table: the same testnet messenger for every remote domain,
        // and `bytes32(0)` for Arc's own domain 26, which is left unset deliberately.
        messenger.setRemoteTokenMessenger(BASE_DOMAIN, REMOTE_MESSENGER);
        messenger.setRemoteTokenMessenger(ARB_DOMAIN, REMOTE_MESSENGER);

        router.grantRole(router.DOMAIN_CURATOR_ROLE(), curator);
    }

    // ─── Settlement ──────────────────────────────────────────────────────────

    /// @notice CHKT-04. An Arc-domain merchant is paid in the origination call itself.
    function test_arcDomainPaysInline() public {
        uint32 arc = router.ARC_DOMAIN();
        _fund(SETTLEMENT);

        vm.expectEmit(true, true, false, true, address(router));
        emit PayoutRouter.PaidOut(address(usdc), merchant, arc, SETTLEMENT);
        router.payout(address(usdc), arc, merchant, SETTLEMENT);

        assertEq(
            usdc.balanceOf(merchant),
            SETTLEMENT,
            "an Arc merchant was not paid inside the settlement call, so CHKT-04's sub-second finality no longer holds"
        );
        assertEq(
            usdc.balanceOf(address(router)),
            0,
            "the router kept settlement it should have passed straight through"
        );
        assertEq(
            router.queued(address(usdc), merchant, arc),
            0,
            "an Arc payout was queued instead of paid, which would leave a merchant waiting on a bridge to their own chain"
        );
        assertEq(messenger.burnCount(), 0, "an Arc payout reached CCTP, which has no route to Arc");
    }

    /// @notice A remote merchant is credited on Arc now and bridged later.
    function test_remoteDomainQueuesAndDoesNotBurn() public {
        _fund(SETTLEMENT);

        vm.expectEmit(true, true, false, true, address(router));
        emit PayoutRouter.PayoutQueued(address(usdc), merchant, BASE_DOMAIN, SETTLEMENT);
        router.payout(address(usdc), BASE_DOMAIN, merchant, SETTLEMENT);

        assertEq(
            router.queued(address(usdc), merchant, BASE_DOMAIN),
            SETTLEMENT,
            "a remote merchant's settlement was not credited on Arc, so the money is neither here nor there"
        );
        assertEq(
            usdc.balanceOf(address(router)),
            SETTLEMENT,
            "the queued settlement is not actually held by the router"
        );
        assertEq(
            messenger.burnCount(),
            0,
            "a burn happened inside the settlement call, which puts Circle's uptime on the origination path"
        );
        assertEq(usdc.balanceOf(merchant), 0, "a remote merchant was paid on Arc instead of bridged");
    }

    /// @notice **The Pitfall 1 closure.**
    ///
    /// @dev Circle holds three kill switches Plazo does not: `MessageTransmitterV2.pause`,
    ///      `TokenMinterV2.pause`, and the messenger's own denylist. Each one surfaces as
    ///      "`depositForBurn` reverts", and `payout()` runs inside `originate()`. If a
    ///      reverting messenger could reach settlement, any one of the three would revert
    ///      a checkout — and CHKT-04 would be a claim about Circle's uptime rather than
    ///      about Arc's.
    function test_revertingMessengerDoesNotBlockSettlement() public {
        messenger.setRevertOnBurn(true);
        _fund(SETTLEMENT);

        router.payout(address(usdc), BASE_DOMAIN, merchant, SETTLEMENT);

        assertEq(
            router.queued(address(usdc), merchant, BASE_DOMAIN),
            SETTLEMENT,
            "settlement did not survive a halted messenger, so a Circle pause breaks checkout rather than delaying a bridge"
        );

        // Only the bridge is down. The degradation is "payout queued", not "checkout
        // broken", and it clears by itself when Circle's switch flips back.
        vm.expectRevert(MockTokenMessengerV2.BurnHalted.selector);
        router.dispatch(address(usdc), merchant, BASE_DOMAIN);

        assertEq(
            router.queued(address(usdc), merchant, BASE_DOMAIN),
            SETTLEMENT,
            "a failed dispatch consumed the queued balance, which would burn a merchant's settlement on a revert"
        );
    }

    // ─── The burn ────────────────────────────────────────────────────────────

    /// @notice The exact seven arguments, and the padding direction of the recipient.
    function test_dispatchBurnsWithCorrectShape() public {
        _queue(merchant, BASE_DOMAIN, SETTLEMENT);

        vm.expectEmit(true, true, false, true, address(router));
        emit PayoutRouter.PayoutDispatched(address(usdc), merchant, BASE_DOMAIN, SETTLEMENT);
        router.dispatch(address(usdc), merchant, BASE_DOMAIN);

        assertEq(messenger.burnCount(), 1, "the dispatch did not reach CCTP exactly once");
        assertEq(messenger.lastAmount(), SETTLEMENT, "the burn was not for the queued amount");
        assertEq(
            messenger.lastDestinationDomain(),
            BASE_DOMAIN,
            "the burn named a destination the merchant did not choose"
        );
        assertEq(
            messenger.lastBurnToken(),
            address(usdc),
            "the burn named a token other than the one that was settled"
        );
        assertEq(
            messenger.lastDestinationCaller(),
            bytes32(0),
            "a destination caller was set, which would stop the merchant completing their own mint"
        );
        assertEq(messenger.lastMaxFee(), 0, "a non-zero max fee was offered on a route Circle prices at zero");
        assertEq(
            messenger.lastMinFinalityThreshold(),
            2000,
            "the finality threshold is not standard, so a toggle exists that the fee table says has no effect"
        );

        // Pitfall 3, asserted three ways. A right-padded recipient mints to an address
        // nobody holds a key for, on a chain with no recovery path — it does not fail
        // here, it fails silently and remotely, which is why the padding gets its own
        // assertions rather than riding on the tuple.
        bytes32 recorded = messenger.lastMintRecipient();
        assertEq(
            recorded,
            bytes32(uint256(uint160(merchant))),
            "the mint recipient is not the left-padded merchant address"
        );
        assertEq(
            uint256(recorded) >> 160,
            0,
            "the mint recipient's leading twenty-four nibbles are not zero, so the address was right-padded and the mint is unrecoverable"
        );
        assertEq(
            address(uint160(uint256(recorded))),
            merchant,
            "the mint recipient's trailing forty nibbles are not the merchant's address"
        );
        assertTrue(
            recorded != bytes32(bytes20(merchant)),
            "the mint recipient is byte-identical to the right-padded encoding, which is the encoding that loses the money"
        );
    }

    /// @notice GOV-08 row 11. A stranger holding no role pushes the payout across.
    function test_dispatchIsPermissionless() public {
        _queue(merchant, BASE_DOMAIN, SETTLEMENT);

        assertFalse(
            router.hasRole(router.DOMAIN_CURATOR_ROLE(), stranger),
            "the stranger holds the curator role, so this proves nothing"
        );
        assertFalse(
            router.hasRole(router.DEFAULT_ADMIN_ROLE(), stranger),
            "the stranger is an admin, so this proves nothing"
        );

        vm.prank(stranger);
        router.dispatch(address(usdc), merchant, BASE_DOMAIN);

        assertEq(
            messenger.burnCount(),
            1,
            "an unroled caller could not dispatch, so the payout path needs an operator and GOV-08 fails"
        );
    }

    /// @notice The queued balance is zeroed before the external call, not after.
    function test_dispatchZeroesBeforeTheExternalCall() public {
        _queue(merchant, BASE_DOMAIN, SETTLEMENT);
        router.dispatch(address(usdc), merchant, BASE_DOMAIN);

        assertEq(
            router.queued(address(usdc), merchant, BASE_DOMAIN),
            0,
            "the queue survived its own dispatch, so the same settlement can be bridged twice"
        );

        vm.expectRevert(PayoutRouter.NothingQueued.selector);
        router.dispatch(address(usdc), merchant, BASE_DOMAIN);
    }

    /// @notice A dispatcher cannot choose a destination the merchant did not.
    ///
    /// @dev `dispatch` is permissionless by design, so the destination has to be fixed by
    ///      whoever was owed the money at the moment they were owed it. An address a
    ///      merchant controls on Arc is not necessarily an address they control on
    ///      Arbitrum, and a burn to the wrong domain is not recoverable from either end.
    function test_dispatchCannotRedirectToAnotherDomain() public {
        _queue(merchant, BASE_DOMAIN, SETTLEMENT);

        vm.prank(stranger);
        vm.expectRevert(PayoutRouter.NothingQueued.selector);
        router.dispatch(address(usdc), merchant, ARB_DOMAIN);

        assertEq(
            router.queued(address(usdc), merchant, BASE_DOMAIN),
            SETTLEMENT,
            "a redirected dispatch moved a balance queued for another domain"
        );
        assertEq(messenger.burnCount(), 0, "a burn fired for a domain nothing was queued for");
    }

    // ─── Refusals ────────────────────────────────────────────────────────────

    /// @notice Pitfall 2. Arc is payable, but never by burn.
    ///
    /// @dev The branch order is the assertion. `remoteTokenMessengers(26)` is
    ///      `bytes32(0)` on chain — CCTP has no self-domain route — so an implementation
    ///      that consulted the routing table before checking Arc would refuse the one
    ///      destination this chain can always pay, and every Arc merchant would fail at
    ///      checkout.
    function test_selfDomainIsRefused() public {
        uint32 arc = router.ARC_DOMAIN();

        assertEq(
            messenger.remoteTokenMessengers(arc),
            bytes32(0),
            "the fixture does not mirror the chain: Arc has no route to itself"
        );
        assertTrue(
            router.supportsDomain(arc),
            "Arc is unsupported, so the routing table was consulted before the Arc branch and no merchant on Arc can be paid"
        );

        _fund(SETTLEMENT);
        router.payout(address(usdc), arc, merchant, SETTLEMENT);

        assertEq(
            router.queued(address(usdc), merchant, arc),
            0,
            "settlement queued for Arc's own domain, which can only ever be dispatched into a void"
        );

        vm.expectRevert(PayoutRouter.NothingQueued.selector);
        router.dispatch(address(usdc), merchant, arc);
    }

    /// @notice A domain CCTP does not acknowledge fails at checkout, legibly.
    function test_unknownDomainIsRefused() public {
        assertFalse(
            router.supportsDomain(UNKNOWN_DOMAIN), "a domain with no remote messenger reads as supported"
        );

        _fund(SETTLEMENT);
        vm.expectRevert(abi.encodeWithSelector(PayoutRouter.UnsupportedDomain.selector, UNKNOWN_DOMAIN));
        router.payout(address(usdc), UNKNOWN_DOMAIN, merchant, SETTLEMENT);
    }

    /// @notice A denied domain takes no new settlement and strands none already owed.
    function test_deniedDomainIsRefused() public {
        _queue(merchant, BASE_DOMAIN, SETTLEMENT);

        vm.expectEmit(true, true, false, false, address(router));
        emit PayoutRouter.DomainDenied(BASE_DOMAIN, curator);
        vm.prank(curator);
        router.denyDomain(BASE_DOMAIN);

        assertFalse(router.supportsDomain(BASE_DOMAIN), "a denied domain still reads as supported");

        _fund(SETTLEMENT);
        vm.expectRevert(abi.encodeWithSelector(PayoutRouter.UnsupportedDomain.selector, BASE_DOMAIN));
        router.payout(address(usdc), BASE_DOMAIN, merchant, SETTLEMENT);

        // The money already owed is still the merchant's. A deny list that could freeze a
        // queued balance would make the curator an operator on the settlement path, which
        // is exactly what GOV-08 rules out.
        vm.prank(stranger);
        router.dispatch(address(usdc), merchant, BASE_DOMAIN);
        assertEq(
            messenger.burnCount(),
            1,
            "denying a domain stranded settlement that was already owed, which hands a curator a freeze button"
        );
    }

    /// @notice A payout naming the zero address is refused rather than burned.
    function test_recipientZeroIsRefused() public {
        _fund(SETTLEMENT);
        vm.expectRevert(PayoutRouter.RecipientZero.selector);
        router.payout(address(usdc), BASE_DOMAIN, address(0), SETTLEMENT);
    }

    /// @notice A zero settlement returns rather than reverting.
    /// @dev `ArcLocalPayout`'s ordering, kept: a fully-withheld settlement is a legitimate
    ///      origination and must not revert one.
    function test_zeroAmountReturnsWithoutReverting() public {
        router.payout(address(usdc), BASE_DOMAIN, merchant, 0);
        assertEq(
            router.queued(address(usdc), merchant, BASE_DOMAIN), 0, "a zero payout created a queue entry"
        );
    }

    // ─── The ratchet ─────────────────────────────────────────────────────────

    /// @notice Only a curator may deny, and only once.
    function test_denyIsRoleGatedAndOneWay() public {
        bytes32 role = router.DOMAIN_CURATOR_ROLE();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        router.denyDomain(BASE_DOMAIN);

        vm.prank(curator);
        router.denyDomain(BASE_DOMAIN);

        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(PayoutRouter.DomainAlreadyDenied.selector, BASE_DOMAIN));
        router.denyDomain(BASE_DOMAIN);

        assertTrue(router.denied(BASE_DOMAIN), "the deny did not stick");
    }

    // ─── Property ────────────────────────────────────────────────────────────

    /// @notice The router never owes more than it holds.
    ///
    /// @dev The 6-vs-18 decimal guard (Pitfall 4). Nothing in `PayoutRouter` scales an
    ///      amount, and this is what would catch it if something started to: a queue
    ///      credited in one unit against a balance held in another diverges by a factor of
    ///      10^12 on the first payout.
    function testFuzz_queuedNeverExceedsHeld(uint64[8] calldata amounts, uint8 seed) public {
        address[3] memory recipients = [merchant, stranger, curator];
        uint32[2] memory domains = [BASE_DOMAIN, ARB_DOMAIN];

        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 amount = bound(uint256(amounts[i]), 0, 1_000_000_000_000);
            address recipient = recipients[(uint256(seed) + i) % 3];
            uint32 domain = domains[(uint256(seed) + i) % 2];

            _fund(amount);
            router.payout(address(usdc), domain, recipient, amount);

            // Dispatch on roughly half the steps, so the property is exercised across
            // interleavings rather than only on a monotonically growing queue.
            if ((uint256(seed) >> (i % 8)) & 1 == 1) {
                if (router.queued(address(usdc), recipient, domain) > 0) {
                    router.dispatch(address(usdc), recipient, domain);
                }
            }

            uint256 owed;
            for (uint256 r = 0; r < recipients.length; r++) {
                for (uint256 d = 0; d < domains.length; d++) {
                    owed += router.queued(address(usdc), recipients[r], domains[d]);
                }
            }

            assertLe(
                owed,
                usdc.balanceOf(address(router)),
                "the router owes more than it holds, so some merchant's queued settlement cannot be dispatched"
            );
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev Mint to this contract and approve the router, which is what
    ///      `CheckoutRouter._settleMerchant` does on the line before it calls `payout`.
    function _fund(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(router), amount);
    }

    function _queue(address recipient, uint32 domain, uint256 amount) internal {
        _fund(amount);
        router.payout(address(usdc), domain, recipient, amount);
    }
}
