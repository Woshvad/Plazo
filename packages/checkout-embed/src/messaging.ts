/**
 * Pre-cart on-site messaging. CHKT-06.
 *
 * "4 payments of $30.00" is what every incumbent renders on a product page, and it is
 * arithmetic — cart total over four, computed on the merchant's server, true of nobody
 * in particular. Plazo can render the other half: the amount **this** buyer would
 * actually be approved for, right now, read from the chain. The underwriter is a pure
 * function of public state, so the number is not a prediction of a decision — it is the
 * decision, ahead of time.
 *
 * ## Why showing it discloses nothing
 *
 * `CheckoutRouter.maxPrincipalFor` is an unrestricted `external view`, and
 * `personId = keccak256(abi.encode("PLAZO.PSEUDONYMOUS", wallet))` is computable by
 * anyone. A buyer's limit is already public to anyone holding their address. Showing a
 * connected buyer their own limit discloses nothing the chain did not.
 *
 * That is not a licence to be careless, and this module obeys two rules:
 *
 * 1. **The read happens in the buyer's browser, from the buyer's connected wallet.**
 *    Never take a wallet address from the merchant's server, and never return a limit
 *    to the merchant's server. The distinction is bulk enumeration: one buyer reading
 *    their own limit is fine; a merchant harvesting limits for a mailing list is the
 *    harm PASS-09 and the Phase 3 `personId` fix exist to prevent.
 * 2. **No function here accepts an array of addresses.** There is no batch form. Adding
 *    one would be adding the enumeration primitive back, and it would arrive looking
 *    like a performance optimisation.
 *
 * ## Zero is not a number to render
 *
 * `maxPrincipalFor` returns `0` rather than a figure in four distinct cases: the pool
 * is not registered, origination is closed, the corridor is paused, or the computed
 * limit fell below `MIN_TICKET`. Three of those are statements about Plazo's book, not
 * about the buyer. Rendering "$0 available" on a public product page would turn the
 * pre-cart widget into a live gauge of whether the credit book is capitalised —
 * readable by anyone, including a competitor and including someone deciding whether now
 * is a good time to run a fraud ring. So a zero renders the availability copy, which is
 * also what an unconnected wallet renders, which is also what a failed read renders.
 * The three are deliberately indistinguishable from outside.
 *
 * ## A product page must not break
 *
 * Arc's public RPC sheds roughly a quarter of requests regardless of pacing. Every
 * failure path here renders the wallet-free copy and returns; nothing throws, and
 * nothing renders an error. A merchant's product page failing because a public endpoint
 * dropped a request would be a worse outcome than showing the arithmetic alone.
 *
 * viem's default retry (three attempts, backing off) is left alone rather than tuned
 * down. At a 25% shed rate a single attempt would lose the limit for one buyer in four;
 * three brings that under half a percent. The latency it costs is invisible, because the
 * schedule is rendered before the read starts and the limit only ever fills in a line
 * that already says something true.
 */
import {ARC_TESTNET_RPC_URL, ARC_USDC, IdentityClass, pseudonymousId, SignerClass} from "@plazo/plan-core";
import {createPublicClient, http, type Address, type Transport} from "viem";

declare global {
  interface Window {
    /** The drop-in's global, populated by whichever modules the bundle includes. */
    Plazo?: Record<string, unknown>;
  }
}

/**
 * One function, declared inline.
 *
 * `packages/abi` is empty — no artefact has been generated into it — so depending on a
 * generated type here would be depending on a file that does not exist. A const-asserted
 * fragment of the one function this module calls is smaller than the dependency and
 * gives viem the same inference. The argument list mirrors `CheckoutRouter.sol`; the
 * parity that matters is enforced by the call reverting or returning nonsense if it
 * drifts, which a test with a stub cannot catch and only the live read can.
 */
export const MAX_PRINCIPAL_FOR_ABI = [
  {
    type: "function",
    name: "maxPrincipalFor",
    stateMutability: "view",
    inputs: [
      {name: "personId", type: "bytes32"},
      {name: "identity", type: "uint8"},
      {name: "signerClass", type: "uint8"},
      {name: "merchant", type: "address"},
      {name: "token", type: "address"},
      {name: "pool_", type: "address"},
    ],
    outputs: [{name: "", type: "uint256"}],
  },
] as const;

export interface LimitOptions {
  /**
   * The buyer's own connected wallet. Singular, and singular on purpose.
   *
   * If this ever becomes `wallets`, the widget has become an enumeration endpoint.
   */
  wallet: Address;
  merchant: Address;
  /** `CheckoutRouter`. */
  router: Address;
  /** The `TranchedCreditPool` the merchant originates against. */
  pool: Address;
  /** Defaults to Arc USDC. */
  token?: Address;
  /**
   * Defaults to the EOA case, which is the conservative direction: a contract signer
   * takes the reduced cap unless a bountied `revalidate()` confirms the strip, so
   * assuming EOA can only ever quote a buyer *more* than a smart account would get.
   * A pre-cart figure that overstates by the contract discount is a worse error than
   * one that understates, so a caller who knows the wallet is a contract should say so.
   */
  signerClass?: SignerClass;
  /** Defaults to the Arc testnet public RPC. */
  transport?: Transport;
}

/**
 * The largest principal the router would approve for this buyer, right now.
 *
 * 6-decimal USDC. Returns `0n` for "no offer", which the caller must not render as a
 * figure — see the module docstring.
 *
 * @throws never for an RPC failure. It returns `0n`, because every caller in this
 * module treats a failed read and a closed gate identically and a caller who had to
 * distinguish them would be building the gauge this design refuses to build.
 */
export async function limitFor(options: LimitOptions): Promise<bigint> {
  const client = createPublicClient({
    transport: options.transport ?? http(ARC_TESTNET_RPC_URL),
  });

  try {
    return await client.readContract({
      address: options.router,
      abi: MAX_PRINCIPAL_FOR_ABI,
      functionName: "maxPrincipalFor",
      args: [
        pseudonymousId(options.wallet),
        IdentityClass.Pseudonymous,
        options.signerClass ?? SignerClass.EOA,
        options.merchant,
        options.token ?? ARC_USDC,
        options.pool,
      ],
    });
  } catch {
    return 0n;
  }
}

export interface MessagingOptions extends Partial<Omit<LimitOptions, "wallet">> {
  /** Where to render. Its contents are replaced. */
  element: HTMLElement;
  /** 6-decimal USDC. */
  cartTotal: bigint;
  installmentCount: number;
  /**
   * The buyer's connected wallet, if there is one.
   *
   * Omit it and the limit half is skipped entirely — no read, no network, no
   * derivation. The arithmetic half needs neither.
   */
  wallet?: Address;
}

interface Split {
  /** What installments 1..n-1 each cost. */
  base: bigint;
  /** What installment 0 costs. The division remainder rides here. */
  first: bigint;
}

/**
 * Split a total the way `InstallmentPlan` does, remainder and all.
 *
 * `_installmentAmountAt` is `principal / count`, with `principal % count` added to
 * index 0. A widget that floored and moved on would quote a schedule that does not sum
 * to the cart total — off by up to `count - 1` units, which is a rounding error on a
 * $120 basket and a broken promise on a receipt. The remainder is disclosed rather
 * than absorbed.
 */
function splitOf(total: bigint, count: number): Split {
  if (count <= 0) throw new RangeError(`installmentCount must be positive: ${count}`);
  const n = BigInt(count);
  const base = total / n;
  return {base, first: base + (total % n)};
}

/**
 * 6-decimal USDC as a display string, with at least two decimal places.
 *
 * A leaf formatter, deliberately: `formatUsdc6` in `plan-core` trims trailing zeros,
 * which is right for a ledger and wrong for a price — "$25" where the schedule says
 * $25.00 reads as a different number to a shopper. Anything finer than a cent is shown
 * in full rather than rounded away, because the sub-cent digits are exactly the
 * remainder this module refuses to hide.
 */
function money(value: bigint): string {
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

/** The copy for "we cannot quote you a figure here", used for all three reasons. */
const AVAILABILITY = "Pay in 4 available at checkout";

function line(text: string, kind: string): HTMLElement {
  const element = document.createElement("div");
  element.className = `plazo-message__${kind}`;
  // `textContent`, never `innerHTML`. None of these strings is attacker-controlled
  // today and none of them should become injectable if one ever is.
  element.textContent = text;
  return element;
}

/**
 * Render the pre-cart message.
 *
 * Resolves once the element has been written. The arithmetic half is rendered
 * synchronously before any network call, so a slow or dead RPC delays the limit and
 * never the price.
 */
export async function messaging(options: MessagingOptions): Promise<void> {
  const {base, first} = splitOf(options.cartTotal, options.installmentCount);

  const root = document.createElement("div");
  root.className = "plazo-message";

  const schedule =
    first === base
      ? `${options.installmentCount} payments of $${money(base)}`
      : `${options.installmentCount} payments of $${money(base)} (first $${money(first)})`;
  root.append(line(schedule, "schedule"));

  const detail = line(AVAILABILITY, "detail");
  root.append(detail);

  options.element.replaceChildren(root);

  const {wallet, merchant, router, pool} = options;
  if (!wallet || !merchant || !router || !pool) return;

  const limit = await limitFor({
    wallet,
    merchant,
    router,
    pool,
    ...(options.token === undefined ? {} : {token: options.token}),
    ...(options.signerClass === undefined ? {} : {signerClass: options.signerClass}),
    ...(options.transport === undefined ? {} : {transport: options.transport}),
  });

  // A zero and a failed read are the same sentence on purpose. See the docstring.
  if (limit > 0n) detail.textContent = `$${money(limit)} available now with Plazo`;
}

/**
 * Exposed for a merchant loading the bundle as a classic script.
 *
 * Merged rather than assigned, so this does not erase `checkout`.
 */
if (typeof window !== "undefined") {
  window.Plazo = {...(window.Plazo ?? {}), messaging, limitFor};
}
