// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IInstallmentPlan} from "../../src/interfaces/IInstallmentPlan.sol";

/// @title PlanInvariants
/// @notice Properties any `InstallmentPlan` must satisfy, written before one exists.
///
/// @dev Written first on purpose. An invariant suite written after the contract it
///      constrains tends to describe the contract rather than the requirement — it
///      encodes what the code happens to do, and then passes forever. These were
///      derived from the specification and the loss model, and the implementation
///      arriving in Phase 2 has to satisfy them rather than the other way round.
///
///      This is also the formal-verification specification. Each property below
///      carries the Certora rule name it becomes; see `SPEC.md`.
///
///      Bind it by inheriting and setting `subject`. Phase 1 bound it to a
///      deliberately breakable stub to prove the assertions fire; Phase 2 binds it
///      to the real `InstallmentPlan` under a fuzzing handler.
///
///      Named `check_*` rather than `invariant_*` on purpose. Foundry's invariant
///      fuzzer picks up `invariant_*` on any inheriting contract and drives it
///      against whatever is deployed — which, in the Phase 1 binding, is a stub with
///      public setters for every field. It would break trivially and prove nothing.
///      `PlanFuzz.t.sol` wraps these in thin `invariant_*` entry points now that
///      there is a real system worth fuzzing.
abstract contract PlanInvariants is Test {
    IInstallmentPlan internal subject;

    /// @dev Grace window in seconds. Phase 2 reads this from `ParameterRegistry`.
    uint256 internal graceWindow = 3 days;

    // ─── Conservation ────────────────────────────────────────────────────────

    /// @notice Every unit collected is accounted for.
    ///
    /// @dev `collected + refundCredit == (principal - outstanding) + feesPaid`.
    ///
    ///      The plan holds no float. Money that arrives has either retired principal
    ///      or paid a fee, and a refund credit stands in for principal the merchant
    ///      gave back. If this drifts, the pool's booked accumulator and the plan
    ///      disagree, and the disagreement compounds silently across a book because
    ///      nothing reconciles a plan against the pool per-plan.
    ///
    /// @custom:certora planValueConserved
    function check_valueIsConserved() public view {
        uint256 retired = subject.principal() - subject.outstandingPrincipal();
        assertEq(
            subject.totalCollected() + subject.refundCredit(),
            retired + subject.feesPaid(),
            "value conservation broken: collections do not equal principal retired plus fees paid"
        );
    }

    /// @notice Outstanding principal never exceeds principal.
    /// @custom:certora outstandingBoundedByPrincipal
    function check_outstandingNeverExceedsPrincipal() public view {
        assertLe(subject.outstandingPrincipal(), subject.principal(), "outstanding exceeds principal");
    }

    /// @notice The payoff figure covers everything owed and nothing more.
    /// @dev A borrower paying `payoffAmount()` must reach a terminal state. If payoff
    ///      understated the debt, a borrower who paid in full would still be
    ///      delinquent; if it overstated, the protocol would be collecting money it
    ///      cannot account for.
    /// @custom:certora payoffCoversOutstanding
    function check_payoffCoversOutstanding() public view {
        assertEq(
            subject.payoffAmount(),
            subject.outstandingPrincipal() + subject.feesOutstanding(),
            "payoff does not equal outstanding principal plus outstanding fees"
        );
    }

    // ─── The collection guarantee ────────────────────────────────────────────

    /// @notice No installment clears twice.
    ///
    /// @dev Belt and braces over the EIP-3009 nonce. The token already enforces
    ///      single use, but the plan's own accounting must not depend on the token
    ///      for a solvency property — `repay()` and a keeper `collect()` racing on
    ///      the same installment must not both credit it.
    ///
    /// @custom:certora noDoubleClear
    function check_noInstallmentClearsTwice() public view {
        uint256 count = subject.installmentCount();
        uint256 clearedSum;
        for (uint256 i = 0; i < count; ++i) {
            if (subject.installmentStatus(i) == IInstallmentPlan.InstallmentStatus.Cleared) {
                clearedSum += subject.installmentAmount(i);
            }
        }
        assertLe(
            clearedSum,
            subject.totalCollected() + subject.refundCredit(),
            "more installments are marked cleared than value has been collected"
        );
    }

    /// @notice Every installment past its grace window has a recorded outcome.
    ///
    /// @dev The highest-damage finding in the research corpus, as an assertion.
    ///
    ///      A failed pull reverts: it emits nothing, changes nothing, pays nobody.
    ///      Grace transitions, Passport marks, NAV provisioning, the subordination
    ///      gate and the first-payment-default kill switch are all fed by an event
    ///      that, left to the token, nobody creates. `try/catch` makes the bounce
    ///      *recordable*; a bountied `markMissed()` is what makes it *recorded*.
    ///
    ///      An installment resting in `Bounced` past grace is exactly the condition
    ///      that must block epoch settlement — see `PoolInvariants`.
    ///
    /// @custom:certora everyInstallmentAccountedFor
    function check_everyOverdueInstallmentIsAccountedFor() public view {
        uint256 count = subject.installmentCount();
        for (uint256 i = 0; i < count; ++i) {
            if (vm.getBlockTimestamp() <= subject.graceEndsAt(i)) continue;

            IInstallmentPlan.InstallmentStatus status = subject.installmentStatus(i);
            bool accounted = status == IInstallmentPlan.InstallmentStatus.Cleared
                || status == IInstallmentPlan.InstallmentStatus.Missed
                || status == IInstallmentPlan.InstallmentStatus.Expired
                || status == IInstallmentPlan.InstallmentStatus.Refunded;

            assertTrue(
                accounted,
                "an installment is past grace with no recorded outcome: the delinquency signal was never created"
            );
        }
    }

    /// @notice Due dates are strictly increasing.
    /// @dev A schedule that is not monotone makes "past grace" ambiguous, and every
    ///      collection and provisioning decision keys off it.
    /// @custom:certora scheduleMonotone
    function check_scheduleIsMonotone() public view {
        uint256 count = subject.installmentCount();
        for (uint256 i = 1; i < count; ++i) {
            assertGt(subject.dueDate(i), subject.dueDate(i - 1), "due dates are not strictly increasing");
        }
    }

    /// @notice Grace always ends after the due date it belongs to.
    /// @custom:certora graceFollowsDueDate
    function check_graceFollowsDueDate() public view {
        uint256 count = subject.installmentCount();
        for (uint256 i = 0; i < count; ++i) {
            assertGe(subject.graceEndsAt(i), subject.dueDate(i), "grace ends before the installment is due");
        }
    }

    // ─── State machine ───────────────────────────────────────────────────────

    /// @notice Terminal states are absorbing and carry no residue.
    ///
    /// @dev `Repaid` and `Defaulted` must be sinks. There is no path from `Repaid`
    ///      back to `Grace` — a borrower who paid in full cannot be made delinquent
    ///      by a late keeper crank, and a charged-off plan cannot resurrect and
    ///      double-count against the waterfall.
    ///
    ///      `Refunded` and `Cancelled` must leave no outstanding principal, or the
    ///      pool is carrying a receivable against a plan that no longer exists.
    ///
    /// @custom:certora terminalStatesAbsorbing
    function check_terminalStatesAreClean() public view {
        IInstallmentPlan.PlanState state = subject.state();

        if (state == IInstallmentPlan.PlanState.Repaid) {
            assertEq(subject.outstandingPrincipal(), 0, "Repaid plan still carries principal");
            assertEq(subject.feesOutstanding(), 0, "Repaid plan still carries fees");
        }

        if (state == IInstallmentPlan.PlanState.Refunded || state == IInstallmentPlan.PlanState.Cancelled) {
            assertEq(
                subject.outstandingPrincipal(),
                0,
                "a refunded or cancelled plan left outstanding principal unaccounted"
            );
        }
    }

    /// @notice A plan carrying no debt is not still soliciting collection.
    /// @dev The state exists precisely so payoff is never blocked on a fee dispute:
    ///      principal clear, fees outstanding, and no further pulls.
    /// @custom:certora settledWithFeeOutstandingIsCoherent
    function check_settledWithFeeOutstandingIsCoherent() public view {
        if (subject.state() != IInstallmentPlan.PlanState.SettledWithFeeOutstanding) return;
        assertEq(subject.outstandingPrincipal(), 0, "SettledWithFeeOutstanding still owes principal");
        assertGt(subject.feesOutstanding(), 0, "SettledWithFeeOutstanding owes no fee");
    }
}
