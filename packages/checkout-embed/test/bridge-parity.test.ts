import {readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

/**
 * The two copies of the `postMessage` union must agree.
 *
 * `packages/checkout-embed/src/bridge.ts` is a duplicate of the checkout app's
 * `_bridge.ts` because the licence boundary forbids the import: this package is open
 * (D-21) and `apps/` is proprietary, so `tools/check-boundaries.mjs` would fail the
 * build on a real dependency. A duplicate that nobody checks is worse than an import —
 * it drifts silently, and the failure mode is a merchant whose `onComplete` never
 * fires because the frame renamed a message six months ago.
 *
 * So the copy is asserted, exactly as `packages/events` asserts its duplicated ABI
 * literals rather than trusting them. This test reads the other file as **text**. It
 * never imports it, which would be the boundary violation, and never names it in a
 * module specifier, which is what the boundary checker scans for — the path below is
 * an argument to `join`, not a specifier.
 *
 * If the file cannot be found this test fails. It does not skip. A parity check that
 * silently passes when it cannot find its counterpart is not a check.
 */

const HERE = fileURLToPath(import.meta.url);
const ROOT = join(HERE, "..", "..", "..", "..");

const APP_BRIDGE = join(ROOT, "apps/checkout/app/_bridge.ts");
const EMBED_BRIDGE = join(ROOT, "packages/checkout-embed/src/bridge.ts");

/** The declarations that constitute the protocol. Everything else may differ. */
const SHARED = ["Outbound", "Inbound", "Step", "CancelReason", "STEPS"] as const;

/**
 * Remove comments without disturbing anything inside a string or a template.
 *
 * A naive regex would eat the `//` in a URL and stop at the first `*` in a doc block.
 * The declarations being compared contain template literal types (`` `0x${string}` ``)
 * and string unions, so the scanner tracks quoting state.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== "*/") i += 1;
      i += 2;
      continue;
    }
    const char = source[i] as string;
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      out += char;
      i += 1;
      while (i < source.length) {
        const next = source[i] as string;
        out += next;
        i += 1;
        if (next === "\\") {
          if (i < source.length) {
            out += source[i] as string;
            i += 1;
          }
          continue;
        }
        if (next === quote) break;
      }
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/**
 * The right-hand side of `export type X =` or `export const X ... =`, to the `;` that
 * closes it at brace depth zero.
 *
 * Depth matters because a union member is an object type literal and carries its own
 * semicolons: `{type: "plazo:resize"; height: number}`. Stopping at the first `;`
 * would compare a fragment and pass on almost any divergence.
 */
function declarationOf(source: string, name: string): string {
  const text = stripComments(source);
  const pattern = new RegExp(`export\\s+(?:type|const)\\s+${name}\\b[^=]*=`);
  const match = pattern.exec(text);
  if (!match) throw new Error(`no exported declaration named ${name}`);

  let i = match.index + match[0].length;
  let depth = 0;
  let body = "";
  while (i < text.length) {
    const char = text[i] as string;
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;
    if (char === ";" && depth === 0) break;
    body += char;
    i += 1;
  }
  if (i >= text.length) throw new Error(`unterminated declaration ${name}`);

  return body.replace(/\s+/g, " ").replace(/^\s*\|\s*/, "").trim();
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(
      `cannot read ${path}. The bridge parity check has no counterpart to compare ` +
        `against, which means the protocol is unverified, not that it is fine.`,
      {cause},
    );
  }
}

describe("bridge parity", () => {
  const app = read(APP_BRIDGE);
  const embed = read(EMBED_BRIDGE);

  it("finds both copies of the protocol", () => {
    expect(app.length).toBeGreaterThan(0);
    expect(embed.length).toBeGreaterThan(0);
  });

  for (const name of SHARED) {
    it(`declares an identical ${name}`, () => {
      expect(declarationOf(embed, name)).toBe(declarationOf(app, name));
    });
  }

  it("carries every message kind the checkout app can emit", () => {
    for (const kind of ["plazo:resize", "plazo:state", "plazo:complete", "plazo:cancelled"]) {
      expect(embed).toContain(kind);
      expect(app).toContain(kind);
    }
  });

  it("carries no variant the checkout app does not have", () => {
    const kinds = (source: string) =>
      [...source.matchAll(/"(plazo:[a-z]+)"/g)].map((m) => m[1] as string).sort();
    expect([...new Set(kinds(embed))]).toStrictEqual([...new Set(kinds(app))]);
  });

  it("has no message variant that could hold a secret leaving the frame", () => {
    // DEC-20 stated as an assertion rather than as a comment. The outbound union is
    // the frame's whole vocabulary; if one of these words ever appears in it, a
    // secret can cross, and this test is where that gets caught.
    const outbound = declarationOf(embed, "Outbound");
    for (const forbidden of ["signature", "privateKey", "authorization", "token", "secret"]) {
      expect(outbound.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
