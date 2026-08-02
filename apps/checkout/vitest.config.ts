import {defineConfig} from "vitest/config";

/**
 * Checkout's tests.
 *
 * `environment: "jsdom"` and not node, which is the opposite of the call `apps/lender`
 * made and for a reason that is specific rather than stylistic. The property under test
 * here is that the creditor disclosure cannot be concealed, and "concealed" is a
 * statement about computed style: `display`, `visibility`, `opacity`, a font size. A
 * markup-only assertion would check that a string is present in some HTML, which is the
 * half of this that was never going to be wrong — an attacker who wanted the disclosure
 * gone would leave the element exactly where it is and make it invisible.
 *
 * `jsdom@30.0.1` is already in this workspace, installed by `packages/checkout-embed`
 * in plan 06-03 and legitimacy-gated there. No package new to the tree is added here.
 *
 * The React testing libraries are still declined, following DEC-35. `renderToStaticMarkup`
 * produces the markup, jsdom parses it and answers `getComputedStyle` — which is the
 * entire assertion. `@testing-library/react` would add an act() loop and a query API on
 * top of a render that is already static, and `@vitejs/plugin-react` exists for Fast
 * Refresh, which a test run does not have. Two registry surfaces for no assertion.
 *
 * `esbuild.jsx` is set here because the app's tsconfig says `"jsx": "preserve"` — Next
 * compiles the JSX, so TypeScript is told to leave it alone. Vitest has no Next in
 * front of it and would meet raw JSX as a syntax error.
 */
export default defineConfig({
  esbuild: {jsx: "automatic"},
  test: {
    include: ["test/**/*.test.ts?(x)"],
    environment: "jsdom",
  },
});
