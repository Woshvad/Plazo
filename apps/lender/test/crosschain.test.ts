/**
 * XCH-01's tests.
 *
 * Three things are worth asserting here and the rest is scaffolding around them:
 *
 * 1. **A Gateway balance string never reaches a float.** `"0.368700"` is six decimals of
 *    USDC and `368700n` is the only correct reading of it. The wrong answer is
 *    well-formed and silent, which is why there is also a grep gate.
 * 2. **The burn intent's field ordering matches Circle's own source.** EIP-712 hashes
 *    fields in declaration order, so a transposition is a signature Gateway rejects — or
 *    accepts against fields the lender did not read.
 * 3. **A multisig lender is told, before they try, that Gateway will not serve them.**
 */

import {beforeEach, describe, expect, it, vi} from "vitest";

import {ARC_CCTP_DOMAIN, GATEWAY_API_TESTNET_BASE_URL, usdc6} from "@plazo/plan-core";

import {
  BURN_INTENT_FIELDS,
  CIRCLE_TYPEHASHES,
  GATEWAY_EIP712_DOMAIN,
  SIGNER_KINDS,
  TRANSFER_SPEC_FIELDS,
  TRANSFER_SPEC_VERSION,
  TYPE_STRINGS,
  arcInboundSpec,
  buildBurnIntent,
  burnIntentSelfCheck,
  cctpDepositPlan,
  cctpRedeemPlan,
  encodeTypeString,
  expirationHeightFor,
  gatewayDomains,
  signerClassAdvice,
  unifiedBalance,
} from "../app/_crosschain";

const LENDER = "0xF4ee61950B63cCA5C82f1146484d018Ac95Bd0F2" as const;
const SALT = `0x${"ab".repeat(32)}` as `0x${string}`;

/** The `/v1/info` shape, trimmed to two domains. Captured live on 2026-08-02. */
const INFO_BODY = {
  version: 1,
  domains: [
    {
      chain: "Base",
      network: "Sepolia",
      domain: 6,
      walletContract: {address: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9", supportedTokens: ["USDC"]},
      minterContract: {address: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B", supportedTokens: ["USDC"]},
      processedHeight: "44934224",
      burnIntentExpirationHeight: "45237309",
    },
    {
      chain: "ARC",
      network: "Testnet",
      domain: 26,
      walletContract: {address: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9", supportedTokens: ["USDC"]},
      minterContract: {address: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B", supportedTokens: ["USDC"]},
      processedHeight: "54863401",
      burnIntentExpirationHeight: "56073002",
    },
  ],
};

function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  delete process.env["PLAZO_GATEWAY_API_URL"];
});

// ─────────────────────────────────────────────────────────────────────────────

describe("gatewayDomains", () => {
  it("returns the labelled sample when PLAZO_GATEWAY_API_URL is unset", async () => {
    const info = await gatewayDomains();
    expect(info.live).toBe(false);
    expect(info.domains).toHaveLength(13);
    expect(info.domains.map((d) => d.domain)).toContain(ARC_CCTP_DOMAIN);
  });

  it("reaches no network at all when unconfigured", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await gatewayDomains();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns live: true when a stubbed fetch answers", async () => {
    stubFetch(INFO_BODY);
    const info = await gatewayDomains({baseUrl: GATEWAY_API_TESTNET_BASE_URL});
    expect(info.live).toBe(true);
    expect(info.domains.map((d) => d.chain)).toEqual(["Base", "ARC"]);
  });

  it("reads the environment at call time, not at module load", async () => {
    stubFetch(INFO_BODY);
    process.env["PLAZO_GATEWAY_API_URL"] = GATEWAY_API_TESTNET_BASE_URL;
    const info = await gatewayDomains();
    expect(info.live).toBe(true);
  });

  it("reads maxBlockHeight from the payload rather than a lookahead", async () => {
    stubFetch(INFO_BODY);
    const info = await gatewayDomains({baseUrl: GATEWAY_API_TESTNET_BASE_URL});
    expect(expirationHeightFor(info, ARC_CCTP_DOMAIN)).toBe(56_073_002n);
    expect(() => expirationHeightFor(info, 99)).toThrow(/does not list domain 99/);
  });
});

describe("unifiedBalance", () => {
  it('parses "0.368700" to 368700n', async () => {
    stubFetch({
      token: "USDC",
      balances: [{domain: 26, depositor: LENDER, balance: "0.368700", pendingBatch: "0.060300"}],
    });
    const result = await unifiedBalance(
      {token: "USDC", sources: [{domain: 26, depositor: LENDER}]},
      {baseUrl: GATEWAY_API_TESTNET_BASE_URL},
    );
    expect(result.balances[0]?.balance).toBe(368_700n);
    expect(result.balances[0]?.pendingBatch).toBe(60_300n);
    expect(result.live).toBe(true);
  });

  it('parses a bare "0" and sums across domains', async () => {
    stubFetch({
      token: "USDC",
      balances: [
        {domain: 26, depositor: LENDER, balance: "0", pendingBatch: "0"},
        {domain: 6, depositor: LENDER, balance: "1250.5", pendingBatch: "0"},
      ],
    });
    const result = await unifiedBalance(
      {token: "USDC", sources: [{domain: 26, depositor: LENDER}]},
      {baseUrl: GATEWAY_API_TESTNET_BASE_URL},
    );
    expect(result.total).toBe(1_250_500_000n);
  });

  it("rejects a balance carrying more precision than USDC has, rather than truncating", async () => {
    stubFetch({
      token: "USDC",
      balances: [{domain: 26, depositor: LENDER, balance: "0.3687001", pendingBatch: "0"}],
    });
    await expect(
      unifiedBalance(
        {token: "USDC", sources: [{domain: 26, depositor: LENDER}]},
        {baseUrl: GATEWAY_API_TESTNET_BASE_URL},
      ),
    ).rejects.toThrow(/7 decimal places/);
  });

  it("returns an empty live: false payload when unconfigured", async () => {
    const result = await unifiedBalance({token: "USDC", sources: []});
    expect(result.live).toBe(false);
    expect(result.total).toBe(0n);
  });
});

describe("buildBurnIntent", () => {
  it("reproduces Circle's TransferSpec type string byte-for-byte", () => {
    expect(encodeTypeString("TransferSpec", TRANSFER_SPEC_FIELDS)).toBe(TYPE_STRINGS.transferSpec);
  });

  it("reproduces Circle's BurnIntent type string byte-for-byte", () => {
    const composed =
      encodeTypeString("BurnIntent", BURN_INTENT_FIELDS) + TYPE_STRINGS.transferSpec;
    expect(composed).toBe(TYPE_STRINGS.burnIntent);
  });

  it("keeps the fourteen TransferSpec fields in declaration order", () => {
    expect(TRANSFER_SPEC_FIELDS.map((f) => f.name)).toEqual([
      "version",
      "sourceDomain",
      "destinationDomain",
      "sourceContract",
      "destinationContract",
      "sourceToken",
      "destinationToken",
      "sourceDepositor",
      "destinationRecipient",
      "sourceSigner",
      "destinationCaller",
      "value",
      "salt",
      "hookData",
    ]);
  });

  it("omits chainId and verifyingContract from the domain, as Circle's contract does", () => {
    expect(Object.keys(GATEWAY_EIP712_DOMAIN)).toEqual(["name", "version"]);
    expect(GATEWAY_EIP712_DOMAIN.name).toBe("GatewayWallet");
  });

  it("carries the typehashes Circle's source declares", () => {
    expect(CIRCLE_TYPEHASHES.transferSpec).toMatch(/^0x[0-9a-f]{64}$/);
    expect(CIRCLE_TYPEHASHES.burnIntent).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("assembles typed data with the height it was handed", () => {
    const spec = arcInboundSpec({
      sourceDomain: 6,
      depositor: LENDER,
      arcRecipient: LENDER,
      value: usdc6(1_000_000n),
      salt: SALT,
    });
    const intent = buildBurnIntent({maxBlockHeight: 45_237_309n, maxFee: 0n, spec});
    expect(intent.primaryType).toBe("BurnIntent");
    expect(intent.message.maxBlockHeight).toBe(45_237_309n);
    expect(intent.message.spec.destinationDomain).toBe(ARC_CCTP_DOMAIN);
    expect(intent.message.spec.version).toBe(TRANSFER_SPEC_VERSION);
  });

  it("left-pads every address in the spec to 32 bytes", () => {
    const spec = arcInboundSpec({
      sourceDomain: 6,
      depositor: LENDER,
      arcRecipient: LENDER,
      value: usdc6(1_000_000n),
      salt: SALT,
    });
    expect(spec.destinationRecipient).toBe(`0x${"0".repeat(24)}${LENDER.slice(2)}`);
    expect(spec.destinationRecipient).toHaveLength(66);
  });

  it("refuses a transfer to its own domain", () => {
    const spec = arcInboundSpec({
      sourceDomain: 6,
      depositor: LENDER,
      arcRecipient: LENDER,
      value: usdc6(1_000_000n),
      salt: SALT,
    });
    expect(() =>
      buildBurnIntent({maxBlockHeight: 1n, maxFee: 0n, spec: {...spec, sourceDomain: 26}}),
    ).toThrow(/own domain/);
  });
});

describe("burnIntentSelfCheck", () => {
  it("passes when Gateway's 400 names a signed burn intent", async () => {
    stubFetch(
      {
        success: false,
        message: "Invalid request: body: At least one signed burn intent or burn intent set is required",
      },
      400,
    );
    const result = await burnIntentSelfCheck({baseUrl: GATEWAY_API_TESTNET_BASE_URL});
    expect(result.ok).toBe(true);
    expect(result.status).toBe(400);
  });

  it("fails when the rejection is about a malformed body instead", async () => {
    stubFetch({success: false, message: "Unexpected token in JSON at position 0"}, 400);
    const result = await burnIntentSelfCheck({baseUrl: GATEWAY_API_TESTNET_BASE_URL});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.because).toMatch(/no longer be the one it parses/);
  });
});

describe("the CCTP two-step (D-14)", () => {
  it("names domain 26 as the destination and left-pads the recipient", () => {
    const plan = cctpDepositPlan({fromDomain: 6, amount: usdc6(5_000_000n), arcRecipient: LENDER});
    expect(plan.route).toBe("cctp-two-step");
    expect(plan.steps[0]?.args["destinationDomain"]).toBe("26");
    expect(plan.steps[0]?.args["mintRecipient"]).toBe(`0x${"0".repeat(24)}${LENDER.slice(2)}`);
    expect(plan.steps[1]?.call).toBe("TranchedCreditPool.requestDeposit");
    expect(plan.amount).toBe("5");
  });

  it("says on the same plan that a deposit confers no claim until the epoch closes", () => {
    const plan = cctpDepositPlan({fromDomain: 6, amount: usdc6(1n), arcRecipient: LENDER});
    expect(plan.caveats.join(" ")).toMatch(/epoch closes/);
  });

  it("names maxFee 0 and minFinalityThreshold 2000 on the way out", () => {
    const plan = cctpRedeemPlan({toDomain: 6, amount: usdc6(1_000_000n), recipient: LENDER});
    const burn = plan.steps[1];
    expect(burn?.args["maxFee"]).toBe("0");
    expect(burn?.args["minFinalityThreshold"]).toBe("2000");
    expect(plan.fee).toBe("zero from Arc to every domain");
  });

  it("refuses a redemption to Arc's own domain, which has no CCTP route", () => {
    expect(() =>
      cctpRedeemPlan({toDomain: ARC_CCTP_DOMAIN, amount: usdc6(1n), recipient: LENDER}),
    ).toThrow(/self-domain/);
  });
});

describe("signerClassAdvice", () => {
  it("gives an EOA both routes", () => {
    const advice = signerClassAdvice("eoa");
    expect(advice.routes).toEqual(["gateway", "cctp-two-step"]);
    expect(advice.gatewayAvailable).toBe(true);
    expect(advice.reason.length).toBeGreaterThan(0);
  });

  it("gives a Safe the CCTP two-step and a non-empty reason", () => {
    const advice = signerClassAdvice("safe");
    expect(advice.routes).toEqual(["cctp-two-step"]);
    expect(advice.gatewayAvailable).toBe(false);
    expect(advice.reason).toMatch(/EOA signatures only/);
  });

  it("never leaves any signer class without a route", () => {
    for (const kind of SIGNER_KINDS) {
      expect(signerClassAdvice(kind).routes.length).toBeGreaterThan(0);
    }
  });
});
