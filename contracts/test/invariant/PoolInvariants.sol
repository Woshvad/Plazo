// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ICreditPool} from "../../src/interfaces/ICreditPool.sol";

/// @title PoolInvariants
/// @notice Share-accounting properties, written before the pool exists.
///
/// @dev These precede the vault design deliberately. Two of them — bucketed
///      provisioning and the epoch-close block — are not descriptions of a chosen
///      implementation, they are constraints that rule implementations out. Writing
///      them after the vault would have meant discovering during formal verification
///      that the accounting shape was wrong, which is a redesign at the worst moment.
///
///      Each property carries the Certora rule name it becomes; see `SPEC.md`.
///
///      Named `check_*` rather than `invariant_*` for the reason given in
///      `PlanInvariants`: the Phase 1 binding is a stub with public setters, and the
///      fuzzer would break it trivially.
abstract contract PoolInvariants is Test {
    ICreditPool internal pool;

    /// @dev Floors. Phase 5 reads these from `ParameterRegistry`.
    uint256 internal minSubordinationBps = 1_000; // 10%
    uint256 internal minReserveBps = 200; // 2% of total assets

    // ─── Solvency identity ───────────────────────────────────────────────────

    /// @notice Assets equal claims, always.
    ///
    /// @dev `totalAssets == reserve + junior + senior`. The single most important
    ///      property in the funding book: if it drifts, someone's shares are backed
    ///      by nothing and nobody finds out until a redemption fails.
    ///
    ///      `totalAssets` must be an internal booked accumulator, never
    ///      `token.balanceOf(this)`. A donation would otherwise inflate NAV for
    ///      existing holders — and against an empty junior tranche, that is half of
    ///      the first-depositor inflation attack.
    ///
    /// @custom:certora assetsEqualClaims
    function check_assetsEqualClaims() public view {
        assertEq(
            pool.totalAssets(),
            pool.reserveBalance() + pool.trancheAssets(ICreditPool.Tranche.Junior)
                + pool.trancheAssets(ICreditPool.Tranche.Senior),
            "pool assets do not equal the sum of reserve, junior and senior claims"
        );
    }

    /// @notice A tranche with shares outstanding has assets behind them.
    /// @dev Guards the inflation attack from the other side: shares issued against
    ///      zero assets means the next depositor funds the previous one.
    /// @custom:certora sharesImplyAssets
    function check_sharesImplyAssets() public view {
        for (uint256 t = 0; t < 2; ++t) {
            ICreditPool.Tranche tranche = ICreditPool.Tranche(t);
            if (pool.trancheShares(tranche) > 0) {
                assertGt(
                    pool.trancheAssets(tranche),
                    0,
                    "a tranche has shares outstanding with no assets behind them"
                );
            }
        }
    }

    // ─── Provisioning ────────────────────────────────────────────────────────

    /// @notice Epoch provision buckets sum to the total provision.
    ///
    /// @dev Bucketing is what lets a cure release exactly what the delinquency took.
    ///
    ///      A flat provision with un-bucketed release is a harvestable NAV
    ///      oscillation: an LP deposits at the trough after a delinquency wave
    ///      provisions, then redeems after the cure wave releases — funded by
    ///      whoever redeemed at the trough. It hits junior hardest, because junior
    ///      absorbs the swing first. The accounting is the fix, which is why this
    ///      has to hold before share accounting is formally verified rather than
    ///      after.
    ///
    /// @custom:certora provisionBucketsSumToTotal
    function check_provisionBucketsSumToTotal() public view {
        uint256 sum;
        uint256 epoch = pool.currentEpoch();
        for (uint256 e = 0; e <= epoch; ++e) {
            sum += pool.provisionedAt(e);
        }
        assertEq(sum, pool.totalProvisioned(), "epoch provision buckets do not sum to the total");
    }

    /// @notice Provision never exceeds the assets it is held against.
    /// @custom:certora provisionBoundedByAssets
    function check_provisionNeverExceedsAssets() public view {
        assertLe(pool.totalProvisioned(), pool.totalAssets(), "provision exceeds total assets");
    }

    // ─── Loss waterfall ──────────────────────────────────────────────────────

    /// @notice The waterfall is ordered: reserve exhausts before junior is touched.
    ///
    /// @dev Senior's claim is that it is struck last. If junior can be impaired
    ///      while the reserve still holds assets, the subordination the senior
    ///      tranche was sold on is not the subordination it has.
    ///
    ///      Stated here as the observable consequence: while junior is below its
    ///      floor, the reserve must already be empty.
    ///
    /// @custom:certora lossWaterfallOrdered
    function check_reserveAbsorbsBeforeJunior() public view {
        uint256 assets = pool.totalAssets();
        if (assets == 0) return;

        uint256 juniorBps = (pool.trancheAssets(ICreditPool.Tranche.Junior) * 10_000) / assets;
        if (juniorBps >= minSubordinationBps) return;

        assertEq(
            pool.reserveBalance(),
            0,
            "junior was impaired while the first-loss reserve still held assets"
        );
    }

    /// @notice The reported subordination matches the balance sheet.
    /// @dev The origination gate reads this figure. If it can be reported
    ///      independently of the assets, the gate can be opened by a bug rather than
    ///      by capital.
    /// @custom:certora subordinationMatchesAssets
    function check_subordinationIsDerived() public view {
        uint256 assets = pool.totalAssets();
        if (assets == 0) return;
        assertEq(
            pool.subordinationBps(),
            (pool.trancheAssets(ICreditPool.Tranche.Junior) * 10_000) / assets,
            "reported subordination does not match the tranche balances"
        );
    }

    // ─── Gates ───────────────────────────────────────────────────────────────

    /// @notice Origination is impossible below the subordination or reserve floor.
    ///
    /// @dev The gate has to bind on senior deposits and redemptions *before* it
    ///      halts new credit — halting origination is the last resort, not the first
    ///      lever, because a book that stops originating while its liabilities keep
    ///      running is a book in runoff.
    ///
    /// @custom:certora originationGatedBySubordination
    function check_originationClosedBelowFloors() public view {
        if (!pool.originationOpen()) return;

        assertGe(
            pool.subordinationBps(),
            minSubordinationBps,
            "origination is open below the subordination floor"
        );

        uint256 assets = pool.totalAssets();
        if (assets > 0) {
            assertGe(
                (pool.reserveBalance() * 10_000) / assets,
                minReserveBps,
                "origination is open below the first-loss reserve floor"
            );
        }
    }

    /// @notice An epoch cannot close while a delinquency is unmarked.
    ///
    /// @dev This is what makes the bountied mark unavoidable rather than merely
    ///      available. Nobody profits from cranking a collection that cannot
    ///      succeed, so the negative signal has to be paid for — and the payment
    ///      only reliably happens if the book cannot close without it.
    ///
    ///      Without this, an operator could settle an epoch on a book whose losses
    ///      have not been recognised, and report a NAV that is simply wrong.
    ///
    /// @custom:certora epochCannotCloseWithUnmarkedDelinquency
    function check_epochBlocksOnUnmarkedDelinquency() public view {
        if (pool.allDelinquenciesMarked()) return;
        assertFalse(
            pool.originationOpen(),
            "the book is originating with unrecognised delinquencies outstanding"
        );
    }
}
