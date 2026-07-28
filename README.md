# Plazo Protocol

Installment credit rebuilt as a clearing network on [Arc](https://docs.arc.io), Circle's stablecoin L1.

Every incumbent staples together four separate systems — a settlement rail, a collections apparatus, a warehouse credit line and an FX desk. Plazo makes each one a property of the settlement layer itself: sub-second-final USDC merchant settlement, collections via EIP-3009 dated authorizations signed as unforgeable post-dated checks, an open tranched capital market as the funding book, and cross-currency installments cleared through StableFX.

**The core claim:** a borrower signs once and the money moves on schedule without anyone ever holding their funds.

---

## Status

**Phase 1 of 9 complete.** The substrate every later phase compiles against exists and is verified. Phase 2 builds the mechanism.

| | |
|---|---|
| Network | Arc testnet, chain `5042002` |
| Arc mainnet | **Not live, no announced date.** There is no mainnet phase; readiness is a CI gate and a config flip. |
| Contracts | `PlanFactory` and the derivation libraries. No collection logic yet — that is Phase 2. |

## What Phase 1 shipped

**Plan identity, derived identically in two languages.** `planId` commits to the chain, the factory, the plan implementation and an origination nonce. A 128-row corpus is generated from Solidity and recomputed in TypeScript; reordering a single field in the type string fails 257 assertions.

**An Arc verification gate.** Twenty-five assertions against the live network on every CI run and daily on a schedule — EIP-3009 typehashes, payee enforcement, validity windows, the domain separator derived rather than hardcoded, the pinned USDC implementation, EURC's corridor capability, and the `eth_getLogs` range the indexer chunks against.

**An invariant suite written before the contracts it constrains.** Seventeen properties across the plan waterfall, the collection guarantee and share accounting, each carrying the Certora rule name it becomes. Each one is driven into failure deliberately, because a suite that has never failed is a suite that might not work.

**A frozen event schema.** Committed by hash. No plan event carries a borrower address in an indexed position — wallet-keyed plan events would let anyone index the log stream into a permanent, public, uncorrectable purchase history.

**The design system**, ported once from the binding comp into a single Tailwind `@theme`, with a build failure on any local colour, font or blurred shadow in `apps/`.

## What the fork spike settled

Full detail in [`contracts/test/fork/FINDINGS.md`](contracts/test/fork/FINDINGS.md).

- **ERC-1271 works end to end on Arc USDC.** One-ceremony signing is mechanically available, so Flex's twelve-check strip needs no re-scoping.
- **Arc USDC has no balance storage** — `balanceOf` reads the account's native balance over 10¹². Gas and the loan are literally one balance, which makes paymaster sponsorship a functional requirement rather than a UX nicety.
- **Token movement is a native precompile Foundry cannot execute.** No fork test can complete a transfer; local tests need a mock token and real value movement needs funded testnet accounts.
- **Measured pull gas is 140,885** — $0.00296, about 4× cheaper than the specification assumed. Recomputing the ops budget confirms a **$75** minimum ticket at a 21% stress margin, and shows keeper bounties dominate gas by an order of magnitude.

## Layout

```
contracts/           Foundry. Apache-2.0.
packages/plan-core/  Identity, nonce and clone-address derivation. Apache-2.0.
packages/events/     The frozen event schema. Apache-2.0.
packages/arc-verify/ The Arc primitive gate. Apache-2.0.
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

## Next

Phase 2 is the vertical slice and the gate for everything downstream: one plan, four checks, a third-party keeper collecting and being paid, a deliberate bounce producing an unambiguous single-block delinquency signal with zero operator transactions, a cure, a payoff — against real Arc testnet USDC.

Third-party access acquisition runs alongside from here. See [`ACCESS.md`](ACCESS.md); nothing on that list blocks the build, and everything on it is stubbed behind an interface.

## Licence

Per directory. Protocol contracts and the strip tooling are Apache-2.0; product surfaces and operator services are proprietary. See [`LICENSE`](LICENSE).
