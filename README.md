# Plazo Protocol

Installment credit rebuilt as a clearing network on [Arc](https://docs.arc.io), Circle's stablecoin L1.

Every incumbent staples together four separate systems — a settlement rail, a collections apparatus, a warehouse credit line and an FX desk. Plazo makes each one a property of the settlement layer itself: sub-second-final USDC merchant settlement, collections via EIP-3009 dated authorizations signed as unforgeable post-dated checks, an open tranched capital market as the funding book, and cross-currency installments cleared through StableFX.

**The core claim:** a borrower signs once and the money moves on schedule without anyone ever holding their funds.

---

## Status

**Phase 2 of 9 complete.** The mechanism works: a borrower signs once, a third-party keeper collects and is paid, a drained borrower produces a delinquency signal with no operator involved, and the borrower cures and pays off through a rail that is never pausable.

| | |
|---|---|
| Network | Arc testnet, chain `5042002` |
| Arc mainnet | **Not live, no announced date.** There is no mainnet phase; readiness is a CI gate and a config flip. |
| Contracts | `InstallmentPlan`, `PlanFactory`, `JurisdictionRegistry`, `IdentityFXRouter`. Not yet deployed — see below. |

## The mechanism

**A dated strip, signed once, collected by anyone.** Four EIP-3009 authorizations payable to a CREATE2 address that holds no code yet, each dated to its installment and single-use by nonce. The borrower's funds never leave their wallet until each due date, there is no allowance a spender could drain, and the plan has no owner, no pauser and no upgrade path.

**A failed pull is recorded, not reverted.** A revert emits nothing, changes nothing and pays nobody — and grace transitions, Passport marks, NAV provisioning, the subordination gate and the kill switch all read that signal. So `collect()` discriminates every failure *before* it pulls and emits a typed bounce: a blocklisted borrower is a compliance event, a paused token is an infrastructure event, and only insufficient funds is a credit event.

**Nobody profits from cranking a collection that cannot succeed**, so `markMissed()` is paid out of an escrow the plan is funded with at origination. It is reserved against every other crank, because a plan that arrives at delinquency unable to afford its own mark fails exactly where it matters.

**The strip lives onchain.** Storing four signatures costs a few thousandths of a dollar on Arc, and it is what makes [`@plazo/keeper`](packages/keeper) need nothing but a key: no Plazo API, no index, no allowlist. If signatures lived on a server, "permissionless collection" would mean "permissioned on our API".

## Verification

**Seventeen properties, written before the contracts, now bound to them.** Phase 1 proved the suite bites by driving each assertion into failure against a breakable stub. Phase 2 points the same properties at the real plan under a fuzzer, which found two defects nobody would have written a test for: `revalidate()` could starve the delinquency budget, and a pause nobody observed kept the grace clock running against a borrower who could not have paid.

**Derivation parity, extended.** Two corpora generated from Solidity and recomputed in TypeScript — identity and clone address, then the terms commitment, the schedule, the authorization windows and the acceptance digest. Moving the jitter half-width by one hour fails 64 of 64 rows.

**The Arc gate**, twenty-five assertions against the live network on every push and daily on a schedule, with the domain separator derived rather than hardcoded.

## What the fork spike settled

Full detail in [`contracts/test/fork/FINDINGS.md`](contracts/test/fork/FINDINGS.md).

- **ERC-1271 works end to end on Arc USDC.** One-ceremony signing is mechanically available, so Flex's twelve-check strip needs no re-scoping.
- **Arc USDC has no balance storage** — `balanceOf` reads the account's native balance over 10¹². Gas and the loan are literally one balance, which makes paymaster sponsorship a functional requirement rather than a UX nicety.
- **Token movement is a native precompile Foundry cannot execute.** No fork test can complete a transfer, and neither can a `forge script`, which executes its body locally before broadcasting. Local tests run against a faithful mock; anything asserting real value movement runs from TypeScript against the live network.
- **Measured pull gas is 140,885** — $0.00296, about 4× cheaper than the specification assumed. Recomputing the ops budget confirms a **$75** minimum ticket at a 21% stress margin, and shows keeper bounties dominate gas by an order of magnitude. The ticket floor is set by the keeper market, not by Arc's fees.

## Layout

```
contracts/           Foundry. Apache-2.0.
packages/plan-core/  Identity, schedule and strip derivation. Apache-2.0.
packages/events/     The frozen event schema. Apache-2.0.
packages/arc-verify/ The Arc primitive gate and the live slice. Apache-2.0.
packages/keeper/     The reference keeper. Apache-2.0.
packages/ui/         Design system. Proprietary.
apps/shell/          App chassis. Proprietary.
services/indexer/    Ponder over the frozen schema. Proprietary.
tools/               Boundary and token enforcement, dependency pinning.
```

The open tree may never import from the closed tree, and CI fails the build if it does. `packages/plan-core` in particular has no network, server or database dependency: a borrower holding a signed strip must be able to recompute the plan id, the payee address and every nonce from the disclosed terms alone. If verifying the deal needed Plazo's cooperation, "the signed bytes commit to the disclosed deal" would be a claim rather than a property.

## Getting started

```bash
pnpm install
```

```bash
bash tools/install-libs.sh
```

Solidity dependencies are pinned by commit, not by tag. Tags can be moved.

```bash
forge test --root contracts --no-match-path 'test/fork/*'
```

```bash
pnpm arc:verify
```

Twenty-five checks against live Arc testnet. Needs no key — the public RPC is open.

```bash
forge test --root contracts --match-path 'test/fork/*' -vv
```

The fork spike. Needs network access; skips cleanly without it.

```bash
pnpm --filter @plazo/shell dev
```

The design system at `localhost:3000`.

## Deploying and running the slice

The local suite proves the logic. It cannot prove the token: Arc USDC moves through a native precompile Foundry cannot execute, so every balance assertion in the suite is against a mock. The slice runner is the other half — two plans originated with real signatures against real USDC.

```bash
forge script script/Deploy.s.sol --root contracts --rpc-url arc_testnet --broadcast
```

```bash
node tools/record-deployment.mjs 5042002
```

The record comes from Foundry's broadcast receipts rather than from the script, because a script writes its file during local execution and would happily record a deployment that failed to send.

```bash
pnpm --filter @plazo/arc-verify slice
```

Needs `DEPLOYER_PRIVATE_KEY` on a funded account — about 0.35 USDC to deploy and about 400 USDC to run, from [`faucet.circle.com`](https://faucet.circle.com).

## Next

Phase 3 is origination and underwriting: the checkout router, signed limit attestations, Tier 0, the merchant registry, the receivable with transfer hooks, and the parameter registry that turns every Appendix A launch hypothesis into something recalibrated from measured cohorts rather than redeployed.

Third-party access acquisition runs alongside. See [`ACCESS.md`](ACCESS.md); nothing on that list blocks the build, and everything on it is stubbed behind an interface.

## Licence

Per directory. Protocol contracts and the strip tooling are Apache-2.0; product surfaces and operator services are proprietary. See [`LICENSE`](LICENSE).
