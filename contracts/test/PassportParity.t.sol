// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {PlazoPassport} from "../src/PlazoPassport.sol";
import {ParameterRegistry} from "../src/ParameterRegistry.sol";
import {ParameterKeys} from "../src/libraries/ParameterKeys.sol";

/// @title PassportParityTest
/// @notice Generates the corpus `packages/passport` is checked against.
///
/// @dev The fourth pair. `planId` in Phase 1, the strip in Phase 2, the underwriting
///      curve in Phase 3, and the credit score here — and this one carries the most
///      weight of the four, because it is the only one where a divergence would be
///      invisible rather than fatal.
///
///      A `planId` that disagrees produces a strip payable to an address that will never
///      hold code: the failure is loud, immediate and in front of a buyer. A *score*
///      that disagrees produces a number that looks perfectly reasonable and is simply
///      wrong, shown to a borrower as the reason they were declined.
///
///      PASS-06 says identical repayment histories produce identical scores. That is a
///      claim about a function, and the only way to make it checkable by the person it
///      protects is to publish the function and prove the two implementations agree.
contract PassportParityTest is Test {
    uint256 internal constant CORPUS_ROWS = 96;
    string internal constant CORPUS_DIR = "./corpus";
    string internal constant CORPUS_PATH = "./corpus/passport.json";

    PlazoPassport internal passport;
    ParameterRegistry internal parameters;

    function setUp() public {
        parameters = new ParameterRegistry(address(this));
        passport = new PlazoPassport(address(this), address(parameters));
        // Far enough in that a twenty-four-month cutoff does not clamp to zero, which
        // would make every ageing row in the corpus trivially "still active".
        vm.warp(1_800_000_000);
    }

    struct Row {
        uint256 completions;
        uint256 markCount;
        uint256 spread;
        uint64[8] marks;
        uint256 active;
        uint8 tier;
    }

    function _row(uint256 seed) internal view returns (Row memory row) {
        bytes32 s = keccak256(abi.encodePacked("plazo/passport-parity", seed));

        row.completions = seed % 9;
        row.markCount = (uint256(s) % 4);
        // How far back the marks are spread: some inside the window, some outside it.
        row.spread = (uint256(keccak256(abi.encodePacked("spread", s))) % (900 days));

        uint256 ttl = parameters.get(ParameterKeys.PASSPORT_NEGATIVE_MARK_TTL);
        uint256 now_ = vm.getBlockTimestamp();

        for (uint256 i = 0; i < row.markCount; ++i) {
            uint256 age = (row.spread * (i + 1)) / (row.markCount == 0 ? 1 : row.markCount);
            row.marks[i] = uint64(now_ - age);
            if (row.marks[i] != 0 && row.marks[i] >= now_ - ttl) row.active += 1;
        }

        row.tier = uint8(passport.score(row.completions, row.active));
    }

    function test_writePassportCorpus() public {
        string memory rows = "";
        for (uint256 i = 0; i < CORPUS_ROWS; ++i) {
            string memory row = _rowJson(_row(i));
            rows = i == 0 ? row : string.concat(rows, ",", row);
        }

        if (!vm.isDir(CORPUS_DIR)) vm.createDir(CORPUS_DIR, true);
        vm.writeFile(
            CORPUS_PATH,
            string.concat(
                '{"version":1,"now":"',
                vm.toString(vm.getBlockTimestamp()),
                '","ttl":"',
                vm.toString(parameters.get(ParameterKeys.PASSPORT_NEGATIVE_MARK_TTL)),
                '","markRing":',
                vm.toString(passport.MARK_RING()),
                ',"rows":[',
                rows,
                "]}"
            )
        );
    }

    function _rowJson(Row memory row) internal pure returns (string memory) {
        return string.concat(
            '{"completions":"',
            vm.toString(row.completions),
            '","marks":[',
            _marksJson(row),
            '],"active":"',
            vm.toString(row.active),
            '","tier":',
            vm.toString(uint256(row.tier)),
            "}"
        );
    }

    function _marksJson(Row memory row) internal pure returns (string memory out) {
        for (uint256 i = 0; i < row.markCount; ++i) {
            string memory mark = string.concat('"', vm.toString(uint256(row.marks[i])), '"');
            out = i == 0 ? mark : string.concat(out, ",", mark);
        }
    }

    // ─── Properties the corpus cannot express ────────────────────────────────

    /// @notice The tier never improves because a mark was added.
    /// @dev Fuzzed rather than sampled, because it is the property a recalibration could
    ///      break silently. A score that went *up* on a missed payment would be a bug
    ///      nobody would report — the borrower would not complain, and the lender would
    ///      not notice until the cohort did.
    function testFuzz_aMarkNeverImprovesTheTier(uint8 completions, uint8 active) public view {
        completions = uint8(bound(completions, 0, 40));
        active = uint8(bound(active, 0, 7));

        assertLe(
            uint8(passport.score(completions, uint256(active) + 1)),
            uint8(passport.score(completions, active)),
            "an extra negative mark improved the tier"
        );
    }

    /// @notice A clean completion never worsens the tier.
    function testFuzz_aCompletionNeverWorsensTheTier(uint8 completions, uint8 active) public view {
        completions = uint8(bound(completions, 0, 40));
        active = uint8(bound(active, 0, 7));

        assertGe(
            uint8(passport.score(uint256(completions) + 1, active)),
            uint8(passport.score(completions, active)),
            "a cleanly completed plan worsened the tier"
        );
    }

    /// @notice The scorer never returns `Unknown` for a record that exists.
    /// @dev `Unknown` means "no record". A scoring function that could produce it from
    ///      real counters would make an established borrower indistinguishable from a
    ///      stranger, which is the one confusion an underwriter must never make.
    function testFuzz_aRealRecordIsNeverUnknown(uint8 completions, uint8 active) public view {
        assertTrue(
            passport.score(bound(completions, 0, 40), bound(active, 0, 7)) != PlazoPassport.Tier.Unknown,
            "a record with counters scored as no record at all"
        );
    }
}
