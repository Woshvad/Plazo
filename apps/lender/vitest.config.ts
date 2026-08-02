import {defineConfig} from "vitest/config";

/**
 * The lender app's tests.
 *
 * `environment: "node"` and not jsdom, deliberately. Every component this app renders is
 * a server component with no event handler, no effect and no client state — so the thing
 * worth asserting is the markup that reaches the browser, which `renderToStaticMarkup`
 * produces directly. A jsdom environment would add a DOM nothing here reads, and the
 * React testing libraries would add three registry surfaces to assert on output they
 * would first have to render anyway. This follows DEC-35's reasoning from plan 06-03,
 * which declined the same packages for the same reason.
 *
 * `esbuild.jsx` is set here because the app's tsconfig says `"jsx": "preserve"` — Next
 * compiles the JSX, so TypeScript is told to leave it alone. Vitest has no Next in front
 * of it and would meet raw JSX as a syntax error.
 */
export default defineConfig({
  esbuild: {jsx: "automatic"},
  test: {
    include: ["test/**/*.test.ts?(x)"],
    environment: "node",
  },
});
