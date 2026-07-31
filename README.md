# Plazo Protocol

Installment credit rebuilt as a clearing network on [Arc](https://docs.arc.io), Circle's stablecoin L1.

Every incumbent staples together four separate systems — a settlement rail, a collections apparatus, a warehouse credit line and an FX desk. Plazo makes each one a property of the settlement layer itself: sub-second-final USDC merchant settlement, collections via EIP-3009 dated authorizations signed as unforgeable post-dated checks, an open tranched capital market as the funding book, and cross-currency installments cleared through StableFX.

**The core claim:** a borrower signs once and the money moves on schedule without anyone ever holding their funds.

---

## Status

**Phase 2 of 9 complete.** The mechanism works: a borrower signs once, a third-party keeper collects and is paid, a drained borrower produces a delinquency signal with no operator involved, and the borrower cures and pays off through a rail that is never pausable.

Deployed and exercised on Arc testnet. Two plans originated against real USDC, sixteen assertions passed, and the published keeper — given only a factory address — found the outstanding crank, sent it, and was paid.

| | |
|---|---|
| Network | Arc testnet, chain `5042002`, from block `54513131` |
| `PlanFactory` | [`0xb864308d…19150`](https://testnet.arcscan.app/address/0xb864308d7214f98d60c5811f451fa96a49619150) |
| `InstallmentPlan` | [`0xe82308b3…Efd14`](https://testnet.arcscan.app/address/0xe82308b350013fa0dcc11fef10b3f0bf684efd14) — the implementation clones point at |
| `JurisdictionRegistry` | [`0x4dcde524…2322`](https://testnet.arcscan.app/address/0x4dcde524f0566f583fab237d7ceed2fe8fb02322) |
| `IdentityFXRouter` | [`0xc61dec55…8867c`](https://testnet.arcscan.app/address/0xc61dec55ed916f97006fc1b01695ee9297a8867c) |
| Arc mainnet | **Not live, no announced date.** There is no mainnet phase; readiness is a CI gate and a config flip. |

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

## The live slice

The local suite proves the logic. It cannot prove the token: Arc USDC moves through a native precompile Foundry cannot execute, so every balance assertion in the suite is against a mock. The slice runner is the other half.

```
Plan A — origination, third-party collection, bounce, cure, payoff
  ok  TypeScript and Solidity agree on the payee address (0x50D71E535D7c86aD90B392594Aa657Cb7bc6bf27)
  ok  the clone landed on the address the borrower signed against
  ok  the down payment cleared and debited exactly one installment (18.75 USDC)
  ok  a quarter of the principal retired
  ok  a third-party keeper collected and was paid the quoted bounty
      (0.41625 USDC bounty, 0.00573145 USDC gas out of the same balance)
  ok  a pull against an empty wallet bounced instead of reverting
  ok  the plan moved to Grace
  ok  the same check cleared once funds arrived
  ok  the plan cured
  ok  the plan is Repaid

Plan B — the delinquency signal, with no operator involved
  ok  an address with no relationship to the plan recorded the delinquency
  ok  the marker was paid out of the plan's own escrow
  ok  the plan is Delinquent and carries a late fee
```

Then, separately, `@plazo/keeper` with a factory address and a key and nothing else:

```
found 3 plan(s) between block 54513131 and 54514737
send  markMissed(0) on 0xbCdCaf6d8d2AeF511B4Bef03ab7456c30b925663 — grace expired uncured
1 action(s) worth 0.1 USDC, 1 transaction(s) sent
```

To reproduce:

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

Needs `DEPLOYER_PRIVATE_KEY` on an account holding about 20 USDC from [`faucet.circle.com`](https://faucet.circle.com) — 0.35 to deploy and roughly one installment of working float, because the settlement recipient is the funding account and the same dollars go round the loop.

**Set an explicit gas limit on anything that moves close to a whole balance.** `eth_estimateGas` prepays its upper bound out of the sender's balance, and on Arc that balance *is* the token balance — so a transfer of 18.75 from an account holding 18.88 reverts with `ERC20: transfer amount exceeds balance` while being perfectly solvent. See [finding 8](contracts/test/fork/FINDINGS.md).

## Next

Phase 3 is origination and underwriting: the checkout router, signed limit attestations, Tier 0, the merchant registry, the receivable with transfer hooks, and the parameter registry that turns every Appendix A launch hypothesis into something recalibrated from measured cohorts rather than redeployed.

Third-party access acquisition runs alongside. See [`ACCESS.md`](ACCESS.md); nothing on that list blocks the build, and everything on it is stubbed behind an interface.

## Licence

Per directory. Protocol contracts and the strip tooling are Apache-2.0; product surfaces and operator services are proprietary. See [`LICENSE`](LICENSE).
