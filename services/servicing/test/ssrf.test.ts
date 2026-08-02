/**
 * The SSRF guard, which is the highest-severity control in the service layer.
 *
 * Nine refusals are asserted because nine distinct vectors reach the same place: an
 * outbound request from inside Plazo's network to an address the merchant chose. The two
 * that matter most are the last two — a hostname that *resolves* to `169.254.169.254`,
 * which no string denylist catches, and a redirect to a private address, which defeats
 * every check that happened before the request went out.
 */
import {describe, expect, it} from "vitest";

import {assertDeliverable, assertNotRedirected, classifyAddress, SsrfError} from "../src/ssrf.js";

/** A resolver that answers whatever the case under test needs. */
const resolvesTo = (...addresses: string[]) => async () => addresses;

const refuse = async (url: string, resolve?: () => Promise<string[]>): Promise<SsrfError> => {
  try {
    await assertDeliverable(url, resolve ? {resolve} : {});
  } catch (error) {
    return error as SsrfError;
  }
  throw new Error(`${url} was accepted and should not have been`);
};

describe("the nine refusals", () => {
  it("1. refuses an http:// scheme — a signed payload does not travel in clear", async () => {
    expect((await refuse("http://hooks.example.com/plazo")).code).toBe("scheme");
  });

  it("2. refuses 127.0.0.1", async () => {
    expect((await refuse("https://127.0.0.1/plazo")).code).toBe("loopback");
  });

  it("3. refuses 10.1.2.3", async () => {
    expect((await refuse("https://10.1.2.3/plazo")).code).toBe("private");
  });

  it("4. refuses 192.168.0.1", async () => {
    expect((await refuse("https://192.168.0.1/plazo")).code).toBe("private");
  });

  /** The one that matters. Instance metadata hands out role credentials to whatever asks. */
  it("5. refuses 169.254.169.254, where the cloud metadata service lives", async () => {
    expect((await refuse("https://169.254.169.254/latest/meta-data/")).code).toBe("link-local");
  });

  it("6. refuses [::1]", async () => {
    expect((await refuse("https://[::1]/plazo")).code).toBe("loopback");
  });

  it("7. refuses [fe80::1]", async () => {
    expect((await refuse("https://[fe80::1]/plazo")).code).toBe("link-local");
  });

  /**
   * A hostname is not a denylist entry. `metadata.example.com` looks like anything else
   * until it is resolved, which is why the check is on the resolved addresses and why
   * this function takes a resolver at all.
   */
  it("8. refuses a hostname whose DNS resolves to 169.254.169.254", async () => {
    const error = await refuse("https://hooks.example.com/plazo", resolvesTo("169.254.169.254"));
    expect(error.code).toBe("link-local");
    expect(error.message).toContain("169.254.169.254");
  });

  /**
   * Every check above was performed against the URL the merchant registered. A 302 is a
   * request to perform none of them.
   */
  it("9. refuses a 302 to a private address rather than following it", async () => {
    const redirect = new Response(null, {status: 302, headers: {location: "http://10.0.0.1/"}});
    expect(() => assertNotRedirected(redirect)).toThrow(SsrfError);

    try {
      assertNotRedirected(redirect);
    } catch (error) {
      expect((error as SsrfError).code).toBe("redirect");
      expect((error as SsrfError).message).toContain("10.0.0.1");
    }
  });
});

describe("the address classifier", () => {
  it("refuses every private, reserved and special-purpose range", () => {
    const cases: Record<string, string> = {
      "0.0.0.0": "unspecified",
      "127.255.255.254": "loopback",
      "10.0.0.1": "private",
      "172.16.0.1": "private",
      "172.31.255.255": "private",
      "192.168.255.255": "private",
      "100.64.0.1": "private",
      "169.254.1.1": "link-local",
      "198.18.0.1": "reserved",
      "224.0.0.1": "multicast",
      "255.255.255.255": "reserved",
      "::": "unspecified",
      "::1": "loopback",
      "fe80::abcd": "link-local",
      "fc00::1": "unique-local",
      "fd12:3456::1": "unique-local",
      "ff02::1": "multicast",
    };

    for (const [address, code] of Object.entries(cases)) {
      expect([address, classifyAddress(address)]).toEqual([address, code]);
    }
  });

  /**
   * A v6 form of a v4 address must not be a bypass of the v4 rules. `::ffff:127.0.0.1`
   * and `::ffff:169.254.169.254` reach exactly the same places their dotted forms do.
   */
  it("applies the v4 rules to an IPv4-mapped and a NAT64 address", () => {
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::ffff:169.254.169.254")).toBe("link-local");
    expect(classifyAddress("::ffff:10.0.0.1")).toBe("private");
    expect(classifyAddress("64:ff9b::169.254.169.254")).toBe("link-local");
  });

  it("allows an ordinary public address", () => {
    expect(classifyAddress("93.184.216.34")).toBeNull();
    expect(classifyAddress("2606:2800:220:1:248:1893:25c8:1946")).toBeNull();
    expect(classifyAddress("172.32.0.1")).toBeNull(); // just outside 172.16/12
    expect(classifyAddress("172.15.255.255")).toBeNull();
  });
});

describe("assertDeliverable", () => {
  it("accepts a public https destination and reports what it resolved to", async () => {
    const target = await assertDeliverable("https://hooks.example.com/plazo", {
      resolve: resolvesTo("93.184.216.34"),
    });
    expect(target.url.pathname).toBe("/plazo");
    expect(target.addresses).toEqual(["93.184.216.34"]);
  });

  /**
   * A name with two A records passes on the first and connects on the second. Checking
   * only `addresses[0]` is the shape of a guard that looks right and is not.
   */
  it("refuses when any resolved address is private, not merely the first", async () => {
    const error = await refuse(
      "https://hooks.example.com/plazo",
      resolvesTo("93.184.216.34", "10.0.0.5"),
    );
    expect(error.code).toBe("private");
  });

  it("refuses a scheme that is not http or https at all", async () => {
    expect((await refuse("file:///etc/passwd")).code).toBe("scheme");
    expect((await refuse("gopher://example.com/")).code).toBe("scheme");
  });

  it("refuses a string that is not a url", async () => {
    expect((await refuse("not a url")).code).toBe("not-a-url");
  });

  it("refuses a name that does not resolve, and does not echo the resolver's error", async () => {
    const error = await refuse("https://nowhere.invalid/x", async () => {
      throw new Error("getaddrinfo ENOTFOUND nowhere.invalid corp.internal");
    });
    expect(error.code).toBe("unresolvable");
    expect(error.message).not.toContain("corp.internal");
  });

  it("refuses a name that resolves to nothing at all", async () => {
    expect((await refuse("https://empty.example.com/x", resolvesTo())).code).toBe("unresolvable");
  });

  it("does not call the resolver for a literal address", async () => {
    let called = false;
    await refuse("https://10.0.0.1/x", async () => {
      called = true;
      return ["93.184.216.34"];
    });
    expect(called).toBe(false);
  });

  it("passes a 200 through assertNotRedirected untouched", () => {
    expect(() => assertNotRedirected(new Response("ok", {status: 200}))).not.toThrow();
    expect(() => assertNotRedirected(new Response("no", {status: 500}))).not.toThrow();
  });
});
