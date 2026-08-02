// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IInstallmentPlan} from "../../../src/interfaces/IInstallmentPlan.sol";
import {IPlanFlowView} from "../PlanInvariants.sol";

/// @notice A plan whose accounting can be set to anything, including states no real
///         implementation should reach.
///
/// @dev Exists so the invariant suite can be shown to have teeth before there is a
///      plan to point it at. A suite that has never failed is a suite that might
///      not work — every assertion in `PlanInvariants` is driven into failure
///      against this stub, one at a time.
///
///      It is not a mock of `InstallmentPlan`. It has no behaviour; Phase 2 builds
///      the real one and rebinds the same invariants to it.
contract ConfigurablePlan is IInstallmentPlan, IPlanFlowView {
    bytes32 public planId;
    PlanState public state = PlanState.Active;
    uint256 public installmentCount;
    uint256 public principal;
    uint256 public outstandingPrincipal;
    uint256 public feesOutstanding;
    uint256 public feesPaid;
    uint256 public totalCollected;
    uint256 public forwarded;
    uint256 public refundCredit;

    mapping(uint256 => uint256) internal _dueDate;
    mapping(uint256 => uint256) internal _graceEndsAt;
    mapping(uint256 => uint256) internal _amount;
    mapping(uint256 => InstallmentStatus) internal _status;

    // ─── Phase 6 flow accounting ─────────────────────────────────────────────
    //
    // Flows the real plan does not store, because it pays every unit out in the same
    // transaction it arrives. Here they are running totals so the two Phase 6
    // properties can be driven to failure — a property that cannot be broken is a
    // property the bite suite is not testing.

    uint256 public refundInflow;
    uint256 public refundToBorrower;
    uint256 public refundToThirdParty;

    uint256 public settlementAmount;
    uint256 public settlementHeld;
    uint256 public settlementReleased;
    uint256 public settlementReturned;
    bool public settlementExitReachable;

    /// @notice A coherent four-installment plan that satisfies every invariant.
    /// @dev The baseline each violation test perturbs by exactly one field, so a
    ///      failure can only be attributed to the thing that was changed.
    function initHealthy(uint256 count, uint256 principal_, uint256 start, uint256 interval) external {
        installmentCount = count;
        principal = principal_;
        outstandingPrincipal = principal_;

        // Nothing refunded yet, and the plan's settlement sitting in escrow with both
        // exits open — the state every escrowed origination starts in.
        settlementAmount = principal_;
        settlementHeld = principal_;
        settlementExitReachable = true;

        for (uint256 i = 0; i < count; ++i) {
            _dueDate[i] = start + (i * interval);
            _graceEndsAt[i] = _dueDate[i] + 3 days;
            _amount[i] = principal_ / count;
            _status[i] = InstallmentStatus.Pending;
        }
    }

    function setState(PlanState s) external {
        state = s;
    }

    function setAccounting(
        uint256 outstanding,
        uint256 collected,
        uint256 paid,
        uint256 owed,
        uint256 credit
    ) external {
        outstandingPrincipal = outstanding;
        totalCollected = collected;
        forwarded = collected;
        feesPaid = paid;
        feesOutstanding = owed;
        refundCredit = credit;
    }

    function setStatus(uint256 index, InstallmentStatus s) external {
        _status[index] = s;
    }

    function setDueDate(uint256 index, uint256 when) external {
        _dueDate[index] = when;
    }

    function setGraceEndsAt(uint256 index, uint256 when) external {
        _graceEndsAt[index] = when;
    }

    function setInstallmentAmount(uint256 index, uint256 amount) external {
        _amount[index] = amount;
    }

    /// @dev The whole refund flow in one call, including `refundCredit`, so a test
    ///      cannot leave the credit and the flow totals disagreeing about the same
    ///      units by accident and then attribute the failure to the wrong thing.
    function setRefundFlow(
        uint256 inflow,
        uint256 credit,
        uint256 toBorrower,
        uint256 toThirdParty
    ) external {
        refundInflow = inflow;
        refundCredit = credit;
        refundToBorrower = toBorrower;
        refundToThirdParty = toThirdParty;
    }

    function setSettlement(
        uint256 amount,
        uint256 held,
        uint256 released,
        uint256 returned,
        bool exitReachable
    ) external {
        settlementAmount = amount;
        settlementHeld = held;
        settlementReleased = released;
        settlementReturned = returned;
        settlementExitReachable = exitReachable;
    }

    bool internal _payoffOverridden;
    uint256 internal _payoffOverride;

    /// @dev Lets a test report a payoff that disagrees with the components, which
    ///      is the only way to exercise `check_payoffCoversOutstanding`.
    function setPayoffOverride(uint256 amount) external {
        _payoffOverridden = true;
        _payoffOverride = amount;
    }

    function payoffAmount() external view returns (uint256) {
        if (_payoffOverridden) return _payoffOverride;
        return outstandingPrincipal + feesOutstanding;
    }

    function dueDate(uint256 index) external view returns (uint256) {
        return _dueDate[index];
    }

    function graceEndsAt(uint256 index) external view returns (uint256) {
        return _graceEndsAt[index];
    }

    function installmentAmount(uint256 index) external view returns (uint256) {
        return _amount[index];
    }

    function installmentStatus(uint256 index) external view returns (InstallmentStatus) {
        return _status[index];
    }

    function isCleared(uint256 index) external view returns (bool) {
        return _status[index] == InstallmentStatus.Cleared;
    }

    function isMarked(uint256 index) external view returns (bool) {
        return _status[index] == InstallmentStatus.Missed || _status[index] == InstallmentStatus.Expired;
    }

    // Not exercised by the invariants. `InstallmentPlan` supplies the real
    // behaviour; this stub exists only to be broken on purpose.
    function collect(uint256) external pure returns (bool, BounceReason) {
        revert("not implemented in Phase 1");
    }

    function collectBatch(uint256[] calldata) external pure returns (bool[] memory, BounceReason[] memory) {
        revert("not implemented in Phase 1");
    }

    function markMissed(uint256) external pure {
        revert("not implemented in Phase 1");
    }

    function markExpired(uint256) external pure {
        revert("not implemented in Phase 1");
    }

    function repay(uint256) external pure {
        revert("not implemented in Phase 1");
    }

    function revalidate() external pure {
        revert("not implemented in Phase 1");
    }
}
