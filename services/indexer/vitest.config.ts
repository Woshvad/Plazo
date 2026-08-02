import {defineConfig} from "vitest/config";

// @ts-expect-error -- repo tooling, plain ESM with no type declarations by design.
import {testEnv} from "../../tools/test-env.mjs";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    /**
     * `PLAZO_TEST_DATABASE_URL` from the repo-root `.env`, and nothing else from it.
     *
     * Without this the fixture falls back to its 5432 default, which on a host where
     * `PLAZO_PG_PORT` had to be changed is some other project's Postgres — and the
     * resulting `28P01` reads as a broken suite rather than as a misconfigured port. See
     * `tools/test-env.mjs` for why the whole file must not be loaded.
     */
    env: testEnv() as Record<string, string>,
  },
});
