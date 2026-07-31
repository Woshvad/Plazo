// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title IComplianceOracle
/// @notice Sanctions and eligibility screening, consumed before a plan exists.
///
/// @dev CHKT-03 and OPS-05. Circle's Compliance Engine is request-gated and has the
///      longest lead time of anything on the access list, so this is built behind an
///      interface with a working local implementation from day one — the standing
///      rule for every third-party dependency in this project.
///
///      **Screening happens before the plan exists.** Not at the first collection,
///      not at settlement. A plan originated for a sanctioned party and then blocked
///      is a plan the protocol created and now cannot collect; a plan that was never
///      originated is nothing at all.
///
///      **Status is a stream, not a lookup.** OPS-05's point is that a borrower who
///      becomes sanctioned mid-strip has to be detected, and a screen performed once
///      at checkout cannot do that. So status is mutable state with an event on
///      every change, and the operator's feed writes it. The token's own blocklist
///      is the other half — `InstallmentPlan` already diagnoses `Blocked` as a
///      compliance event distinct from an insufficient-funds bounce.
interface IComplianceOracle {
    enum Status {
        /// @dev Default. Never screened, and therefore not clear.
        Unknown,
        Clear,
        /// @dev Screened and rejected: sanctions, an unsupported jurisdiction, a
        ///      merchant whose KYB lapsed.
        Denied
    }

    /// @notice Whether `account` may participate in an origination right now.
    function isClear(address account) external view returns (bool);

    function statusOf(address account) external view returns (Status);

    /// @notice When `account` was last screened.
    /// @dev The router enforces a freshness window against this. A screen from six
    ///      months ago is not a screen.
    function screenedAt(address account) external view returns (uint256);

    event ComplianceStatusChanged(address indexed account, Status status, uint256 at);
}
