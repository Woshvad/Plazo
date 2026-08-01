#!/usr/bin/env node
/**
 * Forbids `block.timestamp` inside Foundry test code.
 *
 * Phase 5 turned on `via_ir` (DEC-30) and this fell out of it immediately: the IR
 * optimizer treats `block.timestamp` as constant within a call, because on a real chain
 * it is. `vm.warp` is a cheatcode the optimizer cannot see, so a loop of
 *
 *     for (...) { vm.warp(block.timestamp + WINDOW); plan.revalidate(); }
 *
 * reads the timestamp *once*, hoists it out, and warps to the same moment every
 * iteration. The test still passes or fails — it just stops testing what it says.
 * `KeeperMarket.t.sol` caught it by failing; a test that had been asserting a weaker
 * property would have gone on passing.
 *
 * `vm.getBlockTimestamp()` goes through the cheatcode address, so it cannot be hoisted.
 *
 * Mocks and stubs are exempt: they are plain contracts called from the test, so each
 * call is its own frame and reads the clock fresh — and they have no `vm` to call.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ROOTS = ["contracts/test", "contracts/script"];
const EXEMPT = ["mocks", "stubs"];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (EXEMPT.includes(entry)) continue;
      yield* walk(path);
    } else if (path.endsWith(".sol")) {
      yield path;
    }
  }
}

const violations = [];

for (const tree of ROOTS) {
  for (const file of walk(join(ROOT, tree))) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
      if (line.includes("block.timestamp")) {
        violations.push({
          file: relative(ROOT, file).split(sep).join("/"),
          line: i + 1,
          text: line.trim(),
        });
      }
    });
  }
}

if (violations.length > 0) {
  console.error("`block.timestamp` in test code is not reliable under via_ir:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}\n`);
  }
  console.error(
    "The IR optimizer hoists it past `vm.warp`, so a second read in the same call frame\n" +
      "returns the first read's value. Use `vm.getBlockTimestamp()`.",
  );
  process.exit(1);
}

console.log("Test clock reads go through the cheatcode — no hoistable `block.timestamp`.");
