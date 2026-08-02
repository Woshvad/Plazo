# Arc fork spike — findings

Run: `forge test --match-path 'test/fork/*'` against `rpc.testnet.arc.io`, chain 5042002, block ~54,097,512, USDC implementation `0xC6AD664ac6679F4Ce74e10E91449C93Ec1ae3cA6`.

These answer the open questions Phase 1 owned. Each one is reproducible — the test that produced it is named.

---

## 1. ERC-1271 works end to end. One-ceremony signing is available.

**`test_erc1271SignerAuthorizationCompletes`**

Part 0 research proved the ERC-1271 *branch is reached* — a call trace showed the staticcall to `isValidSignature`. It did not prove an authorization completes, because the traced call used a zero signature and was never expected to move funds. That gap was the highest-value unknown left in the stack.

It is closed. Against real Arc bytecode: the token's `SignatureChecker` at `0xfcFf98B65F9ea559EC0df36F4072C7E3BE0520Df` calls the contract's `isValidSignature`, accepts `0x1626ba7e`, emits `AuthorizationUsed`, marks the nonce consumed, and dispatches the transfer with the correct parties and the correct 6→18 decimal widening.

`test_erc1271RejectingSignerIsRefused` confirms the token really consults the signer rather than short-circuiting on `from.code.length > 0` — a signer returning `0xffffffff` is refused and no transfer is dispatched. Without that control the first result would be worthless.

**Consequences.** A merkle-wrapped ERC-1271 signature is mechanically available on Arc, so the one-ceremony path is open. Flex's twelve-check strip does not need re-scoping, `revalidate()` collapses from N leaves to one root per plan, and the EOA fallback stays a fallback. The contingency drafted for a negative result — EOA-only, EIP-7702, short strips — is not needed.

**Still open, and operator-gated:** whether Circle's MSCA validator accepts a merkle-wrapped signature or Plazo must ship its own ERC-6900 module, and whether the Circle Wallets SDK signs N payloads under one gesture. Both need a Circle developer account. See `ACCESS.md`.

---

## 2. Arc USDC has no balance storage. The balance *is* the native balance.

**`_fund`, and the reason `deal()` fails**

`deal(token, account, amount)` fails with "Slot(s) not found" because there is no balance mapping to find. `balanceOf` reads the account's native balance and divides by 10^12: `vm.deal(a, 5 ether)` makes `balanceOf(a)` read `5_000_000`.

This is the concrete form of "gas and the loan share one balance". Every transaction a borrower sends reduces what a check can collect. A borrower holding exactly one installment cannot pay for their own cure.

**Consequence.** Paymaster sponsorship of all borrower-side transactions is a functional requirement, not a UX nicety — and it must be v0.7, because Circle Paymaster does not cover Arc on v0.8. It also means balance monitoring and top-up (Phase 4) measure something real: without them, the loss model measures wallet UX rather than credit.

---

## 3. Token movement is a native precompile Foundry cannot execute.

**`NativeTransferPrecompileMock`, and the reason it exists**

`receiveWithAuthorization` dispatches the actual transfer to `0x1800000000000000000000000000000000000000`. That address's on-chain code is the single byte `0x01` — a marker so `EXTCODESIZE` is non-zero while the node implements the behaviour internally. Foundry's EVM has no such implementation: it executes `0x01` as ADD and dies with `StackUnderflow`.

The mock etched in its place lets the rest of the path run for real — real proxy, real implementation, real signature checker, real ERC-1271 callback — and records the dispatched transfer. It returns `bool true`, because the token checks the return value and a mock returning nothing makes every transfer revert in a way indistinguishable from the precompile being absent.

**Consequence, and it constrains the whole test strategy.** No fork test can complete a USDC transfer. There are exactly two options and no third:

- Local Solidity tests (unit, integration, invariant, fuzz) run against a **mock token** implementing EIP-3009 faithfully.
- Assertions about **real value movement** — the Phase 2 vertical slice's balance checks — run against **funded Arc testnet accounts**, which needs the faucet, which needs a Circle developer account.

Phase 2's gate should be planned on that basis rather than discovering it mid-phase. The mock token needs to be written carefully: it is what every invariant runs against.

---

## 4. The failure mode the collection design turns on, confirmed.

**`test_insufficientFundsReverts`**

An underfunded pull *reverts*. It emits nothing, changes nothing, pays nobody. The specification's claim that "the failure is the signal" describes an event that, left to the token, nobody ever creates — and grace transitions, Passport marks, NAV provisioning, the subordination gate and the first-payment-default kill switch are all fed by it.

The nonce survives a failed pull, so a cure can still clear that installment later.

**Consequence.** All four mitigations are required, not just the first: `try/catch` around the pull; a typed `CheckBounced` reason; a separately bountied `markMissed()` paid from the ops budget; and epoch settlement that refuses to close while any plan past `grace + 1` is unmarked. Three of the four are already in the Phase 1 interfaces and the invariant suite.

---

## 5. `cancelAuthorization` burns a nonce permanently.

**`test_cancelBurnsNoncePermanently`**

Once cancelled, that nonce can never be used — a subsequent `receiveWithAuthorization` with the same nonce reverts even with a valid signature.

**Consequence.** This is why `originationNonce` is in the `planId` preimage. A borrower who cancels a strip and re-buys the same item must derive different nonces, or the second plan is unsignable forever. `test_originationNonceSeparatesIdenticalPurchases` (Solidity) and its TypeScript counterpart hold that property.

---

## 6. Payee enforcement holds. Griefing is not available.

**`test_onlyPayeeMaySubmit`** — a third party submitting a borrower's authorization reverts, and critically, does **not** burn the nonce. Without this, anyone could render any installment permanently uncollectable at the cost of one transaction.

**`test_validityWindowIsEnforced`** — post-dating and self-expiry both hold on the real token.

---

## 7. Measured gas, and the corrected minimum ticket.

**`test_measurePullGas`** — an EOA `receiveWithAuthorization` costs **140,885 gas**.

At Arc's 21 gwei against 18-decimal native USDC, 1 gas = 2.1 × 10⁻⁸ USDC, so the bare pull is **$0.00296**. The spec's ~$0.013 is wrong by ~4×, in the protocol's favour. Part 0's two estimates bracketed it: STACK modelled $0.0025 for a bare pull, ARCHITECTURE $0.0042 for an accounted one.

The accounted `collect()` — plan state, pool accounting, bounty payment — does not exist yet, so the figures below are **measured primitive plus modelled overhead**, and are labelled as such. Phase 2 must re-derive them once `collect()` is real.

| Line item | Gas | Cost | Basis |
|---|---|---|---|
| `receiveWithAuthorization` | 140,885 | $0.00296 | **measured** |
| Plan state + pool accounting + bounty payment | ~70,000 | $0.00147 | modelled |
| Accounted `collect()` | ~211,000 | **$0.0044** | measured + modelled |
| Checkout (screen, check #1, pool draw, clone, mint, payout) | ~480,000 | $0.0101 | modelled |
| Keeper bounty | — | $0.05 | parameter |
| Mark bounty | — | $0.02 | parameter |

Pay-in-4 has four bounty-bearing events: check #1 at checkout plus three dated collections.

- **Base:** `$0.0101 + 4 × ($0.05 + $0.0044)` = **$0.2277**
- **Stress** (one bounce, one mark, one re-crank): **$0.2965**

Against a 0.5% ops slice:

| Ticket | Ops revenue | Base margin | Stress margin | Verdict |
|---|---|---|---|---|
| $40 (Appendix A) | $0.200 | −$0.028 | −$0.097 | Fails before any bounce |
| $60 | $0.300 | +$0.072 | +$0.004 | Marginal |
| **$75** | $0.375 | +$0.147 | **+$0.078 (21%)** | **Confirmed floor** |
| $100 | $0.500 | +$0.272 | +$0.204 | Comfortable |

**DEC-04's $75 is confirmed by measurement**, with slightly more headroom than the research estimate (21% stress margin against 20%). Bounty economics dominate gas by roughly an order of magnitude, so the ticket floor is set by the keeper market, not by Arc's fees — which means the Dutch ramp parameters matter far more than any gas optimisation.

---

## What this spike did not settle

| Question | Why not | Where it goes |
|---|---|---|
| Circle Wallets: N payloads under one gesture | Needs a Circle developer account | `ACCESS.md`; Phase 4 checkout UX. **No longer blocks D1** — see the addendum. |
| Circle MSCA validator vs a Plazo ERC-6900 module | Same | `ACCESS.md`; Phase 4 |
| Circle key-rotation / recovery webhook | Same | Superseded: Phase 2 made signer mutation an onchain observation anyone is paid to make |
| Arc testnet reset policy | No published statement exists | Mitigated by continuous off-chain snapshotting, not resolved |
| Real value movement under the accounted `collect()` | Requires the precompile, so requires funded testnet accounts | **Closed 2026-07-31** — see the addendum |

D1 — the signer-class to unsecured-cap policy — still cannot be closed, but the shape of the answer changed: ERC-1271 working means smart accounts are viable, so the question is now about *which* smart account and how signer mutation is observed, not whether the path exists at all.

---

# Addendum — what the live run added (Phase 2, 2026-07-31)

The spike above ran on a fork. This section is from the real network: the Phase 2 stack deployed to chain 5042002, two plans originated against real Arc USDC, sixteen assertions passed. Everything here is a consequence of gas and the loan being the same balance, and none of it is visible locally.

## 8. `eth_estimateGas` cannot be used near an account's full balance

A `transferFrom` of 18.75 USDC from an account holding 18.88 reverted with `ERC20: transfer amount exceeds balance`. The account was solvent. The estimator was not.

`eth_estimateGas` binary-searches upward and prepays its **upper bound** out of the sender's balance before execution — and on Arc that balance *is* the token balance. A 30M-gas ceiling at 90 gwei removes 2.7 USDC before the transfer runs, so the token sees an account 2.7 short and reverts.

The failure is indistinguishable from insolvency in the error string, which is the dangerous part: it looks like a balance bug in the contract.

**Anything that moves close to a whole balance on Arc must set an explicit gas limit.** The slice runner pins one on every write; `cast` needs `--gas-limit`. This will bite any sweep, any payoff-in-full, and any borrower curing with exactly the installment they owe.

Reproduce: `packages/arc-verify/src/slice.ts`, the comment on `send`.

## 9. A keeper's bounty cannot be checked with `balanceOf`

The crank's gas comes out of the same balance the bounty is paid into, so the ERC-20 delta is `bounty − gas`, and the 6-decimal view truncates whatever is left. The live assertion reads `eth_getBalance` — the 18-decimal native figure — and checks it exactly:

```
after == before + bounty × 10¹² − gasUsed × effectiveGasPrice
```

Measured: a 0.41625 USDC bounty against 0.00573145 USDC of gas, on the same account, in the same transaction.

Any accounting that reports keeper earnings from an ERC-20 balance on Arc is reporting earnings net of an unrelated cost.

## 10. A `forge script` cannot originate a plan

Not only fork *tests*. `forge script` executes its body locally to collect the transactions it will broadcast, so anything touching USDC hits the precompile and reverts before it can be sent — including `originate`, which pulls the mark escrow. `--skip-simulation` does not help; it skips the onchain simulation, not the local execution.

Contract creation moves no tokens, so deployment works. Everything else runs from TypeScript through viem, which never executes locally at all.

A related trap: a script that writes its own deployment record writes it during that local execution, so **a run that fails at the send step still produces a file naming addresses that hold no code**. The record now comes from Foundry's broadcast receipts via `tools/record-deployment.mjs`.

## 11. Shedding is not optional to handle, at any request rate

The slice lost a run to a shed `balanceOf` on the third account it read — five requests in. `arc-verify` and the keeper already carried the retry; the slice did not, and the failure surfaced as an unhandled RPC error mid-run with two plans half-originated.

## What the live run proved that no local test can

| Claim | Evidence |
|---|---|
| A real EIP-3009 signature over a real digest clears against the real token | 18.75 USDC debited from the borrower, exactly |
| The CREATE2 payee is where the clone lands | `0x50D71E53…` and `0xbCdCaf6d…`, predicted in TypeScript before either existed |
| A third-party keeper is paid | 0.41625 USDC to an address holding no role |
| A drained borrower bounces rather than reverting | `Grace`, with the installment recorded `Bounced` |
| The plan cures and reaches `Repaid` | Both, with no fee outstanding |
| The delinquency signal is written by a stranger and paid for | `markMissed` from an unrelated address, out of the plan's own escrow |
| **The published keeper needs nothing but the chain** | `@plazo/keeper` given only a factory address found all three plans, identified the one crank worth doing, sent it, and was paid — then reported nothing left to do |

---

# Phase 3 addendum — origination against the live deployment

## 12. Foundry's broadcast receipts mix two orderings, and a deployment record built from them is wrong

`tools/record-deployment.mjs` reads Foundry's broadcast artefact and maps each `CREATE` transaction to its deployed address. It preferred `receipt.contractAddress`, falling back to `transaction.contractAddress`.

In the artefact, the receipts array is written with **`transactionHash` in mining order and `contractAddress` in submission order**. A receipt row can therefore carry one transaction's hash beside a different transaction's deployed address:

```
tx MerchantRegistry   hash 0x7db52a67…   receipt.contractAddress 0xeee0320d…  ← ParameterRegistry's
tx ParameterRegistry  hash 0x73f010b9…   receipt.contractAddress 0xca12a3b9…  ← EligibilityRegistry's
```

With Phase 2's four contracts the two orders coincided and the record was right by luck. With Phase 3's fifteen they did not, and the first record produced named the same address for the receivable token and the FX router, and again for the eligibility registry and the compliance oracle. Every consumer of that file — the indexer, the keeper, the slice runner — would have believed it.

**Take the address from the transaction, never from the receipt.** The receipt is still what proves the deployment happened; it is just not what says where. Cross-check the written record against the deploy log before trusting it.

## 13. A $75 ticket needs $300 of book behind it, and that is the cap working

UW-02 caps Tier-0 paper at a share of the pool's book, enforced onchain. The band's ceiling is 25%, so the smallest ticket the protocol will originate needs four times its own value in pool capital before the headroom reaches it — $300 against a $75 plan, plus the merchant bond and the borrower's float.

The full live slice therefore needs **408.84 USDC** on the funding account, and the breakdown is almost entirely capital:

| | |
|---|---|
| Senior deposit | 250.00 |
| Junior deposit | 45.00 |
| First-loss reserve | 25.00 |
| Permanent tranche seeds (POOL-12) | 2.00 |
| Merchant bond | 10.00 |
| Borrower's float across four installments | 75.00 |
| Mark escrow, two plans | 1.60 |
| Gas float, four accounts | 0.24 |

That is a peak holding rather than a spend: the deposits go in, cycle through the plan, and are redeemed at the end. The borrower's float is the part that genuinely moves, and it moves into the pool.

**Two corrections found by pricing it properly**, both of which would have wasted a funded run:

The figure omitted POOL-12's permanent per-tranche seeds — 2 USDC that `prepareBook` spends and `REQUIRED` did not count. A slice that starts and stops two dollars short is worse than one that refuses to start.

And UW-09's per-merchant concentration cap would have refused the origination outright. At the seeded 322 USDC of assets a 20% cap is 64.40, below the protocol's own 75 minimum ticket. It is set to 25% for the run — a setting inside a compiled-in band, not a widening of one — because a one-merchant book is 100% concentrated by construction and concentration is a diversification control with nothing here to diversify. That is a different kind of number from the Tier-0 book share, which bounds what the pool can lose on unproven paper however many merchants there are, and which is why that one sits at its ceiling rather than above it.

It is worth stating plainly because the temptation is to widen the band to make a testnet run cheaper, and the band is one of the two things standing between an unproven scorecard and the senior tranche — DEC-02 put Tier 0 on pool capital from day one against a research recommendation for a shadow book, with the risk accepted knowingly.

## What the Phase 3 live run proved

Twelve assertions against the deployed bytecode at chain 5042002. The credit half needs the funding above; the control half does not, and the refusals are the half that has never been observed anywhere but a mock.

| Claim | Evidence |
|---|---|
| Every contract in the deployment record exists | 12 addresses, all holding bytecode |
| Appendix A is read from a registry, not compiled in | Tier-0 book share reads 1000 bp onchain |
| A parameter outside its hard-coded band is refused | 90% rejected against a 25% ceiling |
| An uncapitalised book will not originate (POOL-05) | `originationOpen()` false, headroom zero |
| The quote surface answers zero rather than a figure it cannot honour | `maxPrincipalFor` returns 0 with the gate shut |
| A merchant onboards without an operator, and cannot clear themselves | self-registration succeeded; `attestKyb` refused |
| Unknown is not clear (CHKT-03) | an unscreened address is not clear; the operator's key made it so |
| The receivable is default-deny from the first mint (GOV-10) | a mint to an unlisted address refused |
| The factory is the router's alone | `deploy` from the deployer refused |

---

# Phases 4 and 5 addendum — the IR pipeline, and what it broke

## 14. Under `via_ir`, `block.timestamp` is hoisted past `vm.warp`, and a test can silently stop testing

Phase 5 turned the IR pipeline on (DEC-30). `TranchedCreditPool` is a credit book, a tranche structure, an epoch accountant and a redemption queue in one contract — because splitting it would put one balance sheet in two places, which is the bug Phase 3 shipped and had to fix — and through the legacy pipeline it lands about 2 kB over EIP-170. The IR pipeline is the standard answer, and it is not only a size fix: every contract in the tree got smaller, `InstallmentPlan` by about 11%.

It also changed a test's behaviour, and the way it changed it is worth knowing.

The IR optimizer treats `block.timestamp` as constant within a call, because on a real chain it is. `vm.warp` is a cheatcode the optimizer cannot see. So a loop like

```solidity
for (uint256 i = 0; i < 40; ++i) {
    vm.warp(block.timestamp + PlanParams.REVALIDATION_WINDOW);
    plan.revalidate();
}
```

reads the timestamp **once**, hoists it out, and warps to the same moment on every iteration. `KeeperMarket.t.sol` caught it by failing on the second pass — but only because that test happened to assert something the stalled clock made impossible. A test asserting a weaker property would have gone on passing while exercising one iteration of forty.

Two things follow.

**`vm.getBlockTimestamp()` goes through the cheatcode address and cannot be hoisted.** Every read in `contracts/test` and `contracts/script` was converted. Mocks and stubs are exempt: they are plain contracts called from the test, so each call is its own frame and reads the clock fresh.

**`tools/check-test-clock.mjs` fails the build on a `block.timestamp` in test code**, and runs in `pnpm boundary`. A hazard that depends on remembering is a hazard that comes back.

## 15. Recognising a fee against the original principal compounds, and strands income

Found by the invariant fuzzer, via `deferredIncome ≤ bookedReceivables`.

The pool defers the MDR at origination and earns it as principal comes back. The first implementation apportioned it against the plan's *original* principal:

```
earned = deferredIncome × recovered / principal
```

That compounds. A plan of 1,000 with 100 deferred recovers 500 and earns 50, leaving 50 against 500 outstanding; the second 500 then earns `50 × 500/1000 = 25`, and a fully repaid plan is left carrying 25 of unearned income against no receivable at all. NAV is understated for the whole life of every plan and then jumps at close — the flatter-then-correct pattern the deferral exists to prevent, running backwards. With enough repaid-but-unclosed plans the unearned total exceeds the receivables it is held against, which is what the fuzzer found.

**The denominator is what is still owed, not what was originally lent.** Against the remaining balance it amortises exactly: the last dollar of principal earns the last cent of fee.

The same formula shipped in Phase 3's flat pool. It never surfaced there because that campaign's handler did not interleave partial collections with epoch closes; adding the epoch actions in Phase 5 is what produced the state.

## What the Phases 4 and 5 live run proved

Twenty-seven assertions against the deployed bytecode at chain 5042002, up from twelve. The credit half still needs the funding in finding 13; the control half does not, and it now covers the capital plane and the Passport as well as origination.

| Claim | Evidence |
|---|---|
| Every contract in the record exists | 19 addresses, all holding bytecode |
| One book per product line, and the book decides what it funds (POOL-01) | Pay-in-4 accepted, a twelve-month schedule refused |
| A product line cannot be repointed | `register` on a taken line refused |
| The empty-vault case is unreachable (POOL-12) | an unseeded tranche refuses deposits; shares carry a 3-decimal offset |
| Junior is locked for a full tenor and senior is not (POOL-10) | 56 days against 0 |
| Only the pool mints a claim on the book (POOL-02) | a direct `mint` refused |
| An epoch cannot be closed early (POOL-04) | `closeEpoch` refused inside the window |
| You cannot be senior to nothing (POOL-06) | `maxSeniorDeposit` is zero with no junior |
| The operator's collections are held back onchain (COLL-07) | the gate reads a 30-minute floor from the registry |
| A borrower's tier is not readable by whoever asks (PASS-02) | `tierOf` refused to a merchant key |
| Nobody outside the protocol writes a record (PASS-01) | `noteOutcome` refused to the deployer |
| The credit score is a pure function anyone can evaluate (PASS-06) | the chain returns the same tiers as the corpus |
| A schema needs a content hash, not a link (PASS-05) | `publish` with a zero hash refused |

**Not re-measured:** finding 5's collection gas (140,885 → ~$0.00296) was taken from a live Phase 2 run under the legacy pipeline. `via_ir` shrank `InstallmentPlan` by about 11% and the figure is almost certainly lower now, but it has not been measured on chain again — the next funded slice run should re-take it rather than assume the improvement.

## 16. The deployment issues a security nobody may hold, and the fixture hides it

`Deploy.s.sol` grants eligibility to two addresses: the pool and the router. Both are
plumbing. It grants it to no lender, because who may hold a restricted security is a
determination about a person and not a property of the infrastructure that issues it —
so the deployment is right to grant nobody.

The consequence is that the book **as deployed cannot take a deposit from any account
on earth**. DEC-01 keeps Reg D transfer restrictions on the tranche claims, so
`TrancheToken._update` refuses a mint to an address the registry has not admitted, and
`requestDeposit` reverts `NotEligible` before it touches a dollar.

Two hundred and eighty-six Foundry tests pass against this. `OriginationFixture.setUp`
grants eligibility to the lender and to the test contract, which is correct for a
fixture and is exactly why the gap is invisible: every local test onboards its lender
as a side effect of existing, and no local test can observe a deployment that did not.

The live trace, which is the only thing that could have found it:

```
requestDeposit(1, 45000000)
  ├─ EligibilityRegistry::isEligible(juniorShares, deployer) [staticcall]
  │   └─ ← false
  └─ ← [Revert] NotEligible(0xF4ee…D0F2)
```

The slice now accredits its own lender before depositing, as an operator would, and
asks the refusal first — of the borrower, who is never a lender, so unlike the controls
in finding 17 that one stays observable for the life of the book.

## 17. Four of the live controls could only ever be asked once

The slice asserts things about a book with nothing in it: that an unseeded tranche
refuses deposits, that senior capacity is zero with no junior beneath it, that Tier-0
headroom and the quote it feeds are zero against no capital. Every one of those is true
exactly until the run itself capitalises the book — after which the same assertions are
false, and a second run fails on properties that were never violated.

This is worse than an inconvenience. A partially-completed run leaves a deployment the
suite can no longer be pointed at, so the failure mode is "the gate now refuses the
chain it was written for" and the tempting fix is to delete the assertions.

They are now reported as `--` rather than `ok`: witnessed once, not observable again,
and **not counted in the pass total**. Counting them would have been the real damage —
the number would keep climbing while the suite quietly stopped asking.

One related assertion was simply wrong rather than one-shot. `every Appendix A
parameter reads from the registry` compared the Tier-0 book share to the deployed
default of 1000 bp, which asserted that nobody had exercised governance — something the
run itself does three lines into `prepareBook`, and the entire purpose of having a
registry. It now asserts the value is inside its compiled band, which is the property
GOV-01 actually claims; that the band is enforced is the assertion immediately after it.

## 18. The slice's compressed schedule was paper the book could never fund

Both plans were originated on a two-day interval, to compress a four-installment
schedule into a run that cannot warp its clock. The pool refused them:

```
acceptsSchedule(4, 172800) → false
  → ScheduleOutOfBand(pool, 4, 172800)
```

`minInterval` is **immutable** on `TranchedCreditPool` — seven days, with a
thirty-one-day ceiling — and DEC-26 makes the book, not a signed field, decide what it
will front. So the demo schedule was not merely unusual, it was unfundable by the only
book on the network, and no amount of configuration could have made it work. The band
is constructor state; changing it is a redeployment.

The anchors move with the interval rather than the interval moving to the anchors. At
seven days, `now - 14d - 13h` leaves installments 0–2 due and installment 3 at least
five days out, whichever way the ±12h `planId` jitter falls — the same shape the
two-day version had, scaled to the band the book actually declares. The delinquency
plan needed the same treatment: at seven days its old `now - 10d` anchor could put the
second installment as little as two and a half days back, which is *inside* the
three-day grace window it exists to be past.

## 19. A live slice is not a test fixture, and this one assumed it was

The suite tears down and rebuilds its world every run. The live slice cannot: it points
at one persistent deployment, and everything it does stays done. Every partial failure
therefore left state that refused the next attempt, and the failures came one per run:

| What the run had already done | What it refused next time |
|---|---|
| Seeded both tranches | four virgin-book controls, now false (finding 17) |
| Raised the Tier-0 share to its ceiling | `every Appendix A parameter reads from the registry` |
| Capitalised the book | a second 295 USDC deposit the account no longer held |
| Posted the merchant's bond | another ten dollars, silently, every run |
| Originated a plan | *itself* — 75 USDC of live exposure consumed the Tier-0 headroom, so the book had 5.50 USDC of room for a 75 USDC ticket |

Each step is now guarded by reading the chain first: seeds skip if seeded, the bond
skips if posted, capitalisation skips if the origination gate is already open — which
also spares the epoch window, the difference between iterating in a minute and in an
hour. The funding check subtracts what is already committed rather than demanding the
virgin total, so a book holding its own capital is not told it is 332 USDC short of
money it is currently holding.

The orphaned plan is the one that does not have a guard, because it is not idempotence
— it is cleanup. A run that dies mid-plan leaves a live receivable, and the only honest
fixes are to drive it to a terminal state or to redeploy. It was cleared by hand here:
`repay`, `recognise`, `notePlanOutcome`, all three permissionless, which is at least
GOV-08 paying for itself in an unplanned way.

## What the funded run proved

**51 assertions against live chain 5042002**, and for the first time the credit half
ran end to end: a plan originated through the router with the merchant credited inside
the origination transaction, a down payment cleared, a third-party keeper collected and
was paid its quoted bounty, a pull against an emptied wallet **bounced instead of
reverting**, the plan went to Grace and cured, a stranger's crank booked the repayment
and earned the deferred fee, and a second plan's delinquency was recorded by an address
with no relationship to it and no operator involved.

The book ended at 336.81 USDC with `grossReceivables` 0, `outstandingExposure` 0,
`openPlans` 0 and `unmarkedDelinquencies` **0** — the last of which is the whole point
of finding 21.

Measured on the way past: a keeper `collect()` cost **0.0058 USDC** of gas against a
0.46875 USDC bounty. That supersedes finding 5's 0.00296, which was taken under the
legacy pipeline and on a narrower transaction.

A run costs the funding account about **26 USDC net** — MDR, the late fee and retained
income moving permanently into the book. It is not a round trip.

## 20–27. Eight defects a preflight audit caught before the money moved

After five failures found one at a time, the un-run half of the slice was audited by
five independent lenses with every finding adversarially verified. Nineteen of
twenty-seven candidates survived. They are grouped here by what they would have cost.

### 21. Marking one installment of two bricks the book permanently

The worst of them, and it would have passed. `runDelinquency` marked installment 1 and
left installment 0 Pending past its grace window. `_syncMarkState` flags the whole book
`unmarked` on *any* such installment.

It stays silent during the run — `front` has already stamped `markedEpoch == _epoch`, so
the crank never walks the plan and `closeEpoch` sees nothing. Then the epoch turns over,
and **the next run's first `markEpoch` sets `unmarkedDelinquencies = 1`**. From that
moment `originationOpen()` is false for every borrower on the book and `closeEpoch()`
reverts `UnmarkedDelinquencyOutstanding`, with no path back. The capital would have been
stranded in a pool that could never close another epoch.

A run that reported complete success would have destroyed the deployment.

### 25. A drained book still reports its gate open

`unwind` had never executed — it died on an ABI error before touching state — so making
it work was the dangerous part. Redeeming the senior leg takes the book from ~337 USDC
to ~90, and `originationOpen()` stays **true** at that size, because subordination and
reserve are *ratios* and ratios improve as a book shrinks. Tier-0 headroom is a *share*:
25% of 90 is 22.50 against a 75 minimum ticket.

So the gate reads open, `prepareBook` skips re-capitalisation, and origination fails for
want of exactly the money the run gave back. `bookIsFunded()` now tests capacity rather
than the gate, and both `prepareBook` and the funding check read it, so the check cannot
promise what the setup will not do. `unwind` is opt-in behind `PLAZO_UNWIND=1`.

### 26. The liquidity fee is charged for undoing your own setup, and is unrecoverable

POOL-09's fee arms above 10% of assets, so a whole-position redemption is far past it
and retains ~1% — about 2.50 USDC. After the redeemer's shares burn, the only holder
left in that tranche is POOL-12's permanent seed, which nothing can ever redeem. Per
run, gone.

### 20. Junior cannot be redeemed for 56 days, so the funding story was overstated

POOL-10's lockup is stamped on the receipt at `claimShares` (DEC-29), and `requestRedeem`
is a transfer the token refuses until it lapses. Proven live: `unlockAt(deployer)`
returns a timestamp 56 days out, and the revert payload matches
`SharesLocked(address,uint256)` carrying exactly that value.

The doc comment claiming deposits "cycle through the plan and are redeemed at the end"
was therefore false for the junior 45 — and, per finding 26, not quite true for the
senior 250 either. Both corrected. `unwind` now skips a locked tranche and says so.

### 22. Plan B held the borrower's only slot for good

`capFor` returns zero outright while `activePlans > 0`, so leaving plan B open meant
every later run reverted `LimitExceeded(75000000, 0)`. The run now settles it — payoff,
`recognise`, `notePlanOutcome` — all three permissionless, which is GOV-08 paying for
itself in a way nobody planned.

### 23. A ten-minute attestation struck from a ninety-minute-old clock

`validUntil` was derived from a timestamp captured before `prepareBook`, which can
legitimately wait a full epoch window. The attestation could be expired at the moment it
was signed. Both TTLs are now struck at origination.

### 24. A refusal that becomes a permission when nobody is looking

`an epoch cannot be closed before its time` asserts a revert. At the one-hour floor the
window lapses between runs, `closeEpoch` then simulates cleanly, and the assertion fails
on a property the contract never violated. Verified live before it could: the window had
closed 39 minutes earlier and `cast call closeEpoch` returned `0x`. The wall clock is not
a state the slice controls, so it reports rather than pretending.

### 27. `unwind` had no assertion of any kind

`claimRedemption` returns zero without reverting when the fill line has not reached the
ticket, so an unwind that paid out nothing was indistinguishable from one that paid out
everything. The least-exercised code in the file was also the only phase that checked
nothing. It now asserts the money arrived.

### The two mechanical ones

`TRANCHE_ABI` had no `approve`, so `unwind` threw `AbiFunctionNotFoundError` client-side
before any RPC. And the redemption index was read with `readContract` — an `eth_call`
with no `from` — so `msg.sender` was the zero address and `requestRedeem` reverted on
`transferFrom`. A `peek()` helper now simulates against a named account, because for a
state-changing call the sender is the whole point.

## The second run, which is the one that proves the fixes

The first funded run proved the mechanism. The second proves the thing this session was
actually about: **it ran again, unchanged, against the deployment the first run left
behind.** 51 assertions, same as before, with no manual chain surgery in between.

That is the whole of findings 17, 19 and 25 demonstrated rather than argued. Six controls
correctly reported as spent rather than failing:

```
--  an uncapitalised book refuses to originate — the book carries capital from an earlier run
--  a tranche refuses deposits until the protocol has seeded it — already seeded
--  senior capacity is zero against a book with no junior — junior is seeded
--  an epoch cannot be closed before its time — epoch 3's window closed 612 minutes ago
```

That last line is finding 24 earning itself. Without it the run would have failed on
assertion four, on a property the contract never violated, because a one-hour epoch had
simply gone stale overnight. `prepareBook` skipped capitalisation and the bond, so
nothing was double-paid.

### What a run actually costs

| | |
|---|---|
| Deployer before / after | 109.11 → 82.77 USDC |
| Book before / after | 336.81 → 348.58 USDC |
| **Net cost of one run** | **26.34 USDC** |

The money is not lost, it is *moved*: MDR, the late fee and retained income are earned by
the book, which is what a lender's return looks like from the funding account's side. But
it does not come back — `unwind` is opt-in, junior is locked 56 days, and POOL-09 takes
its cut of whatever does leave. Budget a run as a spend, not a loan.

Both runs together also settle the re-measurement finding 5 asked for: a third-party
keeper `collect()` cost **0.00580395 USDC** of gas, identical across both runs, against a
0.46875 USDC bounty. The keeper market clears with roughly an 80× margin.

## 28. A `depositForBurn` out of Arc clears, and the nonce is not knowable at burn time

**`pnpm --filter @plazo/arc-verify spike:cctp`**, 2026-08-02, chain 5042002.

Nobody had ever executed this call from Arc. Every view around it read correctly and the
seven-argument selector was in the deployed implementation, but a selector is a claim about
what a contract could do — and Arc USDC's movement runs through a native precompile that
Foundry cannot execute (finding 3), so no local test could tell us whether a third-party
Circle contract can pull that token at all. `PayoutRouter` is designed around the answer,
so the answer was bought for a dollar before it was designed around.

**It clears.**

| | |
|---|---|
| Burn | [`0x693f8632…51a13c44`](https://testnet.arcscan.app/tx/0x693f8632dfc950224cc18ce69c010b13d12b9660f6e10e605c817e8b51a13c44) |
| Approve | `0x0e18d813…2cd44845` |
| Route | domain 26 (Arc) → domain 6 (Base Sepolia), `mintRecipient` = the depositor |
| `depositForBurn` gas | 120,252 → **0.0030063 USDC** at 25 gwei |
| `approve` gas | 55,438 → **0.00138595 USDC** |
| **Full dispatch** | **0.00439225 USDC** |
| CCTP protocol fee | **0**, and not merely quoted as 0 — see the balance arithmetic below |
| `MessageSent` | 376 bytes, from `MessageTransmitterV2`, not from the messenger |
| Attestation | `status: "complete"`, **8.6 s** end to end including the burn's own receipt wait |
| Attestation size | 130 bytes — two 65-byte signatures, matching `signatureThreshold() == 2` |

The deployer went 82.77205 → 81.767658 USDC. That is 1.004392 out for a 1.000000 burn and
0.00439225 of gas, to the last unit. **The zero fee is a measurement, not a quote from the
fee oracle.** Nothing was skimmed in between.

A full cross-chain dispatch therefore costs less than a single `collect()` (0.0058 USDC,
finding 5's re-measurement). Whatever makes cross-chain payout expensive, it is not Arc.

### The thing that was not in any document: the sent nonce is zero

The emitted message's 32-byte `nonce` field is **all zeros**. The real nonce —
`0x7104071acc10559a41bbe8141f59bfab22ede5657e1c257043ab230990289b18` — comes back from
Iris as `eventNonce`, assigned at attestation, not at burn.

This is load-bearing for `PayoutRouter` and it would have been easy to assume the opposite.
**A dispatching contract cannot know, derive, or emit the identifier its own burn will be
tracked by.** There is no onchain value to key a payout row on, no way for the indexer to
join a `PayoutDispatched` event to an attestation without going through the transaction
hash, and no way for a contract to assert "this burn has been attested". The join key
between Plazo's ledger and Circle's is the **transaction hash**, and that is an off-chain
join by construction. Build the dispatch record around the tx hash; do not add a nonce
column and expect the chain to fill it.

The message decodes exactly as specified otherwise: version 1, source 26, destination 6,
sender and recipient both `TokenMessengerV2`, `destinationCaller` zero,
`minFinalityThreshold` 2000, `finalityThresholdExecuted` 0 (nothing has executed yet),
then a v1 burn body carrying `burnToken` = Arc USDC, `mintRecipient` left-padded,
`amount` 1,000,000, `maxFee` 0, `feeExecuted` 0, `expirationBlock` 0, and no hook data.

### Circle's documented Iris endpoint is still wrong, and the spike now proves it every run

`GET /v2/messages?txHash=…` — the form in Circle's own technical guide — returns an HTML
`Cannot GET /v2/messages` with status **404**. The form that works,
`GET /v2/messages/{sourceDomain}?transactionHash=…`, returns status **404** as well when
the message is merely not indexed yet, with a JSON body of
`{"error":"Message not found for provided parameters"}`.

Both are 404. A poller that branches on the status code cannot distinguish "wait" from "you
are asking the wrong URL", and will sit on a dead endpoint for its whole timeout before
reporting a burn as unattested that was attested in eight seconds. **Branch on the body
shape.** The spike asserts both forms before it spends anything, so the day Circle fixes
their routing, that shows up as a failed assertion rather than as a silent behaviour change.

### What this did not settle

- **The destination mint was not attempted**, by decision (D-12). `destinationCaller` is
  `bytes32(0)`, so anyone may call `receiveMessage(message, attestation)` on Base Sepolia —
  but Plazo holds no gas token on any chain but Arc, and acquiring one to close a leg the
  merchant closes for themselves would be building the thing the decision says not to build.
  The message and attestation are in `packages/arc-verify/.spike/` and the mint is a
  documented manual verification.
- **This was an EOA burning its own USDC.** A `PayoutRouter` burning tokens it holds on a
  merchant's behalf is the same call with a different `msg.sender`, but "the same call with
  a different sender" is exactly the class of assumption this finding exists to stop
  anyone making. Plan 06-05 re-measures it from the deployed router.
- **8.6 s is one sample on a quiet testnet.** It is not an SLA and it is not Circle's
  either. The dispatch is asynchronous by design precisely so that this number does not
  have to be trusted.
- **One dollar is not a ceiling test.** `burnLimitsPerMessage(USDC)` reads 1e13 and the gate
  asserts it, but nothing here exercised a burn anywhere near it.

---

# Phase 6 addendum — the merchant plane on the live book

## What the Phase 6 live run proved

`forge script script/Rewire.s.sol --broadcast` and `pnpm --filter @plazo/arc-verify slice`,
2026-08-02, chain 5042002, block ~54,929,585.

Six contracts deployed in one broadcast — a new `MerchantRegistry`, `PayoutRouter`, an
escrow-only `ParameterRegistry`, `SettlementEscrow`, `CheckoutRouter` and `RefundEscrow` —
for a total estimated 20,724,994 gas, **0.833 USDC** quoted and about 0.32 actually spent.
Nothing was revoked from vintage 3.

| Claim | Evidence |
|---|---|
| Every contract in the record holds bytecode | 22 addresses, including the six new ones |
| A settlement to a non-Arc domain credits a queue and not a wallet | `queued(usdc, merchant, 6)` 0 → 1.000000; the merchant's Arc balance did not move |
| …and credits **only** that domain (DEC-36) | `queued(usdc, merchant, 3)` stayed zero |
| A wallet holding no role pushes it across (GOV-08 row 11) | `dispatch` from `0x881fc8B8…`, **0.002792245 USDC** of gas, no role on any contract |
| The queue is zeroed before the external call | `queued` read zero immediately after |
| **A contract's burn clears out of Arc, not just an EOA's** | `MessageSent`, **376 bytes**, from `MessageTransmitterV2` — [`0x1fd0b4f0…c45a5504a`](https://testnet.arcscan.app/tx/0x1fd0b4f0f2636e0546d9a602338282b3293c89732961392fd9d8423c45a5504a) |
| Iris attests it | `complete` after **4.0 s**, 130 bytes — two signatures, matching `signatureThreshold() == 2` |
| The tracking identifier comes from Circle, not from the chain | `eventNonce 0x3e69a51d…c6`; the emitted message's nonce field is still all zeros |
| An unseasoned merchant settles into escrow by default (D-06) | `categoryOf` reads 0 — `Escrowed` is ordinal zero |
| The category opt-out cannot reach an unseasoned merchant | `setCategory(_, Instant)` refused with `KYB_ROLE` held |
| The escrow timers read from a registry, not a constant (D-08) | 168 h / 72 h / 72 h, live |
| The old router is alive for the paper it originated (D-24) | `poolOf` on `0x26482cfc…` still returns the pool for both vintage-3 plans; `openPlans` read **0** before the cut |
| The D-25 renounce guard refuses the live book | demonstrated firing against `EligibilityRegistry`, not asserted to exist |

**36 assertions on the first run, 28 on the second** — the drop is the burn correctly
reporting as spent rather than passing twice (findings 17, 24, 25).

### 29. The live `ParameterRegistry` can never carry the escrow rows, and `get()` reverts

`ParameterKeys.ESCROW_ATTESTATION_DEADLINE`, `ESCROW_RELEASE_TIMER` and
`ESCROW_DISPUTE_TIMELOCK` were added in plan 06-14. They are seeded by `_define`, which is
**private and called only from `ParameterRegistry`'s constructor**, and `get()` reverts
`ParameterUndefined` on a key nobody set rather than returning zero — deliberately, and the
contract's header says why.

The vintage-3 registry predates 06-14. All three read `isDefined == false` on chain, and
there is no function anywhere that could add them.

That is not cosmetic. `SettlementCategory.Escrowed` is ordinal zero, so **every** unseasoned
merchant escrows; `release`, `refundToPool` and `executeSlash` all read one of those rows;
and a settlement held by an escrow that cannot compute its own deadline is a settlement
that strands permanently, with the borrower still paying.

The registry is a constructor immutable on `TranchedCreditPool`, `Tier0Underwriter`,
`MerchantRegistry`, `PlazoPassport`, `RelayerGate` and `FirstPaymentDefaultSwitch`, so
replacing it is a new pool and a migration of every tranche position — which the standing
Phase 5 constraint forbids.

**The rewire therefore deploys a second `ParameterRegistry` read by the two escrows and by
nothing else (DEC-72).** The split is by reader and the key sets are disjoint: the live
registry keeps `MDR_BPS`, `ATTESTATION_MAX_TTL`, `MIN_TICKET`, `MAX_TICKET`,
`LIMIT_HARD_CEILING`, every merchant row and every pool row, along with its governance
history. Its bands are the same compiled `require()`s, so the 24-hour dispute-timelock floor
that stops `SLASHER_ROLE` becoming an instant key over every bond is enforced identically.

**The general lesson, which will recur:** a `ParameterRegistry` whose rows are constructor-
seeded cannot be extended, so **adding a `ParameterKeys` row is a registry redeployment**.
Anything holding it as an immutable either moves with it or reads a second one. Nothing in
`ParameterRegistry`'s own docstring says this and it is the kind of thing that is obvious
once and never again.

### 30. A vintage-3 `MerchantRegistry` cannot serve a Phase 6 router, and the failure is total

Plan 06-09 added `SettlementCategory`, a `category` field inside the `Merchant` struct, and
`categoryOf`. `CheckoutRouter._settleMerchant` calls `categoryOf` on **every** origination.

The live registry predates it. Measured against `0xcbab6e5e…`: `categoryOf` reverts, while
`vestingBpsFor`, `payoutRouteOf` and `velocityCapFor` all answer — so the contract is alive
and only that one selector is missing, which is the shape that makes this easy to miss. A
rewire that had kept it would have deployed a router whose every checkout reverts, and no
local test could have found it: the fixture deploys the current source.

`MerchantRegistry` is a plain constructor deployment with no upgrade path, so it was
redeployed. The blast radius is exactly the three contracts that reference it —
`CheckoutRouter`, `SettlementEscrow` and `RefundEscrow` — all of which are new in this
rewire. The merchant's standing bond on the old registry is not stranded: `withdrawBond` is
merchant-callable and `requiredBond` is zero with no fronted exposure outstanding.

**Read the deployed contract, not the source, before wiring a new contract to an old one.**
The cheapest form of that check is an `eth_call` of the one selector the new caller depends
on. It costs nothing and it is the difference between a working rewire and a router that
reverts on every checkout.

### 31. `abitype` refuses `defined` as a parameter name, so `ParameterRegistry.parameter` needs the tuple form

`parseAbi(["function parameter(bytes32) view returns (uint256 value, uint256 min, uint256 max, bool defined)"])`
throws `SolidityProtectedKeywordError` at parse time — `defined` is on abitype's reserved
list. The struct compiles and the ABI is fine; only the human-readable form is refused.

Use the anonymous tuple: `returns ((uint256,uint256,uint256,bool))`. Worth a line because
the error names Solidity, which sends a reader to the contract, and the contract is correct.

## The refund-arbitrage bond, as arithmetic

The phase context asked for a number nobody has computed: whether the exposure-scaled bond
covers a realistic refund-arbitrage loss. Every input below is **read live from the
`ParameterRegistry` at `0x753e08a6…`** by `pnpm --filter @plazo/arc-verify gov08`, and the
same reads are taken again after the run and compared, so "no parameter was moved to make
this read better" is a check rather than a promise. It reported them identical.

| Row | Value |
|---|---|
| `MERCHANT_BOND_BPS` | 1000 bp (10%) |
| `MERCHANT_BOND_FLOOR` | 0 USDC — a setting inside its 0…10,000 band, so the exposure-scaled term is what is exercised |
| `MERCHANT_VESTING_BPS` | 1000 bp (10%) |
| `MERCHANT_VESTING_WINDOW` | 90 days |
| `MERCHANT_VELOCITY_CAP` | 5,000 USDC |
| `MERCHANT_VELOCITY_WINDOW` | 24 hours |
| `MDR_BPS` | 400 bp (4%) |

A day-one merchant, fronting their whole allowance inside one velocity window:

| | |
|---|---|
| One velocity-cap window of fronted principal | 5,000.00 |
| What the pool actually pays out, less MDR | 4,800.00 |
| Bond the merchant must hold against it | **500.00** |
| …withheld from their own settlements (DEC-09) | 480.00 |
| …their own capital | **20.00** |
| The confederate's down payment, check #1 at checkout | 1,250.00 |
| Pool loss — ships nothing, pays nothing more | **3,550.00** |
| Pool loss — nothing comes back at all | 4,800.00 |

**The bond does not cover one velocity-cap window of fronted exposure. It covers 14.1% of a
realistic refund-arbitrage loss and 10.4% of what the pool fronted.**

It is not designed to and it cannot be. The bond is priced as a *share* of exposure, so it
is that share by construction: raising `MERCHANT_BOND_BPS` to its 5,000 bp ceiling would
take it to 50%, and a merchant would have to post 2,500 USDC of capital to front 5,000 —
which is not a bond, it is prepayment, and it would close the corridor to exactly the
cross-border sellers this product is for.

Nothing here is recovered inside the window, either. `TranchedCreditPool.minInterval` is an
immutable seven days, so the first installment after checkout cannot fall sooner and a
24-hour velocity window is entirely front.

**What actually bounds this loss is the velocity cap and MERCH-04's escrow, not the bond.**
The cap is what makes 5,000 the ceiling rather than an opening balance; the escrow is what
makes the fraud require attesting a shipment that did not happen and then surviving seven
days before `refundToPool` sends the settlement back — and it defaults *on*, because
`Escrowed` is ordinal zero. Read that way the three controls are a sequence rather than
three attempts at the same job: the escrow delays settlement for the merchant class where
"shipped nothing" is the fraud, the cap bounds what one unseasoned merchant can reach, and
the bond takes a first bite out of whatever gets through.

The honest residue: for a merchant governance has moved to `Instant`, the cap and the bond
are the whole of it, and 14% coverage of a total-default window is the number. That belongs
on the standing cohort-recalibration track, which owns the parameter. This plan owns
writing it down.

## The GOV-08 live witness is deferred on funding, and here is the exact gap

`PLAZO_GOV08=1 pnpm --filter @plazo/arc-verify gov08`, 2026-08-02, exit 0. The run reports
its branch in its first four lines and takes the unfunded one, which is a precondition that
was not met rather than a failure.

| | |
|---|---|
| Deployer | `0xF4ee61950B63cCA5C82f1146484d018Ac95Bd0F2` |
| Held | 80.43295 USDC |
| Peak requirement | 409.84 USDC |
| **Shortfall** | **329.40705 USDC** |
| Faucet visits implied | **17**, at ~20 USDC per address |

**GOV-08 is proven by `forge test --root contracts --mt test_operatorFreeLoop`.** That is
the gate and it is green. The live witness is a best-effort extra.

### Top-up procedure

1. Visit `https://faucet.circle.com`, select **Arc Testnet**, and request USDC to
   `0xF4ee61950B63cCA5C82f1146484d018Ac95Bd0F2`. The drip is ~20 USDC per address per
   request, so closing 329.40705 USDC takes **17 requests**. `pnpm --filter @plazo/arc-verify faucet`
   reports progress against the same exported `REQUIRED` the witness enforces.
2. Re-run `PLAZO_GOV08=1 pnpm --filter @plazo/arc-verify gov08`. It re-reads the balance and
   branches again; it deploys nothing until the precondition is met.
3. The peak figure is `REQUIRED` in `packages/arc-verify/src/slice.ts`, exported so it is
   written once. It is 409.84 USDC: 322 of book capitalisation, 10 of merchant bond, 75 of
   borrower float, 1.60 of mark escrow, 1.00 for the payout probe and 0.24 of gas float.
   Most of it is the book rather than a cost, but on a **throwaway** stack none of it comes
   back — that is what throwaway means.
4. Row 12, the negative control, must report as a counted assertion. Paste the output here.

**Widening the Tier-0 band to make the run fit is forbidden.** UW-02's cap is why a $75
ticket needs $300 behind it (finding 13), and DEC-02 put Tier 0 on pool capital from day one
on the understanding that the cap was real. It is also the same registry the bond worked
example above reads, so a moved band would corrupt that too.

---

# Phase 7 addendum — the corridor's preconditions, measured before they were designed around

Every figure in findings 31-34 is transcribed verbatim from one run of
`pnpm --filter @plazo/arc-verify spike:fx` on 2026-08-02 against `rpc.testnet.arc.io`,
chain 5042002, exit 0. Nothing below is rounded, re-derived or inferred. The spike sends no
transaction, estimates no gas, and takes every read through the same `shed()` wrapper
`slice.ts` exports — finding 11's lesson is that a shed request arrives as HTTP 200 with an
error body, so an unretried `balanceOf` would have reported this corridor unfundable with
no way to tell that from the truth.

**On the numbering.** These four carry the `Finding N` prefix because nine downstream Phase 7
plans cite them as 31, 32, 33 and 34, and that citation is the contract. The Phase 6 addendum
already carries a tooling footnote numbered `### 31.` (abitype's reserved-keyword refusal);
it is untouched and keeps its number. Renumbering it would have been a deletion in a document
whose whole value is that it only ever grows.

### Finding 31 — EURC's EIP-3009 surface is canonical, and its domain separator is derived rather than stored

`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`, read from the deployed bytecode:

| Read | Value |
|---|---|
| `name()` / `symbol()` | `EURC` / `EURC` |
| `decimals()` | **6** |
| `version()` | **`"2"`** |
| `RECEIVE_WITH_AUTHORIZATION_TYPEHASH()` | `0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8` |
| `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` | `0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267` |
| `CANCEL_AUTHORIZATION_TYPEHASH()` | `0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429` |
| `DOMAIN_SEPARATOR()`, read | `0x649ec6b0634bd74f28684781d2c9ae49dff14ba3d5f9bb5d70c1e1f0e1ebf160` |
| Separator, **derived** from (`"EURC"`, `"2"`, `5042002`, the token) | `0x649ec6b0634bd74f28684781d2c9ae49dff14ba3d5f9bb5d70c1e1f0e1ebf160` |
| Match | **yes** |

All three typehashes are byte-identical to the canonical FiatToken values already pinned in
`ERC3009_TYPEHASHES` — the same constants `MockArcUsdc` compiles. The corridor's check rail is
therefore mechanically the same rail as the dollar one, and E-01's EURC-denominated plan needs
no second collection mechanism.

**The separator is compared, never cached, and that is the point of reading it at all.** It
embeds `chainId` and `verifyingContract`; both move on mainnet. A stored value would make every
outstanding EURC strip silently fail to validate the day the config flips — the same failure
CLAUDE.md already forbids for USDC. The match above is simultaneously a check on the name, the
version, the chain id and the verifying contract, because a wrong value in any one of the four
produces a different digest.

**Consequence.** `MockArcEurc` (plan 07-02) must reproduce this surface exactly, and it must do
so by parameterising `MockArcUsdc` rather than copying it — two divergent EIP-3009 mocks is a bug
factory, and the four values above are what they would eventually diverge on. No separator is
stored anywhere in the tree.

### Finding 32 — USYC answers permit and reverts on EIP-3009, and its Teller's oracle is an address nothing may read

`0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C`, read from the deployed bytecode:

| Read | Result |
|---|---|
| `symbol()` / `decimals()` | `USYC` / **6** |
| `RECEIVE_WITH_AUTHORIZATION_TYPEHASH()` | **reverted** — `The contract function "RECEIVE_WITH_AUTHORIZATION_TYPEHASH" reverted.` |
| `authorizationState(address,bytes32)` | **reverted** — `The contract function "authorizationState" reverted.` |
| `DOMAIN_SEPARATOR()` | answered: `0xbf0253d19b0cb8b55febeab2e30ee691028fbd141b32ca84ad55acbdee376e5d` |
| Teller `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` `oracle()` | `0x52b56c7642E71dc54714d879127d97cd0B3D4581` |

E-07 said USYC is permit-only. It is now two live reverts rather than a sentence, which matters
because finding 30 is exactly the case of a deployed contract that answers some selectors and
reverts on others — the only way to know which is to ask it.

**Consequence 1.** A Tier-2 pledge is `approve`/`transferFrom` into `PledgeVault`, never a check
strip (E-07, and DEC-28's `ParkedYieldVenue` is the precedent already in the tree). CLAUDE.md
names attempting check collection in USYC as a thing not to do; there is now a revert behind
that instruction. Plan 07-04 asserts the absence twice — `test_noEip3009PathExists` and a grep
gate — so a future USYC upgrade that *adds* EIP-3009 surfaces as a deliberate decision rather
than as a silent capability change.

**Consequence 2, and it is the sharper one.** `0x52b56c7642E71dc54714d879127d97cd0B3D4581` is
recorded here and **must be read by nothing in `contracts/src`** (C1). The balance sheet is
all-dollar, there is no volatile collateral, and a price feed re-adds an attack surface for
nothing — a pledge is valued at par minus `TIER2_PLEDGE_HAIRCUT_BPS`, which is the whole
valuation. Plan 07-02 turns that from a comment into a build failure via
`tools/check-no-oracle.mjs`, wired into `pnpm boundary`, and the guard is proven to fail on cue
before it is trusted. Writing the address down here is the entire permitted use of it.

### Finding 33 — the two FxEscrow addresses hold different implementations, and neither is the answer

| | CLAUDE.md's address | Arc docs' address |
|---|---|---|
| Address | `0x867650F5eAe8df91445971f14d89fd84F0C9a9f8` | `0xd68256f4D69C6BbEcB873D8588AE0Dc6B8E22E10` |
| Code | 130 bytes | 130 bytes |
| ERC-1967 implementation slot | `0x721eafa9c1e38dd7fff81d30ea1a5500b37cf658` | `0xce8d080d7e26b0deeb6abd34dc7064bd7acd9b4c` |
| `owner()` | `0x1C2C8D0CFe5fC6675ff522EF9442eC5EC1d8De7D` | `0x1C2C8D0CFe5fC6675ff522EF9442eC5EC1d8De7D` |
| `PERMIT2()` | **did not answer** | **did not answer** |
| `implementationsDiffer` | **YES** | |

Two live proxies, one owner, **two different implementations**. E-04 said as much from the
documents; this reads it from the chain.

A second result nobody had asked for: **neither proxy answers `PERMIT2()`**. The claim that both
share a Permit2 is not verifiable through that selector on either address — finding 30's shape
again, a signature that is not where a document says it is. Anything that needs the Permit2
address must obtain it the same way it obtains everything else here: from the response.

**Resolution, and it is not a choice between the two.** The `verifyingContract` a StableFX
settlement signs against arrives in the API response's `typedData.domain` and is read from there
at runtime. Plan 07-08 zod-validates that the field is present and fails loudly naming it when it
is not; `services/fx` constructs no domain and holds no escrow address. **A compiled constant
named `FX_ESCROW` is a defect anywhere in this tree** — the same class of error as hardcoding a
`DOMAIN_SEPARATOR`, and with the same failure mode: silently wrong rather than loudly broken.
CLAUDE.md's address should be read as one candidate, not as the answer; this row is the
correction.

### Finding 34 — the corridor is unfunded by 375 EURC, and no AMM venue with USDC/EURC liquidity exists on Arc testnet

**The EURC funding position.** Read first, reported as a branch, `branch UNFUNDED`, exit 0.

| | |
|---|---|
| Deployer | `0xF4ee61950B63cCA5C82f1146484d018Ac95Bd0F2` |
| `eurcHeld` | **0 EURC** |
| `usdcHeld` | 80.43295 USDC |
| `EURC_SEED_REQUIRED` | **375 EURC** |
| **`shortfall`** | **375 EURC** |

`EURC_SEED_REQUIRED` is 300 of book capitalisation plus the 75 ticket: finding 13's arithmetic
applied to the second currency, because UW-02's compiled band caps Tier-0 paper at 25% of the
pool and a 75 ticket therefore needs 4× that behind it before the headroom reaches it. Widening a
Tier-0 band or the reserve floor to make a live run fit is forbidden (DEC-02) — the requirement is
the control working, exactly as it was for the dollar book.

**This is on top of the USDC gap, not instead of it.** The credit half is still 329.40705 USDC
short of the 409.84 peak requirement recorded above. Phase 7's live EURC criteria and Phase 6's
GOV-08 witness are two separate funding asks against the same faucet.

**The faucet question, answered honestly.** `faucet.circle.com` is an interactive, captcha-gated
web form with no public API, so the spike does not pretend to call it. What it measures instead is
how much EURC any address this repo controls has ever held — the deployer plus the first three
derived collection addresses `faucet.ts` stands up:

| Address | EURC |
|---|---|
| `0xF4ee61950B63cCA5C82f1146484d018Ac95Bd0F2` (deployer) | 0 EURC |
| `0x1b585B3d43Fb9B98B468F6736F7dfc6E2074ee3F` (faucet[0]) | 0 EURC |
| `0xAa42c3F24064e701cC9a16Bf210205a392a58EA4` (faucet[1]) | 0 EURC |
| `0x86705A863AeEb6A70b8D0da3C8C4f4f322C1708a` (faucet[2]) | 0 EURC |
| **Total ever obtained** | **0 EURC** |

**This project has never held any EURC on Arc testnet.** Whether the faucet dispenses EURC at
all, and at what drip, is therefore still unknown — and it is unknowable from code, because the
form is captcha-gated. The addresses are derived from `DEPLOYER_PRIVATE_KEY` and no key file is
written. To close it: request EURC on **Arc Testnet** at `https://faucet.circle.com` for the four
addresses above and re-run `pnpm --filter @plazo/arc-verify spike:fx`, which re-reads and
re-branches and attempts nothing until the precondition is met.

**The AMM answer: there is not one.**

| | |
|---|---|
| Candidates probed | 7 |
| Holding bytecode | **0** |
| Returning a quote for 100 USDC → EURC | **0** |
| `best` | **`null`** |

Every candidate — the canonical Uniswap v2/v3 factory, router, quoter and UniversalRouter
addresses that forks most often reuse, plus Curve's cross-chain Router NG — holds **no bytecode
on Arc testnet**. Each row carries `confidence: "low"` and its source in code, because a
LOW-confidence address from a web search must never be able to enter this repo as a verified
venue. `07-RESEARCH.md`'s three named candidates (Coco DEX, Tower Exchange, the "Curve is on Arc"
claim) could not be probed at all: **none of them publishes an Arc-testnet contract address**, and
inventing one to fill the row would have been the exact defect this spike exists to prevent.

**No venue with USDC/EURC liquidity was found on Arc testnet.** Arc's official contract-address
reference lists no DEX at all, and this probe agrees with it. That is a recorded absence and a
successful spike, not a failure.

**Consequence.** FX-05's deviation guard ships against a **stubbed** venue whose router is a
constructor argument set to `address(0)`, and plan 07-03's `test_ammVenueWithZeroRouterRefuses`
makes that the shipped, tested configuration: the guard refuses rather than fabricating a
plausible rate. An unexercised guard on a stub venue is still the audited artefact FX-05 asks for.
A fabricated liquidity claim would be a wrong price on a real loan.

**The deliberate-failure control, because a probe that finds nothing and a probe that is broken
print the same thing.** Re-running `probeAmmVenues` with two extra rows — a fabricated address
holding nothing, and Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`, which holds code and
is emphatically not a venue — returned `probed 9 · withCode 1 · quoting 0 · best null`. The
fabricated address appeared under `probed` and **not** under `withCode`; Multicall3 appeared under
`withCode` and **not** under `quoting`, with `getAmountsOut refused: The contract function
"getAmountsOut" reverted.` The three fields are genuinely distinct, so "something is deployed
there" can never be reported as "it quotes".

**Manual-Only, and it is an access item rather than a code item.** A live EURC origination on
chain 5042002 is gated on obtaining EURC, and obtaining EURC is a captcha-gated web form. The
Foundry proof of the corridor is complete and green against `MockArcEurc`; only the live witness
defers. It sits in `07-VALIDATION.md`'s Manual-Only table rather than as a green tick, because a
deferred assertion that reads as a delivered one is worse than an absent one.
