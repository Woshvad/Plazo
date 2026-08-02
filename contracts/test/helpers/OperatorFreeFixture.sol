// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {OriginationFixture} from "./OriginationFixture.sol";

import {ParkedYieldVenue} from "../../src/ParkedYieldVenue.sol";
import {PayoutRouter} from "../../src/PayoutRouter.sol";
import {RefundEscrow} from "../../src/RefundEscrow.sol";
import {MockTokenMessengerV2} from "../mocks/MockTokenMessengerV2.sol";

/// @notice The Phase 3 stack with every operator role at the zero address. GOV-08.
///
/// @dev **What "every operator role at `address(0)`" means, and what it does not.**
///      It does not mean the protocol runs with nobody. It means no *operator* role
///      sits on the critical path of collection, cure, marking, epoch settlement,
///      redemption or refunds — that once a plan exists, no operator is needed for
///      anything that happens to it, or to the capital behind it, ever again.
///      Origination is deliberately outside that claim: it needs
///      `CheckoutRouter.UNDERWRITER_ROLE` (CHKT-05) and `MerchantRegistry.KYB_ROLE`
///      (MERCH-01), both operator roles by design and both supposed to be
///      load-bearing. `OperatorFree.t.sol` row 12 asserts origination *reverts*, and
///      without that row the whole test would only prove the roles were never doing
///      anything.
///
///      Extends `OriginationFixture` rather than forking it, so the stack under test
///      is the stack `Deploy.s.sol` deploys and the revocation list below is that
///      script's `_wire` block read backwards.
///
///      **The fixture grants nothing back.** No eligibility for the strangers, no
///      settlement category the deployment did not set, no convenience role after a
///      renounce. Finding 16 is the reason: `OriginationFixture` accredits its lender
///      as a side effect of existing, which is correct for a fixture and is exactly
///      why a deployment that accredits nobody passed 286 local tests before a live
///      trace found it. A fixture that grants hides a deployment gap, and this fixture
///      exists to find them.
abstract contract OperatorFreeFixture is OriginationFixture {
    ParkedYieldVenue internal venue;
    PayoutRouter internal payoutRouter;
    RefundEscrow internal refundEscrow;
    MockTokenMessengerV2 internal messenger;

    /// @notice The operator EOA. In `Deploy.s.sol` the admin and the operator are one
    ///         deployer key, and this mirrors that rather than inventing a separation
    ///         the deployment does not have.
    address internal operator;

    /// @notice Five addresses holding no role of any kind, anywhere.
    /// @dev Distinct so a permissionlessness assertion cannot pass because one address
    ///      happened to be special. Created with `makeAddr` so a failing trace names
    ///      the caller rather than showing a bare hex literal.
    address internal stranger1;
    address internal stranger2;
    address internal stranger3;
    address internal stranger4;
    address internal stranger5;

    /// @notice A second person, because Tier 0 allows one active plan each.
    ///
    /// @dev `Tier0Underwriter.capFor` returns zero while `activePlans > 0` (UW-01), so
    ///      two plans open at the same time is two people, and a person here is an
    ///      address that can sign a strip. Everything else about them is identical to
    ///      the first borrower — same identity class, same curve, same band.
    uint256 internal constant SECOND_BORROWER_KEY = 0xB0BB1;
    address internal secondBorrower;

    /// @notice Base Sepolia. The destination the live 06-01 burn actually went to.
    uint32 internal constant REMOTE_DOMAIN = 6;

    /// @notice CCTP v2's testnet messenger, which Arc reports for every remote domain.
    bytes32 internal constant REMOTE_MESSENGER =
        bytes32(uint256(uint160(0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA)));

    /// @dev Whether `_goOperatorFree` has run. Read by the tests so an assertion about
    ///      "after the roles were gone" cannot silently run before they were.
    bool internal operatorFree;

    // ─────────────────────────────────────────────────────────────────────────
    // Deployment
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Everything `OriginationFixture` deploys, plus the four contracts
    ///      `Deploy.s.sol` deploys that it does not: the venue, the CCTP payout
    ///      router, its mocked messenger, and Phase 6's `RefundEscrow`. Each one owns
    ///      a Class-B role that GOV-08 has to be able to revoke, and a role nobody
    ///      holds is a role whose revocation proves nothing.
    function _deployStack() internal virtual override {
        super._deployStack();

        operator = address(this);
        secondBorrower = vm.addr(SECOND_BORROWER_KEY);

        stranger1 = makeAddr("gov08-stranger-collect");
        stranger2 = makeAddr("gov08-stranger-mark");
        stranger3 = makeAddr("gov08-stranger-recognise");
        stranger4 = makeAddr("gov08-stranger-epoch");
        stranger5 = makeAddr("gov08-stranger-settle");

        // `Deploy.s.sol::_wire` grants this (COLL-07) and `OriginationFixture` does
        // not. Granting it here is not a convenience: revoking a role that was never
        // held would let the sharpest assertion in the test — that a stranger can
        // still `collect()` with the operator's collection key gone (DEC-18) — pass
        // against a gate that had never been armed.
        relayer.grantRole(relayer.RELAYER_ROLE(), operator);

        // POOL-13. Allowlisted, not activated: the buffer stays as cash until a
        // treasurer decides otherwise, which is the deployment's own default.
        venue = new ParkedYieldVenue(operator, address(usdc));
        creditPool.setVenueAllowed(address(venue), true);

        messenger = new MockTokenMessengerV2(address(0x7A45));
        messenger.setRemoteTokenMessenger(REMOTE_DOMAIN, REMOTE_MESSENGER);
        payoutRouter = new PayoutRouter(operator, address(messenger));
        payoutRouter.grantRole(payoutRouter.DOMAIN_CURATOR_ROLE(), operator);

        refundEscrow = new RefundEscrow(
            operator,
            address(usdc),
            address(checkout),
            address(merchants),
            address(parameters),
            address(settlementEscrow)
        );

        // Class A, held by a contract. `MerchantRegistry`'s own docstring says Phase
        // 6's `RefundEscrow` is what earns `SLASHER_ROLE`, and D-03 says it may never
        // sit on a human key. It is not revoked below for the same reason the router's
        // roles are not: revoking it would be testing that the protocol stops working.
        merchants.grantRole(merchants.SLASHER_ROLE(), address(refundEscrow));

        // Class B. Phase 6's new operator role, and the loop must survive its absence.
        refundEscrow.grantRole(refundEscrow.ARBITER_ROLE(), operator);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The zeroing
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Revoke every operator-held role and renounce the three `Ownable`s.
    ///
    /// @dev Called directly rather than through `vm.prank`, because in this stack the
    ///      admin *is* the test contract — the same collapse `Deploy.s.sol` has, where
    ///      one deployer key holds both. Pranking would be theatre, and the prank trap
    ///      documented in `OriginationFixture._onboardMerchant` bites hardest in code
    ///      that reads a role constant as an argument to the very call it is pranking.
    ///
    ///      **Class A is left alone, and getting that wrong is the classic mis-scope.**
    ///      `PlanFactory`'s originator, `TranchedCreditPool`'s originator,
    ///      `ReceivableToken`'s issuer, `Tier0Underwriter`'s originator,
    ///      `FirstPaymentDefaultSwitch`'s registrar, `MerchantRegistry`'s bookkeeper,
    ///      `PlazoPassport`'s writer and readers, and `MerchantRegistry`'s slasher held
    ///      by `RefundEscrow` are all held by *contracts*. They are protocol plumbing,
    ///      not operator roles. Revoking them would not prove the protocol survives
    ///      without an operator; it would prove the protocol stops working when you
    ///      take it apart, which nobody doubted.
    ///
    ///      `SettlementEscrow.admin` is not in either class. It is an immutable that
    ///      may name the router once and may do nothing else, and it was spent at
    ///      deployment — so there is no ongoing privilege there to revoke.
    function _goOperatorFree() internal {
        // ── Class B: every role an operator EOA holds ────────────────────────
        merchants.revokeRole(merchants.KYB_ROLE(), operator);
        checkout.revokeRole(checkout.UNDERWRITER_ROLE(), underwriterKey);
        relayer.revokeRole(relayer.RELAYER_ROLE(), operator);
        compliance.revokeRole(compliance.SCREENER_ROLE(), operator);
        pauses.revokeRole(pauses.PAUSER_ROLE(), operator);
        schemas.revokeRole(schemas.PUBLISHER_ROLE(), operator);
        poolRegistry.revokeRole(poolRegistry.CURATOR_ROLE(), operator);
        venue.revokeRole(venue.FUNDER_ROLE(), operator);
        refundEscrow.revokeRole(refundEscrow.ARBITER_ROLE(), operator);
        payoutRouter.revokeRole(payoutRouter.DOMAIN_CURATOR_ROLE(), operator);

        // ── `DEFAULT_ADMIN_ROLE`, last ───────────────────────────────────────
        //
        // Last because it is the role that authorises every revocation above.
        // Revoking it first would make the rest of this function impossible, and a
        // fixture that quietly failed to revoke would report GOV-08 green against a
        // stack that still had an operator in it.
        merchants.revokeRole(merchants.DEFAULT_ADMIN_ROLE(), operator);
        checkout.revokeRole(checkout.DEFAULT_ADMIN_ROLE(), operator);
        relayer.revokeRole(relayer.DEFAULT_ADMIN_ROLE(), operator);
        compliance.revokeRole(compliance.DEFAULT_ADMIN_ROLE(), operator);
        pauses.revokeRole(pauses.DEFAULT_ADMIN_ROLE(), operator);
        schemas.revokeRole(schemas.DEFAULT_ADMIN_ROLE(), operator);
        poolRegistry.revokeRole(poolRegistry.DEFAULT_ADMIN_ROLE(), operator);
        venue.revokeRole(venue.DEFAULT_ADMIN_ROLE(), operator);
        refundEscrow.revokeRole(refundEscrow.DEFAULT_ADMIN_ROLE(), operator);
        payoutRouter.revokeRole(payoutRouter.DEFAULT_ADMIN_ROLE(), operator);
        receivable.revokeRole(receivable.DEFAULT_ADMIN_ROLE(), operator);
        tier0.revokeRole(tier0.DEFAULT_ADMIN_ROLE(), operator);
        killSwitch.revokeRole(killSwitch.DEFAULT_ADMIN_ROLE(), operator);
        passport.revokeRole(passport.DEFAULT_ADMIN_ROLE(), operator);

        // ── The three `Ownable` contracts ────────────────────────────────────
        //
        // `Ownable` sets the owner to `address(0)` irreversibly. There is no path
        // back from any of the three calls below, which is why each one is worth a
        // sentence rather than a line.

        // Disables `setVenue`, `setVenueAllowed`, `setTreasurer`, `setEligibility` and
        // `seed()`. POOL-12's seeds are already placed and DEC-27 made `closeEpoch`
        // permissionless, so epoch settlement and the redemption queue *should*
        // survive — and "should" is exactly why `OperatorFree.t.sol` asserts it rather
        // than this comment claiming it. The buffer does not survive: with no owner
        // there is no path to appoint a treasurer, so `deployBuffer` and
        // `recallBuffer` are dead. That is POOL-13 yield, not the servicing loop, and
        // it is not on GOV-08's list.
        creditPool.renounceOwnership();

        // Fine, and arguably correct. The bands are compiled in as `require()`s
        // (GOV-01), the ratchet is one-way, and DEC-07 says a parameter change never
        // reaches a plan that already exists.
        parameters.renounceOwnership();

        /// @dev **D-25. This call is survivable in a fixture and is not survivable on a
        ///      real book.** Renouncing `EligibilityRegistry` ownership permanently
        ///      freezes the eligible-holder set: no lender can ever be accredited
        ///      again, `TrancheToken._update` refuses every future mint under DEC-01's
        ///      Reg D restrictions, and there is no path back. That is finding 16 — a
        ///      book nobody on earth may deposit into — made permanent instead of
        ///      fixable. It is safe here only because the lender was accredited before
        ///      this line ran and no test after it needs a new one.
        ///
        ///      **If you are reading this because you copied this fixture into a deploy
        ///      script: do not.** D-25 and Pitfall 12 say the live half of GOV-08 runs
        ///      on a throwaway deployment (plan 06-13), never on the deployment holding
        ///      real capital.
        eligibility.renounceOwnership();

        // `JurisdictionRegistry` is a fourth `Ownable` the research's list of three
        // does not name. Its owner is left held deliberately: it governs origination-
        // time jurisdiction parameters, which by DEC-07 never reach a plan that already
        // exists, so it is outside the claim GOV-08 makes. Recorded rather than
        // silently skipped, because a reader counting `Ownable` contracts will find
        // four and should not have to wonder which one was forgotten.

        operatorFree = true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Every warp in this tree reads the clock through the cheatcode. Under
    ///      `via_ir` a bare `block.timestamp` is hoisted past `vm.warp` and a test that
    ///      warps forty times arrives at the same instant forty times and passes anyway
    ///      (DEC-30, finding 14). This file warps constantly.
    function _warpBy(uint256 delta) internal {
        vm.warp(vm.getBlockTimestamp() + delta);
    }

    function _warpTo(uint256 when) internal {
        if (when > vm.getBlockTimestamp()) vm.warp(when);
    }

    /// @notice Point the fixture's signing seam at a person, and screen them.
    ///
    /// @dev `borrower` and `borrowerKey` move together: the first is who the terms name
    ///      and the second is who signs the acceptance and the strip, and a plan whose
    ///      two disagreed would be refused by `_verifyAcceptance` rather than
    ///      originated wrongly. Screening happens here because it is what an operator
    ///      would have done before the zeroing, not a convenience afterwards — after
    ///      `_goOperatorFree()` `SCREENER_ROLE` is gone and this call would revert.
    function _becomeBorrower(address who, uint256 key) internal {
        borrower = who;
        borrowerKey = key;
        _screenClear(who);
    }

    /// @notice Close an epoch from an address that holds no role. DEC-27.
    /// @dev The fixture's own `_closeEpoch` runs as the test contract, which before
    ///      `_goOperatorFree()` is the admin. This one is the same two cranks driven by
    ///      somebody with no relationship to the protocol at all.
    function _closeEpochAsStranger(address who) internal {
        _warpTo(creditPool.epochEndsAt() + 1);
        vm.prank(who);
        creditPool.markEpoch(64);
        vm.prank(who);
        creditPool.closeEpoch();
    }
}
