import {defineConfig} from "vitest/config";

/**
 * No database, no network, no `.env`.
 *
 * Every test in this package runs against recorded fixtures and injected doubles,
 * which is E-03's whole point: the StableFX OpenAPI spec is public, so the client,
 * its schemas and its tests are writable and runnable today without the KYB/AML-gated
 * key. A suite that needed the key would be a suite nobody could run.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    reporters: ["default"],
  },
});
