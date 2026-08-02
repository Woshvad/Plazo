/**
 * The bundle, asserted as the artefact a merchant actually loads.
 *
 * 06-03's own closing note: "the bundle is not built or served… somebody needs to own it
 * before a merchant can integrate." The README has documented an SRI hash and a set of
 * serving headers since then, and until now every one of those sentences was aspirational —
 * true of nothing, checkable by nobody.
 *
 * This suite makes each of them checkable:
 *
 * 1. The bundle exists and **executes in a browser environment**, installing the exact
 *    global surface the README's integration snippet calls. Not "the file is non-empty":
 *    the bytes are evaluated in jsdom and `Plazo.checkout` is invoked.
 * 2. The published integrity hash **recomputes from the bytes on disk**, by the same
 *    command the manifest tells a merchant to run.
 * 3. The README's serving headers **are** `src/serving.ts`'s, read out of the markdown as
 *    text. A README that drifts from the code is how a contract becomes a story.
 *
 * ## It builds rather than skipping
 *
 * `dist/` is gitignored and correctly uncommitted — an SRI hash checked into a repository
 * is a hash that drifts from the bytes it names. So this suite runs the build if the
 * artefact is missing, and fails if the build fails. A skipped bundle test reads exactly
 * like a passing one.
 */
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {JSDOM} from "jsdom";
import {beforeAll, describe, expect, it} from "vitest";

import {
  COMMON_HEADERS,
  LATEST_PATH,
  PINNED_HEADERS,
  PINNED_MAX_AGE_SECONDS,
  PINNED_PATH,
  scriptTag,
  SERVING,
  type BundleManifest,
} from "../src/serving.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "dist", "plazo.js");
const MANIFEST = join(ROOT, "dist", "manifest.json");

let bundle: string;
let manifest: BundleManifest;

beforeAll(() => {
  if (!existsSync(BUNDLE) || !existsSync(MANIFEST)) {
    // Not a skip. See the header.
    execFileSync("node", [join(ROOT, "scripts", "bundle.mjs")], {cwd: ROOT, stdio: "inherit"});
  }
  bundle = readFileSync(BUNDLE, "utf8");
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as BundleManifest;
});

describe("the browser bundle", () => {
  it("is a classic script, not an ES module — the README's snippet needs it synchronous", () => {
    // `type="module"` is deferred by definition, so `Plazo` would not exist when a
    // merchant's own inline handler runs. The failure would be intermittent and would look
    // like a network problem.
    expect(bundle).not.toMatch(/^\s*(?:export|import)\s/m);
    expect(bundle.startsWith("/* @plazo/checkout-embed — Apache-2.0")).toBe(true);
  });

  it("resolves every bare specifier — nothing a browser would have to look up", () => {
    // The whole reason `dist/index.js` could not be pasted into a page: it imports "viem"
    // and "@plazo/plan-core", which no browser can resolve without an import map.
    expect(bundle).not.toMatch(/from\s*["']viem["']/);
    expect(bundle).not.toMatch(/from\s*["']@plazo\//);
    expect(bundle).not.toContain("require(");
  });

  it("carries no source-map comment, because that would be a second fetch on every page", () => {
    expect(bundle).not.toContain("sourceMappingURL");
  });

  it("installs the exact global surface the README's integration calls", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      runScripts: "outside-only",
      url: "https://shop.example-merchant.test/cart",
    });
    dom.window.eval(bundle);

    const plazo = (dom.window as unknown as {Plazo?: Record<string, unknown>}).Plazo;
    expect(plazo).toBeDefined();
    for (const name of ["checkout", "messaging", "limitFor"]) {
      expect(typeof plazo![name], name).toBe("function");
    }
  });

  it("actually mounts a checkout frame when called, which is the whole integration", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      runScripts: "outside-only",
      url: "https://shop.example-merchant.test/cart",
    });
    dom.window.eval(bundle);

    const plazo = (dom.window as unknown as {
      Plazo: {checkout(options: Record<string, unknown>): {close(): void}};
    }).Plazo;

    const handle = plazo.checkout({
      sessionId: "s_secret_do_not_leak",
      origin: "https://checkout.plazo.example",
      onComplete: () => undefined,
      onCancel: () => undefined,
    });

    const frame = dom.window.document.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("src")).toContain("https://checkout.plazo.example");

    // 06-03's claim, re-asserted against the shipped bytes rather than against the source:
    // the session id crosses in `plazo:open` and nowhere the DOM can see.
    expect(frame!.outerHTML).not.toContain("s_secret_do_not_leak");
    expect(dom.window.document.body.innerHTML).not.toContain("s_secret_do_not_leak");

    handle.close();
    expect(dom.window.document.querySelector("iframe")).toBeNull();
  });
});

describe("the published integrity hash", () => {
  it("recomputes from the bytes on disk", () => {
    const bytes = readFileSync(BUNDLE);
    expect(manifest.integrity).toBe(`sha384-${createHash("sha384").update(bytes).digest("base64")}`);
    expect(manifest.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(manifest.bytes).toBe(bytes.length);
  });

  it("is in the shape a browser will enforce", () => {
    // A browser ignores an `integrity` value it cannot parse — silently, and in the
    // permissive direction. sha384 is 48 bytes, which is 64 base64 characters.
    expect(manifest.integrity).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
  });

  it("changes when one byte of the bundle changes", () => {
    const bytes = readFileSync(BUNDLE);
    const tampered = Buffer.concat([bytes, Buffer.from(" ")]);
    expect(`sha384-${createHash("sha384").update(tampered).digest("base64")}`).not.toBe(
      manifest.integrity,
    );
  });

  it("ships a script tag with crossorigin, without which integrity is not enforced at all", () => {
    const tag = scriptTag("https://js.plazo.example", manifest);
    expect(tag).toContain(`https://js.plazo.example${PINNED_PATH}`);
    expect(tag).toContain(manifest.integrity);
    // Omit this and the browser skips the integrity check on a cross-origin script: the tag
    // looks pinned and is exactly as mutable as it was before.
    expect(tag).toContain('crossorigin="anonymous"');
  });

  it("records what a buyer's browser actually downloads, not only the raw size", () => {
    expect(manifest.bytes).toBeGreaterThan(0);
    // The bundle is dominated by viem, which is here for one contract read. The compressed
    // figure is the honest one and a merchant putting this on a product page should see it.
    const transfer = (manifest as BundleManifest & {transfer: {gzip: number; brotli: number}})
      .transfer;
    expect(transfer.brotli).toBeLessThan(transfer.gzip);
    expect(transfer.gzip).toBeLessThan(manifest.bytes);
  });
});

describe("the serving contract", () => {
  it("makes the pinned URL immutable and the tracking URL short-lived", () => {
    expect(SERVING[PINNED_PATH]!.immutable).toBe(true);
    expect(SERVING[PINNED_PATH]!.headers["cache-control"]).toContain("immutable");
    expect(SERVING[PINNED_PATH]!.headers["cache-control"]).toContain(String(PINNED_MAX_AGE_SECONDS));

    expect(SERVING[LATEST_PATH]!.immutable).toBe(false);
    expect(SERVING[LATEST_PATH]!.headers["cache-control"]).not.toContain("immutable");
  });

  it("gives the asset origin no capabilities of its own", () => {
    // A static origin that can fetch, frame or execute is an origin whose compromise
    // reaches further than the files on it.
    expect(COMMON_HEADERS["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(COMMON_HEADERS["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(COMMON_HEADERS["x-content-type-options"]).toBe("nosniff");
  });

  it("is written into the manifest, so a deploy reads it rather than remembering it", () => {
    expect(manifest.serving).toEqual(SERVING);
  });

  /**
   * The parity assertion, in the spirit of `bridge-parity.test.ts`.
   *
   * The README is the artefact a merchant reads and it has been documenting these headers
   * since 06-03 with nothing checking them. Reading it as text and asserting every value in
   * `PINNED_HEADERS` appears is what turns "documented" into "true".
   */
  it("is what the README says it is — every header on both URLs", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");

    for (const [path, {headers}] of Object.entries(SERVING)) {
      for (const [name, value] of Object.entries(headers)) {
        expect(readme.toLowerCase(), `${path} ${name}`).toContain(name);
        expect(readme, `${path} — ${name}: ${value}`).toContain(value);
      }
    }

    expect(readme).toContain(PINNED_PATH);
    expect(readme).toContain(LATEST_PATH);
    // The two rules that make the pin worth anything.
    expect(readme).toContain("integrity=");
    expect(readme).toContain('crossorigin="anonymous"');
  });
});
