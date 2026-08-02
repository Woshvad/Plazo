import {defineConfig} from "vitest/config";

/**
 * The merchant dashboard's tests.
 *
 * `environment: "jsdom"`, matching `apps/checkout` rather than `apps/lender`, and for the
 * same kind of reason checkout gave: the assertions here are **structural**, not textual.
 * The load-bearing claim on the refunds screen is that a partial refund suppresses the
 * *tail* of the schedule and leaves every earlier due date untouched — which is a
 * statement about which rows carry which status, and about the rows either side of the
 * boundary. Asserted as substrings that would be a test that passes on a screen showing
 * the suppression in the wrong place, because both screens contain the same words.
 *
 * `jsdom@30.0.1` is already in this workspace, installed by `packages/checkout-embed` in
 * plan 06-03 and legitimacy-gated there. No package new to the tree is added here.
 *
 * The React testing libraries are still declined, following DEC-35. Every component in
 * this app renders from props with no effect and no data fetching of its own, so
 * `renderToStaticMarkup` produces the markup and jsdom answers `querySelector` on it
 * exactly as it would on a mounted tree. `@testing-library/react` would add an act()
 * loop over a render that is already static.
 *
 * `esbuild.jsx` is set here because the app's tsconfig says `"jsx": "preserve"` — Next
 * compiles the JSX, so TypeScript is told to leave it alone. Vitest has no Next in front
 * of it and would meet raw JSX as a syntax error.
 */
export default defineConfig({
  esbuild: {jsx: "automatic"},
  test: {
    include: ["test/**/*.test.ts?(x)"],
    environment: "jsdom",
  },
});
