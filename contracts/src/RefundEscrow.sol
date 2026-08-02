// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CheckoutRouter} from "./CheckoutRouter.sol";
import {MerchantRegistry} from "./MerchantRegistry.sol";
import {ParameterRegistry} from "./ParameterRegistry.sol";
import {TranchedCreditPool} from "./TranchedCreditPool.sol";
import {IInstallmentPlan} from "./interfaces/IInstallmentPlan.sol";
import {ISettlementEscrow} from "./interfaces/ISettlementEscrow.sol";
import {ParameterKeys} from "./libraries/ParameterKeys.sol";

/// @title RefundEscrow
/// @notice The accounting and adjudication wrapper around a refund that has already
///         happened, and the only holder of `MerchantRegistry.SLASHER_ROLE`.
///
/// @dev MERCH-02 and MERCH-03. The waterfall itself is not here and must never be
///      copied here: `InstallmentPlan.creditRefund` implements D9's settled ordering —
///      principal retired before borrower cash — suppresses the covered tail from the
///      **end** of the schedule, and reaches `Refunded`. A full-value `creditRefund`
///      before fulfilment is arithmetically a void, which is why MERCH-02 needs no new
///      plan state, no `PlanState.Cancelled` transition and no implementation vintage
///      bump (D-05).
///
///      **Why this contract is post hoc, and why that is not a bug.** `creditRefund`
///      gates on `msg.sender == merchant`. This contract is not the merchant and must
///      not become one — an escrow that held the merchant role on every plan would be
///      a single address able to refund the whole book. So the merchant calls
///      `plan.creditRefund(amount)` directly, with their own approval and their own
///      money, and this contract observes and settles *around* that call. A later
///      reader will notice that `noteRefund` cannot originate a refund and will want
///      to "fix" it by giving the escrow the merchant role or by adding a
///      `refundOnBehalfOf`. Both are the same mistake. The refund is the merchant's
///      act; what needs an adjudicated wrapper is what happens to the book, the fee
///      and the bond afterwards.
///
///      **D-04 — there is no second ledger here.** Nothing in this file calls the
///      registry's bookkeeper-gated recovery entry point — `MerchantRegistry.sol:314-326`,
///      the one that writes `outstandingFronted` down directly — and nothing may. That
///      absence is enforced by a grep gate as well as by test, so the name is
///      deliberately not written out anywhere in this file: a mechanical check that a
///      comment can defeat is not a check. Merchant exposure moves
///      through `CheckoutRouter.recognise` and through nothing else, because
///      `recognise` derives the movement from the pool's carrying delta either side of
///      the pool's own crank — that is, from the plan. The pool learns from the plan
///      (DEC-08). A direct write here would be a second ledger for the same money,
///      which is the exact defect Phase 3 shipped and DEC-21 was written to prevent.
///
///      **D-02 — no path releases withholding.** There is deliberately no function on
///      this contract that returns a merchant's withheld settlement. The bond is
///      priced off `outstandingFronted`, which `recognise()` brings down when the
///      refund lands, so `requiredBond()` falls on its own and the merchant recovers
///      the bond through `MerchantRegistry.withdrawBond` as their exposure retires.
///      Releasing withholding on a refund would let a merchant cycle
///      originate → refund to extract their own bond, and the bond is the control that
///      the entire refund-arbitrage threat model rests on.
///
///      **No function here accepts a recipient for refunded value.** `creditRefund`
///      pays the plan's immutable `borrower` and nowhere else, so the on-chain
///      refund-redirection attack is already impossible; this contract adds no address
///      parameter that could reach it. The two address-typed parameters in this ABI
///      name *whose* rebate is being claimed and *which* merchant a dispute is against.
///      Neither is a destination: a rebate pays the payout route recorded in
///      `MerchantRegistry`, and a slash pays this contract and then the pool's reserve.
contract RefundEscrow is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice May open and cancel an adjudicated dispute.
    /// @dev Held by whoever runs the off-chain dispute process. Deliberately *not*
    ///      able to slash on its own: opening a dispute only starts a clock that
    ///      anybody may run out, and cancelling one is the only thing this role can do
    ///      unilaterally. The permissionless non-attestation path below does not need
    ///      this role at all, which is what keeps a borrower's route out of a
    ///      never-shipped order GOV-08-clean.
    bytes32 public constant ARBITER_ROLE = keccak256("PLAZO.ARBITER");

    /// @notice A claim against a merchant's bond, and the clock it has to run.
    struct Dispute {
        /// @dev Whose bond is at risk. Never a caller-supplied value on the
        ///      permissionless path.
        address merchant;
        /// @dev What may be taken. Bounded by the posted bond when the row is written.
        uint256 amount;
        /// @dev Zero means no dispute. The timelock is measured from here.
        uint256 openedAt;
        /// @dev A `bytes32` commitment to an off-chain record under a published
        ///      schema, never cleartext. The same salted-subject rule the Passport
        ///      events follow: a dispute reason in the clear is a purchase diary entry
        ///      no erasure request can reach. On the non-attestation path this is the
        ///      `planId`, because there the evidence *is* the chain.
        bytes32 evidenceRef;
    }

    IERC20 public immutable token;
    CheckoutRouter public immutable checkout;
    MerchantRegistry public immutable merchants;

    /// @notice Where the dispute timelock is read from, at call time, every time.
    /// @dev GOV-01 and D-03. Plan 06-14 seeded `ESCROW_DISPUTE_TIMELOCK` in wave 1
    ///      with a compiled 24-hour floor precisely so this contract has no second
    ///      option: there is no immutable timelock here and no constant to fall back
    ///      on. `get()` reverts on an undefined key by design, and that revert is the
    ///      correct behaviour rather than something to defend against.
    ParameterRegistry public immutable parameters;

    /// @notice The dispute-eligibility seam plan 06-14 declared and plan 06-09 fills.
    /// @dev Declared against the interface on purpose. The implementation is deployed
    ///      after this contract, and coding against it would invert the wave order.
    ISettlementEscrow public immutable settlementEscrow;

    /// @notice The plan's `refundCredit()` as of the last crank, per plan.
    /// @dev What makes `noteRefund` idempotent. A double crank sees no delta and does
    ///      nothing — findings 17 and 19's discipline at the unit level.
    mapping(bytes32 planId => uint256) public credited;

    /// @notice MDR owed back to a merchant and not yet paid.
    mapping(address merchant => uint256) public rebateOwed;

    /// @notice USDC available to pay rebates from.
    uint256 public rebateReserve;

    mapping(bytes32 planId => Dispute) private _disputes;

    event RefundCredited(bytes32 indexed planId, uint256 amount);
    event PlanVoided(bytes32 indexed planId);
    event RebateAccrued(address indexed merchant, uint256 amount);
    event RebateClaimed(address indexed merchant, uint256 amount, uint256 remaining);
    event RebatesFunded(address indexed from, uint256 amount, uint256 balance);
    event DisputeOpened(
        bytes32 indexed planId, address indexed merchant, uint256 amount, bytes32 evidenceRef
    );
    event DisputeCancelled(bytes32 indexed planId);
    event BondSlashedToReserve(bytes32 indexed planId, address indexed merchant, uint256 amount);

    error PlanNotOriginatedHere(bytes32 planId);
    error PlanNotVoidable(bytes32 planId, IInstallmentPlan.PlanState state);
    error NothingToFund();
    error NothingOwed(address merchant);
    error RebateReserveEmpty(uint256 owed);
    error PayoutRecipientZero(address merchant);
    error DisputeAlreadyOpen(bytes32 planId, uint256 openedAt);
    error NoDisputeOpen(bytes32 planId);
    error DisputeAmountZero(bytes32 planId);
    error DisputeExceedsBond(bytes32 planId, uint256 amount, uint256 bond);
    error NotDisputeEligible(bytes32 planId);
    error DisputeStillTimelocked(bytes32 planId, uint256 executableAt);
    error TimelockAlreadyElapsed(bytes32 planId, uint256 executableAt);

    constructor(
        address admin,
        address token_,
        address checkout_,
        address merchants_,
        address parameters_,
        address settlementEscrow_
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        token = IERC20(token_);
        checkout = CheckoutRouter(checkout_);
        merchants = MerchantRegistry(merchants_);
        parameters = ParameterRegistry(parameters_);
        settlementEscrow = ISettlementEscrow(settlementEscrow_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views — what a merchant sees before they confirm
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The exact argument to pass to `creditRefund` to void `planId`.
    ///
    /// @dev The plan's original principal. Passing it retires all outstanding
    ///      principal, returns whatever the borrower has already paid as `toBorrower`,
    ///      suppresses the whole remaining tail and lands the plan in `Refunded` — a
    ///      void, arithmetically, with no new state and no borrower transaction (D-05).
    ///
    ///      Reverts on a plan that has already settled, because a "void" of a repaid
    ///      plan is a merchant sending money to a schedule that owes nothing, and the
    ///      whole amount would land on the borrower with the pool's book untouched.
    function voidAmountFor(bytes32 planId) external view returns (uint256) {
        IInstallmentPlan plan = _planOf(planId);
        IInstallmentPlan.PlanState state = plan.state();
        if (_isTerminal(state)) revert PlanNotVoidable(planId, state);
        return plan.principal();
    }

    /// @notice What a refund of `amount` would do, read before the merchant confirms.
    ///
    /// @dev This is a **read of the plan's public state through D9's arithmetic**, not
    ///      a second implementation of the waterfall. It computes nothing the plan does
    ///      not already expose: the split is `min(amount, outstandingPrincipal)`, and
    ///      the suppression walk is the same forward walk `_suppressCoveredTail` does,
    ///      over `installmentAmount` and `installmentStatus`. If the plan's ordering
    ///      ever changed, this would have to change with it — which is the argument for
    ///      keeping it this thin rather than making it clever.
    ///
    ///      `firstSuppressedIndex` is `type(uint256).max` when the refund suppresses
    ///      nothing.
    function refundPreview(
        bytes32 planId,
        uint256 amount
    )
        external
        view
        returns (
            uint256 appliedPrincipal,
            uint256 toBorrower,
            uint256 firstSuppressedIndex,
            uint256 mdrRebate
        )
    {
        IInstallmentPlan plan = _planOf(planId);
        uint256 outstanding = plan.outstandingPrincipal();

        appliedPrincipal = amount > outstanding ? outstanding : amount;
        toBorrower = amount - appliedPrincipal;
        firstSuppressedIndex = _firstSuppressedIndex(plan, outstanding - appliedPrincipal);
        mdrRebate = mdrRebateFor(planId, appliedPrincipal);
    }

    /// @notice The MDR owed back for retiring `appliedPrincipal` of this plan.
    ///
    /// @dev **D-01, and the denominator is the whole of it.** The rebate is apportioned
    ///      against the plan's **remaining** balance at the moment of the refund, never
    ///      against its original principal.
    ///
    ///      Finding 15 is why. The pool defers the MDR at origination and earns it as
    ///      principal comes back, apportioned against what is *still owed*. Dividing by
    ///      the original principal compounds: a plan of 1,000 with 100 deferred recovers
    ///      500 and earns 50, leaving 50 against 500 outstanding; the second 500 then
    ///      earns `50 × 500/1000 = 25`, and a fully repaid plan carries 25 of unearned
    ///      income against no receivable at all. Apportioning a *rebate* the same wrong
    ///      way reproduces the same defect in a new place, from the other side: two
    ///      successive half-refunds would rebate 75% of the fee on a sale that was
    ///      refunded in full, and the residue would sit as a fee earned on a transaction
    ///      that did not happen.
    ///
    ///      Against the remaining balance it amortises exactly, and it is the same
    ///      formula `TranchedCreditPool.recognise` uses — deliberately, because that
    ///      makes the rebate equal to the deferred MDR the pool is about to earn *on
    ///      account of the refund*. A void refunds everything outstanding, so the whole
    ///      remaining fee is rebated; a partial refund rebates its share; and fee
    ///      earned on principal the borrower actually repaid is kept, because that
    ///      part of the sale happened.
    ///
    ///      The mark-escrow slice of the MDR is not rebatable and is not counted here.
    ///      It was spent at origination funding the plan's own delinquency budget, and
    ///      it is a servicing cost the book carries rather than income anybody earned.
    function mdrRebateFor(bytes32 planId, uint256 appliedPrincipal) public view returns (uint256) {
        TranchedCreditPool.PlanBook memory book = _bookOf(planId);
        return _rebateFrom(book, appliedPrincipal);
    }

    function disputeOf(bytes32 planId) external view returns (Dispute memory) {
        return _disputes[planId];
    }

    /// @notice When a dispute on `planId` becomes executable. Zero when none is open.
    function disputeExecutableAt(bytes32 planId) public view returns (uint256) {
        Dispute storage d = _disputes[planId];
        if (d.openedAt == 0) return 0;
        return d.openedAt + parameters.get(ParameterKeys.ESCROW_DISPUTE_TIMELOCK);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Settlement
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Book a refund the merchant has already credited to the plan.
    ///
    /// @dev **Permissionless and idempotent**, like every other crank in this tree. It
    ///      takes no amount and no recipient: the delta is read from
    ///      `plan.refundCredit()` against what this contract last saw, so a caller
    ///      cannot overstate a refund and a double crank is a no-op.
    ///
    ///      The order matters. The pool's book is read *before* `recognise` runs,
    ///      because the rebate is apportioned against the carrying value the refund is
    ///      about to retire — reading it afterwards would divide by a balance the
    ///      refund had already reduced and rebate nothing at all on a void.
    function noteRefund(bytes32 planId) external nonReentrant {
        TranchedCreditPool.PlanBook memory book = _bookOf(planId);
        IInstallmentPlan plan = IInstallmentPlan(book.plan);

        uint256 total = plan.refundCredit();
        uint256 seen = credited[planId];
        if (total <= seen) return;

        uint256 delta = total - seen;
        credited[planId] = total;

        uint256 rebate = _rebateFrom(book, delta);

        // The only path that moves the pool's book and the merchant's exposure. It
        // reads the pool's carrying delta either side of the pool's own crank, so the
        // movement is derived from the plan rather than asserted here (D-04).
        checkout.recognise(planId);

        if (rebate > 0) {
            rebateOwed[book.merchant] += rebate;
            emit RebateAccrued(book.merchant, rebate);
        }
        emit RefundCredited(planId, delta);

        // The on-chain signature of a void before fulfilment: the plan is fully
        // refunded and the borrower has paid at most the down payment. Stated as "at
        // most" rather than "exactly one installment" because a void can land before
        // the first due date, when nothing has been collected at all — and that is the
        // *more* complete void, not a different event.
        if (
            plan.state() == IInstallmentPlan.PlanState.Refunded
                && plan.totalCollected() <= plan.installmentAmount(0)
        ) {
            emit PlanVoided(planId);
        }
    }

    /// @notice Top up the reserve rebates are paid from. Anyone may.
    ///
    /// @dev **Where the rebate comes from, and why it is not the pool.** The MDR is the
    ///      pool's income and the pool has no path that pays it back: `TranchedCreditPool`
    ///      is a plain constructor deployment holding the live book, `recognise` earns
    ///      the deferral as principal is recovered, and `_close` distributes whatever
    ///      remains unearned to the tranches. Rebating from inside it would mean a pool
    ///      redeployment and a migration of every tranche position, which this phase's
    ///      own constraint forbids — the escrows hang *off* the pool, not inside it.
    ///
    ///      So the rebate is a funded liability rather than a pool reversal, and in
    ///      practice the operator funds it out of its own fee share. That is precisely
    ///      the incentive D-01 exists to invert: a void should cost the operator rather
    ///      than earn it. Permissionless because a liability only the operator can fund
    ///      is a liability the operator can also decline to fund.
    function fundRebates(uint256 amount) external nonReentrant {
        if (amount == 0) revert NothingToFund();
        token.safeTransferFrom(msg.sender, address(this), amount);
        rebateReserve += amount;
        emit RebatesFunded(msg.sender, amount, rebateReserve);
    }

    /// @notice Pay a merchant whatever the reserve can cover of what they are owed.
    ///
    /// @dev Permissionless — anyone may push a merchant's own money to the merchant's
    ///      own registered payout route. The address argument names *whose* rebate, not
    ///      where it goes; the destination is read from `MerchantRegistry`, so a
    ///      stranger calling this cannot redirect a cent of it.
    ///
    ///      A short reserve pays what it can and leaves the rest claimable. That is
    ///      deliberate: an unpaid rebate should be a visible liability with a running
    ///      balance, not a transfer that silently reverted and left the merchant to
    ///      work out why.
    function claimRebate(address merchant) external nonReentrant {
        uint256 owed = rebateOwed[merchant];
        if (owed == 0) revert NothingOwed(merchant);

        uint256 pay = owed > rebateReserve ? rebateReserve : owed;
        if (pay == 0) revert RebateReserveEmpty(owed);

        (address recipient,) = merchants.payoutRouteOf(merchant);
        if (recipient == address(0)) revert PayoutRecipientZero(merchant);

        uint256 remaining = owed - pay;
        rebateOwed[merchant] = remaining;
        rebateReserve -= pay;

        token.safeTransfer(recipient, pay);
        emit RebateClaimed(merchant, pay, remaining);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Dispute and slash (D-03)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Open an adjudicated dispute against a merchant's bond.
    ///
    /// @dev The arbiter path: somebody ran a dispute process off chain and is recording
    ///      its outcome. `evidenceRef` commits to that record under a published schema
    ///      and is never cleartext.
    ///
    ///      This role cannot take the bond. It starts a clock, and the clock is what
    ///      `executeSlash` waits out — so a merchant watching the chain sees the claim
    ///      before anybody can reach their money, and has the whole window to answer it.
    function openDispute(
        bytes32 planId,
        address merchant,
        uint256 amount,
        bytes32 evidenceRef
    ) external onlyRole(ARBITER_ROLE) {
        if (amount == 0) revert DisputeAmountZero(planId);

        uint256 bond = merchants.bondOf(merchant);
        // Refused rather than silently reduced. A dispute recorded for more than can
        // ever be taken is a number the merchant, the arbiter and the indexer would all
        // read differently.
        if (amount > bond) revert DisputeExceedsBond(planId, amount, bond);

        _open(planId, merchant, amount, evidenceRef);
    }

    /// @notice Open a dispute on a plan whose settlement went back for non-attestation.
    ///
    /// @dev **Permissionless, and no `ARBITER_ROLE`.** This is the borrower's route and
    ///      it must not depend on an operator remembering to act.
    ///
    ///      Why it exists: `SettlementEscrow.refundToPool` makes the pool whole and
    ///      leaves the plan's receivable untouched, by design (D-04). Correct — and it
    ///      is also the reason a borrower can be left paying for goods that never
    ///      shipped. Without this entry point their only route is a ticket.
    ///
    ///      Nothing here is a caller assertion. Eligibility is a view on the escrow's
    ///      own row, and the merchant and the amount are read from
    ///      `returnedSettlementOf` rather than taken as parameters — so a stranger
    ///      cannot substitute a merchant they would rather slash or inflate a figure
    ///      they would rather claim. The only thing a caller names is a `planId`.
    ///
    ///      The recorded amount saturates at the posted bond rather than reverting,
    ///      unlike the arbiter path. A merchant whose bond has fallen below what they
    ///      took should still be disputable for what is left; reverting would let a
    ///      thin bond close the borrower's only door.
    function openNonAttestationDispute(bytes32 planId) external {
        if (!settlementEscrow.disputeEligible(planId)) revert NotDisputeEligible(planId);

        ISettlementEscrow.ReturnedSettlement memory row = settlementEscrow.returnedSettlementOf(planId);
        uint256 bond = merchants.bondOf(row.merchant);
        uint256 amount = row.amount > bond ? bond : row.amount;

        // The evidence *is* the chain: the merchant provably failed to attest shipment
        // before an on-chain deadline they could read in advance, and the pool has
        // already taken the settlement back. There is no off-chain record to commit to,
        // so the reference is the plan itself.
        _open(planId, row.merchant, amount, planId);
    }

    /// @notice Withdraw a dispute before its timelock elapses.
    ///
    /// @dev The arbiter is the check on a non-attestation dispute opened in error, and
    ///      the 24-hour floor on `ESCROW_DISPUTE_TIMELOCK` is the window they have to
    ///      use it. Cancels a dispute from either entry point, because a dispute row is
    ///      a dispute row whoever opened it.
    ///
    ///      Refused once the window has passed. A cancellation racing an execution that
    ///      is already legitimate would make the timelock advisory.
    function cancelDispute(bytes32 planId) external onlyRole(ARBITER_ROLE) {
        Dispute storage d = _disputes[planId];
        if (d.openedAt == 0) revert NoDisputeOpen(planId);

        uint256 executableAt = d.openedAt + parameters.get(ParameterKeys.ESCROW_DISPUTE_TIMELOCK);
        if (block.timestamp >= executableAt) revert TimelockAlreadyElapsed(planId, executableAt);

        delete _disputes[planId];
        emit DisputeCancelled(planId);
    }

    /// @notice Take the disputed bond and pay it into the pool's reserve.
    ///
    /// @dev Callable by anyone once the timelock has run. A `SLASHER_ROLE` on a human
    ///      key is a key that can drain any merchant's bond; this contract is the key,
    ///      and the timelock is what makes it one a merchant can see coming. Making the
    ///      *execution* permissionless is the other half — a slash that only the
    ///      arbiter can complete is a slash the arbiter can also hold over a merchant
    ///      indefinitely.
    ///
    ///      The timelock is read from `ParameterRegistry` here, at call time. It is not
    ///      a compiled constant and it is not a constructor immutable.
    ///
    ///      **The proceeds go to the reserve, not down the waterfall (POOL-14).** A
    ///      slashed bond is a fraud recovery, and a fraud loss is not a credit loss the
    ///      senior tranche was sold on. `fundReserve` is permissionless and books into
    ///      `bookedCash`, so routing through it creates no second ledger.
    function executeSlash(bytes32 planId) external nonReentrant {
        Dispute memory d = _disputes[planId];
        if (d.openedAt == 0) revert NoDisputeOpen(planId);

        uint256 executableAt = d.openedAt + parameters.get(ParameterKeys.ESCROW_DISPUTE_TIMELOCK);
        if (block.timestamp < executableAt) revert DisputeStillTimelocked(planId, executableAt);

        address poolAddress = checkout.poolOf(planId);
        if (poolAddress == address(0)) revert PlanNotOriginatedHere(planId);

        delete _disputes[planId];

        merchants.slash(d.merchant, address(this), d.amount);
        token.forceApprove(poolAddress, d.amount);
        TranchedCreditPool(poolAddress).fundReserve(d.amount);

        emit BondSlashedToReserve(planId, d.merchant, d.amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    function _open(bytes32 planId, address merchant, uint256 amount, bytes32 evidenceRef) private {
        Dispute storage existing = _disputes[planId];
        if (existing.openedAt != 0) revert DisputeAlreadyOpen(planId, existing.openedAt);

        _disputes[planId] = Dispute({
            merchant: merchant, amount: amount, openedAt: block.timestamp, evidenceRef: evidenceRef
        });

        emit DisputeOpened(planId, merchant, amount, evidenceRef);
    }

    function _bookOf(bytes32 planId) private view returns (TranchedCreditPool.PlanBook memory book) {
        address poolAddress = checkout.poolOf(planId);
        if (poolAddress == address(0)) revert PlanNotOriginatedHere(planId);
        book = TranchedCreditPool(poolAddress).bookOf(planId);
        if (book.plan == address(0)) revert PlanNotOriginatedHere(planId);
    }

    function _planOf(bytes32 planId) private view returns (IInstallmentPlan) {
        return IInstallmentPlan(_bookOf(planId).plan);
    }

    /// @dev The remaining-balance apportionment, in one place so there is one of it.
    function _rebateFrom(
        TranchedCreditPool.PlanBook memory book,
        uint256 appliedPrincipal
    ) private pure returns (uint256) {
        if (book.carrying == 0 || book.deferredIncome == 0 || appliedPrincipal == 0) {
            return 0;
        }
        uint256 applied = appliedPrincipal > book.carrying ? book.carrying : appliedPrincipal;
        uint256 rebate = (book.deferredIncome * applied) / book.carrying;
        return rebate > book.deferredIncome ? book.deferredIncome : rebate;
    }

    /// @dev The same forward walk `InstallmentPlan._suppressCoveredTail` performs: keep
    ///      live exactly as many checks as `remainingPrincipal` needs and retire the
    ///      rest, so the schedule shortens from the end and the borrower's next due date
    ///      does not move.
    function _firstSuppressedIndex(
        IInstallmentPlan plan,
        uint256 remainingPrincipal
    ) private view returns (uint256) {
        uint256 remaining = remainingPrincipal;
        uint256 count = plan.installmentCount();
        for (uint256 index = 0; index < count; ++index) {
            IInstallmentPlan.InstallmentStatus status = plan.installmentStatus(index);
            if (
                status != IInstallmentPlan.InstallmentStatus.Pending
                    && status != IInstallmentPlan.InstallmentStatus.Bounced
            ) continue;

            uint256 amount = plan.installmentAmount(index);
            if (remaining >= amount) {
                remaining -= amount;
                continue;
            }
            return index;
        }
        return type(uint256).max;
    }

    function _isTerminal(IInstallmentPlan.PlanState state) private pure returns (bool) {
        return state == IInstallmentPlan.PlanState.Repaid || state == IInstallmentPlan.PlanState.Defaulted
            || state == IInstallmentPlan.PlanState.Cancelled || state == IInstallmentPlan.PlanState.Refunded
            || state == IInstallmentPlan.PlanState.FraudReversed;
    }
}
