// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {OriginationFixture} from "./helpers/OriginationFixture.sol";

import {TranchedCreditPool} from "../src/TranchedCreditPool.sol";
import {TrancheToken} from "../src/TrancheToken.sol";
import {PoolRegistry} from "../src/PoolRegistry.sol";
import {ICreditPool} from "../src/interfaces/ICreditPool.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";

/// @title TranchesTest
/// @notice The capital structure: who may hold a claim, what it is worth, and when
///         they are allowed to let go of it.
///
/// @dev POOL-01, POOL-02, POOL-03, POOL-06, POOL-10 and POOL-12. The three-legged
///      inflation defence gets three separate tests rather than one, because each leg
///      has a known bypass on its own and a single test would not tell you which one
///      was carrying the weight.
contract TranchesTest is OriginationFixture {
    address internal secondLender = address(0x1E2);

    function setUp() public {
        _deployStack();
        _prepareOrigination();
    }

    // ─── POOL-02: transfer restriction ───────────────────────────────────────

    /// @notice A tranche share cannot be minted to an address nobody has considered.
    /// @dev Default deny on the *mint*, not just the transfer. A restriction the primary
    ///      distribution walks past is a restriction on the secondary market only, and
    ///      the primary distribution is exactly where an ineligible holder is created.
    function test_aTrancheShareCannotReachAnIneligibleHolder() public {
        usdc.mint(stranger, 1_000e6);
        vm.startPrank(stranger);
        usdc.approve(address(creditPool), 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(TranchedCreditPool.NotEligible.selector, stranger));
        creditPool.requestDeposit(ICreditPool.Tranche.Senior, 1_000e6);
        vm.stopPrank();
    }

    /// @notice Nor can it be transferred to one.
    function test_aTrancheShareCannotBeTransferredToAnIneligibleHolder() public {
        TrancheToken senior = creditPool.seniorShares();
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSelector(TrancheToken.TransferNotPermitted.selector, lender, stranger)
        );
        senior.transfer(stranger, 1e9);
    }

    function test_anEligibleHolderCanReceiveShares() public {
        eligibility.setGlobal(secondLender, true);
        TrancheToken senior = creditPool.seniorShares();

        uint256 before = senior.balanceOf(lender);
        vm.prank(lender);
        senior.transfer(secondLender, 1e9);

        assertEq(senior.balanceOf(secondLender), 1e9, "an eligible holder was refused");
        assertEq(senior.balanceOf(lender), before - 1e9);
    }

    /// @notice Only the pool mints or burns.
    function test_onlyThePoolCanMint() public {
        TrancheToken senior = creditPool.seniorShares();
        vm.expectRevert(abi.encodeWithSelector(TrancheToken.OnlyPool.selector, address(this)));
        senior.mint(lender, 1e9);
    }

    // ─── POOL-10: the junior lockup ──────────────────────────────────────────

    /// @notice Junior shares are locked for a full product tenor.
    function test_juniorSharesAreLockedForATenor() public {
        eligibility.setGlobal(secondLender, true);
        TrancheToken junior = creditPool.juniorShares();

        uint256 until = junior.unlockAt(lender);
        assertGt(until, vm.getBlockTimestamp(), "the junior receipt did not lock");

        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(TrancheToken.SharesLocked.selector, lender, until));
        junior.transfer(secondLender, 1e9);

        vm.warp(until + 1);
        vm.prank(lender);
        junior.transfer(secondLender, 1e9);
        assertEq(junior.balanceOf(secondLender), 1e9, "the lock did not expire");
    }

    /// @notice Senior carries no lock.
    /// @dev The token is read into a local first. `vm.prank` is consumed by the next
    ///      external call, and `creditPool.seniorShares()` is one — inlining it pranks
    ///      the getter and transfers from the test contract instead.
    function test_seniorSharesAreNotLocked() public {
        eligibility.setGlobal(secondLender, true);
        TrancheToken senior = creditPool.seniorShares();

        vm.prank(lender);
        senior.transfer(secondLender, 1e9);
        assertEq(senior.balanceOf(secondLender), 1e9);
    }

    /// @notice A transfer can push the lock later, never earlier.
    ///
    /// @dev DEC-29. Measured per holder the lock is defeated by moving to a fresh
    ///      address, which has no history and therefore no clock. Measured per receipt
    ///      — every inbound movement stamps the recipient forward — the fresh address
    ///      starts a full tenor from the moment it receives, which is strictly worse for
    ///      the evader than staying put.
    function test_theJuniorLockFollowsTheShareNotTheHolder() public {
        eligibility.setGlobal(secondLender, true);
        TrancheToken junior = creditPool.juniorShares();

        vm.warp(junior.unlockAt(lender) + 1);
        vm.prank(lender);
        junior.transfer(secondLender, 1e9);

        uint256 fresh = junior.unlockAt(secondLender);
        assertEq(fresh, vm.getBlockTimestamp() + junior.lockPeriod(), "the receipt did not restamp");

        vm.prank(secondLender);
        vm.expectRevert(
            abi.encodeWithSelector(TrancheToken.SharesLocked.selector, secondLender, fresh)
        );
        junior.transfer(lender, 1e9);
    }

    // ─── POOL-12: the three legs ─────────────────────────────────────────────

    /// @notice Leg one — the decimals offset.
    function test_sharesCarryTheDecimalsOffset() public view {
        assertEq(
            creditPool.seniorShares().decimals(),
            usdc.decimals() + creditPool.seniorShares().DECIMALS_OFFSET(),
            "the share token dropped the decimals offset"
        );
    }

    /// @notice Leg two — a tranche cannot take a deposit before it is seeded.
    /// @dev The "first depositor into an empty vault" case is not made expensive, it is
    ///      made unreachable, and the seed is protocol money rather than a slice of the
    ///      first lender's.
    function test_aTrancheRefusesDepositsUntilItIsSeeded() public {
        TranchedCreditPool fresh = _freshPool();
        eligibility.setGlobal(address(fresh), true);

        usdc.mint(lender, 1_000e6);
        vm.startPrank(lender);
        usdc.approve(address(fresh), 1_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(TranchedCreditPool.NotSeeded.selector, ICreditPool.Tranche.Junior)
        );
        fresh.requestDeposit(ICreditPool.Tranche.Junior, 1_000e6);
        vm.stopPrank();
    }

    /// @notice Leg three — a donation moves the balance and nothing else.
    ///
    /// @dev POOL-11 from the attacker's side. The classic inflation attack needs the
    ///      vault to read its own token balance; this one never does, so the donation is
    ///      a gift to nobody. It does not reach NAV, it does not move a share price, and
    ///      it does not become claimable.
    function test_aDonationDoesNotReachNav() public {
        uint256 assetsBefore = creditPool.totalAssets();
        uint256 priceBefore = creditPool.navPerShare(ICreditPool.Tranche.Junior);

        usdc.mint(address(creditPool), 500_000e6);

        assertEq(creditPool.totalAssets(), assetsBefore, "a donation moved NAV");
        assertEq(
            creditPool.navPerShare(ICreditPool.Tranche.Junior),
            priceBefore,
            "a donation moved the junior share price"
        );
    }

    // ─── POOL-03: asynchronous entry ─────────────────────────────────────────

    /// @notice A pending deposit is not a claim, and can be taken back intact.
    function test_aPendingDepositIsNotAClaimAndCanBeCancelled() public {
        eligibility.setGlobal(secondLender, true);
        usdc.mint(secondLender, 5_000e6);

        uint256 assetsBefore = creditPool.totalAssets();

        vm.startPrank(secondLender);
        usdc.approve(address(creditPool), 5_000e6);
        creditPool.requestDeposit(ICreditPool.Tranche.Junior, 5_000e6);
        vm.stopPrank();

        assertEq(creditPool.totalAssets(), assetsBefore, "a pending deposit reached NAV");
        assertEq(creditPool.juniorShares().balanceOf(secondLender), 0, "a pending deposit issued shares");

        vm.prank(secondLender);
        creditPool.cancelDeposit(ICreditPool.Tranche.Junior);
        assertEq(usdc.balanceOf(secondLender), 5_000e6, "the cancellation returned something else");
    }

    /// @notice Shares cannot be claimed before the epoch that prices them closes.
    function test_sharesCannotBeClaimedBeforeTheEpochCloses() public {
        eligibility.setGlobal(secondLender, true);
        usdc.mint(secondLender, 5_000e6);

        vm.startPrank(secondLender);
        usdc.approve(address(creditPool), 5_000e6);
        creditPool.requestDeposit(ICreditPool.Tranche.Junior, 5_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(TranchedCreditPool.NotYetPriced.selector, creditPool.currentEpoch())
        );
        creditPool.claimShares(ICreditPool.Tranche.Junior);
        vm.stopPrank();
    }

    /// @notice Two depositors in one epoch are priced identically.
    /// @dev The property that makes next-epoch NAV worth having. A synchronous vault
    ///      prices you at the moment you transacted, so being second in the block is
    ///      worth something; here it is worth nothing.
    function test_twoDepositorsInOneEpochGetTheSamePrice() public {
        eligibility.setGlobal(secondLender, true);
        usdc.mint(secondLender, 4_000e6);
        usdc.mint(lender, 2_000e6);

        vm.startPrank(secondLender);
        usdc.approve(address(creditPool), 4_000e6);
        creditPool.requestDeposit(ICreditPool.Tranche.Junior, 4_000e6);
        vm.stopPrank();

        vm.startPrank(lender);
        usdc.approve(address(creditPool), 2_000e6);
        creditPool.requestDeposit(ICreditPool.Tranche.Junior, 2_000e6);
        vm.stopPrank();

        uint256 lenderBefore = creditPool.juniorShares().balanceOf(lender);
        _closeEpoch();

        vm.prank(secondLender);
        uint256 a = creditPool.claimShares(ICreditPool.Tranche.Junior);
        vm.prank(lender);
        uint256 b = creditPool.claimShares(ICreditPool.Tranche.Junior);

        assertEq(creditPool.juniorShares().balanceOf(lender) - lenderBefore, b);
        // Twice the money, twice the shares, within rounding.
        assertApproxEqRel(a, b * 2, 1e12, "two depositors in one epoch were priced differently");
    }

    // ─── POOL-06: the constraint binds on senior first ───────────────────────

    /// @notice A senior deposit that would thin subordination past the floor is refused.
    /// @dev The proportionate lever. Halting origination while the book's liabilities
    ///      keep running is a book in runoff; refusing the money that would cause the
    ///      breach is not.
    function test_aSeniorDepositBreachingSubordinationIsRefused() public {
        uint256 room = creditPool.maxSeniorDeposit();
        assertGt(room, 0, "the book had no senior capacity at all");

        usdc.mint(lender, room + 1e6);
        vm.startPrank(lender);
        usdc.approve(address(creditPool), room + 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                TranchedCreditPool.SubordinationFloor.selector,
                room,
                parameters.get(ParameterKeys.MIN_SUBORDINATION_BPS)
            )
        );
        creditPool.requestDeposit(ICreditPool.Tranche.Senior, room + 1e6);
        vm.stopPrank();
    }

    /// @notice Senior capacity counts junior money pending in the same epoch.
    /// @dev Otherwise a book being capitalised could not take both legs in one epoch,
    ///      and the answer would depend on which order two lenders happened to transact
    ///      in. What stays refused is senior arriving before any junior at all — you
    ///      cannot be senior to nothing.
    function test_seniorCapacityCountsPendingJunior() public {
        uint256 before = creditPool.maxSeniorDeposit();

        usdc.mint(lender, 10_000e6);
        vm.startPrank(lender);
        usdc.approve(address(creditPool), 10_000e6);
        creditPool.requestDeposit(ICreditPool.Tranche.Junior, 10_000e6);
        vm.stopPrank();

        assertGt(
            creditPool.maxSeniorDeposit(), before, "pending junior money did not raise senior capacity"
        );
    }

    // ─── POOL-01: no tenor commingling ───────────────────────────────────────

    /// @notice The book refuses a schedule outside its own tenor band.
    function test_aPoolRefusesPaperOutsideItsTenorBand() public view {
        assertTrue(creditPool.acceptsSchedule(4, 14 days), "the Pay-in-4 book refused Pay-in-4");
        assertFalse(creditPool.acceptsSchedule(12, 30 days), "the Pay-in-4 book accepted a Flex tenor");
        assertFalse(creditPool.acceptsSchedule(4, 90 days), "the Pay-in-4 book accepted Terms paper");
    }

    /// @notice One pool per product line, and a line cannot be repointed.
    function test_aProductLineCannotBeRepointed() public {
        TranchedCreditPool other = _freshPool();
        vm.expectRevert(
            abi.encodeWithSelector(
                PoolRegistry.LineAlreadyRegistered.selector, PAY_IN_4, address(creditPool)
            )
        );
        poolRegistry.register(PAY_IN_4, address(other));
    }

    function _freshPool() private returns (TranchedCreditPool) {
        return new TranchedCreditPool(
            TranchedCreditPool.Wiring({
                admin: address(this),
                token: address(usdc),
                parameters: address(parameters),
                eligibility: address(eligibility),
                productLine: keccak256("PLAZO.FLEX"),
                minInstallments: 3,
                maxInstallments: 12,
                minInterval: 28 days,
                maxInterval: 31 days
            })
        );
    }
}
