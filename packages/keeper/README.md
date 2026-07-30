# @plazo/keeper

The reference Plazo keeper. Collects due installments and records delinquencies for the bounty.

```bash
PLAZO_FACTORY=0x… PLAZO_KEEPER_KEY=0x… npx @plazo/keeper
```

That is the whole setup. There is no Plazo API key, no allowlist, no registration and no endpoint of ours in the code path — the Arc RPC is public and needs no signup, and the authorization strip a keeper collects against is stored onchain rather than in our database.

That last part is a design decision, not an implementation detail. If signatures lived on a server, "permissionless collection" would mean "permissioned on Plazo's API", and the protocol's central claim — that the operator is not required — would be false in the one place it matters.

## What it does

Reads `PlanDeployed` from the factory, reads each plan's state directly, and decides what is worth cranking:

| Action | When | Pays |
|---|---|---|
| `collect(i)` | due, unresolved, and the borrower's balance covers it | a Dutch ramp from 25 bp to 250 bp of the installment across the grace window, floored at $0.05 and capped at $2.50 |
| `markMissed(i)` | past the grace window with no recorded outcome | $0.10 from the plan's own escrow |
| `markExpired(i)` | the authorization outlived its window | $0.10 |
| `halt()` | the token is paused and this plan's clock is still running | nothing — the bounty would be a transfer of the paused token |
| `resume()` | the token is live again and the plan is still suspended | $0.10 |

It will not propose a pull it expects to fail. A crank that reverts costs gas and pays nothing, and firing optimistically at a whole due-date wave loses money on every plan whose borrower is short — which is how a keeper market dies rather than how one starts. So the balance is checked, blocklisted borrowers are skipped, and disputed or settled plans are left alone.

## Economics

A pull measured on live Arc costs **140,885 gas**, which at 21 gwei with USDC as the gas token is **$0.00296**. The floor bounty is roughly 17× that. Batching a wave through `collectBatch` saves calldata and signatures but never earns a discount — each index still pays its own bounty at its own point on the ramp, which is what keeps a single crank worth sending.

## Running against something other than Arc testnet

```bash
PLAZO_RPC_URL=…            # defaults to https://rpc.testnet.arc.io
PLAZO_FACTORY=0x…          # the PlanFactory to watch
PLAZO_START_BLOCK=…        # defaults to ~24 hours back
PLAZO_KEEPER_KEY=0x…       # omit and pass --dry-run to just look
```

Arc's public RPC sheds roughly a quarter of requests with JSON-RPC `-32011` regardless of pacing, and viem does not retry it — a shed request arrives as HTTP 200 with an error body. This package retries on shed responses only, never on a real failure. Anything else you write against Arc will need the same.

## Licence

Apache-2.0.
