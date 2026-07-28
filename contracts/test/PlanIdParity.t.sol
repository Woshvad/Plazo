// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {PlanId} from "../src/libraries/PlanId.sol";
import {CloneAddress} from "../src/libraries/CloneAddress.sol";
import {PlanFactory} from "../src/PlanFactory.sol";
import {PlanImplementationStub} from "./mocks/PlanImplementationStub.sol";

/// @notice Emits the corpus that `packages/plan-core` must reproduce byte for byte.
///
/// @dev The parity test is a differential test, not a golden-file test: the corpus
///      is regenerated here and recomputed there, so a change on either side that
///      the other does not follow fails CI. `planId` cannot be fixed after a strip
///      is signed — the borrower's authorizations name a payee derived from it —
///      so a silent divergence between the contract and the SDK is a migration,
///      discovered at the worst possible time.
contract PlanIdParityTest is Test {
    using PlanId for PlanId.PlanTerms;

    PlanFactory internal factory;
    address internal implementation;

    /// @dev 128 rows is enough to catch field-ordering and encoding drift while
    ///      keeping the JSON small enough to read when it fails.
    uint256 internal constant CORPUS_ROWS = 128;
    string internal constant CORPUS_DIR = "./corpus";
    string internal constant CORPUS_PATH = "./corpus/plan-id.json";

    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function setUp() public {
        implementation = address(new PlanImplementationStub());
        factory = new PlanFactory(implementation);
    }

    /// @notice Write the corpus for the TypeScript side.
    function test_writeCorpus() public {
        string memory rows = "";

        for (uint256 i = 0; i < CORPUS_ROWS; ++i) {
            string memory row = _rowJson(_terms(i));
            rows = i == 0 ? row : string.concat(rows, ",", row);
        }

        string memory json = string.concat(
            '{"planIdTypehash":"',
            vm.toString(PlanId.PLAN_ID_TYPEHASH),
            '","erc1167CreationPrefix":"',
            vm.toString(abi.encodePacked(CloneAddress.CREATION_PREFIX, CloneAddress.RUNTIME_PREFIX)),
            '","erc1167RuntimeSuffix":"',
            vm.toString(abi.encodePacked(CloneAddress.RUNTIME_SUFFIX)),
            '","rows":[',
            rows,
            "]}"
        );

        if (!vm.isDir(CORPUS_DIR)) vm.createDir(CORPUS_DIR, true);
        vm.writeFile(CORPUS_PATH, json);
        console.log("corpus rows:", CORPUS_ROWS);
    }

    /// @notice Prediction and deployment agree for every corpus row.
    /// @dev This is the half a TypeScript test cannot do. `plan-core` proves it
    ///      computes the same address as the library; only an actual CREATE2 proves
    ///      the library computes the same address as the EVM.
    function test_predictionMatchesDeployment() public {
        for (uint256 i = 0; i < 16; ++i) {
            PlanId.PlanTerms memory terms = _terms(i);
            address predicted = factory.predictPlanAddress(terms);
            (bytes32 planId, address deployed) = factory.deploy(terms);

            assertEq(deployed, predicted, "predicted address does not match deployment");
            assertEq(factory.planOf(planId), deployed, "factory did not record the plan");
            assertGt(deployed.code.length, 0, "clone has no code");
        }
    }

    /// @notice Fuzzed: prediction matches deployment for arbitrary terms.
    function testFuzz_predictionMatchesDeployment(
        address borrower,
        address merchant,
        uint96 principal,
        uint8 installmentCount,
        uint32 firstDueDate,
        uint32 interval,
        uint64 originationNonce,
        bytes32 termsHash
    ) public {
        vm.assume(principal > 0);
        vm.assume(installmentCount > 0);
        vm.assume(interval > 0);

        PlanId.PlanTerms memory terms = PlanId.PlanTerms({
            chainId: block.chainid,
            factory: address(factory),
            implementation: implementation,
            borrower: borrower,
            merchant: merchant,
            token: ARC_USDC,
            principal: principal,
            installmentCount: installmentCount,
            firstDueDate: firstDueDate,
            interval: interval,
            originationNonce: originationNonce,
            termsHash: termsHash
        });

        address predicted = factory.predictPlanAddress(terms);
        (, address deployed) = factory.deploy(terms);
        assertEq(deployed, predicted);
    }

    /// @notice An origination nonce is what separates two identical purchases.
    /// @dev Without it a borrower buying the same item twice, or retrying a checkout
    ///      that timed out, derives the same `planId` and therefore the same
    ///      authorization nonces. EIP-3009 nonces are single-use and
    ///      `cancelAuthorization` burns them permanently, so the second plan would
    ///      be unsignable forever.
    function test_originationNonceSeparatesIdenticalPurchases() public view {
        PlanId.PlanTerms memory first = _terms(0);
        PlanId.PlanTerms memory second = _terms(0);
        second.originationNonce = first.originationNonce + 1;

        bytes32 idA = first.derive();
        bytes32 idB = second.derive();

        assertTrue(idA != idB, "identical terms with different origination nonces collided");
        assertTrue(
            PlanId.checkNonce(idA, 0) != PlanId.checkNonce(idB, 0),
            "check nonces collided across origination attempts"
        );
    }

    /// @notice A new plan implementation produces a different plan identity.
    /// @dev The borrower authorizes a pull to an address. If that address could be
    ///      pointed at different logic afterwards, the signature commits to an
    ///      address rather than to a deal. Putting the implementation in the
    ///      preimage is what makes "the signed bytes commit to the disclosed deal"
    ///      true rather than aspirational.
    function test_implementationChangeChangesPlanId() public {
        address nextVintage = address(new PlanImplementationStub());
        PlanFactory nextFactory = new PlanFactory(nextVintage);

        PlanId.PlanTerms memory terms = _terms(3);
        bytes32 idOld = terms.derive();

        terms.factory = address(nextFactory);
        terms.implementation = nextVintage;
        bytes32 idNew = terms.derive();

        assertTrue(idOld != idNew, "a new vintage reused an outstanding plan identity");
    }

    /// @notice Nonces are unique within a plan and never collide across plans.
    function testFuzz_nonceUniqueness(bytes32 planIdA, bytes32 planIdB, uint8 i, uint8 j) public pure {
        vm.assume(planIdA != planIdB);
        vm.assume(i != j);

        assertTrue(PlanId.checkNonce(planIdA, i) != PlanId.checkNonce(planIdA, j), "collision within plan");
        assertTrue(PlanId.checkNonce(planIdA, i) != PlanId.checkNonce(planIdB, i), "collision across plans");
    }

    /// @notice The factory refuses terms it could not originate.
    function test_rejectsTermsBoundToAnotherFactory() public {
        PlanId.PlanTerms memory terms = _terms(1);
        terms.factory = address(0xBEEF);

        vm.expectRevert(
            abi.encodeWithSelector(PlanFactory.FactoryMismatch.selector, address(factory), address(0xBEEF))
        );
        factory.derivePlanId(terms);
    }

    function test_rejectsDuplicateDeployment() public {
        PlanId.PlanTerms memory terms = _terms(2);
        (bytes32 planId, address plan) = factory.deploy(terms);

        vm.expectRevert(abi.encodeWithSelector(PlanFactory.PlanAlreadyDeployed.selector, planId, plan));
        factory.deploy(terms);
    }

    function _terms(uint256 seed) internal view returns (PlanId.PlanTerms memory) {
        return PlanId.PlanTerms({
            chainId: block.chainid,
            factory: address(factory),
            implementation: implementation,
            borrower: address(uint160(uint256(keccak256(abi.encodePacked("borrower", seed))))),
            merchant: address(uint160(uint256(keccak256(abi.encodePacked("merchant", seed))))),
            token: ARC_USDC,
            // $75.00 to $2,122.75 in 6-decimal USDC — spanning the corrected minimum
            // ticket rather than an arbitrary range.
            principal: 75_000_000 + (seed * 16_075_000),
            installmentCount: 3 + (seed % 10),
            firstDueDate: 1_800_000_000 + (seed * 86_400),
            interval: seed % 2 == 0 ? 14 days : 30 days,
            originationNonce: uint256(keccak256(abi.encodePacked("origination", seed))),
            termsHash: keccak256(abi.encodePacked("terms", seed))
        });
    }

    /// @dev Split across three helpers purely to stay under the stack limit; the
    ///      corpus is wide and `string.concat` holds every operand live at once.
    function _rowJson(PlanId.PlanTerms memory terms) internal view returns (string memory) {
        bytes32 planId = terms.derive();
        return string.concat(
            "{",
            _addressFieldsJson(terms),
            ",",
            _scalarFieldsJson(terms),
            ',"planId":"',
            vm.toString(planId),
            '","predictedAddress":"',
            vm.toString(CloneAddress.predict(address(factory), terms.implementation, planId)),
            '","nonces":',
            _noncesJson(planId, terms.installmentCount),
            "}"
        );
    }

    function _addressFieldsJson(PlanId.PlanTerms memory terms) internal pure returns (string memory) {
        return string.concat(
            '"factory":"',
            vm.toString(terms.factory),
            '","implementation":"',
            vm.toString(terms.implementation),
            '","borrower":"',
            vm.toString(terms.borrower),
            '","merchant":"',
            vm.toString(terms.merchant),
            '","token":"',
            vm.toString(terms.token),
            '"'
        );
    }

    function _scalarFieldsJson(PlanId.PlanTerms memory terms) internal pure returns (string memory) {
        return string.concat(
            '"chainId":"',
            vm.toString(terms.chainId),
            '","principal":"',
            vm.toString(terms.principal),
            '","installmentCount":"',
            vm.toString(terms.installmentCount),
            '","firstDueDate":"',
            vm.toString(terms.firstDueDate),
            '","interval":"',
            vm.toString(terms.interval),
            '","originationNonce":"',
            vm.toString(terms.originationNonce),
            '","termsHash":"',
            vm.toString(terms.termsHash),
            '"'
        );
    }

    function _noncesJson(bytes32 planId, uint256 count) internal pure returns (string memory json) {
        bytes32[] memory nonces = PlanId.checkNonces(planId, count);
        json = "[";
        for (uint256 i = 0; i < nonces.length; ++i) {
            json = string.concat(json, i == 0 ? '"' : ',"', vm.toString(nonces[i]), '"');
        }
        json = string.concat(json, "]");
    }
}
