import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

import {keccak256, stringToHex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {describe, expect, it} from "vitest";
import type {Hex} from "viem";

import {createFxApi, NotComposed, type FxIdentity, type FxKeyVerifier} from "../src/api.js";
import {FxConfigError, readFxConfig} from "../src/config.js";
import {
  corridorOf,
  CORRIDOR_LABEL,
  FX_PARAMETER_KEYS,
  MID_PRIMARY_TYPE,
  MID_TYPEHASH,
  MID_TYPES,
  MID_TYPE_STRING,
  midTypedData,
  signMid,
  type FxParameterReader,
} from "../src/mid.js";
import {StableFxClient, type FetchLike} from "../src/stablefx.js";
import {
  AmmQuoteVenue,
  EURC_CORRIDOR,
  FxVenueNotConfigured,
  resolveFxVenue,
  StableFxVenue,
  StubVenue,
} from "../src/venue.js";
import {REFERENCE_QUOTE, TRADABLE_QUOTE, TRADABLE_TYPED_DATA} from "./fixtures/stablefx.js";

const REPO = new URL("../../../", import.meta.url);

function solidity(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, REPO)), "utf8");
}

/** Blank out `///`, `//` and `/* … *\/` so a comment cannot satisfy an assertion. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

function serving(body: unknown): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), {status: 200, headers: {"Content-Type": "application/json"}});
}

/** A registry double. One row, injected, so the clamp is provable without a chain. */
function registry(rows: Record<Hex, bigint>): FxParameterReader {
  return {
    get: async (key) => {
      const value = rows[key];
      if (value === undefined) throw new Error(`no row for ${key}`);
      return value;
    },
  };
}

const SIGNER: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const GUARD = "0x2222222222222222222222222222222222222222" as const;

describe("resolveFxVenue refuses by default, and says which venue came up", () => {
  it("returns StubVenue with no key, and names it in the banner", () => {
    const lines: string[] = [];
    const resolved = resolveFxVenue({
      config: readFxConfig({PLAZO_ENVIRONMENT: "sandbox"}),
      log: (line) => lines.push(line),
    });

    expect(resolved.venue).toBeInstanceOf(StubVenue);
    expect(resolved.venue.name).toBe("StubVenue");
    expect(resolved.banner).toContain("StubVenue");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("StubVenue");
  });

  it("returns StableFxVenue when a matching key is present, and says so unconditionally", () => {
    const lines: string[] = [];
    const resolved = resolveFxVenue({
      config: readFxConfig({
        PLAZO_ENVIRONMENT: "sandbox",
        PLAZO_STABLEFX_API_KEY: "TEST_API_KEY:a:b",
      }),
      log: (line) => lines.push(line),
    });

    expect(resolved.venue).toBeInstanceOf(StableFxVenue);
    expect(resolved.banner).toContain("StableFxVenue");
    expect(resolved.banner).toContain("sandbox");
    expect(lines).toHaveLength(1);
  });

  it("refuses to resolve at all when a LIVE key meets a sandbox deployment", () => {
    expect(() =>
      resolveFxVenue({
        config: readFxConfig({
          PLAZO_ENVIRONMENT: "sandbox",
          PLAZO_STABLEFX_API_KEY: "LIVE_API_KEY:a:b",
        }),
      }),
    ).toThrow(FxConfigError);

    try {
      readFxConfig({PLAZO_ENVIRONMENT: "sandbox", PLAZO_STABLEFX_API_KEY: "LIVE_API_KEY:a:b"});
      expect.unreachable("a LIVE key under sandbox must not resolve");
    } catch (error) {
      // Both sides named, so an operator knows which of the two to change.
      expect((error as Error).message).toContain("LIVE");
      expect((error as Error).message).toContain("sandbox");
    }
  });
});

describe("StubVenue cannot produce a number on any path", () => {
  it("throws, naming the missing credential and the access track", async () => {
    const stub = new StubVenue();
    await expect(stub.quote(EURC_CORRIDOR, "407.00", "tradable")).rejects.toThrow(FxVenueNotConfigured);

    const error = await stub.quote(EURC_CORRIDOR, "407.00", "reference").catch((e: unknown) => e);
    expect((error as FxVenueNotConfigured).missing).toBe("PLAZO_STABLEFX_API_KEY");
    expect((error as FxVenueNotConfigured).accessTrack).toContain("KYB/AML");
    expect(stub.supports(EURC_CORRIDOR)).toBe(false);
  });

  it("has no code path that answers a rate — the source contains no rate literal", () => {
    const source = stripComments(readFileSync(fileURLToPath(new URL("../src/venue.ts", import.meta.url)), "utf8"));
    expect(source).not.toMatch(/fallbackRate|defaultRate/i);
    expect(source).not.toMatch(/\?\?\s*1(\D|$)/);
    expect(source).not.toMatch(/return\s+1(\D|$)/);
  });

  it("AmmQuoteVenue reports unavailable, because finding 34 found no venue at all", async () => {
    const amm = new AmmQuoteVenue(undefined);
    expect(amm.supports(EURC_CORRIDOR)).toBe(false);
    await expect(amm.quote(EURC_CORRIDOR, "407.00", "reference")).rejects.toThrow(FxVenueNotConfigured);
  });
});

describe("the Permit2 domain is passed through, never rebuilt", () => {
  it("returns the venue's typedData byte-identical to what arrived", async () => {
    const venue = new StableFxVenue(
      new StableFxClient({
        baseUrl: "https://api-sandbox.circle.com",
        apiKey: "TEST_API_KEY:a:b",
        fetch: serving(TRADABLE_QUOTE),
      }),
    );

    const quote = await venue.quote(EURC_CORRIDOR, "407.00", "tradable");

    // Deep equality against the fixture. A locally rebuilt domain that happened to agree
    // today would still be a different object tomorrow, which is the whole of E-04.
    expect(quote.typedData).toEqual(TRADABLE_TYPED_DATA);
    expect(quote.typedData?.domain.verifyingContract).toBe(TRADABLE_TYPED_DATA.domain.verifyingContract);
    expect(quote.rate).toBe(TRADABLE_QUOTE.rate);
    expect(quote.venue).toBe("StableFxVenue");
  });

  it("carries no typedData on a reference quote, because nothing is committed", async () => {
    const venue = new StableFxVenue(
      new StableFxClient({
        baseUrl: "https://api-sandbox.circle.com",
        apiKey: "TEST_API_KEY:a:b",
        fetch: serving(REFERENCE_QUOTE),
      }),
    );

    const quote = await venue.quote(EURC_CORRIDOR, "407.00", "reference");
    expect(quote.typedData).toBeUndefined();
    expect(quote.type).toBe("reference");
  });

  it("constructs no EIP-712 domain of its own anywhere in venue.ts", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/venue.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/buildDomain|makeDomain/i);
    expect(source).not.toMatch(/verifyingContract\s*:/);
  });
});

describe("the mid's typed data is proven equal to the Solidity, not transcribed", () => {
  const source = solidity("contracts/src/libraries/FxMidAttestation.sol");

  /**
   * The type string the Solidity hashes, read out of `MID_TYPEHASH`'s own `keccak256`
   * literal. Compared by hash rather than by eye — DEC-37 is what an assumed domain costs,
   * and a hash comparison is cheap.
   */
  it("hashes MID_TYPE_STRING to the same value as the Solidity MID_TYPEHASH literal", () => {
    const literal = /MID_TYPEHASH\s*=\s*keccak256\(\s*((?:"[^"]*"\s*)+)\)/.exec(source);
    expect(literal).not.toBeNull();
    const solidityTypeString = [...literal![1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");

    expect(MID_TYPE_STRING).toBe(solidityTypeString);
    expect(MID_TYPEHASH).toBe(keccak256(stringToHex(solidityTypeString)));
  });

  /**
   * The stronger half. The typehash literal and the struct are two declarations in one
   * file and they can disagree with each other; the Solidity header says field order is
   * part of the commitment and that transposing two fields of the same ABI width changes
   * nothing the compiler can see. So the struct is read and the type string rebuilt from
   * it. Permuting two fields of `Mid` turns this red.
   */
  it("rebuilds the same type string from the Solidity struct's declaration order", () => {
    const body = /struct\s+Mid\s*\{([\s\S]*?)\n\s*\}/.exec(source);
    expect(body).not.toBeNull();
    const fields = [...stripComments(body![1]!).matchAll(/(\w+)\s+(\w+)\s*;/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );

    expect(fields).toHaveLength(MID_TYPES[MID_PRIMARY_TYPE].length);
    expect(`${MID_PRIMARY_TYPE}(${fields.join(",")})`).toBe(MID_TYPE_STRING);
  });

  it("names the guard as the verifying contract and Plazo/1 as the domain", () => {
    const typed = midTypedData(
      {
        corridor: corridorOf("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"),
        fromToken: "0x3600000000000000000000000000000000000000",
        toToken: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
        midE18: 921_840_000_000_000_000n,
        validUntil: 1_785_312_000n,
        sessionId: `0x${"11".repeat(32)}`,
      },
      5_042_002,
      GUARD,
    );

    expect(typed.domain.name).toBe("Plazo");
    expect(typed.domain.version).toBe("1");
    expect(typed.domain.verifyingContract).toBe(GUARD);
    expect(typed.primaryType).toBe("FxMidAttestation");
    // The Solidity derives its separator from the four fields every call; so does this.
    expect(stripComments(source)).toContain("DOMAIN_TYPEHASH");
    expect(stripComments(source)).not.toContain("DOMAIN_SEPARATOR =");
  });
});

describe("corridorOf mirrors the one derivation there is", () => {
  /**
   * `keccak256(abi.encode("PLAZO.CORRIDOR", token))`, measured against solc 0.8.30 rather
   * than assumed: the literal encodes as a dynamic `string` (offset, address, length 14,
   * bytes), not packed into a word. The two encodings both look right in source and
   * produce different ids, and a wrong id pauses a corridor nothing checks.
   */
  it("derives the EURC corridor id solc produces", () => {
    expect(corridorOf("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a")).toBe(
      "0x06a603b94797047ac2a8a8db42b1ee240f458cfe4f226c3a36e2d3e958625310",
    );
  });

  it("reads the same formula out of CheckoutRouter, so a change there is caught here", () => {
    const router = stripComments(solidity("contracts/src/CheckoutRouter.sol"));
    expect(router).toMatch(/function\s+corridorOf\s*\(\s*address\s+token\s*\)/);
    expect(router).toContain(`keccak256(abi.encode("${CORRIDOR_LABEL}", token))`);
  });
});

describe("signMid validates first and clamps second", () => {
  const base = {
    corridor: corridorOf("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"),
    fromToken: "0x3600000000000000000000000000000000000000",
    toToken: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    rate: "0.92184",
    sessionId: `0x${"22".repeat(32)}` as Hex,
  } as const;

  it("cuts an over-long TTL down to the registry row rather than signing it", async () => {
    const signed = await signMid(
      {...base, ttlSeconds: 3600n},
      {
        chainId: 5_042_002,
        guard: GUARD,
        privateKey: SIGNER,
        parameters: registry({[FX_PARAMETER_KEYS.midMaxTtl]: 90n}),
        now: 1_785_312_000n,
      },
    );

    expect(signed.clamped).toBe(true);
    expect(signed.maxTtlSeconds).toBe(90n);
    expect(signed.mid.validUntil).toBe(1_785_312_090n);
    expect(signed.mid.midE18).toBe(921_840_000_000_000_000n);
  });

  it("leaves a TTL inside the row alone, and the signature recovers to the signer", async () => {
    const options = {
      chainId: 5_042_002,
      guard: GUARD,
      privateKey: SIGNER,
      parameters: registry({[FX_PARAMETER_KEYS.midMaxTtl]: 90n}),
      now: 1_785_312_000n,
    } as const;
    const signed = await signMid({...base, ttlSeconds: 30n}, options);

    expect(signed.clamped).toBe(false);
    expect(signed.mid.validUntil).toBe(1_785_312_030n);

    const account = privateKeyToAccount(SIGNER);
    const expected = await account.signTypedData(midTypedData(signed.mid, 5_042_002, GUARD));
    expect(signed.signature).toBe(expected);
  });

  it("refuses a rate that is not an unsigned decimal string, before anything is signed", async () => {
    await expect(
      signMid(
        {...base, rate: "not-a-rate", ttlSeconds: 30n},
        {
          chainId: 5_042_002,
          guard: GUARD,
          privateKey: SIGNER,
          parameters: registry({[FX_PARAMETER_KEYS.midMaxTtl]: 90n}),
          now: 1_785_312_000n,
        },
      ),
    ).rejects.toThrow();
  });
});

describe("the api answers 501 naming its owner when a seam is unfilled", () => {
  const verifier: FxKeyVerifier = {
    verify: async (presented) => {
      if (presented !== "plazo_test_k1_secret") throw new Error("no");
      return {merchantId: "m_1", environment: "sandbox"} satisfies FxIdentity;
    },
  };

  const authorized = {Authorization: "Bearer plazo_test_k1_secret", "Content-Type": "application/json"};

  it("refuses an unauthenticated call before it reaches a venue", async () => {
    const app = createFxApi({verifier, venue: new StubVenue()});
    const response = await app.request("/v1/fx/quote", {method: "POST", body: "{}"});
    expect(response.status).toBe(401);
  });

  it("answers 501 with the missing credential when the venue is the stub", async () => {
    const app = createFxApi({verifier, venue: new StubVenue()});
    const response = await app.request("/v1/fx/quote", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({from: "USD", to: "EUR", amount: "407.00", sessionId: `0x${"33".repeat(32)}`}),
    });

    expect(response.status).toBe(501);
    const body = (await response.json()) as {error: string; owner: string};
    expect(body.error).toBe("not-composed");
    expect(body.owner).toContain("PLAZO_STABLEFX_API_KEY");
  });

  it("answers 501 naming the poll when the corridor health seam is unfilled", async () => {
    const app = createFxApi({verifier, venue: new StubVenue()});
    const response = await app.request(`/v1/fx/corridor/0x${"44".repeat(32)}`, {headers: authorized});

    expect(response.status).toBe(501);
    const body = (await response.json()) as {seam: string; owner: string};
    expect(body.seam).toBe("fx.corridor-poll");
    expect(body.owner).toContain("graphile-worker");
  });

  it("NotComposed carries the seam and what would fill it", () => {
    const error = new NotComposed("fx.mid-signer", "PLAZO_FX_MID_SIGNER_KEY");
    expect(error.seam).toBe("fx.mid-signer");
    expect(error.owner).toContain("PLAZO_FX_MID_SIGNER_KEY");
  });
});
