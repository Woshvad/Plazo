// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IInstallmentPlan} from "./interfaces/IInstallmentPlan.sol";
import {ParameterRegistry} from "./ParameterRegistry.sol";
import {ParameterKeys} from "./libraries/ParameterKeys.sol";

/// @title RelayerGate
/// @notice The operator's collections, held back so everyone else's are provably first.
///
/// @dev COLL-07 and OPS-04. The claim Plazo makes about its keeper market is that the
///      operator is redundant — that collections happen because a bounty makes them
///      worth cranking, not because a company runs a cron job. COLL-10 measures the
///      share of collections cranked by non-operator addresses, and that measurement is
///      worth nothing if the operator can crank at `validAfter` like everybody else,
///      because then every collection it wins is one a third party might have taken.
///
///      **The floor is enforced where it is observable (DEC-18).** A delay implemented
///      in the relayer's own configuration is a claim about a config file that nobody
///      outside the company can audit. `InstallmentPlan.collect` is permissionless and
///      must stay that way, so the floor cannot live there either — a plan that refused
///      early collections would refuse them to third parties too, which is the opposite
///      of the intent.
///
///      So it lives here. The operator's key holds `RELAYER_ROLE` on this contract and
///      nothing else, and every collection the operator makes goes through this address.
///      Anyone can then verify two things from the chain alone: that the operator's
///      collections all came from here, and that every one of them was late.
///
///      **A borrower is never worse off.** The plan is still collectable by anyone from
///      `validAfter`. This contract only declines to be that anyone for the first
///      half hour.
contract RelayerGate is AccessControl {
    using SafeERC20 for IERC20;

    /// @notice The operator's collection key.
    bytes32 public constant RELAYER_ROLE = keccak256("PLAZO.RELAYER");

    ParameterRegistry public immutable parameters;

    event Collected(address indexed plan, uint256 indexed index, bool cleared, uint8 reason);
    event Marked(address indexed plan, uint256 indexed index, bool expired);
    event BountySwept(address indexed token, address indexed to, uint256 amount);

    error TooEarly(uint256 dueDate, uint256 earliest);

    constructor(address admin, address parameters_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        parameters = ParameterRegistry(parameters_);
    }

    function delayFloor() public view returns (uint256) {
        return parameters.get(ParameterKeys.RELAYER_DELAY_FLOOR);
    }

    /// @notice The earliest moment the operator may crank this installment.
    function earliestFor(address plan, uint256 index) public view returns (uint256) {
        return IInstallmentPlan(plan).dueDate(index) + delayFloor();
    }

    /// @notice Crank a collection on the operator's behalf, if it is late enough.
    function collect(address plan, uint256 index) external onlyRole(RELAYER_ROLE) {
        _requireLate(plan, index);
        (bool cleared, IInstallmentPlan.BounceReason reason) = IInstallmentPlan(plan).collect(index);
        emit Collected(plan, index, cleared, uint8(reason));
    }

    function collectBatch(address plan, uint256[] calldata indices) external onlyRole(RELAYER_ROLE) {
        for (uint256 i = 0; i < indices.length; ++i) {
            _requireLate(plan, indices[i]);
        }
        IInstallmentPlan(plan).collectBatch(indices);
    }

    /// @notice Record a missed installment. Also gated, and for the same reason.
    /// @dev The mark carries a bounty too, so an operator that could mark instantly
    ///      would be taking the same paid work the market is supposed to do. The delay
    ///      floor applies to the whole crank surface or it applies to nothing.
    function markMissed(address plan, uint256 index) external onlyRole(RELAYER_ROLE) {
        _requireLate(plan, index);
        IInstallmentPlan(plan).markMissed(index);
        emit Marked(plan, index, false);
    }

    function markExpired(address plan, uint256 index) external onlyRole(RELAYER_ROLE) {
        _requireLate(plan, index);
        IInstallmentPlan(plan).markExpired(index);
        emit Marked(plan, index, true);
    }

    /// @notice Send accumulated bounties on to the operator's treasury.
    /// @dev This contract is the `msg.sender` of every gated crank, so the bounties
    ///      land here. Sweeping is admin-only and goes wherever the admin says; there
    ///      is nothing to protect, because a bounty is a payment for work already done.
    function sweep(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IERC20(token).safeTransfer(to, amount);
        emit BountySwept(token, to, amount);
    }

    function _requireLate(address plan, uint256 index) private view {
        uint256 earliest = earliestFor(plan, index);
        if (block.timestamp < earliest) {
            revert TooEarly(IInstallmentPlan(plan).dueDate(index), earliest);
        }
    }
}
