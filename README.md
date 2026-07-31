# Plazo Protocol

Installment credit rebuilt as a clearing network on [Arc](https://docs.arc.io), Circle's stablecoin L1.

Every incumbent staples together four separate systems — a settlement rail, a collections apparatus, a warehouse credit line and an FX desk. Plazo makes each one a property of the settlement layer itself: sub-second-final USDC merchant settlement, collections via EIP-3009 dated authorizations signed as unforgeable post-dated checks, an open tranched capital market as the funding book, and cross-currency installments cleared through StableFX.

**The core claim:** a borrower signs once and the money moves on schedule without anyone ever holding their funds.

---

## Status

**Phase 3 of 9 complete.** Credit now has exactly one door. A plan can only be created by a router that screens both parties, verifies a signed limit bounded by five separate on-chain caps, checks the merchant's standing, moves the pool's capital, pays the merchant in the same transaction, and mints a transfer-restricted receivable — reading every parameter from a registry whose bands are compiled in and can only be narrowed.

Phase 2 proved the mechanism: a borrower signs once, a third-party keeper collects and is paid, a drained borrower produces a delinquency signal with no operator involved, and the borrower cures and pays off through a rail that is never pausable. Two plans against real USDC, sixteen live assertions, and the published keeper finding and cranking the outstanding work given only a factory address.

Deployed on Arc testnet, chain `5042002`, from block `54561488`. Fifteen contracts; the full list is in [`contracts/deployments/5042002.json`](contracts/deployments/5042002.json).

| | |
|---|---|
| `CheckoutRouter` | [`0xd18d9bc9…5fec`](https://testnet.arcscan.app/address/0xd18d9bc9f9bfca07b73746be82e3b27b55245fec) — the only address that can create a plan |
| `PlanFactory` | [`0x3debc13f…347e`](https://testnet.arcscan.app/address/0x3debc13fde095788d9488d034d5f8cf69cb3347e) |
| `InstallmentPlan` | [`0x3d928f31…3547`](https://testnet.arcscan.app/address/0x3d928f31297fb75e94aa6d624757a5dae9893547) — vintage 2, the implementation clones point at |
| `CreditPool` | [`0x1da66d97…bd90`](https://testnet.arcscan.app/address/0x1da66d97de638bf2863aaf1b8fa6cf902b38bd90) |
| `Tier0Underwriter` | [`0xc82ff622…f894`](https://testnet.arcscan.app/address/0xc82ff622ed0224df5b84aad60a39726194e1f894) |
| `ParameterRegistry` | [`0xeee0320d…b9bd`](https://testnet.arcscan.app/address/0xeee0320d40fbbdaedd034ea90d1399f4f830b9bd) |
| Arc mainnet | **Not live, no announced date.** There is no mainnet phase; readiness is a CI gate and a config flip. |

## The mechanism

**A dated strip, signed once, collected by anyone.** Four EIP-3009 authorizations payable to a CREATE2 address that holds no code yet, each dated to its installment and single-use by nonce. The borrower's funds never leave their wallet until each due date, there is no allowance a spender could drain, and the plan has no owner, no pauser and no upgrade path.

**A failed pull is recorded, not reverted.** A revert emits nothing, changes nothing and pays nobody — and grace transitions, Passport marks, NAV provisioning, the subordination gate and the kill switch all read that signal. So `collect()` discriminates every failure *before* it pulls and emits a typed bounce: a blocklisted borrower is a compliance event, a paused token is an infrastructure event, and only insufficient funds is a credit event.

**Nobody profits from cranking a collection that cannot succeed**, so `markMissed()` is paid out of an escrow the plan is funded with at origination. It is reserved against every other crank, because a plan that arrives at delinquency unable to afford its own mark fails exactly where it matters.

**The strip lives onchain.** Storing four signatures costs a few thousandths of a dollar on Arc, and it is what makes [`@plazo/keeper`](packages/keeper) need nothing but a key: no Plazo API, no index, no allowlist. If signatures lived on a server, "permissionless collection" would mean "permissioned on our API".

## Origination

**The underwriter can decline and nothing else.** Underwriting runs off-chain — the inputs are a borrower's history and a partner's scorecard, and neither belongs in a public log — so what reaches the chain is a number and a signature over it. The router takes the minimum of that number, a hard on-chain ceiling, the Tier-0 cap, the kill-switch throttle and the book-share headroom, which means a stolen signing key cannot mint credit. It can refuse business. What the log gets is a *band*, never a figure: enough to spot a compromised key from an anomalous distribution, not enough to reconstruct anyone's credit line.

**Origination is NAV-neutral.** The pool pays the merchant `principal − MDR`, funds the plan's own delinquency escrow out of that MDR, and books a receivable of `principal`. The fee is deferred and earns as principal actually comes back. A book that recognised the fee at checkout would show a profit the moment it lent money, and the reversal would only arrive when the borrower did not pay.

**The book learns from the plans, not from its balance.** A plan settles with a bare transfer that notifies nobody, and `totalAssets` is never `balanceOf` — a donation would otherwise land in NAV. A permissionless crank reads each plan's own accumulators and books the delta while moving nothing.

**A new merchant's own settlement capitalises their own bond.** The bond scales with outstanding fronted exposure rather than being a flat entry cost, and a fraction of every settlement to a new merchant is withheld into it. Refund arbitrage is the highest-yield attack on a BNPL book, and the merchant most likely to run it is the one who just onboarded.

**The kill switch is graduated and weights new-wallet defaults down.** A binary switch is trivially griefed: mint a hundred wallets, take a hundred minimum tickets, default on every first payment, and close the book for everyone. Weighting those observations at a quarter means buying the throttle down requires seasoned wallets, which cost real completed plans to produce.

**No pause can reach a live plan.** The pause plane stops new credit and nothing else, because the plan has no owner, no pauser and no upgrade path. A test pauses every switch the protocol has and then drives a plan through collect, bounce, mark, cure and payoff — a collections system that can stop accepting money is a collections system that can manufacture a default.

## Verification

**Seventeen properties, written before the contracts, now bound to them.** Phase 1 proved the suite bites by driving each assertion into failure against a breakable stub. Phase 2 points the plan properties at the real plan under a fuzzer; Phase 3 does the same for the pool, across 16,384 fuzzed calls.

Between them the fuzzers have found five defects nobody would have written a test for: `revalidate()` could starve the delinquency budget; a pause nobody observed kept the grace clock running against a borrower who could not have paid; the charge-off clock started at the wrong installment, leaving one plan shape unable to reach a terminal state at all; cancelling a defaulted plan's deferred income wrote off money the book still had; and a merchant's exposure never came down, so a merchant who had repaid everything could never recover their bond.

Two Phase 1 properties were amended in the process, both with the reasoning written into the suite. `check_sharesImplyAssets` was false for a tranche wiped out by a loss — and junior being wiped out is the product, not a bug. `check_reserveAbsorbsBeforeJunior` is a state proxy for a transition: a book that correctly struck the reserve to zero and was then replenished looks identical to one whose waterfall ran out of order, so the fuzz binding watches the step instead.

**Derivation parity, extended again.** Three corpora generated from Solidity and recomputed in TypeScript — identity and clone address; then the terms commitment, schedule, authorization windows and acceptance digest; then the attestation digest, the Tier-0 limit curve and the credit band. Moving the jitter half-width by one hour fails 64 of 64 rows; moving the growth factor by one basis point fails wherever it matters.

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
services/origination/ Quote, session, underwriting, compliance. Proprietary.
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

Phase 2's run, against the plan implementation Phase 3 kept unchanged apart from one accounting view:

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

Phase 3 adds the origination plane, and its controls are verified against the deployed bytecode:

```
The origination plane — live controls
  ok  every contract in the deployment record holds bytecode (12 contracts)
  ok  every Appendix A parameter reads from the registry (Tier-0 book share 1000 bp)
  ok  a value outside its hard-coded band is refused onchain (25% is the ceiling; 90% was refused)
  ok  an uncapitalised book refuses to originate
  ok  Tier-0 headroom is zero against a book with no capital
  ok  the quote surface answers zero rather than a figure it cannot honour
  ok  a merchant registered themselves without an operator
  ok  and cannot attest their own KYB
  ok  an unscreened borrower is not clear
  ok  the operator's feed cleared the borrower
  ok  the receivable refuses to mint to an address nobody has considered
  ok  nobody but the router can deploy a plan
```

To reproduce:

```bash
forge script script/Deploy.s.sol --root contracts --rpc-url arc_testnet --broadcast
```

```bash
node tools/record-deployment.mjs 5042002
```

The record comes from Foundry's broadcast artefact rather than from the script, because a script writes its file during local execution and would happily record a deployment that failed to send. It takes each address from the **transaction** and never from the receipt: Foundry writes the receipts array with `transactionHash` in mining order and `contractAddress` in submission order, so a receipt row can carry one transaction's hash beside another's deployed address. With four contracts the two orders coincided; with fifteen they did not. See [finding 12](contracts/test/fork/FINDINGS.md).

```bash
pnpm --filter @plazo/arc-verify slice
```

The control half needs `DEPLOYER_PRIVATE_KEY` and pennies. **The credit half needs 406.84 USDC**, and most of that is the book rather than a cost: UW-02 caps Tier-0 paper at a share of the pool, and the band's ceiling is 25%, so the smallest ticket the protocol will originate needs four times its own value in capital behind it before the headroom reaches the ticket. The deposits cycle through the plan and are redeemed at the end. Fund at [`faucet.circle.com`](https://faucet.circle.com) and the slice runs the rest.

Widening that band would make a testnet run cheaper and would also remove one of the two things standing between an unproven scorecard and the senior tranche.

**Set an explicit gas limit on anything that moves close to a whole balance.** `eth_estimateGas` prepays its upper bound out of the sender's balance, and on Arc that balance *is* the token balance — so a transfer of 18.75 from an account holding 18.88 reverts with `ERC20: transfer amount exceeds balance` while being perfectly solvent. See [finding 8](contracts/test/fork/FINDINGS.md).

## Next

Phase 4 is servicing and the borrower path: Passport as a commitment, the reminder ladder and balance monitoring, one-tap top-up, hosted checkout, the borrower app, and the relayer and ops console. Phase 5 — the tranched capital market — can run alongside it; both consume Phase 3 and neither depends on the other.

Third-party access acquisition runs alongside. See [`ACCESS.md`](ACCESS.md); nothing on that list blocks the build, and everything on it is stubbed behind an interface.

## Licence

Per directory. Protocol contracts and the strip tooling are Apache-2.0; product surfaces and operator services are proprietary. See [`LICENSE`](LICENSE).
