// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {PlanId} from "../src/libraries/PlanId.sol";
import {PlanParams} from "../src/libraries/PlanParams.sol";
import {PlanAcceptance} from "../src/libraries/PlanAcceptance.sol";
import {TermsDetail} from "../src/libraries/TermsDetail.sol";
import {CloneAddress} from "../src/libraries/CloneAddress.sol";

/// @title StripParityTest
/// @notice Generates the corpus `packages/plan-core` is checked against.
///
/// @dev Phase 1 established parity for `planId`, the nonces and the clone address.
///      Phase 2 adds everything a borrower's wallet has to build before any of that
///      is useful: the terms commitment, the schedule, the face values, the
///      authorization windows and the acceptance digest.
///
///      The reason to spend a corpus on this rather than trust two readings of the
///      same specification is that the TypeScript side is what a borrower runs.
///      `packages/plan-core` has no network, server or database dependency
///      precisely so a borrower can recompute what they signed without Plazo's
///      cooperation — and that guarantee is worth exactly as much as the agreement
///      between the two implementations. A single off-by-one in the jitter would
///      make every recomputed due date wrong while every test on either side still
///      passed.
contract StripParityTest is Test {
    uint256 internal constant CORPUS_ROWS = 64;
    string internal constant CORPUS_DIR = "./corpus";
    string internal constant CORPUS_PATH = "./corpus/plan-strip.json";

    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address internal constant FACTORY = 0x00000000000000000000000000000000000fAc70;
    address internal constant IMPLEMENTATION = 0x0000000000000000000000000000000000019911;

    struct Row {
        PlanId.PlanTerms terms;
        TermsDetail.Detail detail;
        bytes32 planId;
        address planAddress;
        uint256 validUntil;
    }

    function _row(uint256 seed) internal view returns (Row memory row) {
        bytes32 s = keccak256(abi.encodePacked("plazo/strip-parity", seed));

        row.detail = TermsDetail.Detail({
            jurisdiction: keccak256(abi.encodePacked("jurisdiction", s)),
            lineItemsHash: keccak256(abi.encodePacked("basket", s)),
            mdrBps: uint256(s) % 900,
            lateFeeFlat: uint256(keccak256(abi.encodePacked("fee", s))) % (25 * PlanParams.ONE_USDC),
            signerClass: seed % 2 == 0 ? TermsDetail.SignerClass.EOA : TermsDetail.SignerClass.Contract,
            settlementRecipient: address(uint160(uint256(keccak256(abi.encodePacked("pool", s))))),
            fxRouter: address(uint160(uint256(keccak256(abi.encodePacked("router", s)))))
        });

        row.terms = PlanId.PlanTerms({
            chainId: block.chainid,
            factory: FACTORY,
            implementation: IMPLEMENTATION,
            borrower: address(uint160(uint256(keccak256(abi.encodePacked("borrower", s))))),
            merchant: address(uint160(uint256(keccak256(abi.encodePacked("merchant", s))))),
            token: ARC_USDC,
            // Above the minimum ticket, and deliberately including values that do not
            // divide evenly — the remainder is where a schedule silently loses a cent.
            principal: PlanParams.MIN_TICKET + (uint256(s) % 5_000_000_000),
            installmentCount: 2 + (uint256(keccak256(abi.encodePacked("count", s))) % 11),
            firstDueDate: 1_800_000_000 + (uint256(keccak256(abi.encodePacked("start", s))) % 60 days),
            interval: 1 days + (uint256(keccak256(abi.encodePacked("gap", s))) % 30 days),
            originationNonce: uint256(keccak256(abi.encodePacked("nonce", s))),
            termsHash: bytes32(0)
        });

        row.terms.termsHash = TermsDetail.hash(row.detail);
        row.planId = PlanId.derive(row.terms);
        row.planAddress = CloneAddress.predict(FACTORY, IMPLEMENTATION, row.planId);
        row.validUntil = row.terms.firstDueDate + 1 hours;
    }

    function _dueDate(Row memory row, uint256 index) internal pure returns (uint256) {
        if (index == 0) return row.terms.firstDueDate;
        int256 shifted =
            int256(row.terms.firstDueDate + index * row.terms.interval) + PlanParams.jitter(row.planId);
        return uint256(shifted);
    }

    function _amount(Row memory row, uint256 index) internal pure returns (uint256) {
        uint256 base = row.terms.principal / row.terms.installmentCount;
        return index == 0 ? base + (row.terms.principal % row.terms.installmentCount) : base;
    }

    function _acceptance(Row memory row) internal pure returns (PlanAcceptance.Acceptance memory) {
        return PlanAcceptance.Acceptance({
            planId: row.planId,
            borrower: row.terms.borrower,
            merchant: row.terms.merchant,
            token: row.terms.token,
            principal: row.terms.principal,
            installmentCount: row.terms.installmentCount,
            firstInstallment: _amount(row, 0),
            laterInstallment: _amount(row, 1),
            firstDueDate: _dueDate(row, 0),
            finalDueDate: _dueDate(row, row.terms.installmentCount - 1),
            interval: row.terms.interval,
            termsHash: row.terms.termsHash,
            validUntil: row.validUntil
        });
    }

    function test_writeStripCorpus() public {
        string memory rows = "";
        for (uint256 i = 0; i < CORPUS_ROWS; ++i) {
            string memory row = _rowJson(_row(i));
            rows = i == 0 ? row : string.concat(rows, ",", row);
        }

        if (!vm.isDir(CORPUS_DIR)) vm.createDir(CORPUS_DIR, true);
        vm.writeFile(
            CORPUS_PATH,
            string.concat('{"version":1,"chainId":', vm.toString(block.chainid), ',"rows":[', rows, "]}")
        );
    }

    function _rowJson(Row memory row) internal view returns (string memory) {
        return string.concat(
            "{",
            _termsJson(row),
            ",",
            _detailJson(row),
            ",",
            _derivedJson(row),
            ",",
            _scheduleJson(row),
            "}"
        );
    }

    function _termsJson(Row memory row) internal pure returns (string memory) {
        return string.concat(
            '"factory":"',
            vm.toString(row.terms.factory),
            '","implementation":"',
            vm.toString(row.terms.implementation),
            '","borrower":"',
            vm.toString(row.terms.borrower),
            '","merchant":"',
            vm.toString(row.terms.merchant),
            '","token":"',
            vm.toString(row.terms.token),
            '","principal":"',
            vm.toString(row.terms.principal),
            '","installmentCount":"',
            vm.toString(row.terms.installmentCount),
            '","firstDueDate":"',
            vm.toString(row.terms.firstDueDate),
            '","interval":"',
            vm.toString(row.terms.interval),
            '","originationNonce":"',
            vm.toString(row.terms.originationNonce),
            '"'
        );
    }

    function _detailJson(Row memory row) internal pure returns (string memory) {
        return string.concat(
            '"jurisdiction":"',
            vm.toString(row.detail.jurisdiction),
            '","lineItemsHash":"',
            vm.toString(row.detail.lineItemsHash),
            '","mdrBps":"',
            vm.toString(row.detail.mdrBps),
            '","lateFeeFlat":"',
            vm.toString(row.detail.lateFeeFlat),
            '","signerClass":',
            vm.toString(uint256(row.detail.signerClass)),
            ',"settlementRecipient":"',
            vm.toString(row.detail.settlementRecipient),
            '","fxRouter":"',
            vm.toString(row.detail.fxRouter),
            '"'
        );
    }

    function _derivedJson(Row memory row) internal view returns (string memory) {
        return string.concat(
            '"termsHash":"',
            vm.toString(row.terms.termsHash),
            '","planId":"',
            vm.toString(row.planId),
            '","planAddress":"',
            vm.toString(row.planAddress),
            '","jitter":"',
            vm.toString(PlanParams.jitter(row.planId)),
            '","markEscrow":"',
            vm.toString(PlanParams.markEscrowFor(row.terms.installmentCount)),
            '","validUntil":"',
            vm.toString(row.validUntil),
            '","acceptanceDigest":"',
            vm.toString(PlanAcceptance.digest(_acceptance(row), block.chainid, row.planAddress)),
            '"'
        );
    }

    function _scheduleJson(Row memory row) internal pure returns (string memory) {
        string memory dues = "";
        string memory amounts = "";
        string memory nonces = "";
        string memory bounties = "";

        for (uint256 i = 0; i < row.terms.installmentCount; ++i) {
            string memory sep = i == 0 ? "" : ",";
            dues = string.concat(dues, sep, '"', vm.toString(_dueDate(row, i)), '"');
            amounts = string.concat(amounts, sep, '"', vm.toString(_amount(row, i)), '"');
            nonces = string.concat(nonces, sep, '"', vm.toString(PlanId.checkNonce(row.planId, i)), '"');
            // Sampled at the end of the grace window, where the ramp, the floor and
            // the cap can all bind depending on the ticket.
            bounties = string.concat(
                bounties,
                sep,
                '"',
                vm.toString(
                    PlanParams.collectBounty(_amount(row, i), PlanParams.GRACE_WINDOW, PlanParams.GRACE_WINDOW)
                ),
                '"'
            );
        }

        return string.concat(
            '"dueDates":[',
            dues,
            '],"amounts":[',
            amounts,
            '],"nonces":[',
            nonces,
            '],"bountiesAtGraceEnd":[',
            bounties,
            "]"
        );
    }
}
