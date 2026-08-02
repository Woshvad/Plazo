import {custom, pad, toHex, type Address} from "viem";
import {afterEach, describe, expect, it, vi} from "vitest";

import {limitFor, messaging} from "../src/messaging.js";

/**
 * The pre-cart widget, under jsdom with a stubbed transport.
 *
 * The stub is a real viem transport rather than a mocked `readContract`, so the ABI
 * fragment, the argument encoding and the return decoding are all exercised. What it
 * cannot check is that the fragment still matches `CheckoutRouter.sol` — a stub will
 * happily answer a call to a function that no longer exists. That parity is the live
 * read's job, and `@plazo/arc-verify` is where it belongs.
 *
 * The assertions that matter most here are negative: `$0` never appears, and nothing
 * throws when the RPC does.
 */

const MERCHANT = "0x1111111111111111111111111111111111111111" as Address;
const ROUTER = "0x2222222222222222222222222222222222222222" as Address;
const POOL = "0x3333333333333333333333333333333333333333" as Address;
const WALLET = "0x4444444444444444444444444444444444444444" as Address;

/** A transport that answers every `eth_call` with one uint256. */
function answering(value: bigint) {
  const request = vi.fn(async ({method}: {method: string}) => {
    if (method === "eth_call") return pad(toHex(value), {size: 32});
    throw new Error(`unexpected method ${method}`);
  });
  return {transport: custom({request: request as never}), request};
}

/** A transport that is simply down, which on Arc's public RPC is a quarter of calls. */
function failing() {
  const request = vi.fn(async () => {
    throw new Error("the public RPC shed this request");
  });
  return {transport: custom({request: request as never}), request};
}

function mount(): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("limitFor", () => {
  it("returns the router's figure", async () => {
    const {transport} = answering(180_000_000n);
    const limit = await limitFor({
      wallet: WALLET,
      merchant: MERCHANT,
      router: ROUTER,
      pool: POOL,
      transport,
    });
    expect(limit).toBe(180_000_000n);
  });

  it("returns zero rather than throwing when the RPC is down", async () => {
    const {transport} = failing();
    const limit = await limitFor({
      wallet: WALLET,
      merchant: MERCHANT,
      router: ROUTER,
      pool: POOL,
      transport,
    });
    expect(limit).toBe(0n);
  });

  it("calls the router and nothing else", async () => {
    const {transport, request} = answering(0n);
    await limitFor({wallet: WALLET, merchant: MERCHANT, router: ROUTER, pool: POOL, transport});

    const call = request.mock.calls[0]?.[0] as {method: string; params: unknown[]};
    expect(call.method).toBe("eth_call");
    const to = (call.params[0] as {to: string}).to.toLowerCase();
    expect(to).toBe(ROUTER.toLowerCase());
  });
});

describe("messaging", () => {
  it("renders the schedule with no wallet, no network and no error", async () => {
    const element = mount();
    await messaging({element, cartTotal: 120_000_000n, installmentCount: 4});

    expect(element.textContent).toContain("4 payments of $30.00");
    expect(element.textContent).toContain("Pay in 4 available at checkout");
  });

  it("renders the buyer's real headroom when a wallet is connected", async () => {
    const element = mount();
    const {transport} = answering(180_000_000n);
    await messaging({
      element,
      cartTotal: 120_000_000n,
      installmentCount: 4,
      wallet: WALLET,
      merchant: MERCHANT,
      router: ROUTER,
      pool: POOL,
      transport,
    });

    expect(element.textContent).toContain("4 payments of $30.00");
    expect(element.textContent).toContain("$180.00 available now with Plazo");
  });

  it("renders availability copy for a zero limit, and never $0", async () => {
    const element = mount();
    const {transport} = answering(0n);
    await messaging({
      element,
      cartTotal: 120_000_000n,
      installmentCount: 4,
      wallet: WALLET,
      merchant: MERCHANT,
      router: ROUTER,
      pool: POOL,
      transport,
    });

    const text = element.textContent ?? "";
    expect(text).toContain("available at checkout");
    // The whole point. A zero is a statement about the book, not about the buyer.
    expect(text).not.toContain("$0");
    expect(element.innerHTML).not.toContain("$0");
  });

  it("renders the wallet-free copy when the RPC rejects, without throwing", async () => {
    const element = mount();
    const {transport} = failing();

    await expect(
      messaging({
        element,
        cartTotal: 120_000_000n,
        installmentCount: 4,
        wallet: WALLET,
        merchant: MERCHANT,
        router: ROUTER,
        pool: POOL,
        transport,
      }),
    ).resolves.toBeUndefined();

    const text = element.textContent ?? "";
    expect(text).toContain("4 payments of");
    expect(text).toContain("Pay in 4 available at checkout");
    expect(text).not.toContain("$0");
  });

  it("puts the division remainder on the first installment, like the plan does", async () => {
    const element = mount();
    // 100.000001 over 4: base 25.000000, remainder 1 unit, which rides on index 0.
    await messaging({element, cartTotal: 100_000_001n, installmentCount: 4});

    const text = element.textContent ?? "";
    expect(text).toContain("4 payments of $25.00");
    expect(text).toContain("first $25.000001");

    // And it sums back to the cart total, which a silent floor would not.
    expect(25_000_001n + 3n * 25_000_000n).toBe(100_000_001n);
  });

  it("renders no remainder clause when the split is exact", async () => {
    const element = mount();
    await messaging({element, cartTotal: 100_000_000n, installmentCount: 4});
    expect(element.textContent).toContain("4 payments of $25.00");
    expect(element.textContent).not.toContain("first $");
  });

  it("replaces its previous render rather than appending", async () => {
    const element = mount();
    await messaging({element, cartTotal: 120_000_000n, installmentCount: 4});
    await messaging({element, cartTotal: 200_000_000n, installmentCount: 4});

    expect(element.querySelectorAll(".plazo-message")).toHaveLength(1);
    expect(element.textContent).toContain("$50.00");
    expect(element.textContent).not.toContain("$30.00");
  });

  it("skips the read entirely when no wallet is connected", async () => {
    const element = mount();
    const {transport, request} = answering(180_000_000n);
    await messaging({
      element,
      cartTotal: 120_000_000n,
      installmentCount: 4,
      merchant: MERCHANT,
      router: ROUTER,
      pool: POOL,
      transport,
    });

    expect(request).not.toHaveBeenCalled();
    expect(element.textContent).toContain("Pay in 4 available at checkout");
  });
});
