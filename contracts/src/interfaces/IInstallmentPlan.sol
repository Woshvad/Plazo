// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title IInstallmentPlan
/// @notice The frozen plan ABI: state machine, events and entry points.
///
/// @dev No implementation exists in Phase 1. This interface is written first
///      because the invariant suite constrains it, and an invariant suite written
///      after the contract it constrains tends to describe the contract rather
///      than the requirement.
///
///      The state set is deliberately over-provisioned. States added after formal
///      verification re-open formal verification, and several of these are not
///      optional in the long run: permissionless keepers mean a collections hold
///      has to live in the contract rather than in an operator's queue, and a
///      disputed amount has to be freezable. Shipping them unreachable in v1 costs
///      an enum slot; adding them in v2 costs the FV gate.
interface IInstallmentPlan {
    enum PlanState {
        /// @dev Deployed, strip signed, no installment due yet.
        Pending,
        /// @dev At least one installment cleared, none outstanding past its due date.
        Active,
        /// @dev A check bounced or a due date passed uncollected. Keepers retry;
        ///      the borrower may cure. The grace clock runs.
        Grace,
        /// @dev Grace expired without a cure. Late fee accrued, Passport marked,
        ///      NAV provisioned.
        Delinquent,
        /// @dev Merchant or borrower opened a dispute. Collection is suspended on
        ///      the disputed amount without manufacturing delinquency.
        Disputed,
        /// @dev Administrative freeze — compliance review, suspected fraud.
        ///      Distinct from `Disputed`: no counterparty claim, and no clock.
        Hold,
        /// @dev USDC paused or the chain halted. The grace and delinquency clocks
        ///      suspend rather than running against a borrower who cannot pay.
        HALTED,
        /// @dev The borrower's address is on the token blocklist. Collection is
        ///      impossible for reasons that are not the borrower's credit.
        Blocked,
        /// @dev A settled fraud claim reversed the merchant settlement. The loss
        ///      routes to the reserve, not down the credit waterfall.
        FraudReversed,
        /// @dev Principal cleared, fees still outstanding. A terminal-adjacent
        ///      state that exists so payoff is never blocked on a fee dispute.
        SettledWithFeeOutstanding,
        /// @dev Absorbing. No path back to `Grace`.
        Repaid,
        /// @dev Absorbing. Charged off at 60 days past due.
        Defaulted,
        /// @dev Origination reversed before any collection.
        Cancelled,
        /// @dev Fully refunded by the merchant; outstanding principal retired.
        Refunded
    }

    /// @notice Why a pull failed.
    /// @dev These carry opposite Passport and provisioning treatments and lenders
    ///      will demand the distinction: a blocklisted borrower is a compliance
    ///      event, a paused token is an infrastructure event, and only
    ///      `InsufficientFunds` is a credit event. Collapsing them into one
    ///      "failed" would make the loss data unreadable.
    enum BounceReason {
        None,
        InsufficientFunds,
        Blocked,
        Halted,
        SignerInvalid,
        AuthorizationExpired,
        AuthorizationUsed
    }

    /// @notice An installment cleared and funds moved.
    /// @dev Keyed by `planId`, never by borrower address, and the borrower does not
    ///      appear in an indexed position anywhere in this ABI. Plan events are a
    ///      worse privacy exposure than the Passport record they feed: anyone can
    ///      index a wallet-keyed log stream into a purchase diary that no erasure
    ///      request can reach.
    event CheckCleared(bytes32 indexed planId, uint256 indexed index, uint256 amount, address keeper);

    /// @notice A pull failed. Never a revert — a revert emits nothing, changes
    ///         nothing and pays nobody, which leaves the delinquency signal
    ///         uncreated.
    event CheckBounced(bytes32 indexed planId, uint256 indexed index, BounceReason reason);

    /// @notice A missed installment was recorded by a bountied caller.
    event CheckMissed(bytes32 indexed planId, uint256 indexed index, address marker);

    /// @notice An authorization passed `validBefore` uncollected.
    event CheckExpired(bytes32 indexed planId, uint256 indexed index, address marker);

    event PlanStateChanged(bytes32 indexed planId, PlanState from, PlanState to);
    event PlanCured(bytes32 indexed planId, uint256 indexed index);
    event PlanDelinquent(bytes32 indexed planId, uint256 lateFee);
    event PlanRepaid(bytes32 indexed planId, uint256 total);
    event PlanChargedOff(bytes32 indexed planId, uint256 outstanding);
    event RefundCredited(bytes32 indexed planId, uint256 amount);

    function planId() external view returns (bytes32);
    function state() external view returns (PlanState);
    function installmentCount() external view returns (uint256);
    function outstandingPrincipal() external view returns (uint256);
    function feesOutstanding() external view returns (uint256);
    function payoffAmount() external view returns (uint256);
    function dueDate(uint256 index) external view returns (uint256);
    function isCleared(uint256 index) external view returns (bool);
    function isMarked(uint256 index) external view returns (bool);

    /// @notice Pull one installment. Permissionless, bountied, and it does not
    ///         revert on a failed pull.
    function collect(uint256 index) external returns (bool cleared, BounceReason reason);

    /// @notice Record a missed installment. Bountied, because nobody profits from
    ///         cranking a collection that cannot succeed, and without a paid
    ///         negative signal the delinquency is never written.
    function markMissed(uint256 index) external;

    /// @notice Record an authorization that expired uncollected.
    function markExpired(uint256 index) external;

    /// @notice Push repayment. Never pausable — a borrower must always be able to
    ///         cure or prepay, including after the strip has expired.
    function repay(uint256 amount) external;

    /// @notice Re-check an outstanding strip against smart-account signer mutation.
    function revalidate() external;
}
