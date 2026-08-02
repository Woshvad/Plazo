/**
 * The serving contract, as data rather than as prose.
 *
 * The README has documented these headers since 06-03 and nothing implemented them, which
 * is the shape of a contract that is aspirational: the words are right, nobody can check
 * that a deployment matches them, and the first person to configure the origin does it from
 * memory. Putting the contract here makes it three things at once — the thing the build
 * writes into the manifest, the thing a serving origin can read at deploy time, and the
 * thing `test/bundle.test.ts` asserts the README still agrees with.
 *
 * Nothing in this file is browser code. It is here rather than in a script because it is
 * part of what the package publishes: a merchant reading the open source can see exactly
 * what the origin serving them is supposed to send, and check it with `curl -I`.
 */

/**
 * Where the bundle is served from, and what each URL promises.
 *
 * The distinction is the whole of the security story and it is not a versioning nicety. A
 * mutable script tag on a checkout page is a standing permission for somebody else to push
 * unreviewed code into the merchant's PCI scope: every page load re-fetches whatever is at
 * that URL, and neither the merchant nor their assessor reviewed it. `integrity=` is only
 * meaningful against bytes that cannot change, so the pinned URL and the SRI hash are one
 * decision, not two.
 */
export const PINNED_PATH = "/v1/plazo.js";
export const LATEST_PATH = "/plazo.js";

/** A year. Safe only because the bytes at `PINNED_PATH` never change. */
export const PINNED_MAX_AGE_SECONDS = 31_536_000;

/** Five minutes. `LATEST_PATH` changes without notice, so it may not be cached for long. */
export const LATEST_MAX_AGE_SECONDS = 300;

export type Headers = Readonly<Record<string, string>>;

/**
 * The headers every response from the serving origin carries.
 *
 * - `Cross-Origin-Resource-Policy: cross-origin` — the bundle exists to be loaded by
 *   merchant pages, so it says so explicitly rather than inheriting a default that a future
 *   browser may tighten.
 * - `Content-Security-Policy: default-src 'none'; sandbox` — a static asset origin needs no
 *   capabilities at all. Saying so bounds what a compromise of that origin can reach: an
 *   attacker who can write files there still cannot make the origin itself fetch, frame or
 *   execute anything.
 * - `X-Content-Type-Options: nosniff` — without it a browser may decide the content type
 *   for itself, and a script origin is the last place that guess should be available.
 */
export const COMMON_HEADERS: Headers = {
  "content-type": "application/javascript; charset=utf-8",
  "cross-origin-resource-policy": "cross-origin",
  "content-security-policy": "default-src 'none'; sandbox",
  "x-content-type-options": "nosniff",
};

/** The immutable URL. `immutable` is a promise the build has to keep — see `PINNED_PATH`. */
export const PINNED_HEADERS: Headers = {
  ...COMMON_HEADERS,
  "cache-control": `public, max-age=${PINNED_MAX_AGE_SECONDS}, immutable`,
};

/** The tracking URL. Short cache, because the bytes behind it move. */
export const LATEST_HEADERS: Headers = {
  ...COMMON_HEADERS,
  "cache-control": `public, max-age=${LATEST_MAX_AGE_SECONDS}`,
};

/** The whole contract, keyed by path. This is what the build writes into the manifest. */
export const SERVING: Readonly<Record<string, {immutable: boolean; headers: Headers}>> = {
  [PINNED_PATH]: {immutable: true, headers: PINNED_HEADERS},
  [LATEST_PATH]: {immutable: false, headers: LATEST_HEADERS},
};

/**
 * What the build writes to `dist/manifest.json`.
 *
 * The point of a manifest rather than a loose `.sri` file is that the hash and the URL it
 * belongs to travel together. An SRI hash detached from the exact URL it was computed for
 * is the most dangerous artefact in this whole feature: it looks authoritative, it pastes
 * cleanly into a script tag, and a browser silently refuses to run a bundle it does not
 * match — which a merchant experiences as "Plazo is broken on my checkout page".
 */
export interface BundleManifest {
  /** The package version the bytes were built from. */
  readonly version: string;
  /** The bundle's file name inside `dist/`. */
  readonly file: string;
  readonly bytes: number;
  /** `sha384-…`, ready to paste into `integrity=`. */
  readonly integrity: string;
  /** The same bytes as hex sha256, for anything comparing artefacts rather than serving them. */
  readonly sha256: string;
  /** Every path this build should be reachable at, and the headers each one carries. */
  readonly serving: typeof SERVING;
  /** How to reproduce the hash without trusting this file. */
  readonly reproduce: string;
}

/**
 * The `<script>` tag a merchant pastes, for a given origin and manifest.
 *
 * `crossorigin="anonymous"` is not optional decoration: without it the browser will not
 * enforce `integrity` on a cross-origin script at all, and the tag looks pinned while being
 * exactly as mutable as it was before.
 */
export function scriptTag(origin: string, manifest: Pick<BundleManifest, "integrity">): string {
  const base = origin.replace(/\/+$/, "");
  return [
    `<script src="${base}${PINNED_PATH}"`,
    `        integrity="${manifest.integrity}"`,
    `        crossorigin="anonymous"></script>`,
  ].join("\n");
}
