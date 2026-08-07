// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {FxDeviationGuard} from "../../src/fx/FxDeviationGuard.sol";
import {AmmVenue} from "../../src/fx/AmmVenue.sol";
import {StableFxVenueStub} from "../../src/fx/StableFxVenueStub.sol";
import {IFxVenue} from "../../src/interfaces/IFxVenue.sol";
import {FxMidAttestation} from "../../src/libraries/FxMidAttestation.sol";
import {ParameterRegistry} from "../../src/ParameterRegistry.sol";
import {ParameterKeys} from "../../src/libraries/ParameterKeys.sol";
import {PlanParams} from "../../src/libraries/PlanParams.sol";
import {MockArcStablecoin} from "../mocks/MockArcStablecoin.sol";
import {MockArcUsdc} from "../mocks/MockArcUsdc.sol";
import {MockArcEurc} from "../mocks/MockArcEurc.sol";

/// @notice A venue that fills exactly what the test tells it to.
///
/// @dev The point of this double is that its **fill and its word are separable**.
///      `_fill` is what the recipient actually receives; `_reported` is what `settle`
///      returns; `_quoted` is what `quote` says beforehand. A real venue keeps the
///      three in step. The failures FX-05 exists to catch are exactly the cases where
///      they come apart, and a double that could not pull them apart would be a double
///      that can only test the honest path.
///
///      Directional on purpose: it trades `tokenA -> tokenB` and not the reverse, so a
///      mid signed for the opposite direction has something concrete to be refused by.
contract MockFxVenue is IFxVenue {
    address public immutable tokenA;
    address public immutable tokenB;

    uint256 private _fill;
    uint256 private _reported;
    bool private _reportOverride;
    uint256 private _quoted;
    bool private _enforceMinOut;

    constructor(address tokenA_, address tokenB_) {
        tokenA = tokenA_;
        tokenB = tokenB_;
    }

    /// @notice Deliver exactly `out`, and say so.
    function setFill(uint256 out) external {
        _fill = out;
        _reportOverride = false;
    }

    /// @notice Deliver `out` but claim `claim`. A venue that lies about its own fill.
    function setLyingFill(uint256 out, uint256 claim) external {
        _fill = out;
        _reported = claim;
        _reportOverride = true;
    }

    function setQuote(uint256 out) external {
        _quoted = out;
    }

    /// @notice Whether the venue honours the `minOut` it was handed.
    /// @dev Off by default. A venue that honoured `minOut` would revert before the
    ///      guard ever measured anything, which would test the venue rather than the
    ///      guard — and `minOut` is enforced by the party under suspicion, which is
    ///      exactly why the guard does not rely on it.
    function setEnforceMinOut(bool on) external {
        _enforceMinOut = on;
    }

    function supportsPair(address fromToken, address toToken) external view returns (bool) {
        return fromToken == tokenA && toToken == tokenB;
    }

    function quote(address, address, uint256) external view returns (uint256) {
        return _quoted;
    }

    function settle(
        address fromToken,
        address toToken,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256) {
        if (_enforceMinOut && _fill < minOut) revert("MockFxVenue: below minOut");

        MockArcStablecoin(fromToken).transferFrom(msg.sender, address(this), amountIn);
        if (_fill > 0) MockArcStablecoin(toToken).transfer(recipient, _fill);

        return _reportOverride ? _reported : _fill;
    }
}

/// @notice FX-05's deviation guard, and the venues behind it.
///
/// @dev Every clock read goes through `vm.getBlockTimestamp()`. `via_ir` treats
///      `block.timestamp` as constant within a call frame and hoists it past
///      `vm.warp`, which is precisely the shape an expiry test takes (finding 14,
///      DEC-30). `tools/check-test-clock.mjs` fails the build if this file regresses.
contract FxDeviationGuardTest is Test {
    uint256 internal constant SIGNER_KEY = 0xF1;
    uint256 internal constant IMPOSTOR_KEY = 0xF2;

    MockArcUsdc internal usdc;
    MockArcEurc internal eurc;
    ParameterRegistry internal parameters;
    FxDeviationGuard internal guard;
    MockFxVenue internal venue;
    StableFxVenueStub internal stub;
    AmmVenue internal amm;

    address internal signer;
    address internal impostor;
    address internal payer = address(0xBEEF);
    address internal recipient = address(0xCAFE);

    bytes32 internal constant CORRIDOR = keccak256("PLAZO.CORRIDOR.USDC.EURC");

    string internal constant STUB_REASON =
        "StableFX settlement requires a KYB/AML-gated API key Plazo does not hold";

    function setUp() public {
        vm.warp(1_800_000_000);

        signer = vm.addr(SIGNER_KEY);
        impostor = vm.addr(IMPOSTOR_KEY);

        usdc = new MockArcUsdc();
        eurc = new MockArcEurc();
        parameters = new ParameterRegistry(address(this));
        guard = new FxDeviationGuard(address(this), address(parameters));
        guard.grantRole(guard.FX_SIGNER_ROLE(), signer);

        venue = new MockFxVenue(address(usdc), address(eurc));
        stub = new StableFxVenueStub();
        // The shipped configuration. Finding 34: seven candidate routers probed on Arc
        // testnet, zero holding bytecode, so there is no address to pass here.
        amm = new AmmVenue(address(0), address(usdc), address(eurc));

        eurc.mint(address(venue), 1e24);
    }

    // ─── The guard ───────────────────────────────────────────────────────────

    /// @notice A fill inside the band clears; a fill outside it does not, and the
    ///         refusal leaves the recipient exactly where it found them.
    ///
    /// @dev The negative control is half this test and it is the half that matters. A
    ///      guard that reverts *after* the money has moved is not a guard, it is a log
    ///      line. So every refusing branch asserts the recipient's balance is
    ///      unchanged, not merely that the call failed.
    function testFuzz_deviationGuard(uint256 amountIn, uint256 midE18, uint256 fillBps) public {
        amountIn = bound(amountIn, 1e6, 1e12);
        midE18 = bound(midE18, 5e17, 2e18);
        fillBps = bound(fillBps, 0, 20_000);

        uint256 expected = (amountIn * midE18) / 1e18;
        uint256 floor_ = guard.floorFor(amountIn, midE18);
        uint256 realised = (expected * fillBps) / PlanParams.BPS;

        venue.setFill(realised);
        uint256 balanceBefore = eurc.balanceOf(recipient);

        FxMidAttestation.Mid memory mid = _mid(keccak256("fuzz"), midE18);

        if (realised >= floor_) {
            uint256 amountOut = _settle(mid, amountIn, SIGNER_KEY);
            assertEq(
                amountOut, realised, "the guard reported a fill different from the one the venue delivered"
            );
            assertEq(
                eurc.balanceOf(recipient) - balanceBefore,
                amountOut,
                "the recipient's balance did not rise by exactly the amount the guard returned"
            );
        } else {
            _settleExpecting(mid, amountIn, SIGNER_KEY, _fillOutsideGuard(realised, floor_));
            assertEq(
                eurc.balanceOf(recipient),
                balanceBefore,
                "a refused fill still paid the recipient, which makes the guard a log line rather than a guard"
            );
        }

        // The deterministic half: exactly one unit below the floor, on a fresh session.
        if (floor_ == 0) return;

        venue.setFill(floor_ - 1);
        uint256 balanceBeforeEdge = eurc.balanceOf(recipient);
        FxMidAttestation.Mid memory edge = _mid(keccak256("fuzz.edge"), midE18);

        _settleExpecting(edge, amountIn, SIGNER_KEY, _fillOutsideGuard(floor_ - 1, floor_));
        assertEq(
            eurc.balanceOf(recipient),
            balanceBeforeEdge,
            "a fill one unit below the floor was refused but the recipient was paid anyway"
        );
    }

    /// @notice Four ways a mid is refused, each with its own typed error.
    ///
    /// @dev The pair mismatch is the one a reviewer will not think of, and it is why
    ///      `fromToken` and `toToken` sit inside the digest. A mid quoted for USDC→EURC
    ///      applied to the opposite direction would floor the fill against a rate whose
    ///      correct value is the reciprocal — accepting a trade wrong by the square of
    ///      the rate, with a perfectly valid signature.
    function test_midAttestationBounds() public {
        uint256 amountIn = 100e6;
        uint256 midE18 = 9e17;
        uint256 start = vm.getBlockTimestamp();
        venue.setFill(guard.floorFor(amountIn, midE18));

        // 1. Past its own expiry.
        FxMidAttestation.Mid memory expired = _mid(keccak256("expired"), midE18);
        vm.warp(expired.validUntil + 1);
        _settleExpecting(
            expired,
            amountIn,
            SIGNER_KEY,
            abi.encodeWithSelector(FxDeviationGuard.MidExpired.selector, expired.validUntil)
        );
        vm.warp(start);

        // 2. Valid, but for longer than governance permits. A quoting service issuing
        //    hour-long mids would be issuing bearer options on a rate.
        uint256 maxTtl = parameters.get(ParameterKeys.FX_MID_MAX_TTL);
        FxMidAttestation.Mid memory long = _mid(keccak256("long"), midE18);
        long.validUntil = vm.getBlockTimestamp() + maxTtl + 1;
        _settleExpecting(
            long,
            amountIn,
            SIGNER_KEY,
            abi.encodeWithSelector(FxDeviationGuard.MidTooLong.selector, maxTtl + 1, maxTtl)
        );

        // 3. Signed by a key that holds no role.
        FxMidAttestation.Mid memory unroled = _mid(keccak256("unroled"), midE18);
        _settleExpecting(
            unroled,
            amountIn,
            IMPOSTOR_KEY,
            abi.encodeWithSelector(FxDeviationGuard.MidSignerUnauthorized.selector, impostor)
        );

        // 4. Signed correctly, for the other direction. The venue trades USDC→EURC.
        FxMidAttestation.Mid memory reversed = _mid(keccak256("reversed"), midE18);
        reversed.fromToken = address(eurc);
        reversed.toToken = address(usdc);
        _settleExpecting(
            reversed,
            amountIn,
            SIGNER_KEY,
            abi.encodeWithSelector(FxDeviationGuard.MidPairMismatch.selector, address(eurc), address(usdc))
        );
    }

    /// @notice The same signed mid cannot be spent twice, and the second attempt is
    ///         refused before anything moves.
    ///
    /// @dev The stale-mid threat in its concrete form: a rate quoted before a real
    ///      market move, replayed after it. `sessionId` is what distinguishes two
    ///      quotes for the same pair in the same minute, so consuming it is the one
    ///      thing `validUntil` alone cannot do.
    function test_midCannotBeReplayed() public {
        uint256 amountIn = 250e6;
        uint256 midE18 = 11e17;
        venue.setFill(guard.floorFor(amountIn, midE18));

        FxMidAttestation.Mid memory mid = _mid(keccak256("once"), midE18);
        uint256 first = _settle(mid, amountIn, SIGNER_KEY);
        assertGt(first, 0, "the first fill should have cleared");

        uint256 balanceAfterFirst = eurc.balanceOf(recipient);

        _settleExpecting(
            mid,
            amountIn,
            SIGNER_KEY,
            abi.encodeWithSelector(FxDeviationGuard.MidAlreadyUsed.selector, mid.sessionId)
        );

        assertEq(
            eurc.balanceOf(recipient),
            balanceAfterFirst,
            "a replayed mid moved value a second time, which is a stale rate becoming a real trade"
        );
    }

    /// @notice The sharpest test here: a venue that quotes honestly and fills badly.
    ///
    /// @dev If the guard read `quote()` this would pass when it should fail, and that
    ///      single fact is the whole reason FX-05's guard is onchain rather than in the
    ///      quoting service. A service checking its own quote against a venue's quote
    ///      is comparing two statements by the same party.
    function test_guardMeasuresTheFillNotTheQuote() public {
        uint256 amountIn = 500e6;
        uint256 midE18 = 1e18;

        uint256 expected = (amountIn * midE18) / 1e18;
        uint256 floor_ = guard.floorFor(amountIn, midE18);

        // Honest to the last unit on the way in, short on the way out.
        venue.setQuote(expected);
        venue.setFill(floor_ - 1);

        assertEq(
            venue.quote(address(usdc), address(eurc), amountIn),
            expected,
            "the double is meant to quote honestly here; if it does not, this test proves nothing"
        );

        uint256 balanceBefore = eurc.balanceOf(recipient);
        FxMidAttestation.Mid memory mid = _mid(keccak256("honest.quote"), midE18);

        _settleExpecting(mid, amountIn, SIGNER_KEY, _fillOutsideGuard(floor_ - 1, floor_));

        assertEq(
            eurc.balanceOf(recipient),
            balanceBefore,
            "the guard read the quote instead of the fill and let a short fill through"
        );
    }

    /// @notice And a venue that fills badly while claiming otherwise.
    ///
    /// @dev `settle`'s return value is the venue's word too. The guard compares the
    ///      lesser of that figure and the recipient's measured balance delta, so a
    ///      venue cannot buy a passing fill by overstating one.
    function test_guardCatchesAVenueThatOverstatesItsFill() public {
        uint256 amountIn = 400e6;
        uint256 midE18 = 1e18;
        uint256 floor_ = guard.floorFor(amountIn, midE18);

        // Delivers one unit under the floor; claims it delivered twice the floor.
        venue.setLyingFill(floor_ - 1, floor_ * 2);

        uint256 balanceBefore = eurc.balanceOf(recipient);
        FxMidAttestation.Mid memory mid = _mid(keccak256("lying"), midE18);

        _settleExpecting(mid, amountIn, SIGNER_KEY, _fillOutsideGuard(floor_ - 1, floor_));

        assertEq(
            eurc.balanceOf(recipient),
            balanceBefore,
            "a venue talked its way past the guard by overstating a fill it had not made"
        );
    }

    /// @notice The tolerance is governance's, inside a band the registry compiled.
    ///
    /// @dev A fill refused at the seeded deviation clears once governance widens it
    ///      inside the band, and the widening direction stops existing once the band is
    ///      narrowed around it. Neither is the contract's to choose, which is why
    ///      `FX_MAX_DEVIATION_BPS` is a registry read on every call rather than a
    ///      constant compiled into the guard.
    function test_deviationBandComesFromTheRegistry() public {
        uint256 amountIn = 1000e6;
        uint256 midE18 = 1e18;
        uint256 expected = (amountIn * midE18) / 1e18;

        // 200 bps below the mid: outside the seeded 100 bps tolerance.
        uint256 realised = (expected * (PlanParams.BPS - 200)) / PlanParams.BPS;
        venue.setFill(realised);

        uint256 tightFloor = guard.floorFor(amountIn, midE18);
        assertGt(tightFloor, realised, "the fixture must start with a fill the seeded band refuses");

        _settleExpecting(
            _mid(keccak256("tight"), midE18), amountIn, SIGNER_KEY, _fillOutsideGuard(realised, tightFloor)
        );

        // Governance widens, inside the compiled band.
        parameters.set(ParameterKeys.FX_MAX_DEVIATION_BPS, 300);
        assertLe(guard.floorFor(amountIn, midE18), realised, "the widened tolerance did not reach the fill");

        uint256 amountOut = _settle(_mid(keccak256("loose"), midE18), amountIn, SIGNER_KEY);
        assertEq(amountOut, realised, "the same fill was still refused after governance widened the band");

        // Narrowing is one-way, and it takes the widening direction away for good.
        parameters.narrowBand(ParameterKeys.FX_MAX_DEVIATION_BPS, 1, 300);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParameterRegistry.OutOfBand.selector, ParameterKeys.FX_MAX_DEVIATION_BPS, 301, 1, 300
            )
        );
        parameters.set(ParameterKeys.FX_MAX_DEVIATION_BPS, 301);
    }

    /// @notice No standing approval to an external venue survives the call.
    ///
    /// @dev A live allowance from the guard to a venue is a withdrawal right on the
    ///      guard's balance that outlives the trade it was granted for. On the refusing
    ///      branch the allowance is zero because the whole transaction is undone —
    ///      worth asserting precisely because it would stop being true the moment
    ///      anyone wrapped `settle` in a `try/catch`.
    function test_approvalIsZeroedAfterSettle() public {
        uint256 amountIn = 300e6;
        uint256 midE18 = 1e18;
        uint256 floor_ = guard.floorFor(amountIn, midE18);

        venue.setFill(floor_);
        _settle(_mid(keccak256("approve.ok"), midE18), amountIn, SIGNER_KEY);
        assertEq(
            usdc.allowance(address(guard), address(venue)),
            0,
            "the guard left a standing allowance to the venue after a successful fill"
        );

        venue.setFill(floor_ - 1);
        _settleExpecting(
            _mid(keccak256("approve.bad"), midE18),
            amountIn,
            SIGNER_KEY,
            _fillOutsideGuard(floor_ - 1, floor_)
        );
        assertEq(
            usdc.allowance(address(guard), address(venue)),
            0,
            "the guard left a standing allowance to the venue after a refused fill"
        );
    }

    // ─── The venues ──────────────────────────────────────────────────────────

    /// @notice The StableFX stub refuses, and says which credential is missing.
    ///
    /// @dev An operator reading a failed origination has to be able to tell in one line
    ///      that this is an access item on the third-party track and not a bug in the
    ///      corridor. `supportsPair` still answers, because a caller enumerating venues
    ///      must be able to ask without the ask itself failing.
    function test_stubVenueRefusesAndDoesNotQuote() public view {
        assertFalse(
            stub.supportsPair(address(usdc), address(eurc)),
            "the stub refused the question as well as the answer, which makes the seam unusable"
        );

        (bool quoted, bytes memory quoteData) =
            address(stub).staticcall(abi.encodeCall(IFxVenue.quote, (address(usdc), address(eurc), 100e6)));
        assertFalse(quoted, "the stub returned a rate it cannot possibly know");
        assertEq(
            bytes4(quoteData), StableFxVenueStub.NotAccessible.selector, "the quote refusal was not typed"
        );
        assertEq(_reasonOf(quoteData), STUB_REASON, "the quote refusal did not name the missing key");

        (bool settled, bytes memory settleData) = address(stub)
            .staticcall(abi.encodeCall(IFxVenue.settle, (address(usdc), address(eurc), 100e6, 0, recipient)));
        assertFalse(settled, "the stub settled a trade it has no access to settle");
        assertEq(
            bytes4(settleData), StableFxVenueStub.NotAccessible.selector, "the settle refusal was not typed"
        );
        assertEq(_reasonOf(settleData), STUB_REASON, "the settle refusal did not name the missing key");
    }

    /// @notice The shipped AMM configuration: a router that does not exist.
    ///
    /// @dev Finding 34 — seven candidate routers probed on Arc testnet, zero holding
    ///      bytecode. So `address(0)` is not a test fixture, it is the deployment, and
    ///      the refusal has to be legible rather than an arithmetic error thrown from
    ///      somewhere inside a call to nothing.
    function test_ammVenueWithZeroRouterRefuses() public {
        assertEq(amm.router(), address(0), "the fixture must be the shipped zero-router configuration");
        assertFalse(
            amm.supportsPair(address(usdc), address(eurc)),
            "a venue with no router claimed it could trade the pair"
        );

        vm.expectRevert(AmmVenue.VenueUnavailable.selector);
        amm.quote(address(usdc), address(eurc), 100e6);

        vm.expectRevert(AmmVenue.VenueUnavailable.selector);
        amm.settle(address(usdc), address(eurc), 100e6, 0, recipient);
    }

    // ─── Fixture ─────────────────────────────────────────────────────────────

    function _mid(bytes32 sessionId, uint256 midE18) internal view returns (FxMidAttestation.Mid memory) {
        return FxMidAttestation.Mid({
            corridor: CORRIDOR,
            fromToken: address(usdc),
            toToken: address(eurc),
            midE18: midE18,
            validUntil: vm.getBlockTimestamp() + 2 minutes,
            sessionId: sessionId
        });
    }

    function _sign(FxMidAttestation.Mid memory mid, uint256 key) internal view returns (bytes memory) {
        bytes32 digest = FxMidAttestation.digest(mid, block.chainid, address(guard));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _fund(uint256 amountIn) internal {
        usdc.mint(payer, amountIn);
        vm.prank(payer);
        usdc.approve(address(guard), amountIn);
    }

    function _settle(
        FxMidAttestation.Mid memory mid,
        uint256 amountIn,
        uint256 key
    ) internal returns (uint256) {
        _fund(amountIn);
        bytes memory signature = _sign(mid, key);
        vm.prank(payer);
        return guard.settleGuarded(venue, mid, signature, amountIn, recipient);
    }

    /// @dev Funding and signing happen first so that `expectRevert` sits immediately
    ///      before the call under test and cannot be consumed by a mint or an approve.
    function _settleExpecting(
        FxMidAttestation.Mid memory mid,
        uint256 amountIn,
        uint256 key,
        bytes memory expected
    ) internal {
        _fund(amountIn);
        bytes memory signature = _sign(mid, key);
        vm.prank(payer);
        vm.expectRevert(expected);
        guard.settleGuarded(venue, mid, signature, amountIn, recipient);
    }

    function _fillOutsideGuard(uint256 amountOut, uint256 floor_) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(FxDeviationGuard.FillOutsideGuard.selector, amountOut, floor_);
    }

    /// @dev Pull the `reason` string out of a `NotAccessible(string)` revert payload.
    function _reasonOf(bytes memory data) internal pure returns (string memory) {
        bytes memory payload = new bytes(data.length - 4);
        for (uint256 i = 0; i < payload.length; ++i) {
            payload[i] = data[i + 4];
        }
        return abi.decode(payload, (string));
    }
}
