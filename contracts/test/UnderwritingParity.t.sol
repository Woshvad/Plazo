// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {LimitAttestation} from "../src/libraries/LimitAttestation.sol";
import {Tier0Curve} from "../src/libraries/Tier0Curve.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";
import {ParameterRegistry} from "../src/ParameterRegistry.sol";

/// @title UnderwritingParityTest
/// @notice Generates the corpus `packages/plan-core`'s underwriting module is
///         checked against.
///
/// @dev Phase 1 proved parity for `planId` and the clone address; Phase 2 for the
///      strip, the schedule and the acceptance. This is the third pair, and it
///      matters for the same reason the first two did: the TypeScript side is what a
///      merchant's checkout and a borrower's client actually run.
///
///      Three things are pinned here.
///
///      **The attestation digest**, because an underwriting service that signs a
///      digest the router does not recompute the same way issues signatures that
///      cannot originate anything — and the failure surfaces at checkout, in front of
///      a buyer.
///
///      **The Tier-0 curve**, because UW-08 says a borrower can see exactly which
///      events produced their limit. A client that computes a different number from
///      the same completions is showing them a limit they do not have.
///
///      **The band**, because it is what the chain emits and what an operator's
///      anomaly detection reads. A client and a contract that disagree about which
///      bucket $250 falls in would make the whole emission unreadable.
contract UnderwritingParityTest is Test {
    uint256 internal constant CORPUS_ROWS = 64;
    string internal constant CORPUS_DIR = "./corpus";
    string internal constant CORPUS_PATH = "./corpus/underwriting.json";

    /// @dev A fixed address, so the corpus does not move when the deployment does.
    address internal constant ROUTER = 0x00000000000000000000000000000000000c0ffe;

    ParameterRegistry internal parameters;

    function setUp() public {
        parameters = new ParameterRegistry(address(this));
    }

    struct Row {
        LimitAttestation.Attestation attestation;
        uint256 cleanCompletions;
        bool identified;
        bool mutableSigner;
        uint256 tier0Limit;
        uint8 band;
        bytes32 structHash;
        bytes32 digest;
    }

    function _row(uint256 seed) internal view returns (Row memory row) {
        bytes32 s = keccak256(abi.encodePacked("plazo/underwriting-parity", seed));

        row.attestation = LimitAttestation.Attestation({
            sessionId: keccak256(abi.encodePacked("session", s)),
            planId: keccak256(abi.encodePacked("plan", s)),
            borrower: address(uint160(uint256(keccak256(abi.encodePacked("borrower", s))))),
            personId: keccak256(abi.encodePacked("person", s)),
            identityClass: uint8(seed % 2),
            limit: uint256(keccak256(abi.encodePacked("limit", s))) % (6000 * 1e6),
            validUntil: 1_800_000_000 + (uint256(s) % 900)
        });

        row.cleanCompletions = seed % 20;
        row.identified = seed % 2 == 1;
        row.mutableSigner = seed % 3 == 0;

        row.tier0Limit =
            Tier0Curve.limitFor(row.cleanCompletions, row.identified, row.mutableSigner, _curveParams());
        row.band = _band(row.attestation.limit);

        row.structHash = LimitAttestation.hashStruct(row.attestation);
        row.digest = LimitAttestation.digest(row.attestation, block.chainid, ROUTER);
    }

    function _curveParams() internal view returns (Tier0Curve.Params memory) {
        return Tier0Curve.Params({
            initialLimit: parameters.get(ParameterKeys.TIER0_INITIAL_LIMIT),
            growthBps: parameters.get(ParameterKeys.TIER0_GROWTH_BPS),
            pseudonymousCap: parameters.get(ParameterKeys.TIER0_PSEUDONYMOUS_CAP),
            identifiedCap: parameters.get(ParameterKeys.TIER0_IDENTIFIED_CAP),
            contractSignerCapBps: parameters.get(ParameterKeys.CONTRACT_SIGNER_CAP_BPS)
        });
    }

    /// @dev Mirrors `CheckoutRouter.bandOf`, which is `pure` and needs no deployment.
    function _band(uint256 limit) internal pure returns (uint8) {
        return LimitAttestation.bandOf(limit);
    }

    function test_writeUnderwritingCorpus() public {
        string memory rows = "";
        for (uint256 i = 0; i < CORPUS_ROWS; ++i) {
            string memory row = _rowJson(_row(i));
            rows = i == 0 ? row : string.concat(rows, ",", row);
        }

        if (!vm.isDir(CORPUS_DIR)) vm.createDir(CORPUS_DIR, true);
        vm.writeFile(
            CORPUS_PATH,
            string.concat(
                '{"version":1,"chainId":',
                vm.toString(block.chainid),
                ',"router":"',
                vm.toString(ROUTER),
                '","params":',
                _paramsJson(),
                ',"rows":[',
                rows,
                "]}"
            )
        );
    }

    function _paramsJson() internal view returns (string memory) {
        Tier0Curve.Params memory p = _curveParams();
        return string.concat(
            '{"initialLimit":"',
            vm.toString(p.initialLimit),
            '","growthBps":"',
            vm.toString(p.growthBps),
            '","pseudonymousCap":"',
            vm.toString(p.pseudonymousCap),
            '","identifiedCap":"',
            vm.toString(p.identifiedCap),
            '","contractSignerCapBps":"',
            vm.toString(p.contractSignerCapBps),
            '"}'
        );
    }

    /// @dev Split in three. Solidity's stack does not have room for a thirteen-field
    ///      `string.concat`, which is the same wall the plan's collection path hit in
    ///      Phase 2 and has the same fix.
    function _rowJson(Row memory row) internal pure returns (string memory) {
        return string.concat("{", _attestationJson(row), ",", _curveJson(row), ",", _hashJson(row), "}");
    }

    function _attestationJson(Row memory row) internal pure returns (string memory) {
        return string.concat(
            '"sessionId":"',
            vm.toString(row.attestation.sessionId),
            '","planId":"',
            vm.toString(row.attestation.planId),
            '","borrower":"',
            vm.toString(row.attestation.borrower),
            '","personId":"',
            vm.toString(row.attestation.personId),
            '","identityClass":',
            vm.toString(uint256(row.attestation.identityClass)),
            ',"limit":"',
            vm.toString(row.attestation.limit),
            '","validUntil":"',
            vm.toString(row.attestation.validUntil),
            '"'
        );
    }

    function _curveJson(Row memory row) internal pure returns (string memory) {
        return string.concat(
            '"cleanCompletions":"',
            vm.toString(row.cleanCompletions),
            '","identified":',
            row.identified ? "true" : "false",
            ',"mutableSigner":',
            row.mutableSigner ? "true" : "false",
            ',"tier0Limit":"',
            vm.toString(row.tier0Limit),
            '","band":',
            vm.toString(uint256(row.band))
        );
    }

    function _hashJson(Row memory row) internal pure returns (string memory) {
        return string.concat(
            '"structHash":"', vm.toString(row.structHash), '","digest":"', vm.toString(row.digest), '"'
        );
    }

    /// @notice The curve is monotone in clean completions and never exceeds its cap.
    /// @dev Fuzzed rather than sampled, because these are the two properties a
    ///      recalibration could break without any test noticing: a growth factor set
    ///      below 1.0 would make good behaviour shrink a limit, and a cap read from
    ///      the wrong row would let one identity class inherit the other's ceiling.
    function testFuzz_theCurveIsMonotoneAndCapped(uint8 completions, bool identified) public view {
        completions = uint8(bound(completions, 0, 30));
        Tier0Curve.Params memory p = _curveParams();

        uint256 lower = Tier0Curve.limitFor(completions, identified, false, p);
        uint256 upper = Tier0Curve.limitFor(uint256(completions) + 1, identified, false, p);

        assertGe(upper, lower, "a clean completion reduced the limit");
        assertLe(upper, identified ? p.identifiedCap : p.pseudonymousCap, "the identity cap did not bind");
    }

    /// @notice A mutable signer is never offered more than an immutable one.
    function testFuzz_aMutableSignerNeverGetsMore(uint8 completions, bool identified) public view {
        completions = uint8(bound(completions, 0, 30));
        Tier0Curve.Params memory p = _curveParams();

        assertLe(
            Tier0Curve.limitFor(completions, identified, true, p),
            Tier0Curve.limitFor(completions, identified, false, p),
            "a contract signer was offered more than an EOA"
        );
    }
}
