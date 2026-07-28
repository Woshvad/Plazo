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
| Circle Wallets: N payloads under one gesture | Needs a Circle developer account | `ACCESS.md`; blocks D1 |
| Circle MSCA validator vs a Plazo ERC-6900 module | Same | `ACCESS.md`; blocks D1 |
| Circle key-rotation / recovery webhook | Same | `ACCESS.md`; blocks D1 and §3.4 revalidation |
| Arc testnet reset policy | No published statement exists | Mitigated by continuous off-chain snapshotting, not resolved |
| Real value movement under the accounted `collect()` | Requires the precompile, so requires funded testnet accounts | Phase 2 gate |

D1 — the signer-class to unsecured-cap policy — still cannot be closed, but the shape of the answer changed: ERC-1271 working means smart accounts are viable, so the question is now about *which* smart account and how signer mutation is observed, not whether the path exists at all.
