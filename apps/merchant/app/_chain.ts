/**
 * The dashboard's chain reads.
 *
 * ## Why this file exists now and did not before
 *
 * 06-12 left four payloads sample-only — treasury, the escrow rows, `refundPreview` and
 * `voidAmountFor` — and DEC-68 gave the reason: they are contract views, the contracts
 * behind them were not deployed, and a getter calling a route nobody had written would turn
 * a correctly-configured deployment into a 500 where a labelled sample degrades.
 *
 * 06-13 deployed them. `MerchantRegistry`, `PayoutRouter`, `SettlementEscrow`,
 * `CheckoutRouter`, `RefundEscrow` and an escrow-only `ParameterRegistry` are on chain
 * 5042002 with every wiring assertion read back off the chain. So the premise of DEC-68 is
 * gone and these four become live — the same way `packages/checkout-embed` reads
 * `CheckoutRouter.maxPrincipalFor` from the buyer's browser rather than through a service
 * that would have to be built first.
 *
 * ## Read the chain, do not add a service in front of it
 *
 * 06-12's closing note asks for "a read route" on some service. A route would be a second
 * place the ABI lives, a second thing to deploy, and a cache with no invalidation story in
 * front of values a merchant is about to act on. These are unauthenticated views of public
 * state; the dashboard is a server component with a network stack. It reads them directly.
 *
 * ## Every read is bounded, retried, and allowed to fail
 *
 * Arc's public RPC sheds roughly a quarter of requests regardless of pacing — measured in
 * Phase 1 and true since. viem's `http` transport retries, and this file raises the count
 * and shortens nothing. A read that still fails does **not** throw into the page: the
 * payload comes back `live: false` with the failure named, and the unconditional banner
 * prints it. That is a deliberate divergence from `_data.ts`'s "a failing fetch throws"
 * rule, and the reason is the shed rate: a dashboard that 500s because a public endpoint
 * dropped a request is not a dashboard, and a labelled sample naming the RPC is more useful
 * to the reader than a stack trace. It is never silent — the whole point of the per-payload
 * `sampled` string is that it can say something this specific.
 *
 * ## Multicall, and why it is on
 *
 * The escrow and refund reads are one call per plan per field, which is dozens of round
 * trips against an endpoint that sheds. `Multicall3` is deployed on Arc at the canonical
 * address, viem batches through it automatically, and the batching turns a fan-out into a
 * handful of requests. That is the difference between "usually works" and "works".
 */
import {ARC_TESTNET_RPC_URL} from "@plazo/plan-core";
import {createPublicClient, http, keccak256, toHex, type Address, type Hex, type PublicClient} from "viem";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The addresses, read at call time and never at module load.
 *
 * Bracket access throughout — `noPropertyAccessFromIndexSignature` is on, and dotted access
 * on an index signature is the kind of typo that reads fine and returns `undefined`. Call
 * time rather than module load because every live-versus-sample assertion in the test suite
 * depends on being able to set one.
 *
 * The names match `services/indexer/ponder.config.ts` exactly. They are documented here
 * rather than in `.env.example`, following DEC-55: that file scopes itself to the operator
 * database, and a variable listed in two places is a variable one list eventually gets
 * wrong.
 *
 * - `PLAZO_ARC_RPC_URL` — optional; defaults to Arc testnet's public endpoint.
 * - `PLAZO_MERCHANT_REGISTRY_ADDRESS` — treasury.
 * - `PLAZO_SETTLEMENT_ESCROW_ADDRESS` + `PLAZO_ESCROW_PARAMETERS_ADDRESS` — held settlements
 *   and their timers. **Two variables, because the timers are on a second registry** — the
 *   three `plazo.escrow.*` rows cannot exist on the vintage-3 registry, whose `_define` is
 *   private and constructor-only (DEC-72). Reading them from the wrong one returns nothing,
 *   not a wrong number, which is the good failure of the two.
 * - `PLAZO_REFUND_ESCROW_ADDRESS` + `PLAZO_PLAN_FACTORY_ADDRESS` — the refund preview and
 *   the schedule it is previewed against.
 */
const env = (name: string): string | undefined => {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
};

const address = (name: string): Address | undefined => {
  const value = env(name);
  return value !== undefined && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as Address) : undefined;
};

export const CONTRACTS = {
  merchantRegistry: () => address("PLAZO_MERCHANT_REGISTRY_ADDRESS"),
  settlementEscrow: () => address("PLAZO_SETTLEMENT_ESCROW_ADDRESS"),
  escrowParameters: () => address("PLAZO_ESCROW_PARAMETERS_ADDRESS"),
  refundEscrow: () => address("PLAZO_REFUND_ESCROW_ADDRESS"),
  planFactory: () => address("PLAZO_PLAN_FACTORY_ADDRESS"),
} as const;

export const rpcUrl = (): string => env("PLAZO_ARC_RPC_URL") ?? ARC_TESTNET_RPC_URL;

/**
 * A client per request, not a module-level singleton.
 *
 * A memoised client would capture the RPC URL at first use, which makes the variable
 * untestable and makes a deployment's first request decide the endpoint for the life of the
 * process. Constructing one costs nothing; the transport is stateless.
 */
export function client(): PublicClient {
  return createPublicClient({
    transport: http(rpcUrl(), {
      // Arc's public RPC sheds ~25% of requests. Eight attempts with viem's backoff is what
      // makes a page load reliable; fewer is what makes it flaky in a way that reads as a
      // bug in this code.
      retryCount: 8,
      retryDelay: 150,
      timeout: 15_000,
      batch: {wait: 8},
    }),
  }) as PublicClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// ABI fragments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inline and `const`-asserted, because `packages/abi` is empty.
 *
 * The same choice `packages/checkout-embed/src/messaging.ts` made and for the same reason:
 * `abitype` turns a `const`-asserted fragment into full compile-time inference, so a field
 * name that drifts from the contract is a build error rather than an `undefined` at render.
 * What it cannot catch is a signature that drifted on chain — a stubbed transport will
 * happily answer a call to a function that no longer exists. That parity belongs to
 * `@plazo/arc-verify`, which reads live shapes on every CI run.
 *
 * The struct returns are the named-struct form DEC-33 argues for, so the field names travel
 * through the ABI into the types rather than being positional.
 */
export const MERCHANT_REGISTRY_ABI = [
  {
    type: "function",
    name: "merchantOf",
    stateMutability: "view",
    inputs: [{name: "merchant", type: "address"}],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          {name: "registered", type: "bool"},
          {name: "kybVerified", type: "bool"},
          {name: "registeredAt", type: "uint64"},
          {name: "payoutRecipient", type: "address"},
          {name: "payoutDomain", type: "uint32"},
          {name: "bond", type: "uint256"},
          {name: "withheld", type: "uint256"},
          {name: "outstandingFronted", type: "uint256"},
          {name: "bucket", type: "uint256"},
          {name: "bucketAt", type: "uint64"},
          {name: "velocityCapOverride", type: "uint256"},
          {name: "category", type: "uint8"},
        ],
      },
    ],
  },
  {
    type: "function",
    name: "requiredBond",
    stateMutability: "view",
    inputs: [{name: "merchant", type: "address"}],
    outputs: [{name: "", type: "uint256"}],
  },
  {
    type: "function",
    name: "vestingBpsFor",
    stateMutability: "view",
    inputs: [{name: "merchant", type: "address"}],
    outputs: [{name: "", type: "uint256"}],
  },
  {
    type: "function",
    name: "velocityCapFor",
    stateMutability: "view",
    inputs: [{name: "merchant", type: "address"}],
    outputs: [{name: "", type: "uint256"}],
  },
  {
    type: "function",
    name: "velocityUsed",
    stateMutability: "view",
    inputs: [{name: "merchant", type: "address"}],
    outputs: [{name: "", type: "uint256"}],
  },
  {
    type: "function",
    name: "categoryOf",
    stateMutability: "view",
    inputs: [{name: "merchant", type: "address"}],
    outputs: [{name: "", type: "uint8"}],
  },
] as const;

export const SETTLEMENT_ESCROW_ABI = [
  {
    type: "function",
    name: "escrowOf",
    stateMutability: "view",
    inputs: [{name: "planId", type: "bytes32"}],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          {name: "merchant", type: "address"},
          {name: "token", type: "address"},
          {name: "recipient", type: "address"},
          {name: "domain", type: "uint32"},
          {name: "amount", type: "uint256"},
          {name: "heldAt", type: "uint256"},
          {name: "attestedAt", type: "uint256"},
          {name: "returnedAt", type: "uint256"},
          {name: "carrierRef", type: "bytes32"},
          {name: "category", type: "uint8"},
          {name: "state", type: "uint8"},
        ],
      },
    ],
  },
  {
    type: "function",
    name: "releasableAt",
    stateMutability: "view",
    inputs: [{name: "planId", type: "bytes32"}],
    outputs: [{name: "", type: "uint256"}],
  },
  {
    type: "function",
    name: "returnableAt",
    stateMutability: "view",
    inputs: [{name: "planId", type: "bytes32"}],
    outputs: [{name: "", type: "uint256"}],
  },
  {
    type: "function",
    name: "disputeEligible",
    stateMutability: "view",
    inputs: [{name: "planId", type: "bytes32"}],
    outputs: [{name: "", type: "bool"}],
  },
] as const;

export const PARAMETER_REGISTRY_ABI = [
  {
    type: "function",
    name: "get",
    stateMutability: "view",
    inputs: [{name: "key", type: "bytes32"}],
    outputs: [{name: "", type: "uint256"}],
  },
] as const;

export const REFUND_ESCROW_ABI = [
  {
    type: "function",
    name: "voidAmountFor",
    stateMutability: "view",
    inputs: [{name: "planId", type: "bytes32"}],
    outputs: [{name: "", type: "uint256"}],
  },
  {
    type: "function",
    name: "refundPreview",
    stateMutability: "view",
    inputs: [
      {name: "planId", type: "bytes32"},
      {name: "amount", type: "uint256"},
    ],
    outputs: [
      {name: "appliedPrincipal", type: "uint256"},
      {name: "toBorrower", type: "uint256"},
      {name: "firstSuppressedIndex", type: "uint256"},
      {name: "mdrRebate", type: "uint256"},
    ],
  },
] as const;

export const PLAN_FACTORY_ABI = [
  {
    type: "function",
    name: "predictAddress",
    stateMutability: "view",
    inputs: [{name: "planId", type: "bytes32"}],
    outputs: [{name: "", type: "address"}],
  },
] as const;

export const INSTALLMENT_PLAN_ABI = [
  {type: "function", name: "principal", stateMutability: "view", inputs: [], outputs: [{name: "", type: "uint256"}]},
  {
    type: "function",
    name: "outstandingPrincipal",
    stateMutability: "view",
    inputs: [],
    outputs: [{name: "", type: "uint256"}],
  },
  {
    type: "function",
    name: "installmentCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{name: "", type: "uint256"}],
  },
  {
    type: "function",
    name: "installmentAmount",
    stateMutability: "view",
    inputs: [{name: "index", type: "uint256"}],
    outputs: [{name: "", type: "uint256"}],
  },
  {
    type: "function",
    name: "dueDate",
    stateMutability: "view",
    inputs: [{name: "index", type: "uint256"}],
    outputs: [{name: "", type: "uint256"}],
  },
  {
    type: "function",
    name: "installmentStatus",
    stateMutability: "view",
    inputs: [{name: "index", type: "uint256"}],
    outputs: [{name: "", type: "uint8"}],
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Enum decoding — ordinals are the contract, so they are named in one place
// ─────────────────────────────────────────────────────────────────────────────

/** `MerchantRegistry.SettlementCategory`. **`Escrowed` is ordinal zero** and that is D-06. */
export const SETTLEMENT_CATEGORY = ["Escrowed", "Instant"] as const;

/** `SettlementEscrow.EscrowState`. `Released` and `Returned` are both absorbing. */
export const ESCROW_STATE = ["none", "held", "attested", "released", "returned"] as const;

/**
 * `IInstallmentPlan.InstallmentStatus`, folded onto what this screen renders.
 *
 * The dashboard's `Installment.status` is `cleared | due | suppressed`, which is three
 * states against the plan's six. `Refunded` is the plan's word for suppressed; everything
 * that is not cleared and not refunded is still owed, including `Bounced` and `Missed` —
 * folding those into "due" is correct here, because a refund preview answers "what does
 * this retire" and a bounced installment is retired exactly as a pending one is. A screen
 * that needs the distinction is the collections screen, and it is not this one.
 */
export function installmentStatus(ordinal: number): "cleared" | "due" | "suppressed" {
  if (ordinal === 1) return "cleared";
  if (ordinal === 5) return "suppressed";
  return "due";
}

/** `ParameterKeys.ESCROW_*` — keccak of the dotted name, computed rather than pasted. */
export const PARAMETER_KEYS = {
  escrowAttestationDeadline: keccak256(toHex("plazo.escrow.attestationDeadline")),
  escrowReleaseTimer: keccak256(toHex("plazo.escrow.releaseTimer")),
  escrowDisputeTimelock: keccak256(toHex("plazo.escrow.disputeTimelock")),
} as const satisfies Record<string, Hex>;

/**
 * `type(uint256).max`, which `velocityCapFor` returns to mean "no cap".
 *
 * Rendered as `null` rather than as a number, because printing
 * 115792089237316195423570985008687907853269984665640564039457584007913129639935 as a
 * velocity cap is worse than printing nothing.
 */
export const UINT256_MAX = (1n << 256n) - 1n;
