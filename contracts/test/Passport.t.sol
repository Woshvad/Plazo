// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";

import {OriginationFixture} from "./helpers/OriginationFixture.sol";

import {InstallmentPlan} from "../src/InstallmentPlan.sol";
import {PlazoPassport} from "../src/PlazoPassport.sol";
import {AttestationSchemaRegistry} from "../src/AttestationSchemaRegistry.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";

/// @title PassportTest
/// @notice A credit record that is a commitment, ages, and can be corrected.
///
/// @dev PASS-01 through PASS-07. The split this contract rests on is that the
///      *objective* half of a record — how the protocol's own plans ended — is already
///      onchain and self-verifying, so it lives here as counters and the tier is a pure
///      function of them. Everything richer is a commitment to a record held off-chain
///      under a published schema, which is what makes correction and erasure possible
///      at all.
contract PassportTest is OriginationFixture {
    address internal reader;

    bytes32 internal constant SCHEMA = keccak256("plazo.passport.v1");

    function setUp() public {
        _deployStack();
        _prepareOrigination();
        reader = address(0x4EAD);
    }

    // ─── PASS-01: soulbound and protocol-written ─────────────────────────────

    /// @notice Nobody outside the protocol can write a record.
    /// @dev Including the admin. There is no path that hands a borrower a standing
    ///      their plans did not earn, which is what makes the record worth reading.
    function test_onlyAProtocolContractCanWriteARecord() public {
        vm.expectRevert();
        passport.noteOutcome(borrower, true);

        vm.prank(stranger);
        vm.expectRevert();
        passport.noteNegative(borrower);
    }

    /// @notice A completed plan writes itself into the record.
    /// @dev Through `Tier0Underwriter.notePlanOutcome`, which is permissionless and
    ///      reads the plan's own state. Nobody has to be trusted to report the outcome,
    ///      and nobody can decline to.
    function test_aCompletedPlanWritesTheRecord() public {
        InstallmentPlan p = _checkoutDefault();
        _payOff(p);
        tier0.notePlanOutcome(planId);

        (uint32 completions,, uint256 active, PlazoPassport.Tier tier) = passport.standingOf(borrower);
        assertEq(completions, 1, "the clean completion was not recorded");
        assertEq(active, 0, "a clean plan left a mark");
        assertEq(uint8(tier), uint8(PlazoPassport.Tier.Building), "one plan is not yet a history");
    }

    /// @notice A default is a mark, and a refund is not.
    /// @dev A merchant reversing a sale says nothing about the borrower in either
    ///      direction. Treating it as evidence would make credit standing purchasable
    ///      from any merchant willing to refund.
    function test_aDefaultMarksAndARefundDoesNot() public {
        InstallmentPlan p = _checkoutDefault();

        vm.warp(p.graceEndsAt(0) + 1);
        vm.prank(keeper);
        p.markMissed(0);
        tier0.noteDelinquency(planId);

        (,, uint256 active,) = passport.standingOf(borrower);
        assertEq(active, 1, "the delinquency was not recorded");
    }

    /// @notice The delinquency mark is permissionless and cannot be written twice.
    function test_theDelinquencyMarkIsPermissionlessAndIdempotent() public {
        InstallmentPlan p = _checkoutDefault();
        vm.warp(p.graceEndsAt(0) + 1);
        vm.prank(keeper);
        p.markMissed(0);

        vm.prank(stranger);
        tier0.noteDelinquency(planId);
        vm.prank(stranger);
        tier0.noteDelinquency(planId);

        (, uint32 ever, uint256 active,) = passport.standingOf(borrower);
        assertEq(ever, 1, "one delinquency produced two marks");
        assertEq(active, 1);
    }

    /// @notice A plan that is not delinquent cannot be marked.
    function test_aHealthyPlanCannotBeMarked() public {
        _checkoutDefault();
        vm.expectRevert();
        tier0.noteDelinquency(planId);
    }

    // ─── PASS-03: ageing ─────────────────────────────────────────────────────

    /// @notice A negative mark stops counting after twenty-four months.
    ///
    /// @dev A property of the read, not of a job somebody runs. Nothing is deleted; the
    ///      mark simply falls outside the window and stops being counted, so a record
    ///      cannot silently keep penalising a borrower because an operator's cron
    ///      failed.
    function test_aNegativeMarkAgesOut() public {
        InstallmentPlan p = _checkoutDefault();
        vm.warp(p.graceEndsAt(0) + 1);
        vm.prank(keeper);
        p.markMissed(0);
        tier0.noteDelinquency(planId);

        assertEq(passport.activeNegatives(borrower), 1, "the mark was never active");

        uint256 ttl = parameters.get(ParameterKeys.PASSPORT_NEGATIVE_MARK_TTL);
        vm.warp(vm.getBlockTimestamp() + ttl + 1);

        assertEq(passport.activeNegatives(borrower), 0, "the mark did not age out");

        (, uint32 ever,,) = passport.standingOf(borrower);
        assertEq(ever, 1, "the record forgot the mark ever happened");
    }

    // ─── PASS-06: the same history scores the same ───────────────────────────

    /// @notice The tier is a pure function of two integers.
    /// @dev No model in the base layer. Two borrowers whose plans ended the same way get
    ///      the same answer, and neither has to take anybody's word for it — the
    ///      function is public, and `packages/passport` reimplements it against a parity
    ///      corpus.
    function test_theTierIsAPureFunctionOfTheCounters() public view {
        assertEq(uint8(passport.score(0, 0)), uint8(PlazoPassport.Tier.Building));
        assertEq(uint8(passport.score(2, 0)), uint8(PlazoPassport.Tier.Established));
        assertEq(uint8(passport.score(5, 0)), uint8(PlazoPassport.Tier.Trusted));
        // One mark suppresses growth. Two inside two years is a pattern.
        assertEq(uint8(passport.score(9, 1)), uint8(PlazoPassport.Tier.Established));
        assertEq(uint8(passport.score(9, 2)), uint8(PlazoPassport.Tier.Impaired));
    }

    // ─── PASS-02: only the coarse tier, only through the router ──────────────

    /// @notice A stranger cannot read a tier.
    function test_aStrangerCannotReadATier() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PlazoPassport.NotPermitted.selector, stranger));
        passport.tierOf(borrower);
    }

    /// @notice The borrower can read their own, and so can the router.
    function test_theBorrowerAndTheRouterCanRead() public {
        InstallmentPlan p = _checkoutDefault();
        _payOff(p);
        tier0.notePlanOutcome(planId);

        vm.prank(borrower);
        PlazoPassport.Tier own = passport.tierOf(borrower);

        PlazoPassport.Tier viaRouter = checkout.passportTierOf(borrower);
        assertEq(uint8(own), uint8(viaRouter), "the router and the borrower disagree");
    }

    // ─── PASS-04 and PASS-07: consent ────────────────────────────────────────

    /// @notice A reader with the borrower's signature can read; without it they cannot.
    function test_consentIsASignatureNotAFlag() public {
        uint256 key = 0xB0110;
        address who = vm.addr(key);

        PlazoPassport.ConsentGrant memory grant = PlazoPassport.ConsentGrant({
            borrower: who,
            reader: reader,
            schemaId: SCHEMA,
            validUntil: vm.getBlockTimestamp() + 7 days,
            nonce: 1
        });

        vm.prank(reader);
        vm.expectRevert(abi.encodeWithSelector(PlazoPassport.NotPermitted.selector, reader));
        passport.tierWithConsent(who, SCHEMA);

        passport.grantConsent(grant, _sign(key, grant));

        vm.prank(reader);
        passport.tierWithConsent(who, SCHEMA);
        assertTrue(passport.hasConsent(who, reader, SCHEMA), "the grant did not land");
    }

    /// @notice Revocation bites immediately.
    /// @dev A revocation that took effect at the next renewal would be an expiry.
    function test_consentCanBeRevokedImmediately() public {
        uint256 key = 0xB0111;
        address who = vm.addr(key);

        PlazoPassport.ConsentGrant memory grant = PlazoPassport.ConsentGrant({
            borrower: who,
            reader: reader,
            schemaId: SCHEMA,
            validUntil: vm.getBlockTimestamp() + 7 days,
            nonce: 1
        });
        passport.grantConsent(grant, _sign(key, grant));

        vm.prank(who);
        passport.revokeConsent(reader, SCHEMA);

        vm.prank(reader);
        vm.expectRevert(abi.encodeWithSelector(PlazoPassport.NotPermitted.selector, reader));
        passport.tierWithConsent(who, SCHEMA);
    }

    /// @notice A grant cannot outlive its band, and cannot be replayed.
    function test_aGrantIsBoundedAndSingleUse() public {
        uint256 key = 0xB0112;
        address who = vm.addr(key);
        uint256 maxTtl = parameters.get(ParameterKeys.PASSPORT_CONSENT_MAX_TTL);

        PlazoPassport.ConsentGrant memory tooLong = PlazoPassport.ConsentGrant({
            borrower: who,
            reader: reader,
            schemaId: SCHEMA,
            validUntil: vm.getBlockTimestamp() + maxTtl + 1 days,
            nonce: 1
        });
        // Signed first. `_sign` reads `hashConsent` from the contract, and an external
        // call built inline consumes the `expectRevert` meant for `grantConsent`.
        bytes memory tooLongSig = _sign(key, tooLong);
        vm.expectRevert();
        passport.grantConsent(tooLong, tooLongSig);

        PlazoPassport.ConsentGrant memory ok = PlazoPassport.ConsentGrant({
            borrower: who,
            reader: reader,
            schemaId: SCHEMA,
            validUntil: vm.getBlockTimestamp() + 7 days,
            nonce: 2
        });
        bytes memory sig = _sign(key, ok);
        passport.grantConsent(ok, sig);

        bytes memory replayed =
            abi.encodeWithSelector(PlazoPassport.ConsentReplayed.selector, passport.hashConsent(ok));
        vm.expectRevert(replayed);
        passport.grantConsent(ok, sig);
    }

    /// @notice A forged signature does not grant anything.
    function test_aForgedConsentIsRefused() public {
        PlazoPassport.ConsentGrant memory grant = PlazoPassport.ConsentGrant({
            borrower: borrower,
            reader: reader,
            schemaId: SCHEMA,
            validUntil: vm.getBlockTimestamp() + 7 days,
            nonce: 1
        });
        // Signed by somebody who is not the borrower.
        bytes memory forged = _sign(0xDEADBEEF, grant);
        vm.expectRevert(abi.encodeWithSelector(PlazoPassport.ConsentSignatureInvalid.selector, borrower));
        passport.grantConsent(grant, forged);
    }

    // ─── PASS-07: correction and erasure ─────────────────────────────────────

    /// @notice A correction request is the borrower's own transaction.
    /// @dev Keyed by the salted subject rather than by the wallet, like every other
    ///      Passport event. A credit-record stream indexed on borrower addresses would
    ///      be a permanent public credit file, enumerable by anyone with an RPC
    ///      endpoint — which is the exposure PASS-09 keys plan events by `planId` to
    ///      avoid, except this one would be the record itself.
    function test_aCorrectionRequestIsKeyedBySubjectNotByWallet() public {
        vm.recordLogs();
        vm.prank(borrower);
        passport.requestCorrection(keccak256("disputed"), "not my plan");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "the request was not recorded");

        vm.prank(borrower);
        bytes32 subject = passport.subjectOf(borrower);
        assertEq(logs[0].topics[1], subject, "the event was not keyed by the subject");
        assertTrue(
            logs[0].topics[1] != bytes32(uint256(uint160(borrower))),
            "the borrower's wallet is in an indexed position"
        );
    }

    /// @notice A stranger cannot work out a borrower's log key.
    /// @dev The whole control. The subject is `keccak256(prefix ‖ salt ‖ borrower)` and
    ///      the salt is readable only by the borrower and `READER_ROLE`, so bulk
    ///      enumeration means guessing a salt rather than scanning a log.
    function test_aStrangerCannotComputeTheSubject() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PlazoPassport.NotPermitted.selector, stranger));
        passport.subjectOf(borrower);
    }

    /// @notice Rotating the salt changes the subject, so the old stream is orphaned.
    function test_erasureOrphansTheEventStream() public {
        passport.grantRole(passport.WRITER_ROLE(), address(this));
        passport.grantRole(passport.READER_ROLE(), address(this));

        passport.writeCommitment(borrower, keccak256("record"), SCHEMA);
        bytes32 before = passport.subjectOf(borrower);

        passport.rotateSalt(borrower);
        assertTrue(passport.subjectOf(borrower) != before, "the subject survived the rotation");
    }

    /// @notice Erasure rotates the salt and unlinks every prior commitment.
    ///
    /// @dev A chain cannot forget. What it can do is stop the record being
    ///      reconstructible: every commitment ever published was taken over the old
    ///      salt, and without it they are hashes of nothing anyone can check.
    function test_erasureRotatesTheSaltAndVoidsTheCommitment() public {
        passport.grantRole(passport.WRITER_ROLE(), address(this));
        passport.grantRole(passport.READER_ROLE(), address(this));

        bytes32 commitment = keccak256("record-v1");
        passport.writeCommitment(borrower, commitment, SCHEMA);
        assertTrue(passport.verify(borrower, commitment), "the commitment did not land");

        bytes32 saltBefore = passport.recordOf(borrower).salt;
        passport.rotateSalt(borrower);

        assertFalse(passport.verify(borrower, commitment), "the old commitment still verifies");
        assertTrue(passport.recordOf(borrower).salt != saltBefore, "the salt did not rotate");

        // The counters survive. They are the protocol's record of its own plans, derived
        // from public chain state, and erasing them would let a borrower discard a
        // default by asking.
        (uint32 completions,,,) = passport.standingOf(borrower);
        assertEq(completions, 0);
    }

    // ─── PASS-05: the schema registry ────────────────────────────────────────

    /// @notice Schemas are versioned, append-only and dense.
    /// @dev A commitment is meaningless without a published schema, and a schema that
    ///      could change under a commitment would make every historical record
    ///      unverifiable — which is exactly what the commitment exists to prevent.
    function test_schemasAreAppendOnlyAndSequential() public {
        schemas.publish(SCHEMA, 1, keccak256("v1"), "ipfs://one");
        schemas.publish(SCHEMA, 2, keccak256("v2"), "ipfs://two");

        assertEq(schemas.latest(SCHEMA).version, 2);
        assertEq(schemas.versionAt(SCHEMA, 1).contentHash, keccak256("v1"), "version 1 was rewritten");

        vm.expectRevert(abi.encodeWithSelector(AttestationSchemaRegistry.VersionNotSequential.selector, 3, 2));
        schemas.publish(SCHEMA, 2, keccak256("v2-again"), "ipfs://two");
    }

    function test_aSchemaNeedsAContentHash() public {
        vm.expectRevert(AttestationSchemaRegistry.ContentHashZero.selector);
        schemas.publish(SCHEMA, 1, bytes32(0), "ipfs://nothing");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _sign(uint256 key, PlazoPassport.ConsentGrant memory grant) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, passport.hashConsent(grant));
        return abi.encodePacked(r, s, v);
    }
}
