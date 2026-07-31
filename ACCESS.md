# Third-party access — acquisition track

Every item here has external latency measured in weeks, and several gate whole phases. The track starts in Phase 1 and runs to Phase 8. **Nothing below blocks the build**: every dependent component is written behind an interface with a no-op stub, so acquisition and construction proceed in parallel.

Ordered by lead time. Start from the top.

---

## 1. Circle Compliance Engine — start this first

**Class:** permissioned, request form, not self-serve. **The longest gate in the project.**
**Gates:** Tier-0 identity attestation, and all of the compliance screening in Phase 3.
**How:** submit the Compliance Engine request form for **both** testnet and mainnet. It is documented as "only available for eligible customers", so expect a qualification conversation rather than an instant approval.
**Until then:** `IComplianceScreen` with a no-op stub that approves everything and logs. Phase 3 wires the real adapter as an **event stream**, not a one-shot boolean at onboarding — a borrower can become sanctioned mid-strip, and a check signed before that will still try to clear.

## 2. StableFX

**Class:** permissioned, KYB/AML gated.
**Gates:** all of Phase 7's FX corridor.
**How:** email `sales@circle.com` or a Circle representative for an API key. Requires completed Circle KYB/AML.
**Shape once granted:** RFQ quote → offchain accept → PvP settle through `FxEscrow 0x867650F5eAe8df91445971f14d89fd84F0C9a9f8` with Permit2. A browser console exists for manual trading.
**Known unknown:** the taker API is documented for spot trades. Whether it can price a **dated strip** — six weeks of installments at a rate committed at checkout — is unverified. Design `FXRouter` assuming single-RFQ strip pricing is **not** supported, and treat locked-rate (USDC-denominated, rate committed at checkout) as the primary product, since it is mechanically clean.
**Scope reality:** USDC↔EURC only. Every other corridor in the specification names a token that is not deployed on Arc.

## 3. Circle Mint

**Class:** permissioned, KYB, long lead.
**Gates:** fiat LP deposits, and prefunding the first-loss reserve.
**How:** Circle Mint onboarding.

## 4. Counsel and a partner lender

**Class:** engagements, not signups.

| Who | Gates | Note |
|---|---|---|
| Reg D counsel | Tranche share issuance | DEC-01 already chose transfer-restricted shares over money-market pledgeability. Counsel confirms the structure, not the decision. |
| FCRA counsel | Consent-gated Passport reads | A launch gate with a documented ship-dark-in-US contingency, not a code blocker. Passport stores a commitment either way. |
| Partner lender | Flex origination | Interest-bearing consumer credit behind a licensed partner. Phase 8. |

## 5. Circle developer account — self-serve, one afternoon

**Class:** signup.
**Gates:** three Phase 1 spikes that are still open, plus the Arc faucet.
**How:** create an account at the Circle Console, then generate an API key and an entity secret.
**Packages:** `@circle-fin/developer-controlled-wallets@10.8.0`, `@circle-fin/user-controlled-wallets@10.8.0`, `@circle-fin/modular-wallets-core@1.0.15`, `@circle-fin/w3s-pw-web-sdk@1.1.11`.

**These three spikes no longer block D1.** Phase 2 resolved the signer-class cap policy as a protocol mechanism instead: a bountied onchain `revalidate()` makes signer mutation something anyone can observe and anyone is paid to observe, so the cap does not depend on a vendor exposing a webhook. What the spikes still determine is the checkout ceremony — how many prompts a four-check strip costs a borrower — which Phase 4 owns.

1. **Does the Circle Wallets SDK sign N typed-data payloads under one user-verification gesture?** There is no batch typed-data RPC anywhere, so a four-check strip is four prompts unless the wallet collapses them. Count the prompts against a real wallet, not `vm.sign`.
2. **Does Circle's MSCA validator accept a merkle-wrapped ERC-1271 signature, or must Plazo ship its own ERC-6900 validation module?** The fork spike proved Arc USDC honours ERC-1271 end to end, so the mechanism exists — this asks whether Circle's default validator will use it.
3. **Does Circle expose a key-rotation or wallet-recovery webhook?** The cap policy turns on whether signer mutation is observable in real time: observable → full cap, not observable → half. Without this, every smart-account borrower takes the reduced cap, which guts Tier-0 economics.

If any answer is no, file it as a Circle feature request immediately rather than designing around silence.

## 6. Arc testnet RPC and faucet

**Class:** RPC is public with no signup; the faucet needs the Circle account from item 5.
**RPC:** `https://rpc.testnet.arc.io` — already in use, and asserted on every CI run by `pnpm arc:verify`.
**Faucet:** `https://faucet.circle.com`.

**Why the faucet matters more than it looks.** Arc USDC's token movement runs through a native precompile at `0x1800…` that Foundry cannot execute, so **no fork test can complete a transfer** — and neither can a `forge script`, which executes its body locally before broadcasting. Every balance assertion in the 97-test local suite is therefore against a mock. See `contracts/test/fork/FINDINGS.md`.

**Done — the Phase 2 gate is closed.** The stack is deployed on chain 5042002 and the slice has run against real USDC.

| | |
|---|---|
| Funded | `0xF4ee61950B63cCA5C82f1146484d018Ac95Bd0F2`, 20 USDC |
| Deployed | `PlanFactory 0xb864308d7214f98d60c5811f451fa96a49619150`, block 54513131 |
| Slice | 16 assertions across two plans |

About 20 USDC is enough for a full run: the settlement recipient is the funding
account, so the working float recycles rather than accumulating. To re-run:

```bash
forge script script/Deploy.s.sol --root contracts --rpc-url arc_testnet --broadcast
node tools/record-deployment.mjs 5042002
pnpm --filter @plazo/arc-verify slice
```

Or trigger the `slice` job from the CI workflow, which does all three, with `PLAZO_TESTNET_DEPLOYER_KEY` set as a repository secret.

## 7. CCTP v2 and Gateway

**Class:** public permissionless contracts. Kit keys are free and need no KYC.
**Arc is CCTP domain 26.** Hooks are supported. Fast Transfer is marked N/A, which is not a limitation — Arc finalises in about one block.

| Contract | Address |
|---|---|
| `TokenMessengerV2` | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| `MessageTransmitterV2` | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| `GatewayWallet` | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| `GatewayMinter` | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |

**Confirm these with Circle before Phase 6 depends on them.** Research found CCTP is not at its canonical Ethereum addresses on Arc, and an address inherited from another chain's documentation is a silent failure.

## 8. Arc mainnet

**Class:** does not exist. No action is available.

`rpc.mainnet.arc.io` returns UNAUTHORIZED, `status.arc.io` lists testnet components only, and viem ships chain 5042 with an empty RPC array — the id is reserved, the network is not open. Circle's own January 2026 post describes working "toward the milestones that will carry Arc from testnet toward a live production network", with no date.

**There is no mainnet phase in the roadmap and none should be added.** Subscribe to `status.arc.io` incident mail. When it lands, mainnet readiness is: set `ARC_MAINNET_RPC_URL`, run `pnpm --filter @plazo/arc-verify verify:mainnet`, and re-pin the USDC implementation. The gate is already written and already runs daily against testnet.

---

## Status

Update as items land. Every unchecked box below has a working stub behind it.

- [ ] Circle Compliance Engine — request submitted
- [ ] StableFX — KYB started
- [ ] Circle Mint — application submitted
- [ ] Reg D counsel engaged
- [ ] FCRA counsel engaged
- [ ] Partner lender identified
- [x] Circle developer account created
- [ ] Spike: N payloads, one gesture — now a Phase 4 checkout-UX question, not a D1 blocker
- [ ] Spike: MSCA validator vs ERC-6900 module — same
- [ ] Spike: key-rotation webhook — superseded by the bountied `revalidate()`
- [x] **Arc faucet funded, stack deployed, slice run** — the Phase 2 gate is closed
- [ ] CCTP and Gateway addresses confirmed with Circle
