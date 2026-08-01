# Plazo Protocol

Installment credit rebuilt as a clearing network on [Arc](https://docs.arc.io), Circle's stablecoin L1.

Every incumbent staples together four separate systems — a settlement rail, a collections apparatus, a warehouse credit line and an FX desk. Plazo makes each one a property of the settlement layer itself: sub-second-final USDC merchant settlement, collections via EIP-3009 dated authorizations signed as unforgeable post-dated checks, an open tranched capital market as the funding book, and cross-currency installments cleared through StableFX.

**The core claim:** a borrower signs once and the money moves on schedule without anyone ever holding their funds.

---

## Status

**Phases 4 and 5 of 9 complete.** The funding book is a credit market and the borrower has somewhere to live.

Senior and junior claims sit over a first-loss reserve, priced at an epoch NAV nobody can choose after the fact and exited through a queue where being first is worth nothing — a delinquency marks NAV down in the epoch it becomes public, a cure releases exactly what it took, and a charge-off at sixty days flows down reserve → junior → senior with the split itemised in the log.

On the other side, a borrower sees one balance that means something, gets warned before a shortfall becomes a bounce, tops up in one tap sized to the whole horizon, signs on an origin the merchant page cannot reach into, and reads a credit record they can recompute themselves with an open-source library.

Phase 3 gave credit exactly one door; Phase 2 proved the mechanism against real USDC with no operator involved.

Deployed on Arc testnet, chain `5042002`, from block `54714174`. Twenty-one contracts; the full list is in [`contracts/deployments/5042002.json`](contracts/deployments/5042002.json).

| | |
|---|---|
| `CheckoutRouter` | [`0x26482cfc…777e`](https://testnet.arcscan.app/address/0x26482cfc9ff45ec9d79a67689136bc4ff2bb777e) — the only address that can create a plan |
| `TranchedCreditPool` | [`0xe0eF3fa7…2CeF`](https://testnet.arcscan.app/address/0xe0eF3fa7925D538668E7023090B28308Aa3a2CeF) — the book, the tranches, the epochs and the queue |
| `PlazoPassport` | [`0x5dA94df5…76eE`](https://testnet.arcscan.app/address/0x5dA94df51cB626E8c6a979AcB9bbc8193d6276eE) |
| `PlanFactory` | [`0xE598c6bF…E7f3`](https://testnet.arcscan.app/address/0xE598c6bF83650CCE33f18e97464A2A9649ACE7f3) |
| `InstallmentPlan` | [`0xeA0B6f4c…f2A8`](https://testnet.arcscan.app/address/0xeA0B6f4cf3a972045A4181e241Ae01f31Cc5f2A8) — vintage 3, the implementation clones point at |
| `RelayerGate` | [`0x7cea8452…7C73`](https://testnet.arcscan.app/address/0x7cea8452B6feab6C4cc684d6a8CB31D8933F7C73) — where the operator's collections are held back |
| `ParameterRegistry` | [`0x753E08A6…7338`](https://testnet.arcscan.app/address/0x753E08A63ec767045052A0E491eaeF67A6C57338) |
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

**Twenty-seven properties, written before the contracts, now bound to them.** Phase 1 proved the suite bites by driving each assertion into failure against a breakable stub. Phase 2 pointed the plan properties at the real plan under a fuzzer; Phase 3 did the same for the pool; Phase 5 binds the same pool properties, unchanged, to the tranched book — which is the check that "a refinement, not a replacement" is a true description rather than a comforting one. The deep campaign runs 2,048 runs at depth 256.

Between them the fuzzers have found six defects nobody would have written a test for. `revalidate()` could starve the delinquency budget. A pause nobody observed kept the grace clock running against a borrower who could not have paid. The charge-off clock started at the wrong installment, leaving one plan shape unable to reach a terminal state at all. Cancelling a defaulted plan's deferred income wrote off money the book still had. A merchant's exposure never came down, so a merchant who had repaid everything could never recover their bond. And the merchant fee was recognised against the original principal rather than the remaining balance, which compounds — a fully repaid plan left carrying unearned income against no receivable, understating NAV for the life of every plan and then jumping at close.

Three Phase 1 properties have been amended, each with the reasoning written into the suite where the property lives. `check_sharesImplyAssets` was false for a tranche wiped out by a loss, and junior being wiped out is the product. `check_reserveAbsorbsBeforeJunior` is a state proxy for a transition, so the fuzz binding watches the step. `check_provisionNeverExceedsAssets` compared an allowance to net assets, which imposed an accidental fifty-percent ceiling on provisioning that nobody chose; it compares to gross receivables now.

**Derivation parity, four corpora.** Identity and clone address; the terms commitment, schedule, authorization windows and acceptance digest; the attestation digest, Tier-0 curve and credit band; and the credit score, its ageing window and the record commitment. Each is generated from Solidity and recomputed in TypeScript, and each carries a perturbation test proving the comparison would notice a divergence rather than merely reporting agreement.

**The Arc gate**, twenty-five assertions against the live network on every push and daily on a schedule, with the domain separator derived rather than hardcoded.

**Twenty-seven live assertions** against the deployed bytecode — the refusals, which are the half a mock cannot prove: a book that will not fund a tenor it was not stood up for, a tranche that refuses deposits before the protocol has seeded it, an epoch that will not close early, a credit record no stranger can read and no admin can write.

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
packages/keeper/     The reference keeper, and the epoch crank. Apache-2.0.
packages/passport/   Credit scoring, record encoding, commitment. Apache-2.0.
packages/ui/         Design system. Proprietary.
apps/shell/          App chassis. Proprietary.
apps/borrower/       Plans, balance, top-up, Passport. Proprietary.
apps/checkout/       Hosted checkout. Own origin, strict CSP. Proprietary.
apps/console/        Operator console. Proprietary.
apps/lender/         NAV, receivables, buffer, queue. Proprietary.
services/indexer/    Ponder over the frozen schema. Proprietary.
services/origination/ Quote, session, underwriting, compliance. Proprietary.
services/servicing/  Reminders, balances, relayer, console API. Proprietary.
tools/               Boundary and token enforcement, dependency pinning.
```

The open tree may never import from the closed tree, and CI fails the build if it does. `packages/plan-core` in particular has no network, server or database dependency: a borrower holding a signed strip must be able to recompute the plan id, the payee address and every nonce from the disclosed terms alone. If verifying the deal needed Plazo's cooperation, "the signed bytes commit to the disclosed deal" would be a claim rather than a property.

`packages/passport` is open for the same reason and it is the newer half of the argument: a borrower should be able to recompute their own credit standing and check the chain agrees, without asking the party whose interest it serves.

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

The design system at `localhost:3000`. The four product surfaces run the same way:
`@plazo/borrower`, `@plazo/checkout`, `@plazo/console` and `@plazo/lender`. Each reads a
live service when `PLAZO_SERVICING_URL` or `PLAZO_INDEXER_URL` is set and a labelled
sample when it is not — the banner is unconditional, because a demo indistinguishable
from production is how a screenshot ends up in a deck describing a book that does not
exist.

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

Phases 3 to 5 add the origination, capital and servicing planes. What can be proved without capital is what they *refuse*, and that is the half a mock cannot prove — so it runs on every slice invocation, costs pennies, and is verified against the deployed bytecode:

```
The origination plane — live controls
  ok  every contract in the deployment record holds bytecode (19 contracts)
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
  ok  the Pay-in-4 book funds Pay-in-4 paper
  ok  and refuses a tenor it was not stood up for
  ok  the registry knows which book backs the line
  ok  and refuses to repoint it
  ok  a tranche refuses deposits until the protocol has seeded it
  ok  share units carry the decimals offset (9 decimals against USDC's 6)
  ok  junior is locked for a full tenor and senior is not (junior 56 days)
  ok  nobody but the pool can mint a tranche share
  ok  an epoch cannot be closed before its time
  ok  senior capacity is zero against a book with no junior
  ok  the operator's collections are held back by an onchain floor (30 minutes)
  ok  a borrower's tier is not readable by whoever asks
  ok  and nobody outside the protocol can write one
  ok  the credit score is a pure function anyone can evaluate
  ok  a schema cannot be published without a content hash

27 assertions passed against live chain 5042002.
```

**The credit half has now run.** 51 assertions against the live chain, funded to 408.84 USDC by aggregating twenty faucet drips:

```
Plan A — origination through the router, collection, bounce, cure, payoff
  ok  the merchant was credited in full minus MDR in the origination transaction
  ok  the down payment cleared and debited exactly one installment (18.75 USDC)
  ok  a third-party keeper collected and was paid the quoted bounty
  ok  a pull against an empty wallet bounced instead of reverting
  ok  the plan moved to Grace … the same check cleared once funds arrived … the plan cured
  ok  a stranger's crank booked the repayment and earned the deferred fee (2.008125 USDC)

Plan B — the delinquency signal, with no operator involved
  ok  an address with no relationship to the plan recorded the delinquency
  ok  the marker was paid out of the plan's own escrow
```

Most of the 408.84 is the book rather than a cost: UW-02 caps Tier-0 paper at a share of the pool, so the smallest ticket the protocol will originate needs four times its own value in capital behind it. But it is a standing commitment, not a round trip — POOL-10 locks the junior leg for a full 56-day tenor, POOL-09 skims about 1% on the way out of the senior leg, and a run moves roughly 26 USDC of fees permanently into the book. `unwind` is opt-in for that reason.

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

The control half needs `DEPLOYER_PRIVATE_KEY` and pennies. **The credit half needs 408.84 USDC on a virgin book**, and most of that is the book rather than a cost: UW-02 caps Tier-0 paper at a share of the pool, and the band's ceiling is 25%, so the smallest ticket the protocol will originate needs four times its own value in capital behind it before the headroom reaches the ticket.

The faucet drips ~20 USDC an address, so it cannot be filled directly. `arc-verify faucet` stands up twenty collection addresses derived from the deployer key — no key file to write, lose or leak — and sweeps them when they are full:

```bash
pnpm --filter @plazo/arc-verify faucet          # addresses, balances, what is still needed
pnpm --filter @plazo/arc-verify faucet sweep    # into the funding account
```

Once the book is capitalised it stays that way, and a re-run needs only the working float. The slice subtracts what the chain already holds rather than quoting the virgin total.

Widening that band would make a testnet run cheaper and would also remove one of the two things standing between an unproven scorecard and the senior tranche.

**Set an explicit gas limit on anything that moves close to a whole balance.** `eth_estimateGas` prepays its upper bound out of the sender's balance, and on Arc that balance *is* the token balance — so a transfer of 18.75 from an account holding 18.88 reverts with `ERC20: transfer amount exceeds balance` while being perfectly solvent. See [finding 8](contracts/test/fork/FINDINGS.md).

## Next

Phase 6 closes the Pay-in-4 loop: refunds and voids, physical-goods escrow, the merchant dashboard and sandbox, the drop-in SDK, and cross-chain payout and deposit. Its gate is GOV-08 — with every operator role set to the zero address, collection, cure, marking, epoch settlement, redemption requests and refunds all still work, proven by test.

The formal-verification track starts now rather than at Phase 9. It was chartered to run from Phase 5 in parallel, because FV finds design flaws rather than bugs and discovering one on frozen code inside a terminal gate is a schedule catastrophe. Share accounting and the loss waterfall are the subjects; `PoolInvariants` already carries the Certora rule names.

Third-party access acquisition runs alongside. See [`ACCESS.md`](ACCESS.md); nothing on that list blocks the build, and everything on it is stubbed behind an interface.

## Licence

Per directory. Protocol contracts and the strip tooling are Apache-2.0; product surfaces and operator services are proprietary. See [`LICENSE`](LICENSE).
