# Plazo Protocol

## Product & Technical Specification — v0.2, July 2026

**Changelog v0.1 → v0.2 (post adversarial review):** reconciled pool yield and loss math with a worked table; rebuilt Tier‑0 economics around observed pseudonymous-default data (identity cost, FPD kill-switch, book cap); cryptographic plan-to-check binding via CREATE2 + derived nonces; push `repay()` rail closing the late-fee and dead-zone holes; sanctioned-cancellation rules and ERC‑1271 revalidation sweeps; honest v1 answer on cross-chain repayments (Arc-resident balances); per-product pools with subordination gates and a prefunded Reserve; delinquency-time provisioning and anti-run redemption gates; buyer-protection escrow default for physical goods; Passport privacy hardening; securities structuring for Yield; competitive-landscape and go-to-market sections; Appendix A parameter sheet.

**Status:** Draft for review. **Network:** Arc (public testnet today; Circle targets mainnet for summer 2026 per the May 2026 whitepaper). **License posture:** protocol contracts open-source; operator services proprietary.

---

## 1. Thesis

Installment credit — "pay in 4" at checkout, monthly consumer plans, net-terms between businesses — is a payments vertical measured in hundreds of billions of dollars of annual volume. Every incumbent (Klarna, Affirm, Afterpay, and the trade-credit desks of the B2B world) is four systems stapled together: a settlement rail to pay the merchant, a collections apparatus to pull repayments (card-on-file and ACH, with their failure rates and interchange costs), a warehouse credit line to fund the book, and — for anything cross-border — an FX desk. Each staple is a cost center, a counterparty, and a failure mode.

Plazo rebuilds installment credit as a **clearing network on Arc**, where each of the four systems is a property of the settlement layer itself. Merchant settlement is a sub-second-final USDC transfer (Malachite BFT consensus; deterministic finality, no reorgs — stronger finality than card rails, which settle T+1/T+2 with chargeback tails). Collections run on **EIP-3009 dated authorizations native to the USDC contract** — the borrower signs the full repayment schedule once, as unforgeable post-dated checks. The funding book is an open ERC-4626 capital market whose lenders can enter from a dozen chains in under 500ms via Circle Gateway. And cross-currency installments clear through StableFX and Circle's partner-stablecoin program (EURC, JPYC, MXNB, BRLA, PHPC, KRW1, AUDF, QCAD) — real issuer-backed local currencies, not synthetics.

The one-line position: **Plazo is the installment-credit clearinghouse for the stablecoin economy.** Arc holds the book; every chain is a storefront.

Design principles that follow from the thesis, and govern every decision below: **non-custodial by construction** (borrower funds stay in borrower wallets until each due date — the protocol never takes deposits); **all-dollar balance sheet** (no volatile collateral anywhere in the system, so there is no liquidation engine and no price-oracle dependency — the only market risks are credit and FX, both priced explicitly); **the chain is the audit trail** (every underwriting input, every cleared or bounced payment, every tranche loss is a public, block-timestamped event); and **regulated activities live in a licensed operator layer, not in the contracts** (§9).

---

## 2. Product suite

Plazo ships as one network with six named surfaces.

**Plazo Pay‑in‑4.** The anchor product: 25% at checkout, three biweekly installments, 0% cost to the borrower who pays on time. Merchant pays a discount rate (MDR). Tenor 42 days, weighted average life ~4 weeks.

**Plazo Flex.** 3/6/12-month interest-bearing consumer plans for larger tickets, priced by Passport tier (§6), originated through licensed lending partners (§9). The repayment schedule is still a signed check strip — 12 dated authorizations signed in one ceremony.

**Plazo Terms.** B2B net‑30/60/90 trade credit: a business buyer checks out on terms, the supplier is paid in full immediately, and the receivable enters the same capital stack. This is the largest expansion relative to consumer BNPL — trade credit dwarfs consumer installment volume, the buyers are exactly the KYB'd institutional population Arc is built for, and the underwriting input (onchain operating cashflow) is richer for businesses than consumers. Includes an invoice-factoring mode: a supplier holding an approved receivable can discount it to the pool instantly.

**Plazo Yield.** The lender side: senior shares (fixed-target yield, first claim, short-duration dollar paper) and junior shares (residual yield, first loss) of the credit pools, plus a protocol-fee-funded first-loss reserve beneath both. Deposits and withdrawals from any Gateway-supported chain.

**Plazo Passport.** A non-transferable, per-wallet credit record: plans opened, checks cleared and bounced, limits earned, with a published attestation schema so any Arc application can read (or contribute to) it. Long-term, Passport is a public good the network gives the ecosystem — portable, deterministic, user-inspectable credit history.

**Plazo Connect.** The distribution layer: hosted checkout, drop-in web SDK, e-commerce platform plugins, a PSP white-label API, and an x402 endpoint so agentic buyers (AI agents paying via the HTTP-402 standard, now stewarded by the Linux Foundation's x402 Foundation with Visa and Mastercard as members) can be offered and accept terms programmatically within their wallet policy limits.

---

## 3. Core mechanism: authorization-backed installment schedules

### 3.1 The primitive

USDC natively implements EIP‑3009, which allows a holder to sign an offchain authorization over `(from, to, value, validAfter, validBefore, nonce)` that can be submitted onchain by a third party once — and only within — its validity window. Circle's own Nanopayments product is built on this primitive; Plazo uses it as a **collection rail**.

At checkout the borrower signs the full schedule in one signing ceremony: for Pay‑in‑4, four authorizations — 25% valid immediately, three more that each become valid at `dueDate_i` and expire at `dueDate_i + gracePeriod + retryBuffer`. These are post-dated checks with cryptographic guarantees: unforgeable, single-use (unique nonces), self-expiring, and submittable by anyone.

Properties this rail has that no card-on-file or ACH pull has: funds remain in the borrower's wallet until each due date (no custody, no float, no prefunding); a clearing attempt either succeeds or fails on insufficient balance in a single block — the failure *is* the delinquency signal, with zero ambiguity and zero retry-webhook infrastructure; collection cost is one Arc transaction (~$0.013, denominated in dollars, predictable) versus ~2%+ interchange on a card pull; and the mechanism is a property of USDC itself, so it works identically from a Circle passkey wallet, a MetaMask EOA, or a smart account (USDC's ERC‑1271 support lets contract wallets be the signer).

### 3.2 Submission pattern

Checks are collected with `receiveWithAuthorization` (not `transferWithAuthorization`): the InstallmentPlan contract is the payee and executes the pull against the borrower's signed message when a keeper calls `collect(planId, i)`. Because `receiveWithAuthorization` requires the caller to be the payee, third parties cannot front-run or grief-submit authorizations; the keeper merely pokes the plan contract, which does the pull, applies waterfall logic (late fees, FX conversion, early-repayment rebates), and forwards proceeds to the pool.

### 3.3 The keeper market

Collection must not depend on one operator's cron job. `collect()` is **permissionless** and pays the caller a fixed USDC bounty (e.g., $0.05) from the plan's ops budget the first time each installment clears. Anyone — the operator's relayer, independent keepers, the merchant, the borrower themselves — can crank a due check. The operator runs a relayer for reliability (driven by Circle Contracts event webhooks); the keeper market makes the operator non-essential. Decentralized collections is a sentence no incumbent can say. Two economics notes: because wallet balances are public state, rational keepers submit only when success is visible — cures collect within seconds of funds arriving, failed-attempt spam is self-limiting (a failed attempt costs the keeper gas and pays nothing), and no separate retry incentive is needed. And bounty-plus-gas per plan sets a minimum viable ticket size (Appendix A) below which the ops budget goes negative.

### 3.4 Failure, cure, and cancellation

If a check bounces (insufficient balance), the plan enters `Grace`: keepers collect the moment funds appear (balances are public), and the borrower can cure from the app — via self-collection or the `repay()` rail (their own cure transaction earns them the keeper bounty back — a small dignity-preserving touch). Uncured past `grace`, the plan is `Delinquent`: a flat late fee accrues to the payoff amount (collected through `repay`, since fixed-value checks cannot carry fees), Passport records the event, and new originations for that borrower freeze. If the check strip expires uncured, the push rail keeps cure open all the way to the charge-off point (§7.3), at which the plan is `Defaulted` and the loss flows down the tranche waterfall.

EIP‑3009 also permits the signer to `cancelAuthorization` on unclear checks. Context determines meaning. **Sanctioned cancellations** — after `Repaid` (prepayment), after `Refunded`, or after plan-initiated cancellation — are expected hygiene and carry no penalty. Cancelling while a plan is `Active` with obligations outstanding is an anticipatory default: onchain, attributable, *louder* than a bounce — immediate Passport impairment and limit freeze. The real mitigation for walk-away risk is structural, not punitive: unsecured limits start small and grow only through repayment history (§5.1, §6), and the two large-limit paths (salary‑linked and secured) make cancellation either self-defeating or fully collateralized.

Smart accounts add a quieter failure mode: an ERC‑1271 signer can rotate keys or validation modules, silently invalidating an outstanding strip with no cancellation event. Plazo therefore **revalidates outstanding strips** — a nightly sweep plus event-driven checks on wallet recovery/module-change webhooks — and a strip that fails revalidation while `Active` is treated exactly like a bounce (grace → cure via `repay` → default), so silent rotation gains nothing a bounce wouldn't. Account classes with mutable signature validation carry lower unsecured caps (Appendix A). Threat analysis in §10.

### 3.5 Schedule variants

Biweekly (Pay‑in‑4) and monthly (Flex) strips are the defaults. Two opt-in variants: **streaming repayment** via Nanopayments — daily micro-debits against an EIP‑3009 stream for borrowers who prefer $3.57/day to $50 biweekly (gas-free at the micro level, batch-settled via Gateway); and **salary-source deduction** (§5.2), where the installment is split from an inbound payroll flow before it ever reaches spendable balance.

### 3.6 Plan binding

Checks must be unusable outside the exact plan the borrower saw. The InstallmentPlan clone address is precomputed with CREATE2 using `salt = planId`, where `planId = keccak256(borrower, merchant, principal, schedule, feeTerms, currencyLegs)` — so the plan's address *is* a commitment to its terms. Every authorization in the strip (including check #1) names that address as payee, and each nonce is derived as `nonce_i = keccak256(planId ‖ i)`. The wallet UI renders the terms behind the hash at signing. Replay analysis: a check cannot credit any other plan (payee- and nonce-bound), cannot clear twice (EIP‑3009 nonce), cannot clear early (`validAfter`), and dies on its own past `validBefore`. Nothing about the strip is trust-me: the signed bytes commit to the disclosed deal.

### 3.7 Early repayment and the push rail

`repay(planId, amount)` is a permissionless push-payment function — the borrower (or anyone on their behalf) can settle remaining principal at any time. Prepayment marks the plan `Repaid`; outstanding checks become moot because the plan refuses further collection, and the borrower may `cancelAuthorization` them for hygiene without penalty (§3.4). The repay rail is load-bearing beyond prepayment: it is how **late fees** are collected (fixed-value checks cannot carry a variable fee — the fee accrues to the payoff amount and settles through `repay`), and how a borrower **cures after a check strip has expired** — there is no dead zone between `validBefore` and charge-off, because the push rail stays open until the day the loss is recognized.

---

## 4. Architecture

### 4.1 Topology: one book, many storefronts

The credit book, capital pools, Passport, and all settlement live on Arc. Buyers and merchants live anywhere: a checkout on Base, Solana, or Ethereum funds through **Gateway** (unified USDC balance, sub-500ms crosschain mint) or **CCTP v2 Fast Transfer** (seconds, with Hooks for delivery-with-action), and merchant payouts route back out the same way. One honest constraint, stated plainly: EIP‑3009 checks debit the borrower's **Arc-resident USDC balance** — a Gateway unified balance sitting on Base is not collectible by a check on Arc. So in v1, repayment balances live on Arc: funding *into* Arc is one tap (or one scheduled action) from any chain via Gateway/CCTP, the app prompts and can automate top-ups ahead of due dates, and salary-linked borrowers are natively funded because payroll lands on Arc. Delegated cross-chain top-ups (standing, dated authorizations against a Gateway balance) are a roadmap item contingent on Gateway's signed-intent API supporting them. Outbound is unconstrained today: the merchant on Solana receives native USDC there via a CCTP v2 Hook. Arc's role is the clearinghouse — the place where finality, FX, and the capital market live.

### 4.2 Contract set

| Contract | Responsibility |
|---|---|
| **CheckoutRouter** | Entry point. Validates credit decision + schedule signatures, executes check #1, triggers instant merchant settlement, clones an InstallmentPlan, mints the Receivable |
| **InstallmentPlan** (minimal-proxy clones, CREATE2 at `planId`) | Per-loan state machine; holds schedule metadata (never funds); `collect()` + permissionless `repay()` (prepayment, late fees, post-expiry cure); strip revalidation hooks; late-fee/rebate/FX waterfall; refund logic |
| **CreditPool** (ERC‑4626 ×2 + Reserve; one pool per product line) | Pay‑in‑4, Flex, and Terms each get their own pool — no tenor commingling. Senior/junior tranches; epoch accounting; delinquency-time provisioning; redemption queue with anti-run gates; prefunded first-loss Reserve; subordination-ratio origination gate |
| **ReceivableToken** (ERC‑721) | One per loan: face, schedule, tier, corridor, status. The unit of trading, factoring, and recovery auctions |
| **FXRouter** | Adapter over StableFX taker API (RFQ, PvP settlement) with venue-agnostic interface and AMM fallback; corridor allowlist + haircuts |
| **Passport** (soulbound + attestations) | Deterministic credit record; published read/write attestation schema; slashing on bounce/cancel |
| **KeeperMarket** | Bounty escrow + accounting for permissionless `collect()` cranks |
| **RefundEscrow** (default for physical goods) | Conditional settlement: merchant payout held until shipment/delivery attestation or a short escrow window elapses; instant-settle mode reserved for digital and low-risk categories; operator-arbitrated disputes against an onchain evidence log |
| **FactoringMarket** | Terms receivable discounting: instant bid from pool, open-auction fallback |

Loan state machine: `Created → Active → Grace → Delinquent → Defaulted | Repaid | Refunded | Cancelled`, with transitions emitted as events consumed by Circle Contracts webhooks (dashboards, keeper triggers, LP reporting).

### 4.3 Managed-service layer

Circle Wallets: user-controlled passkey wallets for consumers (email/social recovery, no seed phrases), developer-controlled wallets for merchant treasury and operator relayer. Gas Station/Paymaster: borrower- and merchant-side interactions sponsored; on Arc, gas is USDC anyway, so "gas UX" reduces to an invisible line item. Circle Contracts: deployment, event monitoring, webhook automation. Compliance Engine: wallet screening at onboarding and transaction screening at checkout. Circle Mint: fiat on/off-ramp for institutional LPs and large merchants. StableFX: institutional RFQ + PvP settlement for every cross-currency leg (access is permissioned; the FXRouter abstraction keeps the protocol venue-agnostic).

### 4.4 Sequence: standard checkout

1. Merchant site calls Connect → CheckoutRouter quote: price, schedule, MDR, borrower's available limit (Passport read).
2. Borrower approves in-wallet: one passkey ceremony signs 4 (or 12) authorizations whose payee is the CREATE2-precomputed plan address and whose nonces derive from `planId` (§3.6) — the signatures *are* the acceptance of the disclosed terms.
3. CheckoutRouter: Compliance screen → `receiveWithAuthorization` on check #1 → CreditPool fronts remainder → merchant wallet credited in full minus MDR, **final in <1s** → InstallmentPlan cloned, Receivable minted to pool.
4. Due dates: keepers crank `collect()`; waterfall applies; Passport updates; tranche NAV ticks.
5. Terminal: `Repaid` (Passport limit grows) or the failure path of §3.4.

---

## 5. Underwriting

Plazo does not import credit bureaus; it prices what the chain can verify, and reserves bureau-style data for the licensed-operator layer where regulation requires it.

**5.1 Progressive unsecured limits (Tier 0) — deliberately small, deliberately gated.** The honest starting point: the only public data on pseudonymous, unsecured stablecoin consumer lending (Divine Research's 30k+ microloan book) shows **~40% first-loan default rates** — an order of magnitude above the 2–4% charge-offs of identity-verified installment books. A naive "everyone gets $50" tier is therefore LTV-negative per marginal borrower and, worse, farmable: repaying a few small plans to compound a limit and busting out costs an attacker only MDR and gas. Tier 0 is designed against that reality. Entry requires a sybil cost: a verified-identity attestation (via the operator's Compliance-Engine-based flow — free, and it aggregates limits per *person*, not per wallet) or, for pseudonymous mode, a small non-refundable activation fee. One active plan at a time until the first completes. Limits start at $50 and grow ×1.25 per clean plan, hard-capped at $500 pseudonymous / $1,000 identity-linked — the compounding curve is slow enough that farming yields less than it costs. Tier‑0 paper is capped at ≤10% of any pool's book, and a **first-payment-default kill-switch** auto-throttles originations if any weekly cohort's FPD rate breaches threshold (Appendix A). Framing for LPs and for ourselves: Tier 0 is a bounded customer-acquisition channel expected to run near break-even; the profit engine is Tiers 1–3, and the product pushes borrowers up-tier (salary-link pricing, secured mode). The borrower can still inspect exactly why their limit is what it is — a property no incumbent offers.

**5.2 Cashflow-verified limits (Tier 1).** Where income arrives onchain — payroll paid in USDC via CCTP v2 Hooks, recurring x402 revenue for agents and creators, verifiable merchant settlement for businesses — the underwriter reads inflow history directly and sets limits as a fraction of verified monthly income. Borrowers who opt into **salary-source deduction** (the installment splits off inside the inbound payroll hook, before funds hit spendable balance) get materially better pricing (§8), because repayment stops depending on balance management. This fuses earned-wage-access mechanics with installment credit, and is only possible where payroll, checkout, and credit share one settlement layer.

**5.3 Secured limits (Tier 2).** A borrower pledges a whitelisted yield-bearing dollar asset — USYC where eligible, senior Plazo Yield shares, or other approved Arc savings tokens — and receives an instant limit against it at the lowest pricing tier. The pledge **keeps earning its native yield while locked**; both collateral and debt are dollars, so there is no liquidation-price risk, only a small haircut for depeg tails. For a saver yielding ~4–5%, an interest-free plan against pledged savings strictly dominates paying cash: they keep the yield and the float. "Borrow against your savings without losing the yield, with zero liquidation risk" is a sentence neither BNPL incumbents nor DeFi money markets can currently say.

**5.4 Partner-underwritten limits (Tier 3).** For Flex and Terms, licensed lending partners may blend offchain data (bureau, open banking, business financials) under their own regulatory permissions. The protocol records only the resulting limit and tier — PII never touches the chain (§9.3).

**5.5 Fraud model.** The three vectors that actually kill BNPL books, and their Plazo answers: *merchant collusion* (fake merchant, cash out the fronted 75%) → merchants stake a refundable USDC bond, MDR proceeds vest with a short delay for new merchants, per-merchant velocity caps, Compliance Engine screening; *stolen wallets* → passkey possession-based signing, checkout velocity limits, high-value plans require step-up confirmation; *sybil farming* → Tier 0 economics above, plus device/attestation heuristics at the operator layer; and *bust-out farming* — the compound attack where a wallet (or a colluding merchant-borrower pair) repays small plans to grow a limit, then extracts through real merchants and abandons the wallet → priced out structurally by Tier 0's design: the activation cost per wallet, ×1.25 growth to a $500 pseudonymous ceiling, single-plan concurrency, and per-person aggregation make the farm's expected extraction roughly equal to its cost before fraud-ops overhead, while the FPD kill-switch bounds cohort damage if a farm slips through. Portfolio-level: per-merchant, per-corridor, and per-tier concentration caps enforced in CreditPool parameters.

---

## 6. Plazo Passport

Passport is a soulbound record per wallet: plans opened/completed, checks cleared/bounced/cancelled, current and historical limits, and tier — written only by protocol contracts. Privacy is engineered, not hoped for: Passport stores **banded aggregates only** (counts, amount bands, tier — never merchant identities, never exact purchase amounts), so a wallet's credit record does not double as a purchase diary; **negative marks age out after 24 months** (bureau-style aging — a permanent scarlet letter would be both unjust and a regulatory liability); and while the coarse tier is publicly readable, any richer read by a third party requires a **borrower consent signature** — a deliberate line that keeps Plazo outside consumer-reporting-agency posture (an FCRA analysis is a launch gate; if counsel concludes consent-gated reads still constitute consumer reporting in the US, third-party reads ship dark there). The write side uses a versioned attestation schema so third-party Arc applications can both consume it (a lending market pricing a Passport holder's rate) and, with governance approval, contribute compatible attestations (a rent-payment app attesting on-time payments). Two design commitments: **determinism** (identical histories produce identical scores — no black-box model in the base layer) and **user legibility** (the app renders exactly which events produced the current limit). When Arc's confidential-transfer capability ships, Passport gains selective disclosure: amounts shield, and the borrower (or a regulator with view-key access) chooses what to reveal. Passport is deliberately unmonetized protocol infrastructure — the moat is that every repaid Plazo plan makes the network's underwriting asset richer.

---

## 7. Capital markets

### 7.1 Tranche structure

Each **product line runs its own pool** — Pay‑in‑4, Flex, and Terms are separate books, because 42-day paper and 12-month consumer loans cannot honestly share one redemption-liquidity story. Each CreditPool issues senior shares (fixed target yield, set per weekly epoch by the operator within a published band; first claim on all collections) and junior shares (residual MDR + late fees after senior coupon; absorb losses first, above the Reserve). Beneath both sits the **Reserve**: a first-loss buffer **prefunded by the operator to its 2% target at launch** (a solvency claim that assumes a reserve must not launch without one) and replenished from the 0.5%-of-GMV protocol-fee accrual thereafter. Origination is gated on capital structure: new loans pause automatically if junior falls below its subordination floor or the Reserve below its floor (Appendix A) — undersubscribed tranches throttle growth rather than thin the protection. Loss waterfall: Reserve → junior → senior. The senior instrument is deliberately boring: short-duration (42-day max tenor, ~4-week WAL for Pay‑in‑4 books), all-dollar, first-claim consumer/trade paper with real-time, per-receivable performance transparency — every underlying check clearing or bouncing is a public event. TradFi securitization reports quarterly; Plazo reports per block.

### 7.2 Liquidity and NAV

Weekly epochs. Deposits enter at next-epoch NAV (via Gateway from any supported chain; via Circle Mint for fiat institutions). Redemptions queue against a liquidity buffer (target 10% of pool) plus natural runoff — short WAL means the book self-liquidates fast, the structural advantage of financing 6-week paper with open-ended vaults. NAV provisioning is designed against its own transparency: because every bounce is public at `grace+1`, marking losses only at charge-off would hand informed LPs a 50-day head start to redeem ahead of the markdown — real-time information plus lagged marks is a run design. So NAV takes a **50% expected-loss provision the moment a plan turns Delinquent**, 100% at charge-off, released on cure — the mark moves in the same epoch the information becomes public. Redemptions execute at post-provision NAV; if the queue exceeds the liquidity buffer, fills go pro-rata with an early-exit fee that accrues to remaining LPs. The idle buffer parks in USYC where eligible, so liquidity drag earns the T-bill rate instead of zero.

### 7.3 Impairment and recovery

Delinquent at `grace+1`; charged off at 60 days past due (loss hits waterfall immediately — no extend-and-pretend). Charged-off ReceivableTokens transfer to a **recovery auction**: licensed collection specialists bid USDC for the paper (with jurisdiction-appropriate servicing obligations attached at the operator layer); recoveries above the winning bid rebate to the waterfall in reverse. Even collections becomes a transparent market with an auditable price for distressed consumer paper.

### 7.4 Composability of the senior share

The senior share is designed to be *the* collateral-grade dollar-yield asset other Arc protocols want: whitelisted as Tier‑2 collateral inside Plazo itself (reflexive but haircut-bounded), pledgeable in Arc money markets, and — as Arc's fixed-income infrastructure matures — strippable into principal/yield legs on term-structure venues. Terms receivables (30/60/90-day corporate paper) extend the curve: Plazo ends up originating the short end of an onchain dollar credit curve as a byproduct of checkout.

---

## 8. FX layer

Every cross-currency leg clears through the FXRouter: StableFX RFQ (competing institutional makers, PvP smart-contract settlement — both legs or neither) with an AMM fallback for resilience and small size.

**Spot plans:** installments denominated in the borrower's currency (KRW1 wage-earner, MXNB remittance recipient) convert at collection time; the merchant's settlement currency is independent (a Brazilian merchant settles BRLA regardless of what buyers pay in). **Locked-rate plans:** at checkout, the FXRouter prices the full dated strip in one RFQ; the borrower sees "₩132,000 — four payments of ₩33,000, rate locked"; the pool warehouses the resulting FX exposure and hedges its *net* book (not per-loan) daily through StableFX, within per-corridor exposure limits. A consumer FX forward strip — an instrument that requires an ISDA in TradFi — becomes a checkout checkbox. Corridor rollout follows Circle's partner-stablecoin program liquidity: EURC first, then MXNB, BRLA, PHPC, KRW1. Each corridor carries its own haircut, exposure cap, and circuit breaker (pause on depeg or venue outage; unclear checks simply wait — `validBefore` buffers absorb pauses up to the retry window).

---

## 9. Legal & compliance architecture

**9.1 Layered structure.** The protocol layer (contracts above) is non-custodial software: it never holds borrower deposits, never originates in its own name, and is open-source. Regulated activities live with **licensed operators**: consumer originations for Flex run through partner lenders under their state/national licenses (the partnership structure standard across the industry); Pay‑in‑4 operates under the lighter-touch regimes that currently govern no-interest 4-installment products (the CFPB withdrew its 2024 BNPL interpretive rule in May 2025 and has said it will not reissue it, leaving US federal treatment light-touch but a growing state licensing patchwork in its place), while the EU's CCD2 brings BNPL into scope with application phasing in from late 2026 — jurisdiction-by-jurisdiction counsel review is a launch gate, not an afterthought. Collections and recovery run only through licensed servicers (§7.3).

**9.2 Financial-crimes controls.** Circle Compliance Engine screens wallet creation and checkout; merchant KYB at Connect onboarding; Terms counterparties KYB'd by definition. Limits keep pseudonymous Tier‑0 exposure trivial ($50–a few hundred dollars); verified tiers gate everything material.

**9.3 Data.** PII lives exclusively at the operator layer; the chain stores wallet-keyed events and commitments. Passport is pseudonymous, banded, and aging by design (§6). Arc confidential transfers, when live, shield amounts with view-key disclosure for auditors and regulators — the correct end-state for consumer credit data on a public ledger.

**9.4 Securities treatment of Plazo Yield.** Working assumption, not an afterthought: senior and junior shares — pooled capital, profits from the efforts of others, an operator-set target yield — are almost certainly **securities in the US** under Howey/Reves, and the GENIUS Act's carve-out covers payment stablecoins themselves, not yield products built on them. Launch structure: share tokens are transfer-restricted; Yield deposits are gated by Compliance-Engine allowlists; the US path is Reg D 506(c) (verified accredited investors, general solicitation permitted) alongside Reg S for offshore, until a broader registered or exempt path exists. Marketing discipline is part of the legal architecture: Plazo Yield is exposure to consumer and trade receivables — it is never described as "yield on USDC," both because that's inaccurate and because the OCC has proposed extending the GENIUS Act's issuer yield ban to affiliates and third parties. The credit products can launch before Yield opens to the public; sequencing is a compliance tool.

---

## 10. Security & threat model

Audit program: two independent firms plus formal verification of InstallmentPlan waterfall math and CreditPool share accounting before mainnet; ongoing bug bounty; UUPS upgradeability behind a timelock with tranche-holder veto; per-corridor and global pause switches (pauses never strand borrower funds — there are none to strand).

Principal threats and dispositions: **walk-away cancellation** (`cancelAuthorization` on future checks) → economically a default, instantly attributable, Passport-slashed (with sanctioned no-slash contexts for repaid/refunded plans per §3.4); bounded by small unsecured limits, eliminated in salary-linked and secured tiers. **Silent signer mutation** (smart-account key/module rotation invalidating a strip with no cancel event) → nightly strip revalidation + wallet recovery-event webhooks; failed revalidation while Active is bounce-equivalent, and mutable-validation account classes carry lower unsecured caps. **Bust-out/limit farming** → Tier‑0 activation cost, slow growth curve, ceilings, concurrency-1, per-person aggregation, FPD kill-switch (§5.1, §5.5). **Informed-redemption runs** (LPs exiting ahead of visible delinquencies) → delinquency-time provisioning, post-provision NAV redemptions, queue gates with early-exit fees (§7.2). **Empty-wallet defaults** → the base credit risk; priced via MDR, absorbed via §7 waterfall; structurally reduced by salary-source deduction. **Keeper censorship/failure** → permissionless bounty market plus operator relayer redundancy; worst case, borrower or merchant self-collects. **Merchant collusion fraud** → §5.5 (bonds, vesting MDR, velocity caps, screening). **FX venue outage** → AMM fallback, retry buffers, corridor pause. **Partner-stablecoin depeg** → haircuts, exposure caps, corridor circuit breakers; USDC itself is the book's unit of account. **Smart-contract risk** → audits/FV above; minimal external dependencies by design (no price oracles, no liquidation bots, no governance token). **Sequencer/validator trust** → Arc is currently a permissioned-validator PoA network (a PoS transition via the ARC token is whitepapered but unlaunched); Plazo accepts Circle-aligned validator trust at this stage and documents it plainly — appropriate honesty for a credit system settling on a young chain.

---

## 11. Economics

| Product | Borrower pays | Merchant/counterparty pays | Notes |
|---|---|---|---|
| Pay‑in‑4 (standard) | 0% on time; flat USDC late fee after grace | 4.0% MDR | |
| Pay‑in‑4 (salary-linked) | 0% | 2.5% MDR | Lower loss assumption, passed to merchant |
| Pay‑in‑4 (secured) | 0% | 1.0% MDR | Near-zero loss; collateral keeps earning |
| Flex 3/6/12mo | APR by tier (partner-priced) | 0–2% MDR | Protocol: 1% origination + 0.5%/yr servicing |
| Terms (net‑30/60/90) | 0% inside terms | 0.5–1.5% per 30d (buyer or supplier side, market-set) | Factoring: discount rate set by instant pool bid |
| FX legs | — | 5–10bps over RFQ mid | Shared operator/protocol |

Flow of the 4.0% standard MDR: ~3.0% to the CreditPool as gross yield; 0.5% protocol fee (of which the Reserve accrues until target); 0.5% ops (keeper bounties at ~$0.05/collection, gas at ~$0.013/tx — collection COGS is basis points, not percent — remainder to the operator). Worked pool arithmetic (per $100 of Pay‑in‑4 GMV, corrected in v0.2 after review): the pool fronts $75, recovered in thirds at days 14/28/42, so **average outstanding ≈ $50** across the 42-day window; revenue to the pool is $3 ⇒ **~6% per cycle on average deployed capital**, a theoretical ~50% annualized ceiling at perfect recycling — realistically compressed hard by the liquidity buffer, sub-100% utilization, and losses. Senior shares accrue their banded APR (Appendix A); junior takes the levered residual and the levered losses.

Loss math, quoted against the *worst-severity* denominator (first-installment default, ~zero recovery on pseudonymous paper, loss = the full $75 front): each 1% of a cohort defaulting costs ~$0.75 per $100 GMV, so whole-pool net-interest break-even sits at **~4% cohort first-payment defaults**. With the Reserve at its prefunded 2% target and junior at 20% of capital, senior impairment begins around **high-teens percent cohort FPD** (roughly 13% if the Reserve were empty — which is why it is not allowed to be). For calibration: identity-verified installment books run 2–4% charge-offs; pseudonymous stablecoin microcredit has printed ~40% first-loan defaults (Divine Research) — the entire Tier‑0 design in §5.1 (identity cost, ×1.25 growth, 10% book cap, FPD kill-switch) exists to keep the book's blended cohort defaults on the left side of these break-evens. A stress-test appendix with vintage curves is a v0.3 deliverable once testnet cohort data exists. **No protocol token exists or is planned**; the network is fee-financed, and any future decentralization of parameter governance would hand control to tranche holders and merchants — the parties with skin in the book — not to a speculative asset.

---

## 12. Roadmap

| Phase | Window | Gate | Scope |
|---|---|---|---|
| **0 — Testnet** | Now → Arc mainnet | Audits passed; StableFX + USYC access granted; 2 design-partner merchants live on testnet | Full Pay‑in‑4 loop, single pool, Passport v0, Connect SDK alpha |
| **1 — Mainnet pilot** | Arc mainnet launch (Circle target: summer 2026) + 1 quarter | Loss rates within model on ≥$1M GMV | Pay‑in‑4 in USDC + EURC corridor; dedicated Pay‑in‑4 pool with prefunded Reserve and subordination gates; keeper market live; Tier‑0 caps + FPD kill-switch active |
| **2 — Credit expansion** | +2 quarters | Partner lender signed; corridor liquidity verified | Flex via licensed partner; salary-linked + secured tiers GA; MXNB/BRLA/PHPC corridors; Terms beta with KYB'd pairs |
| **3 — Capital markets** | +2 quarters | Reserve at target; recovery servicers contracted | Factoring market; recovery auctions; senior-share composability listings; locked-rate FX plans GA; publish the **Installment Authorization Strip** pattern as an ERC draft — owning the standard is worth more than owning the app |
| **4 — Network** | 2027+ | — | Passport open attestation standard; x402 agentic checkout GA — collateralized/policy-bonded agent plans only, until agent identity (ERC‑8004) plus staked reputation make unsecured agent terms honestly underwritable; confidential amounts when Arc privacy ships; parameter governance to stakeholders |

KPIs per phase: GMV, approval rate, first-payment default rate, 60+ DPD, net charge-offs, realized senior/junior APY, redemption-queue depth, merchant repeat share, borrower repeat rate, corridor FX slippage vs RFQ mid.

---

## 13. Competitive landscape (as of July 2026)

No live or announced project, to our knowledge, combines checkout-grade BNPL, an open onchain credit pool, and a stablecoin-native L1 — but every component has a serious owner, and the window is measured in quarters, not years.

**Closest by product: Yumi Finance** (Solana → Monad) — stablecoin pay-in-4 SDK, unsecured credit lines, B2B trade credit, onchain credit profiles; embedded credit-as-a-service with centralized underwriting and balance-sheet risk, still pre-scale. **Closest by architecture: 3Jane** (Ethereum; Paradigm-led seed; live June 2026) — tranched USD3/sUSD3 USDC pool funding unsecured credit lines with hybrid on/offchain underwriting, score-slashing, and NPL auctions to licensed collectors; no merchant checkout layer. **The incumbent vector: Klarna** — KlarnaUSD (issued via Stripe Bridge) on the Tempo L1, rolling into a 114M-customer app; settlement is going onchain, but credit funding remains on Klarna's balance sheet — if that ever opens, it's the category's gravity well, and it will happen on Tempo, not Arc. **Adjacent muscle:** Huma Finance ($11B+ cumulative volume in cashflow-backed stablecoin credit — the proof that income-underwritten stablecoin lending scales), Divine Research (the pseudonymous-default dataset §5.1 is calibrated against), Maple (institutional credit, already an Arc launch partner — a natural Terms funding ally rather than a rival), Credix/Centrifuge (receivables funding, LATAM overlap with Terms), Slope (offchain B2B net-terms, partially funded by 3Jane's conduit), Cred Protocol (onchain credit scores — ingredient or competitor for Passport), and Pact Labs (Tether-backed stablecoin payroll + credit — the nearest rival to salary-linked repayment).

What is structurally ours: the post-dated-check collection rail (nobody surveyed uses dated EIP‑3009 strips as an installment mechanic — x402 uses the same primitive for instant payments only), non-custodial permissionless collections, locked-rate cross-currency installments (requires StableFX + real local-currency stables — not portable to Solana, Ethereum, or Tempo), and Arc itself: zero announced BNPL competition on the chain whose institutions are the target LP base. What is not ours: time.

---

## 14. Go-to-market

**Merchant wedge first, and not US general retail.** Two beachheads where 4% MDR buys something cards can't: **cross-border corridor commerce** — LATAM/SEA merchants selling to stablecoin-holding diaspora buyers (MXNB, BRLA, PHPC corridors), where the alternative is 3–6% FX+processing and settlement measured in days; and **crypto-native storefronts** — x402-enabled services and onchain commerce whose customers already hold USDC and whom card BNPL declines by default. US general e-commerce waits for the licensing stack (§9), not the tech.

**Distribution over sales.** Plazo Connect targets PSPs and platform plugins (white-label) rather than merchant-by-merchant sales — BNPL history says checkout share is won at the platform layer. The x402 endpoint is a zero-CAC channel for agentic commerce as that volume arrives.

**Why a merchant says yes** (the pitch, quantified in pilot decks): approval of customers card rails decline or can't see; zero chargeback fraud exposure (disputes run through escrow policy, not networks); T+0 final settlement vs T+2; corridor FX built in; pilot MDR of 3% to buy the first cohort, standard 4% thereafter.

**Capital side.** Reserve prefunded by the operator; cornerstone junior LPs recruited from credit funds already active onchain (Maple/Credix-adjacent allocators); senior opens under Reg D/S gating (§9.4) — the early LP base is institutional by legal necessity, which conveniently matches Arc's population. **Borrower side:** acquisition rides merchant checkout (BNPL's proven loop); salary-linked adoption rides stablecoin-payroll partnerships (Deel-style providers, x402-earning agents' operators), which simultaneously feeds Tier‑1 underwriting.

---

## 15. Open questions (tracked for v0.3)

Jurisdiction sequencing for Pay‑in‑4's regulatory perimeter (US state patchwork vs EU CCD2 timing vs LATAM corridors first); partner-lender selection criteria and term sheet for Flex; hedge mandate specifics for the locked-rate FX book (daily net hedge vs per-corridor bands); USYC eligibility geography for the secured tier and the fallback collateral whitelist; recovery-servicer economics and whether auctions clear at acceptable prices for sub-$100 consumer paper; Reserve target ratio calibration once real loss data exists; and the decision point for opening InstallmentPlan issuance to third-party originators (Plazo as pure infrastructure) versus staying vertically integrated through Phase 3. Added in v0.2: feasibility of delegated cross-chain due-date top-ups via Gateway signed intents (removes the Arc-resident balance requirement); Tier‑0 entry split-test — identity attestation vs activation fee — and what each does to conversion and FPD; senior APR band governance once the operator sets rates against real subscription data; and the FCRA counsel outcome on consent-gated Passport reads (ship-dark-in-US contingency per §6).

---

## Appendix A — v1 parameter sheet

Every number below is a launch hypothesis inside a governance band `[range]`; all are recalibrated against testnet cohort data before mainnet.

| Parameter | v1 value | Band |
|---|---|---|
| Grace period | 10 days | [7–15] |
| `validBefore` buffer | due date + 21 days | — |
| Late fee | $5 flat per installment, once, state-cap aware | [$0–$8] |
| Keeper bounty | $0.05 per cleared collection | [$0.02–$0.25] |
| Minimum ticket | $40 | — |
| Tier‑0 start / growth | $50; ×1.25 per clean plan | — |
| Tier‑0 unsecured cap | $500 pseudonymous / $1,000 identity-linked | — |
| Tier‑0 concurrency | 1 active plan until first completion | — |
| Tier‑0 share of pool book | ≤10% | [5–15%] |
| Pseudonymous activation fee | $2, non-refundable | [$1–$5] |
| FPD kill-switch | weekly cohort first-payment defaults >8% → auto-throttle | [5–10%] |
| Mutable-signer (smart-account) unsecured cap | 0.5× tier cap | — |
| Junior subordination floor | ≥15% of pool capital (origination gate) | [15–30%] |
| Reserve | 2% of outstanding book, **prefunded at launch** | [1–4%] |
| Provisioning | 50% at Delinquent, 100% at charge-off (60 DPD) | — |
| Liquidity buffer | 10% of pool, parked in USYC where eligible | [5–20%] |
| Senior APR band | 5–10%, set per weekly epoch | — |
| Corridor exposure cap | $250k per corridor at launch | — |
| FX fallback deviation guard | AMM fallback only within 50 bps of last RFQ mid | [25–100 bps] |
| MDR | 4.0% standard / 2.5% salary-linked / 1.0% secured | pilot may discount to 3.0% |

---

*Plazo Protocol specification v0.2 — July 2026 (supersedes v0.1). Built on Arc: USDC-native gas, Malachite BFT sub-second finality, StableFX, Gateway, CCTP v2, Circle Wallets/Contracts/Compliance. This document describes intended functionality; nothing in it is an offer of credit or securities.*

