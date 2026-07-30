// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice A smart-contract wallet that validates with one key — until it does not.
///
/// @dev Stands in for the borrower wallet the product actually ships: a passkey
///      MSCA, or an EOA delegated through EIP-7702. Both were verified available on
///      Arc, and the Phase 1 fork spike proved the live token completes an ERC-1271
///      authorization end to end, so this is the signing path the strip is designed
///      around rather than an exotic case.
///
///      `revokeSigner()` is the thing an EOA cannot do and the whole reason D1
///      exists. A contract account can change what it considers a valid signature at
///      any moment, which retroactively invalidates every outstanding check it
///      signed. The protocol's answer is a bountied `revalidate()` — an onchain
///      observation anyone can make and anyone is paid to make — rather than a
///      wallet vendor's webhook.
contract MockContractWallet {
    bytes4 internal constant MAGIC = 0x1626ba7e;

    address public signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function revokeSigner() external {
        signer = address(0);
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (signer == address(0)) return 0xffffffff;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) return 0xffffffff;
        return MAGIC;
    }
}
