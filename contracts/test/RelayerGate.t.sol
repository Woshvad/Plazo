// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {OriginationFixture} from "./helpers/OriginationFixture.sol";

import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {RelayerGate} from "../src/RelayerGate.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";

/// @title RelayerGateTest
/// @notice The operator's collections are late, and provably so.
///
/// @dev COLL-07 and OPS-04. The load-bearing claim in this whole design is that the
///      keeper market makes the operator redundant, and COLL-10 measures it — but the
///      measurement means nothing if the operator can crank at `validAfter` like
///      everybody else, because then every collection it wins is one a third party
///      might otherwise have taken.
///
///      What this suite checks is that the floor is enforced somewhere an outsider can
///      audit, and that it costs a borrower nothing.
contract RelayerGateTest is OriginationFixture {
    address internal operator = address(0x09E);

    function setUp() public {
        _deployStack();
        _prepareOrigination();
        relayer.grantRole(relayer.RELAYER_ROLE(), operator);
    }

    /// @notice The operator cannot collect inside the floor.
    function test_theOperatorCannotCollectEarly() public {
        InstallmentPlan p = _checkoutDefault();
        _fundBorrower(200e6);

        vm.warp(p.dueDate(1));
        uint256 earliest = relayer.earliestFor(address(p), 1);
        assertEq(
            earliest,
            p.dueDate(1) + parameters.get(ParameterKeys.RELAYER_DELAY_FLOOR),
            "the floor is not the parameter"
        );

        // The expected-revert payload is built first. `p.dueDate(1)` is an external
        // call, and building it inline would consume the prank meant for `collect`.
        bytes memory expected = abi.encodeWithSelector(RelayerGate.TooEarly.selector, p.dueDate(1), earliest);

        vm.prank(operator);
        vm.expectRevert(expected);
        relayer.collect(address(p), 1);
    }

    /// @notice Anyone else can collect the moment it is due.
    ///
    /// @dev The borrower is never worse off for the gate existing. The plan stays
    ///      permissionless from `validAfter`; this contract simply declines to be that
    ///      anyone for the first half hour, which is what makes an early collection
    ///      provably not the operator's.
    function test_aThirdPartyCollectsAtValidAfterRegardless() public {
        InstallmentPlan p = _checkoutDefault();
        _fundBorrower(200e6);

        vm.warp(p.dueDate(1));
        vm.prank(keeper);
        (bool cleared,) = p.collect(1);

        assertTrue(cleared, "the third party could not collect at the due date");
    }

    /// @notice Past the floor, the operator collects and the bounty lands at the gate.
    /// @dev The gate is the `msg.sender` of the crank, so it is paid. That is what makes
    ///      the operator's collections identifiable from the chain alone: they all come
    ///      from one address, and every one of them is late.
    function test_pastTheFloorTheOperatorCollectsAndIsPaid() public {
        InstallmentPlan p = _checkoutDefault();
        _fundBorrower(200e6);

        vm.warp(relayer.earliestFor(address(p), 1) + 1);
        vm.prank(operator);
        relayer.collect(address(p), 1);

        assertTrue(p.isCleared(1), "the operator's collection did not clear");
        assertGt(usdc.balanceOf(address(relayer)), 0, "the bounty did not reach the gate");
    }

    /// @notice Marking is gated too.
    /// @dev The mark carries a bounty as well, so an operator that could mark instantly
    ///      would be taking the same paid work the market is supposed to do. The floor
    ///      applies to the whole crank surface or it applies to nothing.
    function test_markingIsGatedOnTheSameFloor() public {
        InstallmentPlan p = _checkoutDefault();

        vm.warp(p.dueDate(0) + 1);
        vm.prank(operator);
        vm.expectRevert();
        relayer.markMissed(address(p), 0);

        vm.warp(p.graceEndsAt(0) + 1);
        vm.prank(operator);
        relayer.markMissed(address(p), 0);
        assertTrue(p.isMarked(0), "the operator could not mark after the floor");
    }

    /// @notice Only the operator's key can use the gate.
    function test_theGateIsNotAPublicCrank() public {
        InstallmentPlan p = _checkoutDefault();
        vm.warp(relayer.earliestFor(address(p), 1) + 1);

        vm.prank(stranger);
        vm.expectRevert();
        relayer.collect(address(p), 1);
    }

    /// @notice Collected bounties can be swept to the operator's treasury.
    function test_bountiesCanBeSwept() public {
        InstallmentPlan p = _checkoutDefault();
        _fundBorrower(200e6);

        vm.warp(relayer.earliestFor(address(p), 1) + 1);
        vm.prank(operator);
        relayer.collect(address(p), 1);

        uint256 earned = usdc.balanceOf(address(relayer));
        relayer.sweep(address(usdc), operator, earned);

        assertEq(usdc.balanceOf(operator), earned, "the sweep paid somewhere else");
        assertEq(usdc.balanceOf(address(relayer)), 0);
    }

    /// @notice With the operator's role revoked, collection still completes.
    ///
    /// @dev GOV-08's rehearsal, narrowed to this component. The relayer provides
    ///      redundancy; it is not load-bearing, and the way to prove that is to take it
    ///      away and watch the loop close anyway.
    function test_withTheRelayerGoneCollectionStillCompletes() public {
        InstallmentPlan p = _checkoutDefault();
        _fundBorrower(200e6);

        relayer.revokeRole(relayer.RELAYER_ROLE(), operator);

        vm.warp(p.dueDate(1));
        vm.prank(keeper);
        p.collect(1);

        vm.warp(p.dueDate(2));
        vm.prank(stranger);
        p.collect(2);

        assertTrue(p.isCleared(1) && p.isCleared(2), "the loop needed the operator after all");
    }
}
