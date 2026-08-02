import {defineConfig} from "vitest/config";

/**
 * The repository's first browser test environment.
 *
 * Every other package here is arithmetic and can be tested in Node. This one is not:
 * it creates iframes, reads `event.origin` and `event.source`, and asserts on rendered
 * DOM. A headless test of that would be a test of string construction, which is the
 * half of the code that was never going to be wrong.
 *
 * `jsdom` is the only browser-environment dependency this package takes. The React
 * testing libraries were considered and dropped — nothing here renders React, so they
 * would have been three more registry surfaces for no assertion.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "jsdom",
  },
});
