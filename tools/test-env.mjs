/**
 * Hand the test database URL from the repo-root `.env` to vitest, and nothing else.
 *
 * `.env.example` says `PLAZO_TEST_DATABASE_URL` is part of the documented local setup, but
 * nothing was reading it: vitest does not load `.env` into `process.env`, and turbo passes
 * variables through rather than loading them. So the documented setup produced a suite that
 * could not find the database it had just been told about, and the obvious next move — a
 * default URL, or a skip — is precisely what the integration fixtures exist to prevent.
 *
 * **Only `PLAZO_TEST_DATABASE_URL` crosses.** Loading the whole file would also set
 * `DATABASE_URL`, which is the switch `resolveAuditLog` and `resolveSessionStore` read: unit
 * tests that expect an in-memory store would silently start writing to a real database, and
 * the first sign of it would be a test suite that passes locally and fails on a machine
 * without Postgres. One variable, named, is the whole contract.
 *
 * An already-exported value wins over the file, so CI can set it without a `.env` existing.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const KEY = "PLAZO_TEST_DATABASE_URL";

/**
 * A deliberately small parser: `KEY=value`, optional quotes, `#` comments, blank lines.
 *
 * Not dotenv, because pulling a dependency into the build to read one line of one file is a
 * worse trade than twelve lines that a reviewer can read in full.
 */
export function testEnv() {
  if (process.env[KEY]) return {[KEY]: process.env[KEY]};

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  let text;
  try {
    text = readFileSync(join(root, ".env"), "utf8");
  } catch {
    // No `.env`. Not an error here — the fixtures fail loudly, with instructions, at the
    // point where the absence actually matters.
    return {};
  }

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== KEY) continue;

    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (value) return {[KEY]: value};
  }

  return {};
}
