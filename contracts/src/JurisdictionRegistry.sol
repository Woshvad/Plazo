// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PlanParams} from "./libraries/PlanParams.sol";

/// @title JurisdictionRegistry
/// @notice Per-jurisdiction consumer-credit parameter sets, selected per plan.
///
/// @dev GOV-04, and the jurisdiction half of D5. Consumer-credit limits are not a
///      product decision; they are law, and they differ by where the borrower is.
///      A late-fee cap hard-coded at one number is either illegal somewhere or
///      leaving money on the table everywhere else, and discovering which after
///      origination has begun means every outstanding plan was priced under the
///      wrong rule.
///
///      The indirection lands in Phase 2 rather than with the rest of the parameter
///      work in Phase 3 because **the first origination assesses a fee**. There is
///      no later point at which adding this is free.
///
///      A plan reads its set once, at initialisation, and copies the values it
///      needs into its own storage. A registry row that could move afterwards would
///      let governance re-price a plan a borrower has already signed — which is
///      exactly the thing `termsHash` exists to make impossible. The registry
///      configures *origination*; it never reaches a live plan.
///
///      Phase 3 folds this into `ParameterRegistry` alongside the rest of Appendix
///      A. The bands below are the same idea in miniature: a governance key that
///      can set any value is a governance key that can set a usurious one.
contract JurisdictionRegistry is Ownable {
    struct Params {
        /// @notice Late fee ceiling as a fraction of the installment it attaches to.
        uint256 lateFeeCapBps;
        /// @notice Late fee ceiling in absolute USDC, 6-decimal.
        uint256 lateFeeCapAbsolute;
        /// @notice Maximum all-in APR expressible under this set.
        /// @dev Zero for Pay-in-4, which carries no interest. Flex reads it in
        ///      Phase 8, and the field exists now so a Flex plan cannot be
        ///      originated under a set that never considered a rate cap.
        uint256 aprCapBps;
        /// @notice How often a statement must be issued, in seconds.
        uint256 statementCadence;
        /// @notice Cooling-off period during which a borrower may withdraw.
        uint256 withdrawalWindow;
        bool enabled;
    }

    /// @notice The set a plan gets when its terms name no specific jurisdiction.
    /// @dev Deliberately the most restrictive of the seeded sets rather than the
    ///      most permissive. An unrecognised jurisdiction is missing information,
    ///      and missing information should not resolve to the highest fee the
    ///      protocol can charge.
    bytes32 public constant DEFAULT_JURISDICTION = keccak256("PLAZO.DEFAULT");

    // Bands. A governance key that can set any value is a governance key that can
    // set a usurious one, and "we would never" is not a control.
    uint256 internal constant MAX_LATE_FEE_CAP_BPS = 2500;
    uint256 internal constant MAX_LATE_FEE_CAP_ABSOLUTE = 25 * PlanParams.ONE_USDC;
    uint256 internal constant MAX_APR_CAP_BPS = 3600;
    uint256 internal constant MIN_STATEMENT_CADENCE = 1 days;
    uint256 internal constant MAX_STATEMENT_CADENCE = 60 days;
    uint256 internal constant MAX_WITHDRAWAL_WINDOW = 30 days;

    mapping(bytes32 jurisdiction => Params) internal _params;

    event JurisdictionSet(bytes32 indexed jurisdiction, Params params);
    event JurisdictionDisabled(bytes32 indexed jurisdiction);

    error UnknownJurisdiction(bytes32 jurisdiction);
    error LateFeeCapBpsOutOfBand(uint256 provided, uint256 max);
    error LateFeeCapAbsoluteOutOfBand(uint256 provided, uint256 max);
    error AprCapOutOfBand(uint256 provided, uint256 max);
    error StatementCadenceOutOfBand(uint256 provided, uint256 min, uint256 max);
    error WithdrawalWindowOutOfBand(uint256 provided, uint256 max);

    constructor(address governance) Ownable(governance) {
        Params memory fallbackSet = Params({
            lateFeeCapBps: 2500,
            lateFeeCapAbsolute: 7 * PlanParams.ONE_USDC,
            aprCapBps: 0,
            statementCadence: 30 days,
            withdrawalWindow: 14 days,
            enabled: true
        });
        _params[DEFAULT_JURISDICTION] = fallbackSet;
        emit JurisdictionSet(DEFAULT_JURISDICTION, fallbackSet);
    }

    function set(bytes32 jurisdiction, Params calldata params) external onlyOwner {
        if (params.lateFeeCapBps > MAX_LATE_FEE_CAP_BPS) {
            revert LateFeeCapBpsOutOfBand(params.lateFeeCapBps, MAX_LATE_FEE_CAP_BPS);
        }
        if (params.lateFeeCapAbsolute > MAX_LATE_FEE_CAP_ABSOLUTE) {
            revert LateFeeCapAbsoluteOutOfBand(params.lateFeeCapAbsolute, MAX_LATE_FEE_CAP_ABSOLUTE);
        }
        if (params.aprCapBps > MAX_APR_CAP_BPS) {
            revert AprCapOutOfBand(params.aprCapBps, MAX_APR_CAP_BPS);
        }
        if (
            params.statementCadence < MIN_STATEMENT_CADENCE || params.statementCadence > MAX_STATEMENT_CADENCE
        ) {
            revert StatementCadenceOutOfBand(
                params.statementCadence, MIN_STATEMENT_CADENCE, MAX_STATEMENT_CADENCE
            );
        }
        if (params.withdrawalWindow > MAX_WITHDRAWAL_WINDOW) {
            revert WithdrawalWindowOutOfBand(params.withdrawalWindow, MAX_WITHDRAWAL_WINDOW);
        }

        _params[jurisdiction] = params;
        emit JurisdictionSet(jurisdiction, params);
    }

    function disable(bytes32 jurisdiction) external onlyOwner {
        _params[jurisdiction].enabled = false;
        emit JurisdictionDisabled(jurisdiction);
    }

    /// @notice The parameter set for `jurisdiction`.
    /// @dev Reverts on an unknown or disabled jurisdiction rather than falling back
    ///      to the default. A plan whose jurisdiction was never configured is a plan
    ///      nobody decided the rules for, and silently applying someone else's rules
    ///      to it is how a fee gets assessed under a regime that forbids it. The
    ///      caller asks for the default explicitly if that is what it wants.
    function paramsFor(bytes32 jurisdiction) external view returns (Params memory) {
        Params memory resolved = _params[jurisdiction];
        if (!resolved.enabled) revert UnknownJurisdiction(jurisdiction);
        return resolved;
    }

    function isConfigured(bytes32 jurisdiction) external view returns (bool) {
        return _params[jurisdiction].enabled;
    }
}
