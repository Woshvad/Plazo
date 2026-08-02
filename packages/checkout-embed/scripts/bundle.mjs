#!/usr/bin/env node
/**
 * Build `plazo.js` — the browser bundle a merchant actually pastes into their page.
 *
 * 06-03 shipped `@plazo/checkout-embed` as a workspace package emitting `tsc` output to
 * `dist/`, and its README documented an SRI hash and a set of serving headers. **No plan
 * built the bundle, computed the hash or defined the headers.** `dist/index.js` is a tree
 * of ES modules with bare specifiers (`viem`, `@plazo/plan-core`) that no browser can
 * resolve, so a merchant could not integrate a package whose whole purpose is one script
 * tag. This closes that.
 *
 * ## Why an IIFE and not an ES module
 *
 * The README's integration is a classic `<script src=… integrity=…>` and a synchronous
 * `Plazo.checkout(...)` from an inline handler. `type="module"` is deferred by definition,
 * so the global would not exist when the merchant's own inline script runs, and the failure
 * presents as `Plazo is not defined` on some page loads and not others depending on network
 * timing. An IIFE executes where it is parsed. `checkout.ts` and `messaging.ts` already
 * install `window.Plazo` at import time, merging rather than assigning, so importing the
 * package index is the whole of the entry point.
 *
 * ## Why the hash is computed here and not published by hand
 *
 * An SRI hash that somebody transcribed is a hash that is eventually wrong, and a wrong one
 * is worse than none: the browser silently refuses to execute the script, and the merchant
 * experiences it as "Plazo is broken on my checkout page" with nothing in the console that
 * names the cause. So the hash is a build artefact, it travels in the same file as the URL
 * it belongs to, and `reproduce` in the manifest is the one-line command that recomputes it
 * from the bytes. The package is open source precisely so "reproducible" is something a
 * merchant can check rather than something Plazo asserts.
 *
 * ## Determinism, and what it does and does not promise
 *
 * `esbuild` with a fixed target, fixed minifier settings and no timestamp or path banner
 * produces the same bytes from the same inputs. It does **not** promise the same bytes
 * across esbuild versions or across dependency upgrades, and it must not be read as
 * promising that: the hash is the hash of these bytes, and a new build is a new URL. That
 * is the whole design of `/v1/plazo.js` being immutable.
 *
 * Run: `pnpm --filter @plazo/checkout-embed bundle`
 */
import {createHash} from "node:crypto";
import {brotliCompressSync, gzipSync} from "node:zlib";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {build} from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT_DIR = join(ROOT, "dist");
const OUT_FILE = "plazo.js";
const OUT_PATH = join(OUT_DIR, OUT_FILE);
const MANIFEST_PATH = join(OUT_DIR, "manifest.json");

/**
 * The browser baseline.
 *
 * Chosen against what a merchant's buyers actually run rather than against what is newest.
 * These four cover passkeys, `crypto.subtle` in a secure context and `BigInt` literals,
 * all of which this bundle depends on, and they are old enough that the transform does not
 * silently rewrite `bigint` arithmetic into something lossy.
 */
const TARGET = ["chrome108", "firefox110", "safari16", "edge108"];

async function main() {
  await mkdir(OUT_DIR, {recursive: true});

  const result = await build({
    entryPoints: [join(ROOT, "src", "index.ts")],
    outfile: OUT_PATH,
    bundle: true,
    /**
     * A classic script, with the package's exports also reachable as `window.Plazo` for
     * anything that wants the types. `checkout.ts` and `messaging.ts` install the callable
     * surface themselves; `globalName` is what makes the module's own exports addressable
     * without a second entry file whose only job is a re-export.
     */
    format: "iife",
    globalName: "Plazo",
    platform: "browser",
    target: TARGET,
    minify: true,
    /**
     * Emitted, and not referenced from the bundle.
     *
     * A `//# sourceMappingURL=` comment would change the bytes and therefore the hash, and
     * would make every page load in a merchant's browser with devtools open fetch a second
     * file from Plazo's origin. The map is published beside the bundle for anyone who wants
     * it and is attached deliberately rather than automatically.
     */
    sourcemap: "external",
    legalComments: "none",
    charset: "utf8",
    metafile: true,
    define: {"process.env.NODE_ENV": '"production"'},
    /**
     * The banner is the only non-derived text in the file and it stays one line.
     *
     * A merchant reading `view-source:` on a minified bundle deserves to know what it is
     * and where the readable version lives. It is inside the hashed bytes, which is
     * correct: it is part of what was served.
     */
    banner: {js: "/* @plazo/checkout-embed — Apache-2.0 — https://github.com/plazo/plazo */"},
  });

  const bytes = await readFile(OUT_PATH);
  const integrity = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const {version} = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

  /**
   * The serving contract, read from the package's own compiled source rather than restated
   * here.
   *
   * `src/serving.ts` is the single definition; a second copy in this script is how the
   * manifest, the README and the code that ships end up disagreeing. `tsc` runs before this
   * script — see the `build` script — so `dist/serving.js` exists by now, and if it does not
   * that is worth failing on rather than falling back to a hardcoded guess.
   */
  const {SERVING} = await import(new URL("../dist/serving.js", import.meta.url).href);

  /**
   * What the buyer's browser actually downloads.
   *
   * Recorded because the raw byte count is the number nobody transfers and therefore the
   * number nobody should be reassured by. This bundle is dominated by `viem`, which is here
   * for one call — `CheckoutRouter.maxPrincipalFor` in the pre-cart widget — and a merchant
   * putting it on a product page deserves the compressed figure in front of them rather
   * than after a Lighthouse run.
   */
  const transfer = {
    gzip: gzipSync(bytes, {level: 9}).length,
    brotli: brotliCompressSync(bytes).length,
  };

  const manifest = {
    version,
    file: OUT_FILE,
    bytes: bytes.length,
    transfer,
    integrity,
    sha256,
    serving: SERVING,
    reproduce: `openssl dgst -sha384 -binary dist/${OUT_FILE} | openssl base64 -A`,
  };

  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  /**
   * A bare `integrity=` value too, because the thing a CI step wants to paste into a header
   * or a template is one string and not a JSON path expression.
   */
  await writeFile(join(OUT_DIR, `${OUT_FILE}.sri`), `${integrity}\n`, "utf8");

  const kb = (bytes.length / 1024).toFixed(1);
  const gz = (transfer.gzip / 1024).toFixed(1);
  const br = (transfer.brotli / 1024).toFixed(1);
  const inputs = Object.keys(result.metafile.inputs).length;
  process.stdout.write(
    [
      `[plazo:embed] dist/${OUT_FILE}  ${kb} kB raw · ${gz} kB gzip · ${br} kB brotli · ${inputs} modules`,
      `[plazo:embed] ${integrity}`,
      `[plazo:embed] manifest: dist/manifest.json  ·  verify: ${manifest.reproduce}`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
