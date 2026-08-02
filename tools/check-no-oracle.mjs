#!/usr/bin/env node
/**
 * No price oracle reaches the contract tree. Ever.
 *
 * C1, and CLAUDE.md's "What NOT to Use" in its own words:
 *
 *   "Any price oracle of any kind — §1 removes volatile collateral, which removes
 *    the reason to have one. Adding one re-adds an attack surface for nothing."
 *
 * The rule is easy to state and easy to erode, because every erosion arrives as a
 * local convenience: an FX valuation that only needs a mid "temporarily", a pledge
 * marked to a NAV rather than haircut, a corridor health check that reads a feed
 * instead of comparing two of its own quotes. Each one is a day's work and none of
 * them announce themselves as a design change. So this is a build failure rather
 * than a paragraph.
 *
 * **The one legal shape.** A price may reach the chain only as a signed,
 * band-bounded, short-TTL attestation that a contract uses to **refuse** a fill —
 * never to value a position, size a limit or price a payout. `FxMidAttestation`
 * (plan 07-03) is exactly that and is not a violation: the mid is an upper bound
 * the fill must beat, its TTL is `FX_MID_MAX_TTL`, and if the attestation is absent
 * or stale nothing is valued at all — the origination simply does not happen. The
 * difference between that and an oracle is the direction of failure. An oracle that
 * goes wrong prints a number; an attestation that goes wrong prints nothing.
 *
 * **Comment stripping matters more than the identifier list.** A guard that fired
 * on the word "oracle" inside the paragraph explaining why there is no oracle would
 * be disabled inside a week, and a disabled guard is worse than none — it is a
 * green check over an unenforced rule. So comments and string literals are blanked
 * (to spaces, preserving line and column) before anything is matched, and the
 * deliberate-failure check in 07-02 proves both halves: a real call fails, the same
 * word in a doc comment does not.
 */

import {readdirSync, readFileSync, statSync} from "node:fs";
import {join, relative, sep} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TREE = "contracts/src";
const SKIP = new Set(["node_modules", ".git", "out", "cache", "lib", ".turbo"]);

/**
 * Whole-word identifiers. Each is a price-feed entry point or a name that only
 * exists to hold one.
 */
const FORBIDDEN_WORDS = [
  "latestRoundData",
  "latestAnswer",
  "AggregatorV3Interface",
  "AggregatorV2V3Interface",
  "chainlink",
  "IPriceOracle",
  "priceOracle",
  "getPrice",
  "slot0",
  "twap",
];

/**
 * Call-shaped matches, deliberately narrower than a bare word.
 *
 * `observe` and `consult` are the Uniswap v3 and v2 TWAP entry points, and they are
 * also ordinary English. `FirstPaymentDefaultSwitch.observe(bytes32)` is a real,
 * unrelated function in this tree — a rule that fired on its declaration would be a
 * false positive on day one, and a guard whose first output is a false positive is a
 * guard somebody deletes. Matching only the *member call* form catches
 * `pool.observe(secondsAgos)` and leaves the declaration alone.
 *
 * `oracle()` is matched case-sensitively for the same reason: it is USYC's Teller
 * selector (finding 32), and `IComplianceOracle(...)` is a legitimate constructor
 * call in `CheckoutRouter` that a case-insensitive rule would flag.
 */
const FORBIDDEN_CALLS = [
  {pattern: /\.observe\s*\(/g, name: ".observe(", why: "Uniswap v3 TWAP observation"},
  {pattern: /\.consult\s*\(/g, name: ".consult(", why: "Uniswap v2 oracle read"},
  {
    pattern: /(?<![A-Za-z0-9_$])oracle\s*\(/g,
    name: "oracle()",
    why: "USYC Teller price oracle — E-07 says a pledge is haircut, never marked",
  },
];

/**
 * The concrete address this phase must never read. Recorded live from chain 5042002
 * by plan 07-01 as finding 32: `USYC_TELLER.oracle()`.
 */
const FORBIDDEN_ADDRESSES = [
  {
    value: "0x52b56c7642e71dc54714d879127d97cd0b3d4581",
    name: "USYC Teller oracle (finding 32)",
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
    else if (entry.endsWith(".sol")) acc.push(full);
  }
  return acc;
}

/**
 * Blank every comment and string literal, replacing their characters with spaces so
 * that line and column numbers in a report still point at the real source.
 *
 * A regex would not do here. `"https://…"` inside a string literal is not a comment,
 * and `// the word oracle` inside a block comment is not two comments. The state
 * machine is short and it is the part of this file that decides whether the rule
 * survives contact with the prose that explains it.
 */
function blankCommentsAndStrings(source) {
  const out = Array.from(source);
  let state = "code"; // code | line | block | double | single
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        out[i] = " ";
        out[i + 1] = " ";
        i++;
      } else if (c === "/" && next === "*") {
        state = "block";
        out[i] = " ";
        out[i + 1] = " ";
        i++;
      } else if (c === '"') {
        state = "double";
        out[i] = " ";
      } else if (c === "'") {
        state = "single";
        out[i] = " ";
      }
      continue;
    }

    if (state === "line") {
      if (c === "\n") state = "code";
      else out[i] = " ";
      continue;
    }

    if (state === "block") {
      if (c === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i++;
        state = "code";
      } else if (c !== "\n") {
        out[i] = " ";
      }
      continue;
    }

    // Inside a string literal. Escapes are consumed as a pair so that a trailing
    // backslash cannot close the literal early and leak the rest of the file.
    if (c === "\\") {
      out[i] = " ";
      if (next !== undefined) out[i + 1] = " ";
      i++;
      continue;
    }
    if ((state === "double" && c === '"') || (state === "single" && c === "'")) {
      out[i] = " ";
      state = "code";
      continue;
    }
    if (c !== "\n") out[i] = " ";
  }
  return out.join("");
}

const files = walk(join(ROOT, TREE));
const violations = [];

for (const file of files) {
  const stripped = blankCommentsAndStrings(readFileSync(file, "utf8"));
  const lines = stripped.split("\n");
  const rel = relative(ROOT, file).split(sep).join("/");

  lines.forEach((line, i) => {
    for (const word of FORBIDDEN_WORDS) {
      const re = new RegExp(`(?<![A-Za-z0-9_$])${word}(?![A-Za-z0-9_$])`, "gi");
      if (re.test(line)) {
        violations.push({file: rel, line: i + 1, found: word, text: line.trim()});
      }
    }
    for (const call of FORBIDDEN_CALLS) {
      call.pattern.lastIndex = 0;
      if (call.pattern.test(line)) {
        violations.push({file: rel, line: i + 1, found: call.name, why: call.why, text: line.trim()});
      }
    }
    const lower = line.toLowerCase();
    for (const address of FORBIDDEN_ADDRESSES) {
      if (lower.includes(address.value)) {
        violations.push({file: rel, line: i + 1, found: address.name, text: line.trim()});
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`A price oracle reached ${TREE} — ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.found}${v.why ? `  (${v.why})` : ""}`);
    console.error(`    ${v.text}\n`);
  }
  console.error(
    'CLAUDE.md, "What NOT to Use": "Any price oracle of any kind — §1 removes volatile\n' +
      'collateral, which removes the reason to have one. Adding one re-adds an attack\n' +
      'surface for nothing."\n\n' +
      "There is exactly one legal shape for a price on this chain: a signed, band-bounded,\n" +
      "short-TTL attestation a contract uses to REFUSE a fill — never to value a position,\n" +
      "size a limit or price a payout. If the attestation is missing or stale, nothing is\n" +
      "valued and the origination does not happen. That is `FxMidAttestation`, and it is why\n" +
      "it is not a violation.\n\n" +
      "A pledge is valued at par minus `TIER2_PLEDGE_HAIRCUT_BPS`, never at a mark (E-07).",
  );
  process.exit(1);
}

console.log(
  `No price oracle in ${TREE} — ${files.length} Solidity files read, ` +
    `${FORBIDDEN_WORDS.length + FORBIDDEN_CALLS.length + FORBIDDEN_ADDRESSES.length} patterns, ` +
    "comments and string literals excluded.",
);
