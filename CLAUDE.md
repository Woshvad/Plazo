<!-- GSD:project-start source:PROJECT.md -->

## Project

**Plazo Protocol**

Plazo is installment credit rebuilt as a clearing network on Arc, Circle's stablecoin L1. Where every incumbent (Klarna, Affirm, Afterpay, B2B trade-credit desks) staples together four separate systems — a settlement rail, a collections apparatus, a warehouse credit line, and an FX desk — Plazo makes each one a property of the settlement layer itself: sub-second-final USDC merchant settlement, collections via EIP-3009 dated authorizations signed as unforgeable post-dated checks, an open ERC-4626 tranched capital market as the funding book, and cross-currency installments cleared through StableFX and Circle's partner-stablecoin program.

It serves three sides. **Merchants** — beachhead is cross-border corridor commerce (LATAM/SEA sellers to stablecoin-holding diaspora buyers) and crypto-native storefronts, not US general retail. **Borrowers** — consumers and businesses who get 0%-on-time installments with funds that never leave their own wallet until each due date. **Lenders** — institutional allocators buying senior (fixed-target, first-claim, short-duration dollar paper) or junior (residual, first-loss) shares of the credit pools.

The one-line position: Plazo is the installment-credit clearinghouse for the stablecoin economy. Arc holds the book; every chain is a storefront.

**Core Value:** **A borrower signs once and the money moves on schedule without anyone ever holding their funds.** If the authorization-backed check strip does not clear reliably, non-custodially, and permissionlessly, nothing else in the specification matters — the capital markets, the FX layer, and Passport are all downstream of that one mechanism working.

### Constraints

- **Target** — Real Arc testnet deployment, not a demo or hackathon submission. Contracts must actually work; Appendix A parameters become code, not a table.
- **Timeline** — Originally framed as "racing Arc mainnet." **Research refuted the premise: Arc mainnet is not live and has no announced date** (`rpc.mainnet.arc.io` returns `UNAUTHORIZED`; viem ships chain 5042 with an empty RPC array; `status.arc.io` lists testnet only). The schedule dependency is unowned, so testnet deployment is the actual deliverable and mainnet readiness is a CI gate plus a config flip. Sequencing remains the lever, not scope: the Pay-in-4 loop front-loads so something is deployable and provable early, with Flex, Terms, and FX corridors as later phases that do not block it.
- **Scope** — Full, through Flex and Terms, including every surface needed for a functional product and the complete operator service stack. Scope reduction is not on the table; ordering is.
- **Tech stack — contracts** — Foundry. Chosen for Solidity-native fuzzing and invariant testing, which is what the InstallmentPlan waterfall math and CreditPool share accounting actually need ahead of the formal-verification gate.
- **Tech stack — frontend** — Next.js + Tailwind for all app surfaces and hosted checkout.
- **Repo shape** — Monorepo. Contracts, apps, services, and shared packages in one tree so generated contract types flow to the SDK, backend, and UIs without publishing. Must still accommodate the license posture: protocol contracts open-source, operator services proprietary.
- **Non-custodial by construction** — Borrower funds stay in borrower wallets until each due date. This is not a feature to be traded away under schedule pressure.
- **All-dollar balance sheet** — No volatile collateral anywhere. No liquidation engine, no price oracle. The only market risks are credit and FX, both priced explicitly.
- **Arc-resident repayment balances (v1)** — EIP-3009 checks debit the borrower's Arc balance. A Gateway unified balance on another chain is not collectible by a check on Arc. Funding in is one tap from any chain; the app must prompt and automate top-ups ahead of due dates.
- **Validator trust** — Arc is a permissioned-validator PoA network today. This is accepted and documented plainly rather than papered over.
- **Git attribution** — STRICT: no Claude or AI attribution on any commit. No `Co-Authored-By`, no `Generated with` trailers. A `commit-msg` hook at `.githooks/commit-msg` strips them as a backstop.
- **Git isolation** — `Desktop/Plazo` is its own repository. The parent home directory is itself a git repo; commits must not leak into it.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Part 0 — The load-bearing verification (read this first)

### VERIFIED TRUE — every core assumption in spec §3

| Spec claim | Status | Evidence |
|---|---|---|
| Arc USDC implements EIP-3009 | **VERIFIED** | All three typehashes readable onchain and byte-identical to canonical FiatToken values |
| `transferWithAuthorization` / `receiveWithAuthorization` / `cancelAuthorization` / `authorizationState` present | **VERIFIED** | All present in both `(v,r,s)` and `bytes signature` forms; selectors found in implementation bytecode |
| `receiveWithAuthorization` enforces payee == caller (§3.2 anti-griefing) | **VERIFIED** | Live revert: `FiatTokenV2: caller must be the payee` |
| `validAfter` post-dating works (§3.1 post-dated checks) | **VERIFIED** | Live revert: `FiatTokenV2: authorization is not yet valid` |
| `validBefore` self-expiry works | **VERIFIED** | Live revert: `FiatTokenV2: authorization is expired` |
| Nonce single-use / cancellation | **VERIFIED** | `authorizationState(address,bytes32)` live; revert string `FiatTokenV2: authorization is used or canceled` present in bytecode |
| ERC-1271 smart-contract-wallet signing (§3.1, §3.4) | **VERIFIED** | Live call trace shows a `staticcall` to `isValidSignature(bytes32,bytes)` on the contract signer |
| CREATE2 plan binding (§3.6) | **VERIFIED** | Canonical deterministic deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` is deployed on Arc |

### The exact EIP-712 domain (this is what you sign against)

### Arc-specific deviations from canonical FiatTokenV2_2

### Reproduce the verification (put this in CI as a mainnet-readiness gate)

# ERC-1271 path proof: authorizer is a contract, expect a staticcall in the trace

### Verified FALSE / not-yet-true spec assumptions

| Spec claim | Reality | Fallback |
|---|---|---|
| §8 corridors "MXNB, BRLA, PHPC, KRW1" | **Not deployed on Arc.** Only USDC, EURC, USYC exist on Arc testnet. StableFX supports **USDC↔EURC only**. Partner issuers (Juno/MXNB, Avenia/BRLA, Coins.ph/PHPC, Beyond/KRW1, JPYC, Forte/AUDF, Stablecorp/QCAD, ZAR Universal/ZARU) are announced program members, not live contracts. | Build FXRouter against the EURC corridor only. Keep the venue-agnostic adapter (§4.2) and treat every other corridor as configuration, not code. Do not roadmap a non-EURC corridor to a date. |
| §3.1 "collection cost ~$0.013/tx" | **Wrong, and in your favour.** Base fee is 20 gwei floor, gas price 21 gwei, USDC native at 18 decimals. A `collect()` at ~120k gas costs **~$0.0025**. A plain ERC-20 transfer is ~$0.0014. | Recompute the Appendix A minimum ticket ($40) and keeper bounty ($0.05) against ~$0.0025, not $0.013. The ops budget has ~5× more headroom than modelled. |
| §12 "Phase 1 — Arc mainnet launch (summer 2026)" | **Mainnet is not live as of 2026-07-27.** Status page lists only Testnet components. `rpc.mainnet.arc.io` resolves but returns `UNAUTHORIZED`. viem ships an `arc` mainnet chain definition with **chain ID 5042** and an *empty* RPC array — the ID is reserved, the network is not open. Circle's own Jan 2026 post says "working toward the milestones that will carry Arc from testnet toward a live production network," with no date. | The race is real but the finish line has moved. Testnet is the deliverable; treat mainnet as a config flip plus a re-run of the Part 0 verification script. |
| §4.3 "Circle Contracts: deployment, event monitoring, webhook automation" as the keeper trigger | Circle Smart Contract Platform **is available on Arc testnet**, but it is a convenience layer, not an indexer. It cannot carry LP reporting or the plan state machine. | Use it (if at all) only for webhook-driven relayer wake-ups. Run a real indexer (Ponder) as the source of truth. Do not make the relayer depend on a Circle webhook — §3.3 already says the keeper market makes the operator non-essential; build to that. |

### Newly available capability the spec does not exploit

## Part 1 — Arc network facts (all verified live, 2026-07-27)

| Property | Value | Confidence |
|---|---|---|
| Status | **Public testnet only.** Mainnet not live. | HIGH — status.arc.io components; `rpc.mainnet.arc.io` returns `UNAUTHORIZED`; viem `arc` chain has no RPC |
| Testnet chain ID | `5042002` | HIGH — `cast chain-id` |
| Mainnet chain ID (reserved) | `5042` | MEDIUM — viem chain definition only |
| Primary RPC | `https://rpc.testnet.arc.io` (also `…arc.network`), WS `wss://rpc.testnet.arc.io` | HIGH |
| Alt RPCs | Blockdaemon, dRPC, QuickNode subdomains under `*.testnet.arc.io` | HIGH |
| Explorer | `https://testnet.arcscan.app` (API at `/api`) | HIGH |
| Faucet | `https://faucet.circle.com` | HIGH |
| Gas token | USDC — 18 decimals natively, 6 decimals over ERC-20. Same balance. | HIGH |
| Base fee | 20 gwei floor (testnet), 20,000 gwei ceiling, EIP-1559 + EWMA smoothing, **no burn** (base fee goes to the block beneficiary) | HIGH — `cast block` |
| Block time | **0.514 s** measured over 1,000 blocks | HIGH — measured |
| Block gas limit | 30,000,000 | HIGH |
| Consensus / finality | Malachite BFT, deterministic single-slot finality, **zero reorgs** | HIGH — docs + design |
| EVM target | **Osaka** baseline, plus selected Amsterdam features (EIP-7708 native value transfer logs) | HIGH |
| `PREVRANDAO` | **Always returns 0.** No onchain randomness. | HIGH |
| Blob txs | Unsupported; `BLOBHASH`→0, `BLOBBASEFEE`→1 | HIGH |
| `eth_getLogs` | **Hard limit: 10,000 block range** on the public RPC | HIGH — measured (`-32614`) |
| Validator set | Permissioned PoA today; ARC token presale raised $222M (a16z-led), PoS transition signalled but not shipped | MEDIUM — press, not primary docs |

### Deployed infrastructure on Arc testnet (all confirmed to have bytecode)

| Contract | Address | Why it matters |
|---|---|---|
| USDC | `0x3600000000000000000000000000000000000000` | The check rail |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` | **Full EIP-3009, canonical typehash, `version()=="2"`** — the EURC corridor is buildable today |
| USYC | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` | Liquidity-buffer parking (§7.2). **No EIP-3009** — permit/`DOMAIN_SEPARATOR` only. Do not attempt check collection in USYC. |
| USYC Teller | `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` | Mint/redeem for the buffer |
| Deterministic CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | Required for §3.6 `planId` binding |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | Batched reads |
| **Multicall3From** | `0x522fAf9A91c41c443c66765030741e4AaCe147D0` | **Arc-specific.** Use for batching keeper `collect()` cranks. |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | StableFX PvP settlement uses Permit2 |
| FxEscrow (StableFX) | `0x867650F5eAe8df91445971f14d89fd84F0C9a9f8` — **do not hardcode; see note** | StableFX onchain settlement leg. **Arc's own contract-address reference names a different address, `0xd68256f4…`.** Both hold code, same owner, same Permit2, **different implementations** (`0x721eafa9…` vs `0xce8d080d…`). Do not pick one: the Permit2 `verifyingContract` arrives in the API response's `typedData.domain` and must be read from there at runtime. Same class of error as hardcoding USDC's `DOMAIN_SEPARATOR`, which this document already forbids. |
| CCTP v2 TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | Inbound/outbound USDC |
| CCTP v2 MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | Hooks receive path |
| GatewayWallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | Unified balance deposits |
| GatewayMinter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` | Unified balance mint on Arc |
| ERC-4337 EntryPoint v0.6 / v0.7 / v0.8 | `0x5FF137D4…2789` / `0x0000000071727De2…a032` / `0x4337084d…f108` | **All three deployed.** Smart accounts work today. |

### Two Arc-specific risks the spec does not name

## Part 2 — Circle service availability matrix and how to obtain each

| Service | Available on Arc? | Access class | How to obtain |
|---|---|---|---|
| **Arc testnet RPC** | Yes | **(a) Public, no signup** | Point at `https://rpc.testnet.arc.io`. Nothing to request. |
| **Arc testnet faucet** | Yes | **(b) Signup** | `https://faucet.circle.com` — Circle developer account. Free. |
| **Arc mainnet** | **(d) Does not exist yet** | — | No action available. Monitor `status.arc.io` (subscribe to incident emails) and Circle's pressroom. Assume config-only work when it lands. |
| **Circle Wallets — developer-controlled** | Arc Testnet, EOA + SCA | **(b) Signup, self-serve** | Circle Console → create developer account → API key + entity secret. `@circle-fin/developer-controlled-wallets` **10.8.0**. Use for merchant treasury + operator relayer (§4.3). |
| **Circle Wallets — user-controlled / passkey** | Arc Testnet, EOA + SCA + **MSCA** | **(b) Signup, self-serve** | Same console. `@circle-fin/user-controlled-wallets` **10.8.0** (server) + `@circle-fin/w3s-pw-web-sdk` **1.1.11** (browser). |
| **Circle Modular Wallets (passkey MSCA)** | Arc Testnet, MSCA only | **(b) Signup** | `@circle-fin/modular-wallets-core` **1.0.15** (published 2026-07-22, the most actively maintained Circle client package). **This is the borrower wallet.** See Part 7. |
| **Circle Paymaster** | **Arc Testnet — v0.7 only** | **(b) Signup** | v0.7 covers Arbitrum, Base, Arbitrum Sepolia, **Arc Testnet**, Base Sepolia. v0.8 does **not** cover Arc. **Build against EntryPoint v0.7 on Arc, not v0.8.** |
| **Circle Gas Station** | Via Circle Wallets | **(b) Signup** | Console policy config. On Arc gas is USDC and ~$0.0014–0.0025, so sponsorship is a UX nicety, not an economic necessity. Low priority. |
| **Circle Smart Contract Platform (Contracts)** | Arc Testnet (not mainnet on any chain list that includes Arc) | **(b) Signup** | `@circle-fin/smart-contract-platform` **10.8.0**. Useful for event webhooks feeding the relayer. Not a substitute for an indexer. |
| **Circle Compliance Engine** | Not stated for Arc | **(c) Permissioned — request form** | **Not self-serve.** "Only available for eligible customers"; submit the Compliance Engine request form for *both* testnet and mainnet. **Start this immediately** — §5.1 Tier-0 identity attestation and §9.2 both block on it. Build behind an interface with a no-op stub. |
| **CCTP v2** | **Yes — Arc is domain 26**, testnet and mainnet | **(a) Public, permissionless contracts** | Call the contracts directly, or use Bridge Kit / App Kit. **Hooks supported on Arc.** Fast Transfer is marked N/A on Arc (unnecessary — Arc finalises in ~1 block). No signup for the contracts; a kit key improves rate limits. |
| **Circle Gateway** | **Yes** — Arc listed on mainnet and testnet chain lists, ~0.5 s attestation | **(a)/(b)** | `GatewayWallet` / `GatewayMinter` addresses above. Kit keys are **free and require no KYC**. Nanopayments (§3.5 streaming variant) live under Gateway. |
| **Arc App Kit** | Yes | **(a) Public npm** | `npm i @circle-fin/app-kit` — Send, Bridge, Swap, Unified Balance in one package, with viem / ethers v6 / Solana / Circle Wallets adapters. Get a Console **kit key** for production Swap rate limits. |
| **StableFX** | Arc only (that is where it lives) | **(c) Permissioned — KYB/AML gated** | **USDC↔EURC only today.** Email `sales@circle.com` or your Circle rep for an API key. Requires completed Circle KYB/AML. Flow: RFQ quote → accept offchain → PvP settle via FxEscrow + Permit2 on Arc. There is a browser StableFX Console for manual trading. **Start the KYB conversation now**; it gates §8 entirely. |
| **Circle Mint** | Institutional fiat on/off-ramp | **(c) Permissioned — KYB** | Apply through Circle Mint onboarding. Gates §7.2 fiat LP deposits and the §7.1 Reserve prefunding. Long lead time. |
| **xReserve** | Program for issuing partner stablecoins | **(c) Permissioned** | Not relevant unless Plazo wants to issue. Ignore. |
| **Partner stablecoins (MXNB/BRLA/PHPC/KRW1/JPYC/AUDF/QCAD/ZARU)** | **(d) Not deployed on Arc** | — | Program members announced; no Arc contracts. Nothing to request. Treat as future config. |
| **Circle Payments Network (CPN)** | Not Arc-specific | (c) Permissioned | Out of scope for v1. |

## Part 3 — Contracts stack

### Core

| Technology | Version | Purpose | Why |
|---|---|---|---|
| **Foundry** | **1.7.1** (stable, 2026-05-08) | Build, test, fuzz, invariant, script, deploy | Locked by the user, and correct. Solidity-native invariant testing is exactly what the §3 waterfall and §7 share accounting need. Pin with `foundryup --install 1.7.1` and commit the version to CI — do not use `nightly`. |
| **forge-std** | **v1.16.2** (2026-06-30) | Test harness, `StdInvariant`, cheatcodes | Required for handler-based invariant suites. |
| **Solidity** | **0.8.30** | Compiler | 0.8.36 is latest, but pin conservatively and bump deliberately. Auditors price re-review on compiler churn. |
| `evm_version` | **`"prague"`** | Codegen target | Arc targets Osaka (a Prague superset), so Prague bytecode is guaranteed valid. Do **not** set `"osaka"` or `"amsterdam"` — you gain nothing and you break local `forge test` reproducibility and third-party fork tooling. Do **not** target `"cancun"` or below; you lose nothing but there is no reason to. |
| **OpenZeppelin Contracts** | **5.6.1** | ERC-721, AccessControl, Pausable, ReentrancyGuard, SafeERC20, EIP-712, MerkleProof | The audit-legible default. Auditors read OZ without being paid to. |
| **OpenZeppelin Contracts Upgradeable** | **5.6.1** | UUPS for CheckoutRouter, CreditPool, Passport, FXRouter | §10 mandates UUPS behind a timelock. Version-match with non-upgradeable, always. |
| **openzeppelin-foundry-upgrades** | **v0.4.1** (2026-05-29) | Storage-layout safety on upgrade | Non-negotiable given UUPS + a live credit book. Add `validateUpgrade` to CI. |
| **Solady** | **v0.1.26** (tag 2025-08-25; repo active, last commit 2026-06-08) | `LibClone`, `ERC4626`, `MerkleProofLib`, `MerkleTreeLib`, `SignatureCheckerLib`, `EIP712` | See below. Pin to the tag, not `main`. |

### Where each library goes, specifically

### Do NOT use

| Avoid | Why | Instead |
|---|---|---|
| Hardhat | Second toolchain, second config, second CI path, and it cannot run Foundry invariant suites. The only thing it buys is JS deploy scripts you do not need in a monorepo that already has TS services. | Foundry only. `forge script` for deploys. |
| Solady `ERC4626` | See above — no built-in inflation mitigation of OZ's form, and no existing FV corpus. | OZ `ERC4626` |
| OZ `Clones` | No immutable-args variant; slightly worse runtime. | Solady `LibClone` |
| `solmate` | Effectively unmaintained; superseded by Solady. | Solady |
| `foundryup nightly` | Non-reproducible builds; a compiler/behaviour change mid-audit is a self-inflicted wound. | Pinned `1.7.1` |
| A price oracle of any kind | §1 explicitly removes it. Anyone reaching for Chainlink is smuggling volatile collateral back in. | All-dollar balance sheet |

## Part 4 — Verification stack (the §10 formal-verification gate)

| Tool | Version | Status | Verdict |
|---|---|---|---|
| **Certora Prover** | Open source, repo active (last commit 2026-07-21) | Free tier: **2,000 prover-minutes/month**, write your own rules, Discord support. Premium/Enterprise are sales-quoted. | **PRIMARY. Use this.** |
| **Foundry invariant testing** | in 1.7.1 | Active | **PRIMARY.** Handler-based invariants are the daily driver. |
| **Medusa** | **v1.5.1** (2026-03-11) | Active (Trail of Bits) | **SECONDARY.** Parallel coverage-guided fuzzing; catches what Foundry's fuzzer misses on deep state. |
| **Kontrol** | **v1.0.255** (2026-06-24) | Very active (Runtime Verification) | **TERTIARY, targeted.** The only tool here with **loop invariants** — relevant if the waterfall iterates installments. Also the home of the ERCx ERC-4626 conformance suite. |
| **Echidna** | v2.3.2 (2026-03-27) | Active | Skip — Medusa is its successor and shares the property syntax. |
| **Halmos** | v0.3.3, **last commit 2025-08-06** | **~1 year stale** | **DO NOT USE.** A near-dead dependency cannot sit on the critical path of a launch gate. This is a change from the conventional wisdom of a year ago. |
| **Slither** | 0.11.5 (2026-01-16) | Active | Yes — run in CI. Free, fast, catches the boring things before an auditor bills for them. |

### What to actually verify, and where the free tier runs out

- Total assets equals reserve + junior + senior claims, always.
- No sequence of deposit/redeem/provision/release changes another holder's per-share value except through a loss or a fee.
- The loss waterfall is monotone and ordered: Reserve exhausts before junior, junior before senior.
- Provisioning is idempotent — 50% at `Delinquent` applied twice is still 50%; `100%` at charge-off supersedes rather than compounds.
- Cure releases exactly the provision that delinquency took. This round-trip property is where real bugs live.
- Origination is impossible when subordination or reserve is below floor.
- Sum of all collected installments plus rebates minus fees equals the plan's principal plus accrued fees at any terminal state.
- No installment index can clear twice (belt-and-braces over the EIP-3009 nonce).
- `repay()` and `collect()` are commutative with respect to final payoff — a borrower who cures by push and a keeper who cranks must not double-charge.
- State machine reachability: `Repaid` and `Defaulted` are absorbing; there is no path from `Repaid` back to `Grace`.
- No path leaves outstanding principal unaccounted after `Refunded` or `Cancelled`.

## Part 5 — Type generation from ABIs

- The `foundry` plugin watches `out/` and regenerates on `forge build`, so the monorepo's "generated contract types flow everywhere without publishing" constraint is satisfied by a file watcher, not a release process.
- It emits `const`-asserted ABIs, which **abitype 1.3.0** turns into full compile-time inference of function names, argument tuples, return types, and event payloads. A typo in an event field is a build error in the yield dashboard.
- viem (and therefore wagmi, and therefore Ponder) all consume the same artefact. One representation, zero adapters.
- The `react` plugin optionally emits typed hooks; use it for the three Next.js surfaces, skip it for the backend.

## Part 6 — Frontend

| Technology | Version | Notes |
|---|---|---|
| **Next.js** | **16.2.12** | Locked by the user. App Router. Three surfaces + hosted checkout + drop-in SDK embed. |
| **React** | **19.2.8** | Next 16 peer range is `^18.2 \|\| ^19`. Use 19. |
| **Tailwind CSS** | **4.3.3** | Locked. v4 is CSS-first config (`@theme`), not `tailwind.config.js`. The binding design comp (`Plazo.dc.html`) should be ported into `@theme` tokens once, then consumed by all three surfaces. |
| **viem** | **2.55.10** | **Ships `arcTestnet` (id 5042002) and `arc` (id 5042) chain definitions out of the box.** No custom `defineChain` needed. |
| **wagmi** | **3.7.4** | Peers: `viem 2.x`, `react >=18`, `@tanstack/react-query >=5`, `typescript >=5.9.3`. |
| **@tanstack/react-query** | **5.101.4** | wagmi peer. |
| **@circle-fin/modular-wallets-core** | **1.0.15** | Passkey MSCA borrower wallet. Registers as a wagmi connector / viem account. |
| **@circle-fin/app-kit** | latest | Bridge/Swap/Send/Unified Balance UI primitives for the §4.1 cross-chain funding tap. Get a Console kit key. |

## Part 7 — The one-ceremony signing problem (materially affects the product)

### There is no batch typed-data signing RPC. None.

- **Circle Modular Wallets (MSCA)** — ERC-6900 modular, passkey-native, Arc Testnet supported with MSCA account type, `@circle-fin/modular-wallets-core` 1.0.15 is Circle's most actively maintained client package. **Check whether Circle's default MSCA validator already accepts a merkle-wrapped signature format, or whether Plazo must ship an installable ERC-6900 validation module.** This is the highest-value unknown left in the stack and deserves a spike in the first contract phase.
- **EIP-7702 delegation** — **live on Arc testnet (verified)**. An EOA borrower signs one 7702 authorization to delegate to a Plazo-audited validator implementation, and thereafter gets one-ceremony signing with their existing wallet. This converts Path A into Path B *without asking the borrower to migrate wallets*, and it is the single most valuable capability Arc offers this product that the spec does not currently use.
- **Safe / ZeroDev Kernel** — for merchant treasury and institutional LPs, not consumers.

### The consequence, stated plainly

## Part 8 — Backend / operator services

| Concern | Choice | Version | Why |
|---|---|---|---|
| **Event indexing** | **Ponder** | **0.17.1** (last commit 2026-07-20) | TypeScript-native, viem-based (peer `viem >=2.35`), Postgres-backed via Drizzle, chain-agnostic — Arc is just an RPC URL and a `startBlock`. Reorg handling, Ponder's hardest problem elsewhere, is **free on Arc**: deterministic finality means no rollback logic. Serves GraphQL and custom Hono API routes, so it doubles as the read API for all three surfaces. |
| ↳ Arc-specific config | `maxRequestsPerSecond` + block range | — | **Set the log range to ≤10,000** — the public RPC hard-errors above it (`-32614`). Set `startBlock` to your deployment block; the chain is already past 53.9M blocks at 0.514 s and a genesis backfill is pointless. |
| ↳ Faster backfill | **Envio HyperSync / HyperRPC** — **now token-gated, verified 2026-08-02** | — | Envio has first-class Arc Testnet support (HyperSync at `https://arc-testnet.hypersync.xyz`, plus HyperRPC), and pointing Ponder's transport at HyperRPC is still the right architecture — Ponder's DX, Envio's ingestion, no 10k-range limit. **But all three Arc-testnet endpoints now require an API token behind an interactive signup**, so this is no longer the drop-in it reads as. Until a token exists, Ponder runs against the public RPC and **the backfill does not complete**: measured in Phase 6, 390 blocks of a 194,092-block range in nine minutes, with 641 shed responses escaping the transport's retries. Treat the token as an access-acquisition item on the standing third-party track, not as configuration. |
| **Database** | **PostgreSQL 17** | — | Ponder targets it natively. Credit ledgers want real transactions, `numeric` for money, and boring durability. Keep the indexed chain state and the operator's private state (PII, underwriting features, FX quotes) in **separate schemas** — §9.3 says PII never touches the chain, and schema separation makes that auditable. |
| **ORM (operator services)** | **Drizzle ORM 0.45.2** | | Ponder already depends on Drizzle; sharing it means one migration story and one query builder. |
| **API layer** | **Hono 4.12.32** | | Ponder embeds Hono, so custom endpoints (Connect API, PSP white-label, x402) live in the same process or a sibling with the same idioms. |
| **Keeper scheduling** | **BullMQ 5.81.2** + Redis | | Due-date cranks are delayed jobs with retry and idempotency keys — BullMQ's core competency. Job key = `${planId}:${installmentIndex}` so a duplicate crank is a no-op. Alternative if you want zero extra infrastructure: **graphile-worker 0.17.3** (Postgres-only, no Redis) — pick this if operational simplicity beats throughput, which at Plazo's volumes it probably does. |
| **Keeper transaction sending** | viem + Circle developer-controlled wallet | | §3.3 says the relayer is redundant, not required. Build it that way: the relayer is *a* keeper, and the permissionless bounty path must be exercised in tests, not just documented. |
| **Contract event → relayer wake-up** | Ponder indexing function, not Circle webhooks | | §4.2 suggests Circle Contracts webhooks. Use them as a *secondary* trigger at most. A credit system's collection loop should not have a single vendor webhook on its critical path. |

## Part 9 — Monorepo

### Layout, with the license boundary designed in

- Per-package `LICENSE` files with an explicit root `LICENSE` note that per-directory licenses govern. This is the standard, legally boring approach.
- **Enforce the dependency direction in CI**, because the licence posture is only real if the code respects it: `contracts/` and `packages/{abi,sdk,strip}` must never import from `apps/` or `services/`. A dependency-cruiser or ESLint boundaries rule that fails the build is worth more than a policy document.
- When the time comes to open-source, `git subtree split` on `contracts/` + the three OSS packages produces a clean public repo with real history. Design for that split now (no cross-imports, no shared private config) and it costs nothing later.
- `packages/strip` **must** be open source and independently runnable. §3.6 claims "nothing about the strip is trust-me: the signed bytes commit to the disclosed deal." That claim is only true if a borrower can reproduce the digests without Plazo's server.

## Installation

# Toolchain

# Contracts

# Type generation

# Frontend (per app)

# Backend

# Verification (CI)

# Medusa v1.5.1 and Kontrol v1.0.255 via their release binaries

# Certora Prover: free tier account at certora.com/signup

## Alternatives Considered

| Recommended | Alternative | When the alternative wins |
|---|---|---|
| Ponder | Envio HyperIndex | If Arc backfill volume becomes the bottleneck and you want ingestion and indexing from one vendor. HyperIndex has first-class Arc support. The hybrid (Ponder + HyperRPC transport) captures most of the benefit without the DX change. |
| Ponder | Circle Smart Contract Platform webhooks | Never as the primary. Fine as a redundant relayer wake-up. |
| BullMQ | graphile-worker | If you want to avoid running Redis. At Plazo's expected job volume this is a defensible simplification — arguably the better default. |
| OZ ERC-4626 | Solady ERC-4626 | If gas were the binding constraint. On Arc it is not ($0.0014/tx). |
| OZ ERC-4626 | ERC-7540 async vault | Worth revisiting for the redemption queue if an ecosystem of ERC-7540 integrators materialises on Arc. Today it buys standard-compliance with nobody. |
| Certora | Kontrol | For loop-heavy waterfall code specifically; Kontrol is the only one of these with loop invariants. Use it surgically alongside Certora, not instead. |
| Turborepo | Nx | Large org, many teams, heavy code generation. Not this project. |
| wagmi connectors | RainbowKit / ConnectKit | If the design comp were not binding. It is. |
| Node.js relayer | Go/Rust relayer | If keeper throughput ever exceeds what Node can push. Nowhere near, and it would forfeit end-to-end type sharing. |

## What NOT to Use

| Avoid | Why | Use instead |
|---|---|---|
| **TypeChain** | Last published 2023-10-15. Dead. ethers v5 bindings. | `@wagmi/cli` + abitype |
| **Halmos** | Last commit 2025-08-06 — roughly a year stale. Cannot sit on a launch gate. | Certora Prover (now free + open source) |
| **Hardhat** | Duplicate toolchain; cannot run Foundry invariants. | Foundry only |
| **ethers.js** | wagmi/viem/Ponder/abitype all speak viem. Mixing costs you the type graph. | viem 2.55.10 |
| **solmate** | Unmaintained. | Solady v0.1.26 |
| **The Graph / subgraphs** | AssemblyScript; no type sharing; hosted dependency. | Ponder |
| **Any price oracle** | §1 removes volatile collateral, which removes the reason to have one. Adding one re-adds an attack surface for nothing. | All-dollar balance sheet |
| **Circle Paymaster v0.8 on Arc** | v0.8 does **not** cover Arc. Only **v0.7** does. Building against v0.8 fails at integration. | Paymaster v0.7 + EntryPoint v0.7 on Arc |
| **Hardcoding the USDC `DOMAIN_SEPARATOR`** | It embeds `chainId` and `verifyingContract`. Both change on mainnet. Every outstanding strip would silently fail to validate. | Derive from the four domain fields at runtime |
| **Assuming 18-decimal USDC in app code** | Arc USDC is 18-dec native and 6-dec ERC-20 on one balance. EIP-3009 `value` is **6-dec**. | A branded/typed unit in `packages/strip`; never a bare `bigint` |
| **`foundryup nightly`** | Non-reproducible builds during an audit. | Pinned 1.7.1 |
| **ERC-7920 composite signatures** | Draft, no wallet support, and USDC's ECDSA path rejects root signatures from EOAs anyway. | ERC-1271 merkle validation on a smart account (Part 7) |

## Version Compatibility

| Package | Compatible with | Notes |
|---|---|---|
| `wagmi@3.7.4` | `viem@2.x`, `react>=18`, `@tanstack/react-query>=5`, `typescript>=5.9.3` | The TS floor is 5.9.3 — bumps the whole repo's TS baseline. |
| `next@16.2.12` | `react@^18.2 \|\| ^19` | Use React 19.2.8. |
| `ponder@0.17.1` | `viem>=2.35`, `hono>=4.5`, `typescript>=5.4` | Bundles `drizzle-orm@0.41.0` internally; if you also depend on 0.45.2 directly, pin via pnpm overrides to avoid two Drizzle copies. **Verify this at setup.** |
| `@openzeppelin/contracts` ↔ `-upgradeable` | Must be the **same** version (5.6.1) | Mismatched pairs cause storage-layout drift that the upgrades plugin will (correctly) refuse. |
| `solc 0.8.30` | `evm_version = "prague"` | Arc targets Osaka ⊃ Prague. |
| `viem@2.55.10` | ships `arcTestnet` (5042002), `arc` (5042) | `arc` has an empty RPC array — supply your own transport when mainnet lands. |
| Circle Paymaster **v0.7** | EntryPoint **v0.7** on Arc | v0.8 is not on Arc. |
| `@circle-fin/*-wallets@10.8.0` | — | Keep dev-controlled, user-controlled, and smart-contract-platform on the same 10.8.0 line; Circle ships them in lockstep. |

## Open questions for phase-level research

## Sources

- `cast` 1.7.1 against `https://rpc.testnet.arc.io`: chain ID, block time (0.514 s over 1,000 blocks), base fee (20 gwei), gas limit (30M), `eth_getLogs` 10k range limit
- USDC `0x3600…0000`: `name`/`symbol`/`decimals`/`version`, `DOMAIN_SEPARATOR`, all three EIP-3009 typehashes, `PERMIT_TYPEHASH`, `authorizationState`, proxy implementation `0x3910B7cb…`
- Domain separator reconstructed from (`"USDC"`, `"2"`, 5042002, `0x3600…0000`) — exact match
- `cast call --trace` proving the ERC-1271 `staticcall` path via `SignatureCheckerLib` at `0xd8C18dFF…`
- Live reverts confirming payee check, `validAfter`, `validBefore`
- Control diff against Ethereum mainnet USDC implementation `0x43506849d7c04f9138d1a2050bbf3a0c054402dd` — identical EIP-3009 selector profile
- EURC `0x89B5…D72a`: EIP-3009 confirmed. USYC `0xe918…b86C`: EIP-3009 absent
- EIP-7702 type-4 transaction accepted by txpool (rejected only for funds)
- Bytecode presence confirmed for EntryPoint v0.6/v0.7/v0.8, Permit2, Multicall3, Multicall3From, CREATE2 deployer
- `https://docs.arc.io/arc/references/rpc-endpoints`, `/contract-addresses`, `/evm-differences`, `/gas-and-fees`, `/arc/concepts/deterministic-finality`, `/arc/tools/data-indexers`, `/arc/tools/account-abstraction`, `/app-kit/tutorials/installation`, `/llms.txt`
- `https://developers.circle.com/llms.txt`, `/cctp/concepts/supported-chains-and-domains` (Arc = domain 26, Hooks yes, Fast Transfer N/A), `/gateway/references/supported-blockchains`, `/wallets/supported-blockchains`, `/paymaster/addresses-and-events` (v0.7 covers Arc; v0.8 does not), `/contracts/supported-blockchains`, `/stablefx`, `/stablefx/references/supported-currencies` (USDC + EURC only), `/w3s/compliance-engine` (request-form gated)
- `https://status.arc.io/api/v2/summary.json` — components list Testnet only
- `https://eips.ethereum.org/EIPS/eip-7920` — Draft, created 2025-03-20, no production implementations
- npm: viem 2.55.10, wagmi 3.7.4, @wagmi/cli 2.10.0, abitype 1.3.0, next 16.2.12, react 19.2.8, tailwindcss 4.3.3, ponder 0.17.1, hono 4.12.32, drizzle-orm 0.45.2, bullmq 5.81.2, graphile-worker 0.17.3, pnpm 11.17.0, turbo 2.10.7, nx 23.1.0, typechain 8.3.2 (2023), @circle-fin/* 10.8.0 / 1.0.15 / 1.1.11, @openzeppelin/contracts(-upgradeable) 5.6.1
- GitHub releases + commit activity: foundry v1.7.1, forge-std v1.16.2, openzeppelin-foundry-upgrades v0.4.1, solady v0.1.26 (commits to 2026-06-08), kontrol v1.0.255, medusa v1.5.1, echidna v2.3.2, **halmos v0.3.3 last commit 2025-08-06**, **Certora/CertoraProver last commit 2026-07-21 (open source)**
- PyPI: slither-analyzer 0.11.5, halmos 0.3.3
- soliditylang binaries: latest 0.8.36
- viem tarball inspection: `chains/definitions/arcTestnet.ts` (5042002) and `arc.ts` (5042, empty RPC)
- `https://www.circle.com/blog/building-the-internet-financial-system-circles-product-vision-for-2026` (2026-01-29) — Arc still moving "from testnet toward a live production network"
- `https://www.circle.com/blog/introducing-circle-stablefx-and-circle-partner-stablecoins` — partner list (Avenia/BRLA, Beyond/KRW1, Coins.ph/PHPC, Forte/AUDF, Juno/MXNB, JPYC, Stablecorp/QCAD, ZAR Universal/ZARU)
- `https://envio.dev/chains/arc-testnet` — HyperSync at `https://arc-testnet.hypersync.xyz`; **re-checked 2026-08-02: all three Arc-testnet endpoints now require an API token behind an interactive signup**
- `https://www.certora.com/pricing` — free tier 2,000 prover-min/month

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
