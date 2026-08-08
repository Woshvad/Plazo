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
| `refundOnlyToBorrower` | `check_refundOnlyToBorrower` | A merchant naming where refunded value goes. `creditRefund` splits every unit between principal — forwarded to the disclosed settlement recipient — and the plan's immutable `borrower`, and no function in the tree accepts a recipient. "Already impossible by construction" is exactly the claim that stops being true the day somebody adds a convenience parameter, and the second clause rules out a residue as well as a redirection: value that entered the plan and left toward nobody accountable. |
| `escrowNeverStrands` | `check_escrowNeverStrandsSettlement` | MERCH-04's fourth outcome. A settlement is paid to the merchant's route, returned to the pool's reserve, or held with at least one exit anybody can reach — never in none of them, and never held with neither exit open. An escrow that can reach that state has made the operator a party the merchant's money depends on, which is the thing GOV-08 exists to rule out (D-07). |

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

## Added in Phase 2, against the real implementation

Phase 1 wrote the properties above before any contract existed and proved they bite by driving each one into failure against a breakable stub. `PlanFuzz.t.sol` is the other half: the same assertions bound to `InstallmentPlan` under Foundry's fuzzer, plus three the implementation makes it possible to state.

| Certora rule | Foundry invariant | What it rules out |
|---|---|---|
| `planHoldsNoFloat` | `invariant_planHoldsNoFloat` | Custody by accident. Every unit that arrives leaves in the same transaction — to the keeper who cranked, back to the borrower as a rebate, or forward to the disclosed recipient. The only balance a plan carries is its own crank escrow. |
| `markBudgetAlwaysFunded` | `invariant_markBudgetStaysFunded` | A plan reaching the moment it must record its own default and being unable to afford the bounty. Found by the fuzzer: `revalidate()` and `markMissed()` drew on the same escrow, so a plan whose signer kept changing could be revalidated weekly for the ninety days its strip stays live and arrive at delinquency with nothing left. The mark budget is now reserved and observation spends only the surplus. |
| `overdueInstallmentRecordable` | `invariant_everyOverdueInstallmentIsRecordable` | The collection guarantee, stated as something a contract can actually promise. Checked by *performing* the crank from an unrelated address and rolling the state back, so it asserts what the contract does rather than what its views claim. |
| `refundNeverReturnsToMerchant` | `invariant_refundNeverReturnsToTheMerchant` | Added in Phase 6. The half of `refundOnlyToBorrower` a live system can be asked directly: the merchant's balance is exactly what was minted to them minus what they successfully refunded, so any path returning refunded value to the merchant — by any route, in any order — shows up as a surplus. The merchant is the address to watch because they are the only party with both a motive and a call. |

## Added in Phase 7 — `FxInvariants.sol`

| Certora rule | Foundry check | What it rules out |
|---|---|---|
| `sweeperNeverHoldsValue` | `check_sweeperNeverHoldsValue` | **`PayrollSweeper` becoming a custody contract.** UW-05's plain-language form — "the installment splits from inbound payroll before it reaches spendable balance" — describes exactly the thing C3 forbids, and an implementation that held wages for one block would still look like it worked. The design receives the borrower's authorised value and repays the plan in one transaction, returns every unit of residue to the borrower, and reverts `SweeperRetainedValue` on a non-zero closing balance. This asserts the observable consequence over arbitrary histories: whatever sequence of sweeps, collections, cures, opt-ins and opt-outs produced the state, the sweeper's balance between transactions is zero. Stated over protocol flows — an unsolicited transfer to the sweeper's address is not one, and nothing in the tree performs it. |
| `eurcPaperNeverEntersTheUsdcBook` | `check_eurcPaperNeverEntersTheUsdcBook` | **A euro receivable carried by the dollar book, making both books wrong at once with neither one showing it.** The dollar book would carry paper it never wrote and the euro book would be missing paper it funded, and each would still balance against its own numbers — so nothing internal to either could detect it, and the first symptom would be a redemption priced off a NAV that was never right. This is also the honest form of FX-03's "the warehouse exposure is booked": under the two-pool design there is no cross-currency position inside a book to mark, because a euro lender holds euro assets against euro liabilities and nets to zero. There is nothing to hedge, and — StableFX offers only `instant \| hourly \| daily` tenors, and access is KYB-gated and not held — nothing to hedge it with. What protects NAV is that the two balance sheets never commingle, and that is checkable. Stated over the book row's existence rather than only over a non-zero `carrying`, because a fully-recovered plan in the wrong book is the same defect found a week later. |
| `corridorExposureSumsToOpenPaper` | `check_corridorExposureSumsToOpenPaper` | **A corridor counter drifting from the open paper it gates, so FX-04's cap binds at the wrong number.** In whichever direction the drift ran it is silent and it costs something real: a counter above the open paper refuses credit the book had room for, and a counter below it writes concentration the LPs were told could not be written. Nothing else in the system reconciles the two figures — the cap is enforced against the counter and the NAV is computed from the carrying, and they only agree because `front` and `_reduceExposure` move them by the same amount. That coincidence is the property. `open` is the qualifier that makes it exact: `_close` reduces the counter by the remaining carrying and zeroes it, so a closed plan contributes to neither side. |

`FxInvariants.sol` is created by plan 07-05 and extended by 07-10 with the cross-pool isolation and corridor-counter properties. Its sweeper harness signs its own sweep authorizations rather than replaying one, and `test_theHandlerDrivesTheSystem` requires every counter to move — a handler whose actions all revert is a campaign of no-ops reporting green.

### Why the two-book properties bind the real fixture rather than `ConfigurablePool`

The pool properties drive `ConfigurablePool` because their subject is one book's internal accounting, which is exactly what a stub can be made to get wrong on purpose. The subject of these two is the relationship *between* two books, and the stub is one settable book: it has no second instance, no `corridorOf` keying and no `front` that could put a receivable in the wrong place. A cross-pool leak is not expressible against it, so the property could not be driven into failure — and an invariant that cannot fail is not one. `CorridorBookInvariantsTest` therefore binds the real `CorridorFixture`, with origination on the harness rather than in the handler so that a plan's strip, acceptance and limit attestation are built by the one path the product uses.

### Why the two Phase 6 plan properties bind to a separate view

`check_refundOnlyToBorrower` and `check_escrowNeverStrandsSettlement` read an `IPlanFlowView` bound alongside `subject`, not `IInstallmentPlan`. The reason is deliberate: they are stated over **flows** (`refundInflow`, `refundToBorrower`) and over an escrow row that lives in a different contract, and the real `InstallmentPlan` stores neither — it pays every unit out in the same transaction it arrives. Adding storage to a live contract so a test could read it would be the test changing the system it is supposed to constrain.

Under Certora the distinction disappears: the prover sees the transition relation and the sums are quantified over it directly. Under Foundry the bite suite binds `ConfigurablePlan`, which carries the running totals precisely so both properties can be driven to failure, and `invariant_refundNeverReturnsToTheMerchant` covers the live half.

### Why `everyInstallmentAccountedFor` is not asserted under the fuzzer

The specification's form — every installment reaches a terminal status within `validBefore + 1` — is a **liveness** claim. It holds "given at least one honest keeper", and a random walk is under no obligation to be one. Asserting it would amount to asserting that the fuzzer got lucky, which is false and says nothing about the contract.

What the contract can guarantee unconditionally is that the crank is always *available* and always *paid*. That is `overdueInstallmentRecordable` — a stronger statement about the protocol and a weaker one about luck. `check_everyOverdueInstallmentIsAccountedFor` stays in the suite as the specification of the intended outcome, and Phase 5 asserts it over a book where the epoch settlement gate makes marking economically forced rather than merely possible.

One exception is carved out deliberately: nothing is recordable while the token is paused. A mark during an outage would provision NAV and put a default on a Passport for a borrower whose only failing was that USDC was paused.

## Properties this file does not yet carry

Deferred with their phase, not forgotten:

- **Cure round-trip** — a cure releases exactly the provision the delinquency took, per epoch bucket. Needs both a plan and a pool, so it lands in Phase 5. This round trip is where real bugs live.
- **Provisioning idempotence** — 50% applied twice at `Delinquent` is still 50%; 100% at charge-off supersedes rather than compounds. Phase 5.
- **Redemption queue fairness** — cumulative positions fill pro-rata, and every redeemer in an over-threshold epoch pays the same uniform liquidity fee. Phase 5.
- **`repay()` / `collect()` commutativity** — a borrower curing by push and a keeper cranking must not double-charge. Both entry points now exist and the fuzzer drives them against each other, so `planValueConserved` and `noDoubleClear` cover the outcome; what is still missing is the property stated over the *order*, which needs Certora's transition relation rather than a snapshot.
- **State-machine reachability** — no path from `Repaid` back to `Grace`, expressed over the transition relation rather than over a snapshot. Best done in Certora, where the relation is available; the Foundry check here only sees states, not edges.

## Free-tier budget

Certora's free tier is 2,000 prover-minutes a month. The plan properties are cheap — bounded loops over `installmentCount`. The pool properties are not: `assetsEqualClaims` and `lossWaterfallOrdered` over a book of arbitrary size will exhaust the tier. Run those against a bounded book in CI and reserve unbounded runs for the pre-audit campaign.

Kontrol is the fallback for anything loop-heavy: it is the only tool in the verification stack with loop invariants, which is what the waterfall needs if it iterates installments.
