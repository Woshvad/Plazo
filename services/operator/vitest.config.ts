import {defineConfig} from "vitest/config";

// @ts-expect-error -- repo tooling, plain ESM with no type declarations by design.
import {testEnv} from "../../tools/test-env.mjs";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    reporters: ["default"],
    /**
     * `PLAZO_TEST_DATABASE_URL` from the repo-root `.env`, and nothing else from it.
     * See `tools/test-env.mjs` for why the whole file must not be loaded.
     */
    env: testEnv() as Record<string, string>,
    /**
     * The delivery suite starts a real listening socket and waits on a real HTTP
     * round trip through the SSRF guard. The default 5s is enough on this machine
     * and is not enough on a cold CI runner.
     */
    testTimeout: 30_000,
  },
});
