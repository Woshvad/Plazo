// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CorridorFixture} from "../helpers/CorridorFixture.sol";
import {PlanFixture} from "../helpers/PlanFixture.sol";
import {InstallmentPlan} from "../../src/InstallmentPlan.sol";
import {TranchedCreditPool} from "../../src/TranchedCreditPool.sol";
import {PlanParams} from "../../src/libraries/PlanParams.sol";
import {IInstallmentPlan} from "../../src/interfaces/IInstallmentPlan.sol";
import {PayrollSweeper} from "../../src/underwriting/PayrollSweeper.sol";
import {MockArcStablecoin} from "../mocks/MockArcStablecoin.sol";
import {MockArcUsdc} from "../mocks/MockArcUsdc.sol";

/// @notice What the two-book properties read: the paper a campaign has written, and the
///         corridors it has written it into.
///
/// @dev A narrow view rather than a handler type, so `FxInvariants` stays bound to an
///      interface (DEC-48) and a Certora harness can supply the same three answers from
///      ghost state without inheriting a Foundry handler.
interface ICorridorPaper {
    function paperCount() external view returns (uint256);

    /// @return planId The plan.
    /// @return pool The book named in that plan's own `settlementRecipient`.
    function paperAt(uint256 index) external view returns (bytes32 planId, address pool);

    function corridorCount() external view returns (uint256);
    function corridorAt(uint256 index) external view returns (bytes32);
}

/// @title FxInvariants
/// @notice Properties for the cross-currency and payroll-deduction surfaces.
///
/// @dev Created by plan 07-05 with the one property UW-05 turns on; extended by 07-10
///      with the cross-pool isolation and corridor-counter properties.
///
///      Named `check_*` rather than `invariant_*` for the reason `PlanInvariants` gives:
///      the property module is bound by a harness, and the harness is what decides which
///      properties a given campaign asserts.
///
///      **Each property binds to something the system already exposes** — DEC-48. An
///      invariant that needs new storage on the contract under test in order to be
///      observable has changed the system it was meant to constrain, and then it is
///      describing the instrumentation rather than the design.
abstract contract FxInvariants is Test {
    /// @dev The token whose balance is watched, and the address it is watched at. Both
    ///      set by the harness; nothing is added to `PayrollSweeper` to make this
    ///      readable, because an ERC-20 balance already is.
    IERC20 internal sweptToken;
    address internal sweepContract;

    // ─── UW-05 / C3 ──────────────────────────────────────────────────────────

    /// @notice The sweeper never holds value.
    ///
    /// @dev The non-custody claim, stated over every reachable history rather than over
    ///      the two or three a scripted test can write down. "Borrower funds stay in the
    ///      borrower's wallet until each due date" is a project constraint, and payroll
    ///      deduction is the one mechanism in this phase whose plain-language description
    ///      — value splitting off an inbound flow — reads like a custody contract. So the
    ///      design receives and repays in one transaction, returns every unit of residue
    ///      to the borrower, and reverts `SweeperRetainedValue` if its own balance is
    ///      anything but zero when it finishes. This asserts the observable consequence:
    ///      between any two transactions, whatever sequence of sweeps, collections,
    ///      cures, opt-ins and opt-outs produced them, there is nothing there.
    ///
    ///      Stated over *protocol* flows. An unsolicited transfer straight to the
    ///      sweeper's address is not one — nothing in the tree performs it, and the next
    ///      sweep would forward it to that borrower rather than stranding it.
    ///
    /// @custom:certora sweeperNeverHoldsValue
    function check_sweeperNeverHoldsValue() public view {
        assertEq(
            sweptToken.balanceOf(sweepContract),
            0,
            "the payroll sweeper is holding borrower funds between transactions"
        );
    }

    // ─── FX-03 / FX-04, added by plan 07-10 ──────────────────────────────────

    /// @dev The two books, and the campaign's record of what it wrote into them. Set by
    ///      the harness; nothing is added to `TranchedCreditPool` to make any of this
    ///      readable, because `bookOf` and `corridorExposure` already are (DEC-48).
    TranchedCreditPool internal usdcBook;
    TranchedCreditPool internal eurcBook;
    ICorridorPaper internal paper;

    /// @notice A receivable is booked in exactly one pool, and it is the pool the plan
    ///         itself names.
    ///
    /// @dev **This is the honest form of FX-03's "the warehouse exposure is booked", and
    ///      the reasoning is written here because a reader expecting a hedge-accounting
    ///      invariant will otherwise think one is missing.**
    ///
    ///      Under E-01's two-pool design there is no cross-currency position inside a
    ///      book to mark. A EURC lender holds EURC assets against EURC liabilities and
    ///      nets to zero FX exposure; the residual dollar exposure sits with whoever
    ///      seeded the book, outside it. There is nothing to hedge and — E-02, E-03 —
    ///      nothing to hedge it with: StableFX's `tenor` enum is `instant | hourly |
    ///      daily`, so no forward exists to lay a 56-day strip off into, and StableFX
    ///      access is KYB-gated and not held, so the venue interface is stubbed and
    ///      cannot execute at all. An invariant asserting "the warehouse is hedged" would
    ///      be asserting something about an instrument that does not exist.
    ///
    ///      What *does* protect NAV is that the two balance sheets never commingle. A
    ///      EURC receivable appearing in the dollar book would make **both** books wrong
    ///      at once — the dollar book carrying paper it never wrote and the euro book
    ///      missing paper it funded — and neither would show it, because each one's
    ///      internal accounting would still balance against its own numbers. That is
    ///      checkable, so it is what is checked.
    ///
    ///      Stated over the row's existence rather than only over a non-zero `carrying`,
    ///      because a fully-recovered plan in the wrong book is the same defect caught a
    ///      week later.
    ///
    /// @custom:certora eurcPaperNeverEntersTheUsdcBook
    function check_eurcPaperNeverEntersTheUsdcBook() public view {
        uint256 n = paper.paperCount();
        for (uint256 i = 0; i < n; ++i) {
            (bytes32 planId, address expected) = paper.paperAt(i);

            bool inUsdc = usdcBook.bookOf(planId).plan != address(0);
            bool inEurc = eurcBook.bookOf(planId).plan != address(0);

            assertFalse(inUsdc && inEurc, "one receivable is carried by both books at once");
            assertEq(
                inUsdc ? address(usdcBook) : address(eurcBook),
                expected,
                "a receivable is booked in a pool other than the one its own plan settles to"
            );
            assertTrue(inUsdc || inEurc, "a fronted receivable is carried by neither book");

            TranchedCreditPool other = expected == address(usdcBook) ? eurcBook : usdcBook;
            assertEq(other.bookOf(planId).carrying, 0, "the other book is carrying this plan's paper");
        }
    }

    /// @notice Each pool's corridor counters sum to the open paper that pool holds.
    ///
    /// @dev FX-04's exposure cap is only worth having if the counter it reads is exact,
    ///      and E-06 says this phase supplied a *value* to an existing counter rather
    ///      than building a new one — so the counter's exactness is the thing worth
    ///      asserting about it.
    ///
    ///      What a drift would do, in whichever direction it ran: a counter above the
    ///      open paper binds the cap early and refuses credit the book had room for; a
    ///      counter below it binds late and writes concentration the LPs were told could
    ///      not be written. Both are silent, because nothing else in the system
    ///      reconciles the two figures.
    ///
    ///      `open` is the qualifier that makes this exact: `_close` reduces the counter
    ///      by the remaining carrying and zeroes it, so a closed plan contributes to
    ///      neither side.
    ///
    /// @custom:certora corridorExposureSumsToOpenPaper
    function check_corridorExposureSumsToOpenPaper() public view {
        _assertCounterExact(usdcBook);
        _assertCounterExact(eurcBook);
    }

    function _assertCounterExact(TranchedCreditPool pool) private view {
        uint256 counted;
        uint256 corridors = paper.corridorCount();
        for (uint256 c = 0; c < corridors; ++c) {
            counted += pool.corridorExposure(paper.corridorAt(c));
        }

        uint256 open;
        uint256 n = paper.paperCount();
        for (uint256 i = 0; i < n; ++i) {
            (bytes32 planId,) = paper.paperAt(i);
            TranchedCreditPool.PlanBook memory book = pool.bookOf(planId);
            if (book.open) open += book.carrying;
        }

        assertEq(counted, open, "a corridor counter has drifted from the open paper the cap gates on");
    }
}

/// @notice The system's environment for the sweeper: a payroll deposit landing at random
///         moments, a borrower who opts in and out, a keeper cranking the ordinary rail,
///         and a clock that jumps.
///
/// @dev The handler signs its own sweep authorizations, because a handler that could only
///      replay one pre-built signature would exercise one value at one index and the
///      campaign would be a single scripted path wearing a fuzzer's clothes.
///
///      Every action swallows its own revert — `fail_on_revert = false`, and roughly half
///      of these calls are expected to be refused by design (a burned nonce, a closed
///      plan, a withdrawn opt-in). Which is also how an invariant suite quietly becomes
///      sixteen thousand no-ops reporting green, so the counters below exist and
///      `test_theHandlerDrivesTheSystem` requires each of them to move.
contract PayrollSweepHandler is Test {
    InstallmentPlan public plan;
    MockArcUsdc public usdc;
    PayrollSweeper public sweeper;

    address public borrower;
    uint256 internal borrowerKey;
    bytes32 public planId;

    uint256 public swept;
    uint256 public collected;
    uint256 public repaid;
    uint256 public optedOut;

    address internal constant KEEPER = address(0xA1);
    address internal constant STRANGER = address(0xB2);

    constructor(
        InstallmentPlan plan_,
        MockArcUsdc usdc_,
        PayrollSweeper sweeper_,
        address borrower_,
        uint256 borrowerKey_,
        bytes32 planId_
    ) {
        plan = plan_;
        usdc = usdc_;
        sweeper = sweeper_;
        borrower = borrower_;
        borrowerKey = borrowerKey_;
        planId = planId_;
    }

    modifier as_(address actor) {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    function _signSweep(
        uint256 index,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                borrower,
                address(sweeper),
                value,
                validAfter,
                validBefore,
                sweeper.sweepNonce(planId, index)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev A payroll deposit landing and a keeper acting on it. The value is fuzzed
    ///      across and beyond the payoff amount on purpose: the over-payment path is the
    ///      one where `repay` hands a rebate back to this contract, and therefore the one
    ///      where a custody bug would appear.
    function sweepAt(uint256 seed, uint256 amount) external as_(STRANGER) {
        uint256 index = bound(seed, 0, plan.installmentCount() - 1);
        uint256 value = bound(amount, 1, 300e6);
        uint256 validBefore = vm.getBlockTimestamp() + 30 days;

        try sweeper.sweep(
            address(plan), index, value, 0, validBefore, _signSweep(index, value, 0, validBefore)
        ) {
            swept++;
        } catch {}
    }

    function optIn() external as_(borrower) {
        sweeper.optIn(planId);
    }

    function optOut() external as_(borrower) {
        sweeper.optOut(planId);
        optedOut++;
    }

    function collect(uint256 seed) external as_(KEEPER) {
        try plan.collect(bound(seed, 0, plan.installmentCount() - 1)) returns (
            bool cleared, IInstallmentPlan.BounceReason
        ) {
            if (cleared) collected++;
        } catch {}
    }

    function repay(uint256 amount) external as_(borrower) {
        uint256 value = bound(amount, 1, 300e6);
        usdc.mint(borrower, value);
        usdc.approve(address(plan), value);
        try plan.repay(value) {
            repaid++;
        } catch {}
    }

    function fundBorrower(uint256 amount) external {
        usdc.mint(borrower, bound(amount, 1, 500e6));
    }

    /// @dev The borrower spending their balance elsewhere. On Arc that balance also pays
    ///      for gas, so it is routine rather than exotic.
    function drainBorrower() external {
        usdc.burnAll(borrower);
    }

    function warp(uint256 seconds_) external {
        vm.warp(vm.getBlockTimestamp() + bound(seconds_, 1 hours, 45 days));
    }
}

/// @title SweeperInvariantsTest
/// @notice `check_sweeperNeverHoldsValue`, bound to the real `PayrollSweeper` under a
///         handler that is actually able to sweep.
contract SweeperInvariantsTest is PlanFixture, FxInvariants {
    PayrollSweeper internal sweeper;
    PayrollSweepHandler internal handler;

    function setUp() public {
        _deployStack();
        vm.warp(1_800_000_000);
        sweeper = new PayrollSweeper(address(factory));
        _originateDefault();
        _fundBorrower(400e6);

        vm.prank(borrower);
        sweeper.optIn(planId);

        sweptToken = IERC20(address(usdc));
        sweepContract = address(sweeper);

        handler = new PayrollSweepHandler(plan, usdc, sweeper, borrower, borrowerKey, planId);
        targetContract(address(handler));
    }

    /// @notice The handler can drive the system it is supposed to fuzz.
    ///
    /// @dev Every handler action swallows its own revert, which is what stops a consumed
    ///      prank leaking into the next call and is also how a campaign becomes thousands
    ///      of no-ops that report green. If the sweep counter never moves, the invariant
    ///      below is asserting that an untouched contract holds no balance — true, and
    ///      about nothing. So the handler is exercised once by hand and each counter is
    ///      required to move.
    function test_theHandlerDrivesTheSystem() public {
        handler.fundBorrower(400e6);
        handler.sweepAt(1, 20e6);
        assertEq(handler.swept(), 1, "the handler cannot sweep");

        handler.collect(0);
        assertEq(handler.collected(), 1, "the handler cannot collect");

        handler.repay(10e6);
        assertEq(handler.repaid(), 1, "the handler cannot reach the push rail");

        handler.optOut();
        assertEq(handler.optedOut(), 1, "the handler cannot withdraw consent");
        handler.optIn();

        handler.warp(10 days);
        handler.drainBorrower();
    }

    function invariant_sweeperNeverHoldsValue() public view {
        check_sweeperNeverHoldsValue();
    }
}

/// @notice What the two-book handler needs from the harness: a new plan, on a book it
///         names, signed by a person who does not already have one.
///
/// @dev Origination lives on the harness rather than in the handler because a plan needs
///      a strip signed against the corridor's own token domain, an acceptance signed
///      against the predicted plan address, and a limit attestation signed by the
///      underwriter key — all of which `CorridorFixture` already builds correctly. A
///      handler that re-implemented them would be a second origination path, and the
///      first bug it hid would be a difference between the two.
///      **The plan address is returned rather than looked up through `pool`.** An earlier
///      shape had the handler resolve it with `TranchedCreditPool(pool).bookOf(planId).plan`,
///      which made the handler read its answer out of the very mapping the isolation
///      property asserts over: a wrong `pool` then produced a zero address, the record was
///      dropped by the handler's own `catch`, and the property quantified over an empty
///      list and reported green. Measured, not theorised — that is exactly what the first
///      run of this file's deliberate-failure check did.
interface ICorridorOriginator {
    function originateFor(
        uint256 seed,
        bool useEurc
    ) external returns (bytes32 planId, address pool, address plan);
}

/// @notice The environment for the two-book properties: paper written into both corridors
///         at random, collected at random, cranked at random, and a clock that jumps.
///
/// @dev **Bound to the real `CorridorFixture`, not to `ConfigurablePool`, and the reason
///      is that a stub cannot falsify these properties.** `ConfigurablePool` is one
///      settable book: it has no second instance, no `corridorOf` keying, and no `front`
///      that could put a receivable in the wrong place — so a cross-pool leak is not
///      expressible against it, and an invariant that cannot fail is not one. The pool
///      invariants use the stub because their subject is one book's internal accounting,
///      which is exactly what a stub can be made to get wrong on purpose. The subject
///      here is the relationship *between* two books, so the two books have to be real.
///
///      Every action swallows its own revert — `fail_on_revert = false`, and most calls
///      here are expected to be refused by design (a person who already has a plan, a
///      corridor at its cap, a merchant past their daily velocity). Which is also how an
///      invariant suite quietly becomes thousands of no-ops reporting green, so the
///      counters below exist and `test_theBookHandlerDrivesBothBooks` requires each to
///      move.
contract CorridorBookHandler is Test, ICorridorPaper {
    struct Paper {
        bytes32 planId;
        address pool;
        address plan;
        address borrower;
        address token;
    }

    ICorridorOriginator public originator;
    Paper[] internal _paper;
    bytes32[] internal _corridors;

    uint256 public written;
    uint256 public collected;
    uint256 public recognised;
    uint256 public marked;

    /// @dev A ceiling on open paper. Both properties are O(paper) per assertion and the
    ///      deep profile runs 2048 × 256, so an unbounded book would turn a correctness
    ///      campaign into a benchmark of this loop.
    uint256 internal constant MAX_PAPER = 10;

    address internal constant KEEPER = address(0xA1);
    address internal constant STRANGER = address(0xB2);

    constructor(ICorridorOriginator originator_, bytes32[] memory corridors_) {
        originator = originator_;
        for (uint256 i = 0; i < corridors_.length; ++i) {
            _corridors.push(corridors_[i]);
        }
    }

    // ─── ICorridorPaper ──────────────────────────────────────────────────────

    function paperCount() external view returns (uint256) {
        return _paper.length;
    }

    function paperAt(uint256 index) external view returns (bytes32, address) {
        return (_paper[index].planId, _paper[index].pool);
    }

    function corridorCount() external view returns (uint256) {
        return _corridors.length;
    }

    function corridorAt(uint256 index) external view returns (bytes32) {
        return _corridors[index];
    }

    // ─── Actions ─────────────────────────────────────────────────────────────

    /// @dev Both books, chosen by the fuzzer. A campaign that only ever wrote euro paper
    ///      could not observe a dollar receivable landing in the euro book, which is half
    ///      of what the isolation property is about.
    function originate(uint256 seed, bool useEurc) external {
        if (_paper.length >= MAX_PAPER) return;
        try originator.originateFor(seed, useEurc) returns (bytes32 planId, address pool, address planAddr) {
            InstallmentPlan p = InstallmentPlan(planAddr);
            _paper.push(
                Paper({planId: planId, pool: pool, plan: planAddr, borrower: p.borrower(), token: p.token()})
            );
            written++;
        } catch {}
    }

    function collectOn(uint256 planSeed, uint256 indexSeed) external {
        if (_paper.length == 0) return;
        Paper memory row = _paper[bound(planSeed, 0, _paper.length - 1)];
        InstallmentPlan p = InstallmentPlan(row.plan);
        uint256 index = bound(indexSeed, 0, p.installmentCount() - 1);

        vm.prank(KEEPER);
        try p.collect(index) returns (bool cleared, IInstallmentPlan.BounceReason) {
            if (cleared) collected++;
        } catch {}
    }

    function markOn(uint256 planSeed, uint256 indexSeed) external {
        if (_paper.length == 0) return;
        Paper memory row = _paper[bound(planSeed, 0, _paper.length - 1)];
        InstallmentPlan p = InstallmentPlan(row.plan);
        uint256 index = bound(indexSeed, 0, p.installmentCount() - 1);

        vm.prank(STRANGER);
        try p.markMissed(index) {
            marked++;
        } catch {}
    }

    /// @dev The crank the counter's exactness depends on. `recognise` is the only place
    ///      `carrying` and `_corridorExposure` move together after origination, so a
    ///      campaign that never called it would assert the property over a book frozen at
    ///      the moment it was written.
    function recogniseOn(uint256 planSeed) external {
        if (_paper.length == 0) return;
        Paper memory row = _paper[bound(planSeed, 0, _paper.length - 1)];
        try TranchedCreditPool(row.pool).recognise(row.planId) {
            recognised++;
        } catch {}
    }

    function fund(uint256 planSeed, uint256 amount) external {
        if (_paper.length == 0) return;
        Paper memory row = _paper[bound(planSeed, 0, _paper.length - 1)];
        MockArcStablecoin(row.token).mint(row.borrower, bound(amount, 1, 500e6));
    }

    /// @dev The borrower spending their balance elsewhere. On Arc that balance also pays
    ///      for gas, so it is routine rather than exotic.
    function drain(uint256 planSeed) external {
        if (_paper.length == 0) return;
        Paper memory row = _paper[bound(planSeed, 0, _paper.length - 1)];
        MockArcStablecoin(row.token).burnAll(row.borrower);
    }

    function warp(uint256 seconds_) external {
        vm.warp(vm.getBlockTimestamp() + bound(seconds_, 1 hours, 21 days));
    }
}

/// @title CorridorBookInvariantsTest
/// @notice `check_eurcPaperNeverEntersTheUsdcBook` and
///         `check_corridorExposureSumsToOpenPaper`, bound to two real books.
contract CorridorBookInvariantsTest is CorridorFixture, FxInvariants, ICorridorOriginator {
    CorridorBookHandler internal bookHandler;

    /// @dev A fresh person per plan. Tier 0 allows one active plan each (UW-01), so a
    ///      campaign reusing one borrower would write one plan and then fuzz against a
    ///      book that never grew.
    uint256 internal person = 0xB00000;

    function setUp() public {
        _deployStack();
        _prepareCorridorOrigination();

        usdcBook = creditPool;
        eurcBook = eurcPool;

        bytes32[] memory corridors = new bytes32[](2);
        corridors[0] = checkout.corridorOf(address(usdc));
        corridors[1] = checkout.corridorOf(address(eurc));

        bookHandler = new CorridorBookHandler(ICorridorOriginator(address(this)), corridors);
        paper = ICorridorPaper(address(bookHandler));
        targetContract(address(bookHandler));
    }

    /// @inheritdoc ICorridorOriginator
    function originateFor(uint256 seed, bool useEurc) external returns (bytes32, address, address) {
        require(msg.sender == address(bookHandler), "only the handler originates");

        person += 1;
        borrower = vm.addr(person);
        borrowerKey = person;
        _screenClear(borrower);

        // Inside the ticket band and under a first-timer's Tier-0 cap once loaded by the
        // corridor haircut: the euro ceiling is the tighter of the two, so both branches
        // use it and the two books stay comparable.
        uint256 principal = bound(seed, PlanParams.MIN_TICKET, 95e6);
        uint256 nonce = person;

        if (useEurc) {
            _originateEurcPlan(principal, nonce, keccak256(abi.encode("inv-eurc", nonce)), 5000e6);
            return (planId, address(eurcPool), address(plan));
        }
        _checkout(_terms(principal, COUNT, nonce), keccak256(abi.encode("inv-usdc", nonce)), 5000e6);
        return (planId, address(creditPool), address(plan));
    }

    /// @notice The handler can drive both books it is supposed to fuzz.
    ///
    /// @dev Every handler action swallows its own revert, which is what stops a consumed
    ///      prank leaking into the next call and is also how a campaign becomes thousands
    ///      of no-ops reporting green. If `written` never moved, both properties below
    ///      would be quantifying over an empty list — true, and about nothing. So each
    ///      counter is required to move, and **both books are required to hold paper**,
    ///      because an isolation property asserted against one book is not one.
    function test_theBookHandlerDrivesBothBooks() public {
        bookHandler.originate(80e6, true);
        bookHandler.originate(80e6, false);
        assertEq(bookHandler.written(), 2, "the handler cannot write paper into both books");

        assertGt(eurcPool.corridorExposure(checkout.corridorOf(address(eurc))), 0, "the euro book is empty");
        assertGt(
            creditPool.corridorExposure(checkout.corridorOf(address(usdc))), 0, "the dollar book is empty"
        );

        bookHandler.fund(0, 400e6);
        bookHandler.collectOn(0, 0);
        assertEq(bookHandler.collected(), 1, "the handler cannot collect");

        bookHandler.recogniseOn(0);
        assertEq(bookHandler.recognised(), 1, "the handler cannot crank the book");

        bookHandler.warp(20 days);
        bookHandler.markOn(1, 0);
        assertEq(bookHandler.marked(), 1, "the handler cannot record a delinquency");

        bookHandler.drain(0);

        check_eurcPaperNeverEntersTheUsdcBook();
        check_corridorExposureSumsToOpenPaper();
    }

    function invariant_eurcPaperNeverEntersTheUsdcBook() public view {
        check_eurcPaperNeverEntersTheUsdcBook();
    }

    function invariant_corridorExposureSumsToOpenPaper() public view {
        check_corridorExposureSumsToOpenPaper();
    }
}
