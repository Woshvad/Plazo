/**
 * @vitest-environment node
 *
 * **Node, not jsdom, and the reason is not stylistic.** These reads run in a server
 * component and go out through viem's `http` transport, which builds a `RequestInit`
 * carrying a Node `AbortSignal`. jsdom substitutes its own `AbortSignal` on the global, the
 * two are not the same class, and every request fails with
 * `Expected signal to be an instance of AbortSignal` — retried eight times, so the symptom
 * is a five-second timeout rather than an error anyone can read. The rest of this app's
 * suite renders markup and belongs in jsdom; this file talks to a network stack.
 */

/**
 * The four payloads 06-12 left sample-only, now that 06-13 has deployed what they read.
 *
 * ## What this suite is actually checking
 *
 * Not "does a `live` flag flip". The valuable assertion here is that **`_chain.ts`'s inline
 * ABI fragments describe the same functions the Solidity does**, and it is made without
 * trusting those fragments: every selector this stub answers is derived from a
 * human-readable signature transcribed from the contract source, and every return value is
 * encoded from a type list transcribed the same way. If a field were dropped from
 * `merchantOf`'s tuple, or `refundPreview`'s four returns reordered, the decode would fail
 * or produce visibly wrong numbers — which is the whole class of defect an ABI constant
 * copied by hand is prone to.
 *
 * What it does **not** check is that the deployed bytecode still has those signatures. A
 * stubbed transport will happily answer a call to a function that no longer exists. That
 * parity belongs to `@plazo/arc-verify`, which reads live shapes on every CI run, and 06-13
 * is the plan that learned it the hard way: the live `MerchantRegistry` answered every
 * selector except `categoryOf`, which is exactly the shape that makes a stale dependency
 * invisible until every checkout reverts (finding 30, DEC-73).
 */
import {beforeEach, afterEach, describe, expect, it, vi} from "vitest";
import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toFunctionSelector,
  toHex,
  type Hex,
} from "viem";

import {escrows, refunds, treasury} from "../app/_data";

const MERCHANT = "0x00000000000000000000000000000000000acced";

/** 06-13's deployed addresses on chain 5042002. Real, so a reader can check them. */
const REGISTRY = "0x95dae25BB1C63540F4B14D74CC6Bd0ce6eBbEFbe";
const SETTLEMENT_ESCROW = "0x37246b3C63bC9ec9c18CcacC51bf2C77Dc0502DD";
const ESCROW_PARAMETERS = "0xE74d5aC797EF9c0084553430FEe6C11f1c8B0344";
const REFUND_ESCROW = "0x901BF45C12683758890ab244d1af1dF7e5C8371b";
const PLAN_FACTORY = "0x000000000000000000000000000000000000fac7";
/** Where `PlanFactory.predictAddress` says this plan lives. */
const PLAN = "0x00000000000000000000000000000000000p1a11".replace("p1a", "111") as Hex;

const PLAN_ID = "0x3a71c8e02f9d465b1e7a04c93f28d6b5079e14a3c8b60d92f5e37a1b48c609dd";

/**
 * `keccak256("plazo.escrow.releaseTimer")`, computed from the same string
 * `ParameterKeys.sol` uses rather than pasted, so the two registry rows can be told apart
 * without trusting `_chain.ts`'s copy of either.
 */
const RELEASE_TIMER_KEY = keccak256(toHex("plazo.escrow.releaseTimer")).slice(2).toLowerCase();

/**
 * Selectors, from signatures transcribed out of the Solidity rather than out of `_chain.ts`.
 *
 * This is the independence that makes the suite worth running. `toFunctionSelector` on
 * `"function merchantOf(address) view returns (...)"` computes the same four bytes the
 * contract does; if the ABI constant under test disagrees about a name or an input type,
 * viem encodes a selector this stub has never heard of and the read fails.
 */
const sel = (signature: string): Hex => toFunctionSelector(signature);

const SELECTORS = {
  merchantOf: sel("function merchantOf(address)"),
  requiredBond: sel("function requiredBond(address)"),
  vestingBpsFor: sel("function vestingBpsFor(address)"),
  velocityCapFor: sel("function velocityCapFor(address)"),
  velocityUsed: sel("function velocityUsed(address)"),
  categoryOf: sel("function categoryOf(address)"),
  escrowOf: sel("function escrowOf(bytes32)"),
  releasableAt: sel("function releasableAt(bytes32)"),
  returnableAt: sel("function returnableAt(bytes32)"),
  disputeEligible: sel("function disputeEligible(bytes32)"),
  get: sel("function get(bytes32)"),
  voidAmountFor: sel("function voidAmountFor(bytes32)"),
  refundPreview: sel("function refundPreview(bytes32,uint256)"),
  predictAddress: sel("function predictAddress(bytes32)"),
  principal: sel("function principal()"),
  outstandingPrincipal: sel("function outstandingPrincipal()"),
  installmentCount: sel("function installmentCount()"),
  installmentAmount: sel("function installmentAmount(uint256)"),
  dueDate: sel("function dueDate(uint256)"),
  installmentStatus: sel("function installmentStatus(uint256)"),
} as const;

const encode = (types: string, values: readonly unknown[]): Hex =>
  encodeAbiParameters(parseAbiParameters(types), values as never);

const UINT256_MAX = (1n << 256n) - 1n;

/** `MerchantRegistry.Merchant`, field for field, in declaration order. */
const MERCHANT_STRUCT =
  "(bool registered, bool kybVerified, uint64 registeredAt, address payoutRecipient, uint32 payoutDomain, uint256 bond, uint256 withheld, uint256 outstandingFronted, uint256 bucket, uint64 bucketAt, uint256 velocityCapOverride, uint8 category)";

/** `SettlementEscrow.Escrow`, field for field, in declaration order. */
const ESCROW_STRUCT =
  "(address merchant, address token, address recipient, uint32 domain, uint256 amount, uint256 heldAt, uint256 attestedAt, uint256 returnedAt, bytes32 carrierRef, uint8 category, uint8 state)";

/** Answers by `(to, selector)`. Anything unrecognised is a revert, loudly. */
function answer(to: string, data: Hex): Hex {
  const selector = data.slice(0, 10) as Hex;
  const at = to.toLowerCase();

  if (at === REGISTRY.toLowerCase()) {
    switch (selector) {
      case SELECTORS.merchantOf:
        return encode(MERCHANT_STRUCT, [
          {
            registered: true,
            kybVerified: true,
            registeredAt: 1_751_500_000n,
            payoutRecipient: MERCHANT,
            payoutDomain: 26,
            bond: 118_400_000n,
            withheld: 51_216_000n,
            outstandingFronted: 965_000_000n,
            bucket: 0n,
            bucketAt: 0n,
            velocityCapOverride: 0n,
            category: 0,
          },
        ]);
      case SELECTORS.requiredBond:
        return encode("uint256", [96_500_000n]);
      case SELECTORS.vestingBpsFor:
        return encode("uint256", [1000n]);
      case SELECTORS.velocityCapFor:
        return encode("uint256", [UINT256_MAX]);
      case SELECTORS.velocityUsed:
        return encode("uint256", [965_000_000n]);
      case SELECTORS.categoryOf:
        return encode("uint8", [1]);
      default:
        throw new Error(`unstubbed registry selector ${selector}`);
    }
  }

  if (at === SETTLEMENT_ESCROW.toLowerCase()) {
    switch (selector) {
      case SELECTORS.escrowOf:
        return encode(ESCROW_STRUCT, [
          {
            merchant: MERCHANT,
            token: "0x3600000000000000000000000000000000000000",
            recipient: MERCHANT,
            domain: 26,
            amount: 301_968_000n,
            heldAt: 1_754_064_100n,
            attestedAt: 0n,
            returnedAt: 0n,
            carrierRef: `0x${"0".repeat(64)}`,
            category: 0,
            state: 1,
          },
        ]);
      case SELECTORS.releasableAt:
        return encode("uint256", [0n]);
      case SELECTORS.returnableAt:
        return encode("uint256", [1_754_064_100n + 604_800n]);
      case SELECTORS.disputeEligible:
        return encode("bool", [false]);
      default:
        throw new Error(`unstubbed escrow selector ${selector}`);
    }
  }

  if (at === ESCROW_PARAMETERS.toLowerCase() && selector === SELECTORS.get) {
    // 06-13 read these back off the chain: 604800 and 259200, on the escrow registry only.
    const key = data.slice(10).toLowerCase();
    return encode("uint256", [key === RELEASE_TIMER_KEY ? 259_200n : 604_800n]);
  }

  if (at === REFUND_ESCROW.toLowerCase()) {
    switch (selector) {
      case SELECTORS.voidAmountFor:
        return encode("uint256", [824_000_000n]);
      case SELECTORS.refundPreview: {
        const amount = BigInt(`0x${data.slice(74)}`);
        const outstanding = 618_000_000n;
        const applied = amount > outstanding ? outstanding : amount;
        return encode("uint256, uint256, uint256, uint256", [
          applied,
          amount - applied,
          applied === 206_000_000n ? 3n : applied === outstanding ? 1n : UINT256_MAX,
          (applied * 4n) / 100n,
        ]);
      }
      default:
        throw new Error(`unstubbed refund selector ${selector}`);
    }
  }

  if (at === PLAN_FACTORY.toLowerCase() && selector === SELECTORS.predictAddress) {
    return encode("address", [PLAN]);
  }

  if (at === PLAN.toLowerCase()) {
    switch (selector) {
      case SELECTORS.principal:
        return encode("uint256", [824_000_000n]);
      case SELECTORS.outstandingPrincipal:
        return encode("uint256", [618_000_000n]);
      case SELECTORS.installmentCount:
        return encode("uint256", [4n]);
      case SELECTORS.installmentAmount:
        return encode("uint256", [206_000_000n]);
      case SELECTORS.dueDate: {
        const index = Number(BigInt(`0x${data.slice(10)}`));
        return encode("uint256", [BigInt(1_754_064_100 + index * 14 * 24 * 60 * 60)]);
      }
      case SELECTORS.installmentStatus: {
        const index = Number(BigInt(`0x${data.slice(10)}`));
        // Ordinal 1 is Cleared, 0 is Pending. The first is paid; the rest are owed.
        return encode("uint8", [index === 0 ? 1 : 0]);
      }
      default:
        throw new Error(`unstubbed plan selector ${selector}`);
    }
  }

  throw new Error(`unstubbed call to ${to} ${selector}`);
}

/** A JSON-RPC transport that only knows `eth_call`, and handles viem's batching. */
function stubRpc(): ReturnType<typeof vi.fn> {
  const handle = (request: {id: number; method: string; params?: unknown[]}) => {
    if (request.method !== "eth_call") {
      throw new Error(`this suite only serves eth_call, got ${request.method}`);
    }
    const call = request.params?.[0] as {to: string; data: Hex};
    return {jsonrpc: "2.0", id: request.id, result: answer(call.to, call.data)};
  };

  const spy = vi.fn(async (_url: string, init: {body: string}) => {
    const body = JSON.parse(init.body) as
      | {id: number; method: string; params?: unknown[]}
      | {id: number; method: string; params?: unknown[]}[];
    const result = Array.isArray(body) ? body.map(handle) : handle(body);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {"content-type": "application/json"},
    });
  });

  vi.stubGlobal("fetch", spy);
  return spy as unknown as ReturnType<typeof vi.fn>;
}

const CHAIN_ENV = [
  "PLAZO_ARC_RPC_URL",
  "PLAZO_MERCHANT_ADDRESS",
  "PLAZO_MERCHANT_REGISTRY_ADDRESS",
  "PLAZO_SETTLEMENT_ESCROW_ADDRESS",
  "PLAZO_ESCROW_PARAMETERS_ADDRESS",
  "PLAZO_REFUND_ESCROW_ADDRESS",
  "PLAZO_PLAN_FACTORY_ADDRESS",
] as const;

function configure() {
  process.env["PLAZO_ARC_RPC_URL"] = "https://rpc.example-arc.test";
  process.env["PLAZO_MERCHANT_ADDRESS"] = MERCHANT;
  process.env["PLAZO_MERCHANT_REGISTRY_ADDRESS"] = REGISTRY;
  process.env["PLAZO_SETTLEMENT_ESCROW_ADDRESS"] = SETTLEMENT_ESCROW;
  process.env["PLAZO_ESCROW_PARAMETERS_ADDRESS"] = ESCROW_PARAMETERS;
  process.env["PLAZO_REFUND_ESCROW_ADDRESS"] = REFUND_ESCROW;
  process.env["PLAZO_PLAN_FACTORY_ADDRESS"] = PLAN_FACTORY;
}

beforeEach(() => {
  for (const name of CHAIN_ENV) delete process.env[name];
  vi.unstubAllGlobals();
});

afterEach(() => {
  for (const name of CHAIN_ENV) delete process.env[name];
  vi.unstubAllGlobals();
});

describe("nothing configured", () => {
  it("stays sampled and reaches no network", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    for (const payload of [await treasury(), await escrows([PLAN_ID]), await refunds([PLAN_ID])]) {
      expect(payload.live).toBe(false);
      expect(payload.source).toBe("chain");
      expect(payload.sampled.length).toBeGreaterThan(0);
    }
    // DEC-68's rule survives: an unconfigured deployment makes no call it cannot make.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("treasury, read from MerchantRegistry", () => {
  it("is live and carries the row", async () => {
    configure();
    stubRpc();

    const book = await treasury();
    expect(book.live).toBe(true);
    expect(book.sampled).toBe("");
    expect(book.bond).toBe("118400000");
    expect(book.bondFromWithholding).toBe("51216000");
    expect(book.requiredBond).toBe("96500000");
    expect(book.outstandingFronted).toBe("965000000");
    expect(book.vestingBps).toBe(1000);
    expect(book.domain).toBe(26);
    expect(book.kybVerified).toBe(true);
    expect(book.registeredAt).toBe(1_751_500_000);
  });

  it("renders an uncapped velocity as null rather than as 2^256-1", async () => {
    configure();
    stubRpc();
    // Printing 115792089237316195423570985008687907853269984665640564039457584007913129639935
    // as a velocity cap is worse than printing nothing.
    expect((await treasury()).velocityCap).toBeNull();
  });

  it("takes the settlement category from categoryOf, not from the stored struct field", async () => {
    configure();
    stubRpc();
    // The stub's struct says 0 (Escrowed) and `categoryOf` says 1 (Instant). The screen
    // must show the one the router will act on — 06-13's finding 30 is what this guards.
    expect((await treasury()).settlementCategory).toBe("Instant");
  });

  /**
   * The failure here is a JSON-RPC error rather than a dropped socket, and that is a
   * property of the test rather than of the code.
   *
   * A dropped socket is what Arc's public endpoint actually does, and viem retries it eight
   * times with exponential backoff — roughly forty seconds of budget, which is the point of
   * having it and is not something to sit through in a unit test. A JSON-RPC error is not
   * retryable, so it exercises the same `catch` immediately. What is *not* asserted here is
   * the retry budget itself; that is measured against the live endpoint, not stubbed.
   */
  it("falls back to a named sample when the chain read fails", async () => {
    configure();
    vi.stubGlobal("fetch", async (_url: string, init: {body: string}) => {
      const body = JSON.parse(init.body) as {id: number} | {id: number}[];
      const error = (r: {id: number}) => ({
        jsonrpc: "2.0",
        id: r.id,
        error: {code: -32000, message: "header not found"},
      });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(error) : error(body)), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    });

    const book = await treasury();
    expect(book.live).toBe(false);
    // Not silent, and specific enough to act on: the reader can tell an outage from a
    // misconfiguration without opening a console.
    expect(book.sampled).toContain("the chain read failed");
    expect(book.sampled).toContain("https://rpc.example-arc.test");
  });
});

describe("escrow rows, read from SettlementEscrow", () => {
  it("is live, and the timers come from the escrow registry", async () => {
    configure();
    stubRpc();

    const held = await escrows([PLAN_ID]);
    expect(held.live).toBe(true);
    // DEC-72: these three rows exist only on the escrow-only registry, and 06-13 read
    // 604800 / 259200 back off the chain.
    expect(held.attestationDeadlineSeconds).toBe(604_800);
    expect(held.releaseTimerSeconds).toBe(259_200);
  });

  it("decodes the row and names the state by its ordinal", async () => {
    configure();
    stubRpc();

    const [row] = (await escrows([PLAN_ID])).escrows;
    expect(row).toBeDefined();
    expect(row!.amount).toBe("301968000");
    expect(row!.state).toBe("held");
    expect(row!.attestedAt).toBe(0);
    expect(row!.returnableAt).toBe(1_754_064_100 + 604_800);
    // Zero bytes32 is "never attested", and rendering it as a commitment would be a lie
    // with 64 characters of authority.
    expect(row!.carrierRef).toBeNull();
    expect(row!.disputeEligible).toBe(false);
  });

  it("carries no external id, because the join lives in the operator database", async () => {
    configure();
    stubRpc();
    // `page.tsx` joins it back from the settlements payload. A chain read cannot.
    expect((await escrows([PLAN_ID])).escrows[0]!.externalId).toBeNull();
  });

  it("is live and empty when the book names no escrowed plan", async () => {
    configure();
    const spy = stubRpc();
    const held = await escrows([]);
    expect(held.live).toBe(true);
    expect(held.escrows).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("refund previews, read from RefundEscrow", () => {
  it("is live and reads the schedule off the plan", async () => {
    configure();
    stubRpc();

    const {candidates, live} = await refunds([PLAN_ID]);
    expect(live).toBe(true);
    const candidate = candidates[0]!;
    expect(candidate.principal).toBe("824000000");
    expect(candidate.outstandingPrincipal).toBe("618000000");
    expect(candidate.voidAmount).toBe("824000000");
    expect(candidate.schedule).toHaveLength(4);
    expect(candidate.schedule[0]!.status).toBe("cleared");
    expect(candidate.schedule[3]!.status).toBe("due");
  });

  it("answers for the amount the merchant actually typed", async () => {
    configure();
    stubRpc();

    const {candidates} = await refunds([PLAN_ID], "206000000");
    const preview = candidates[0]!.previews.find((p) => p.amount === "206000000");
    expect(preview).toBeDefined();
    expect(preview!.appliedPrincipal).toBe("206000000");
    expect(preview!.firstSuppressedIndex).toBe(3);
    expect(preview!.isVoid).toBe(false);
  });

  it("marks the void amount as a void and returns the borrower's paid principal", async () => {
    configure();
    stubRpc();

    const {candidates} = await refunds([PLAN_ID]);
    const voided = candidates[0]!.previews.find((p) => p.isVoid);
    expect(voided).toBeDefined();
    expect(voided!.amount).toBe("824000000");
    expect(voided!.appliedPrincipal).toBe("618000000");
    expect(voided!.toBorrower).toBe("206000000");
  });

  it("turns the contract's 'suppresses nothing' sentinel into null", async () => {
    configure();
    stubRpc();

    // The contract returns `type(uint256).max`. A screen printing that as an installment
    // index would be printing a number nobody can read as if it meant something.
    const {candidates} = await refunds([PLAN_ID], "1000000");
    const preview = candidates[0]!.previews.find((p) => p.amount === "1000000");
    expect(preview!.firstSuppressedIndex).toBeNull();
  });

  it("drops a plan whose void amount reverts, rather than offering a refund of it", async () => {
    configure();
    vi.stubGlobal("fetch", async (_url: string, init: {body: string}) => {
      const body = JSON.parse(init.body) as {id: number} | {id: number}[];
      const one = Array.isArray(body) ? body[0]! : body;
      return new Response(
        JSON.stringify(
          Array.isArray(body)
            ? body.map((r) => ({jsonrpc: "2.0", id: r.id, error: {code: 3, message: "execution reverted"}}))
            : {jsonrpc: "2.0", id: one.id, error: {code: 3, message: "execution reverted"}},
        ),
        {status: 200, headers: {"content-type": "application/json"}},
      );
    });

    // `voidAmountFor` reverts with PlanNotVoidable on a settled plan. That revert is the
    // filter — a terminal plan is not an answer to "what can I refund".
    const {candidates, live} = await refunds([PLAN_ID]);
    expect(live).toBe(true);
    expect(candidates).toHaveLength(0);
  });

  it("stays a lookup keyed by amount, and never computes a preview itself", async () => {
    configure();
    const spy = stubRpc();

    await refunds([PLAN_ID], "206000000");

    // DEC-71: every preview on the screen came back from `refundPreview`. If any were
    // arithmetic this count would be lower than the number of previews rendered.
    const calls = spy.mock.calls.flatMap(([, init]) => {
      const body = JSON.parse((init as {body: string}).body) as unknown;
      return Array.isArray(body) ? body : [body];
    }) as {params?: [{data: Hex}]}[];
    const previews = calls.filter((c) => c.params?.[0]?.data.startsWith(SELECTORS.refundPreview));
    expect(previews.length).toBeGreaterThanOrEqual(3);
  });
});
