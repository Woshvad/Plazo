#!/usr/bin/env node
/**
 * Dependency-direction check.
 *
 * The licence posture — protocol contracts and the strip tooling open source,
 * operator services proprietary — is only real if the code respects it. The
 * open tree must never reach into the proprietary tree, or the eventual
 * `git subtree split` produces a public repo that does not build.
 *
 * Fails the build. A policy document would not.
 */
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join, relative, sep} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** Trees that ship under an open licence and may not depend on anything closed. */
const OPEN = ["contracts", "packages/plan-core", "packages/events", "packages/arc-verify"];

/** Trees that are proprietary. Nothing open may import from these. */
const CLOSED = ["apps", "services"];

/** Workspace package names that belong to the closed tree. */
const CLOSED_PACKAGES = ["@plazo/indexer", "@plazo/shell"];

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|sol)$/;
const SKIP = new Set(["node_modules", ".git", "dist", "out", "cache", ".next", ".turbo", "lib", "corpus"]);

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

/** Import specifiers, covering ESM, CJS, dynamic import and Solidity. */
const SPECIFIER =
  /(?:from\s+|import\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g;

const violations = [];

for (const tree of OPEN) {
  for (const file of walk(join(ROOT, tree))) {
    const text = readFileSync(file, "utf8");
    for (const [, spec] of text.matchAll(SPECIFIER)) {
      const closedPackage = CLOSED_PACKAGES.find((p) => spec === p || spec.startsWith(`${p}/`));
      const closedPath = CLOSED.find(
        (c) => spec.includes(`/${c}/`) || spec.startsWith(`${c}/`) || spec.startsWith(`../${c}/`),
      );
      if (closedPackage || closedPath) {
        violations.push({
          file: relative(ROOT, file).split(sep).join("/"),
          spec,
          target: closedPackage ?? closedPath,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Licence boundary violated — the open tree imports from the proprietary tree:\n");
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    imports "${v.spec}"  →  ${v.target}\n`);
  }
  console.error(
    "The open tree must stand alone. Move the shared code into packages/, or invert the\n" +
      "dependency so the proprietary side imports the open side.",
  );
  process.exit(1);
}

console.log(`Licence boundary intact — ${OPEN.length} open trees, no reach into ${CLOSED.join(", ")}.`);
