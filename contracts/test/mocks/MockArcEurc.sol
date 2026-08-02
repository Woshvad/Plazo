// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {MockArcStablecoin} from "./MockArcStablecoin.sol";

/// @title MockArcEurc
/// @notice A local stand-in for Arc EURC (`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`).
///
/// @dev Three facts, all read live from chain 5042002 by plan 07-01 and recorded as
///      finding 31 rather than taken from a document:
///
///      - `decimals()` is **6**, the same as USDC's.
///      - `version()` is **"2"**, the same as USDC's.
///      - `RECEIVE_WITH_AUTHORIZATION_TYPEHASH` — and the transfer and cancel
///        typehashes with it — is **byte-identical** to the canonical FiatToken value
///        USDC carries. The literal itself is not repeated here on purpose: it exists
///        once in `MockArcStablecoin` and nowhere else in this tree, because a
///        typehash written down twice is a typehash that can disagree with itself.
///
///      The measured separator matched the four-field derivation
///      `("EURC", "2", 5042002, 0x89B50855…)` exactly. So a EURC domain separator
///      differs from a USDC one only through `name` and `verifyingContract`, both of
///      which the base already varies — and therefore **a strip signed against one
///      token can never validate against the other**. That is not an incidental
///      property; it is the thing a corridor test has to be able to assert, and it
///      comes free precisely because the two mocks share an implementation rather
///      than each carrying their own.
///
///      Nothing is added to the base for EURC — no pause of its own, no blacklist
///      entry, no decimals override. The measurements say the two tokens are the same
///      shape, and inventing a difference the chain does not have would make the mock
///      lie in the one direction that is hardest to notice.
contract MockArcEurc is MockArcStablecoin {
    constructor() MockArcStablecoin("EURC", "EURC") {}
}
