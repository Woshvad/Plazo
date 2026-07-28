// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title CloneAddress
/// @notice EIP-1167 minimal-proxy creation code and CREATE2 address prediction.
///
/// @dev Written out rather than pulled from a clone library on purpose. The
///      borrower's authorizations name the predicted address as payee before any
///      code exists there, so the prediction has to be reproducible by anyone
///      holding only the public constants — including `packages/plan-core` in
///      TypeScript, and including a borrower who wants to check the strip without
///      trusting Plazo's server. Depending on a library's internal encoding would
///      make that reproduction a matter of reading someone else's assembly.
///
///      The bytes below are canonical EIP-1167, unmodified.
library CloneAddress {
    /// @dev 20 bytes. `3d602d80600a3d3981f3` returns the 45-byte runtime;
    ///      `363d3d373d3d3d363d73` begins it, up to the implementation address.
    bytes10 internal constant CREATION_PREFIX = 0x3d602d80600a3d3981f3;
    bytes10 internal constant RUNTIME_PREFIX = 0x363d3d373d3d3d363d73;

    /// @dev 15 bytes. Delegatecall, copy returndata, return or revert.
    bytes15 internal constant RUNTIME_SUFFIX = 0x5af43d82803e903d91602b57fd5bf3;

    error DeployFailed();

    /// @notice The 55-byte EIP-1167 creation code for `implementation`.
    function creationCode(address implementation) internal pure returns (bytes memory) {
        return abi.encodePacked(CREATION_PREFIX, RUNTIME_PREFIX, implementation, RUNTIME_SUFFIX);
    }

    /// @notice keccak256 of the creation code — the third input to CREATE2.
    function initCodeHash(address implementation) internal pure returns (bytes32) {
        return keccak256(creationCode(implementation));
    }

    /// @notice Predict the CREATE2 address of a clone.
    /// @param deployer The contract that will execute CREATE2. This is always
    ///        `PlanFactory`, never the shared permissionless deployer at
    ///        `0x4e59b448…` — that one is callable by anyone, so a strip signed
    ///        against an address derived from it could be front-run and squatted
    ///        by a third party deploying arbitrary code there first.
    function predict(address deployer, address implementation, bytes32 salt) internal pure returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash(implementation)))
                )
            )
        );
    }

    /// @notice Deploy a clone at the predicted address.
    function deploy(address implementation, bytes32 salt) internal returns (address instance) {
        bytes memory code = creationCode(implementation);
        assembly ("memory-safe") {
            instance := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (instance == address(0)) revert DeployFailed();
    }
}
