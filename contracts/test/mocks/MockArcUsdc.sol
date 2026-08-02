// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {MockArcStablecoin} from "./MockArcStablecoin.sol";

/// @title MockArcUsdc
/// @notice A faithful local stand-in for Arc USDC.
///
/// @dev The body moved to `MockArcStablecoin` in Phase 7, unchanged. EURC needed the
///      same EIP-3009 implementation, and a second copy of it would have been two
///      implementations of which only one is exercised hard — the unexercised one
///      drifting, and the drift surfacing as a signature that verifies in test and is
///      rejected on chain. Read the base contract's header for what is reproduced
///      faithfully and what is deliberately not.
///
///      **The no-argument constructor is the point of this file.** Every existing
///      `new MockArcUsdc()` call site compiles unchanged, so the refactor is proved
///      by the suite passing at its standing count rather than by inspection, and no
///      fixture had to be touched to land it.
contract MockArcUsdc is MockArcStablecoin {
    constructor() MockArcStablecoin("USDC", "USDC") {}
}
