#!/usr/bin/env node
/**
 * Design-token enforcement.
 *
 * The phase criterion is that no surface holds a local colour, type or spacing
 * value. That is not a property a code review reliably enforces — one hardcoded
 * `#141412` looks identical to the token in a diff, and by the fourth surface there
 * are four slightly different greens.
 *
 * So it fails the build. Every colour, font family and font size in `apps/` must
 * come from `@plazo/ui`.
 *
 * Deliberately narrow: it flags literals, not "wrong" values. A hex that happens to
 * match a token is still flagged, because the point is that the app should not know
 * the hex at all.
 */
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join, relative, sep} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SCANNED = ["apps"];
const SKIP = new Set(["node_modules", ".next", "dist", ".turbo", "out"]);
const SOURCE = /\.(tsx?|jsx?|css)$/;

/** The one file allowed to name raw values: the design system itself. */
const EXEMPT = [join("packages", "ui")];

const RULES = [
  {
    name: "hardcoded colour",
    pattern: /#[0-9a-fA-F]{3,8}\b/g,
    hint: 'use a token: text-ink, bg-paper, border-rule, text-green, text-danger, bg-accent',
  },
  {
    name: "hardcoded font family",
    pattern: /font-family\s*:\s*["']?(Space Grotesk|IBM Plex Mono|Instrument Sans)/g,
    hint: "use font-display, font-mono or font-body",
  },
  {
    name: "hardcoded font size",
    pattern: /font-size\s*:\s*\d+(\.\d+)?(px|rem)/g,
    hint: "use a type-scale token: text-xs, text-base, text-md, text-5xl",
  },
  {
    name: "blurred shadow",
    // Depth in this system is displacement, not blur. A third non-zero length in a
    // box-shadow is a blur radius, and one of them makes the whole surface look
    // like a different product.
    pattern: /box-shadow\s*:\s*-?\d+px\s+-?\d+px\s+[1-9]\d*px/g,
    hint: "use shadow-card, shadow-raised or shadow-hero — hard offsets, no blur",
  },
];

function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (SOURCE.test(entry)) acc.push(full);
  }
  return acc;
}

const violations = [];

for (const tree of SCANNED) {
  for (const file of walk(join(ROOT, tree))) {
    const rel = relative(ROOT, file);
    if (EXEMPT.some((e) => rel.startsWith(e))) continue;

    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      // Allow an explicit, reviewed exception.
      if (line.includes("design-token-exempt")) return;

      for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        const match = rule.pattern.exec(line);
        if (match) {
          violations.push({
            file: rel.split(sep).join("/"),
            line: i + 1,
            rule: rule.name,
            found: match[0],
            hint: rule.hint,
          });
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(`Design tokens bypassed in ${violations.length} place(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.rule}: ${v.found}`);
    console.error(`    ${v.hint}\n`);
  }
  console.error(
    "The design system is ported once and consumed everywhere. A local value here\n" +
      "becomes four slightly different values across four surfaces, and the comp is\n" +
      "binding.\n\n" +
      "If a value genuinely belongs outside the system, add it to packages/ui and use\n" +
      "the token. If a line is a justified exception, annotate it design-token-exempt.",
  );
  process.exit(1);
}

console.log("Design tokens intact — no local colour, type or shadow values in apps/.");
