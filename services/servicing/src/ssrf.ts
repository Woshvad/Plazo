/**
 * Destination validation for merchant-supplied URLs. The highest-severity control in the
 * operator service layer, and the one that is easiest to write in a form that does not
 * work.
 *
 * A webhook URL is chosen by the merchant and fetched by Plazo's server, from inside
 * Plazo's network. That is a server-side request forgery primitive by construction: the
 * merchant picks the destination and the operator supplies the credentials, the routing
 * table and the trust. On a cloud host the interesting address is `169.254.169.254`,
 * where the instance metadata service will hand out role credentials to anything that
 * asks from the right place.
 *
 * ## Resolve, then check the addresses — never the string
 *
 * A denylist of hostnames is worthless: `localtest.me`, a merchant's own DNS record, and
 * any of a dozen public resolvers will point a perfectly ordinary-looking name at
 * `127.0.0.1`. What has to be checked is what the name **resolves to**, and every address
 * it resolves to, because a name with two A records passes on the first and connects on
 * the second.
 *
 * ## Re-resolve on every send. This is why the sender calls it, not the registrar
 *
 * A registration-time check that is cached is a DNS rebinding attack with the work done
 * for it: the merchant registers `hooks.example.com` pointing at a public address, Plazo
 * validates and stores it, and the record is then re-pointed at `169.254.169.254` before
 * the first delivery. Validation at registration is a courtesy that gives the merchant an
 * error early. Validation at send is the control. `deliver` in `webhooks.ts` calls this
 * on every attempt for exactly that reason, and there is no cache anywhere in this file.
 *
 * ## The residual race, stated plainly
 *
 * Between this resolution and the socket the runtime opens, the name is resolved a second
 * time by `fetch`, and a sufficiently precise attacker can change the answer in between.
 * Closing that needs a connect-time hook that pins the checked address, which `undici`
 * can do and which is worth doing when this service gets a real deployment. What is here
 * removes the whole class of trivially-exploitable cases and narrows the remainder to a
 * timing window; it is recorded rather than implied so nobody later reads this file as a
 * complete answer.
 *
 * ## HTTPS only, and no redirects
 *
 * `http:` sends a signed payload in clear. `file:`, `gopher:` and the rest have no
 * business here at all. And a 302 to `169.254.169.254` defeats every check above, which
 * is why `assertNotRedirected` exists and why the sender configures `redirect: "manual"`.
 */
import {lookup} from "node:dns/promises";
import {isIP} from "node:net";

/**
 * Which rule fired. A string union rather than a message, so a caller can branch and a
 * log line can be aggregated.
 */
export type SsrfCode =
  | "not-a-url"
  | "scheme"
  | "no-host"
  | "unresolvable"
  | "loopback"
  | "link-local"
  | "private"
  | "unique-local"
  | "multicast"
  | "unspecified"
  | "reserved"
  | "redirect";

export class SsrfError extends Error {
  constructor(
    message: string,
    readonly code: SsrfCode,
  ) {
    super(message);
    this.name = "SsrfError";
  }
}

/** How a hostname becomes addresses. Injected so a rebinding case can be asserted. */
export type Resolver = (hostname: string) => Promise<readonly string[]>;

/** The real one. `all: true` because a name with two A records must be checked on both. */
export const systemResolver: Resolver = async (hostname) => {
  const results = await lookup(hostname, {all: true, verbatim: true});
  return results.map((r) => r.address);
};

export interface DeliverableTarget {
  readonly url: URL;
  /** Every address the hostname resolved to, all of which passed. */
  readonly addresses: readonly string[];
}

/** IPv4 dotted quad → four octets, or null. */
function v4Octets(address: string): [number, number, number, number] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map((p) => Number(p));
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

/**
 * IPv6 → sixteen bytes.
 *
 * Written out rather than pulled in, because the alternative is a dependency on the
 * network path of an operator service to do something the standard library almost does.
 * `isIP` has already established the string is a valid address, so this only has to
 * expand it: at most one `::`, and a possible dotted-quad tail.
 */
function v6Bytes(address: string): Uint8Array | null {
  if (isIP(address) !== 6) return null;

  let text = address;
  const bytes = new Uint8Array(16);

  // A trailing dotted quad (::ffff:1.2.3.4) is two groups' worth of bytes.
  let tail: number[] = [];
  const dotted = text.lastIndexOf(".");
  if (dotted !== -1) {
    const cut = text.lastIndexOf(":") + 1;
    const octets = v4Octets(text.slice(cut));
    if (!octets) return null;
    tail = octets;
    text = text.slice(0, cut - 1) + ":0:0";
  }

  const [head, rest] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":").filter((g) => g.length > 0) : [];
  const right = rest !== undefined && rest.length > 0 ? rest.split(":").filter((g) => g.length > 0) : [];

  // The dotted tail was rewritten into two zero groups above, so the count is eight
  // either way. Without a `::` every group must be present or the address is not one.
  const filled = left.length + right.length;
  if (rest === undefined && filled !== 8) return null;

  const write = (group: string, at: number) => {
    const value = Number.parseInt(group, 16);
    if (!Number.isFinite(value)) return false;
    bytes[at] = (value >> 8) & 0xff;
    bytes[at + 1] = value & 0xff;
    return true;
  };

  for (const [i, group] of left.entries()) if (!write(group, i * 2)) return null;
  for (const [i, group] of right.entries()) {
    if (!write(group, 16 - (right.length - i) * 2)) return null;
  }

  if (tail.length === 4) {
    bytes[12] = tail[0]!;
    bytes[13] = tail[1]!;
    bytes[14] = tail[2]!;
    bytes[15] = tail[3]!;
  }

  return bytes;
}

/** IPv4 classification. Returns the rule that refuses this address, or null to allow. */
function classifyV4(octets: [number, number, number, number]): SsrfCode | null {
  const [a, b] = octets;

  if (a === 0) return "unspecified"; // 0.0.0.0/8 — "this network", and a loopback alias
  if (a === 127) return "loopback"; // 127.0.0.0/8
  if (a === 10) return "private"; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
  if (a === 192 && b === 168) return "private"; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return "private"; // 100.64.0.0/10, carrier NAT
  if (a === 169 && b === 254) return "link-local"; // 169.254.0.0/16 — cloud metadata
  if (a === 192 && b === 0 && octets[2] === 0) return "reserved"; // 192.0.0.0/24, IETF protocol
  if (a === 198 && (b === 18 || b === 19)) return "reserved"; // 198.18.0.0/15, benchmarking
  if (a >= 224 && a <= 239) return "multicast"; // 224.0.0.0/4
  if (a >= 240) return "reserved"; // 240.0.0.0/4 and 255.255.255.255

  return null;
}

function classifyV6(bytes: Uint8Array): SsrfCode | null {
  const zeroPrefix = bytes.slice(0, 12).every((b) => b === 0);

  // ::, and ::1
  if (bytes.every((b) => b === 0)) return "unspecified";
  if (zeroPrefix && bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15] === 1) {
    return "loopback";
  }

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: the v4 rules decide, or a v6 form
  // becomes a bypass of every one of them.
  const mapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  // NAT64's well-known prefix 64:ff9b::/96 embeds a v4 address in the same position.
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0);

  if (mapped || nat64 || zeroPrefix) {
    const embedded = classifyV4([bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!]);
    if (embedded) return embedded;
  }

  if (bytes[0] === 0xff) return "multicast"; // ff00::/8
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return "link-local"; // fe80::/10
  if ((bytes[0]! & 0xfe) === 0xfc) return "unique-local"; // fc00::/7

  return null;
}

/**
 * Refuse an address that is not on the public internet.
 *
 * Exported because the classification is the interesting part and deserves to be
 * assertable directly, without a URL and without a resolver.
 */
export function classifyAddress(address: string): SsrfCode | null {
  const octets = v4Octets(address);
  if (octets) return classifyV4(octets);

  const bytes = v6Bytes(address);
  if (bytes) return classifyV6(bytes);

  return "unresolvable";
}

const REFUSAL: Record<SsrfCode, string> = {
  "not-a-url": "is not a url",
  scheme: "is not https",
  "no-host": "has no host",
  unresolvable: "does not resolve",
  loopback: "resolves to loopback",
  "link-local": "resolves to a link-local address (cloud metadata lives at 169.254.169.254)",
  private: "resolves to a private address",
  "unique-local": "resolves to an IPv6 unique-local address",
  multicast: "resolves to a multicast address",
  unspecified: "resolves to the unspecified address",
  reserved: "resolves to a reserved address",
  redirect: "redirected, and a redirect is not followed",
};

export interface DeliverableOptions {
  readonly resolve?: Resolver | undefined;
}

/**
 * Assert that a merchant-supplied URL may be fetched, right now.
 *
 * Call this from the sender, on every attempt. Calling it once at registration and
 * trusting the answer later is the DNS-rebinding hole this function's whole shape exists
 * to close.
 */
export async function assertDeliverable(
  target: string,
  options: DeliverableOptions = {},
): Promise<DeliverableTarget> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new SsrfError(`webhook destination ${REFUSAL["not-a-url"]}`, "not-a-url");
  }

  if (url.protocol !== "https:") {
    throw new SsrfError(
      `webhook destination ${REFUSAL["scheme"]} (got ${url.protocol}); a signed payload does not travel in clear`,
      "scheme",
    );
  }

  // `new URL("https://[::1]/")` keeps the brackets on `hostname`; a resolver will not.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) throw new SsrfError(`webhook destination ${REFUSAL["no-host"]}`, "no-host");

  let addresses: readonly string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    const resolve = options.resolve ?? systemResolver;
    try {
      addresses = await resolve(hostname);
    } catch {
      // The resolver's own error is deliberately dropped rather than wrapped: it can echo
      // internal search domains, and this message goes back to the merchant who supplied
      // the name.
      throw new SsrfError(`webhook destination ${hostname} ${REFUSAL["unresolvable"]}`, "unresolvable");
    }
  }

  if (addresses.length === 0) {
    throw new SsrfError(`webhook destination ${hostname} ${REFUSAL["unresolvable"]}`, "unresolvable");
  }

  // Every address, not the first. A name with two A records passes on one and connects
  // on the other.
  for (const address of addresses) {
    const code = classifyAddress(address);
    if (code) {
      throw new SsrfError(`webhook destination ${hostname} (${address}) ${REFUSAL[code]}`, code);
    }
  }

  return {url, addresses};
}

/**
 * Refuse a redirect rather than following it.
 *
 * Every check above is performed on the URL the merchant registered. A 302 to
 * `169.254.169.254` is a request to perform none of them, and the only safe answer is to
 * treat the redirect itself as the failure. The sender sets `redirect: "manual"` so this
 * can see it at all.
 */
export function assertNotRedirected(response: {status: number; headers: {get(name: string): string | null}}): void {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "(no location)";
    throw new SsrfError(
      `webhook destination ${REFUSAL["redirect"]}: ${response.status} to ${location}`,
      "redirect",
    );
  }
}
