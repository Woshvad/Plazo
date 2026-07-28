# Invariant specification

The properties in `PlanInvariants.sol` and `PoolInvariants.sol` are the formal-verification specification, not a test-suite afterthought. They were written before the contracts they constrain, and the implementations arriving in Phases 2 and 5 have to satisfy them rather than the other way round.

An invariant suite written after the contract tends to describe the contract — it encodes what the code happens to do and then passes forever.

## How this is used across the phases

| Phase | What happens |
|---|---|
| 1 | Properties written. Bound to a breakable stub and each one driven into failure, proving it bites (`InvariantsBite.t.sol`). |
| 2 | `InstallmentPlan` implements `IInstallmentPlan`. A binding wraps `check_*` in `invariant_*` entry points and runs them under Foundry's invariant fuzzer with a handler. |
| 2 | A vendor specification review is purchased against this file and the frozen state machine. |
| 5 | `CreditPool` binds `PoolInvariants` the same way. `provisionBucketsSumToTotal` and `epochCannotCloseWithUnmarkedDelinquency` must hold **before** share accounting is verified — the accounting shape is the fix, so verifying the wrong shape wastes the gate. |
| 5–9 | Certora rules carrying the names below run as a parallel track, converging in Phase 9. Formal verification is never a terminal gate: it finds design flaws, and discovering one on frozen code in the final week is a schedule failure, not a quality win. |

## Plan properties

| Certora rule | Foundry check | What it rules out |
|---|---|---|
| `planValueConserved` | `check_valueIsConserved` | The plan holding float nobody accounts for. Collections must equal principal retired plus fees paid, with refund credit standing in for principal the merchant gave back. Drift here compounds silently across a book, because nothing reconciles a plan against the pool per-plan. |
| `outstandingBoundedByPrincipal` | `check_outstandingNeverExceedsPrincipal` | Debt appearing from nowhere. |
| `payoffCoversOutstanding` | `check_payoffCoversOutstanding` | A borrower paying in full and remaining delinquent, or the protocol collecting money it cannot book. |
| `noDoubleClear` | `check_noInstallmentClearsTwice` | `repay()` and a keeper `collect()` racing on one installment and both crediting it. Belt and braces over the EIP-3009 nonce — a solvency property must not depend on the token. |
| `everyInstallmentAccountedFor` | `check_everyOverdueInstallmentIsAccountedFor` | **The highest-damage failure in the design.** A failed pull reverts: it emits nothing, changes nothing, pays nobody. Grace transitions, Passport marks, NAV provisioning, the subordination gate and the FPD kill switch are all fed by an event that, left to the token, nobody creates. |
| `scheduleMonotone` | `check_scheduleIsMonotone` | An ambiguous "past grace", which every collection and provisioning decision keys off. |
| `graceFollowsDueDate` | `check_graceFollowsDueDate` | A grace window that closes before the installment is due. |
| `terminalStatesAbsorbing` | `check_terminalStatesAreClean` | A repaid plan being made delinquent by a late keeper crank; a charged-off plan resurrecting and double-counting against the waterfall; a refunded plan leaving principal the pool still believes it holds. |
| `settledWithFeeOutstandingIsCoherent` | `check_settledWithFeeOutstandingIsCoherent` | The state existing for no reason. It exists so payoff is never blocked on a fee dispute: principal clear, fee outstanding, no further pulls. |

## Pool properties

| Certora rule | Foundry check | What it rules out |
|---|---|---|
| `assetsEqualClaims` | `check_assetsEqualClaims` | Shares backed by nothing, discovered when a redemption fails. `totalAssets` must be an internal booked accumulator — using `balanceOf(this)` lets a donation inflate NAV for existing holders, which against an empty junior tranche is half the first-depositor attack. |
| `sharesImplyAssets` | `check_sharesImplyAssets` | The other half: shares issued against zero assets, so the next depositor funds the previous one. |
| `provisionBucketsSumToTotal` | `check_provisionBucketsSumToTotal` | The harvestable NAV oscillation. Un-bucketed provisioning means a cure cannot release exactly what the delinquency took, so an LP can deposit at the trough and redeem after the cure wave — funded by whoever redeemed at the trough, and hitting junior hardest. |
| `provisionBoundedByAssets` | `check_provisionNeverExceedsAssets` | Provisioning against assets that are not there. |
| `lossWaterfallOrdered` | `check_reserveAbsorbsBeforeJunior` | Junior impaired while the reserve still holds assets. Senior's whole claim is that it is struck last; if the order can be violated, the subordination senior was sold is not the subordination it has. |
| `subordinationMatchesAssets` | `check_subordinationIsDerived` | The origination gate being opened by a reporting bug rather than by capital. |
| `originationGatedBySubordination` | `check_originationClosedBelowFloors` | Writing new credit below the subordination or reserve floor. |
| `epochCannotCloseWithUnmarkedDelinquency` | `check_epochBlocksOnUnmarkedDelinquency` | Settling an epoch on a book whose losses have not been recognised, and reporting a NAV that is simply wrong. This is also what makes the bountied mark *unavoidable* rather than merely available. |

## Properties this file does not yet carry

Deferred with their phase, not forgotten:

- **Cure round-trip** — a cure releases exactly the provision the delinquency took, per epoch bucket. Needs both a plan and a pool, so it lands in Phase 5. This round trip is where real bugs live.
- **Provisioning idempotence** — 50% applied twice at `Delinquent` is still 50%; 100% at charge-off supersedes rather than compounds. Phase 5.
- **Redemption queue fairness** — cumulative positions fill pro-rata, and every redeemer in an over-threshold epoch pays the same uniform liquidity fee. Phase 5.
- **`repay()` / `collect()` commutativity** — a borrower curing by push and a keeper cranking must not double-charge. Needs both entry points implemented; Phase 2.
- **State-machine reachability** — no path from `Repaid` back to `Grace`, expressed over the transition relation rather than over a snapshot. Best done in Certora, where the relation is available; the Foundry check here only sees states, not edges.

## Free-tier budget

Certora's free tier is 2,000 prover-minutes a month. The plan properties are cheap — bounded loops over `installmentCount`. The pool properties are not: `assetsEqualClaims` and `lossWaterfallOrdered` over a book of arbitrary size will exhaust the tier. Run those against a bounded book in CI and reserve unbounded runs for the pre-audit campaign.

Kontrol is the fallback for anything loop-heavy: it is the only tool in the verification stack with loop invariants, which is what the waterfall needs if it iterates installments.
