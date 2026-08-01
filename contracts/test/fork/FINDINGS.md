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
