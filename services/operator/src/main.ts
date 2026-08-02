/**
 * The process. `pnpm --filter @plazo/operator start`.
 *
 * ## Environment
 *
 * | Variable | Effect |
 * |---|---|
 * | `DATABASE_URL` | **Required.** Both services' tables, one `operator` schema. No in-memory mode (DEC-63). |
 * | `PLAZO_ENVIRONMENT` | `sandbox` (default) or `live`. Decides which keys authenticate at all. |
 * | `PLAZO_OPERATOR_PORT` | Listen port. Default 8787. |
 * | `PLAZO_OPERATOR_HOST` | Bind address. Default `127.0.0.1` — see below. |
 * | `PLAZO_RELAYER_GATE_ADDRESS` | The relayer gate, so `/ops/keeper-share` can tell its own cranks from a stranger's. |
 *
 * **The default bind is loopback, not `0.0.0.0`.** A process holding an authentication
 * store and an audit log should not become reachable from the network by forgetting a
 * variable; exposing it is a deliberate act with a value attached to it.
 *
 * **`PLAZO_ENVIRONMENT` defaults to `sandbox` and the banner says which world came up.** A
 * production deployment that forgets it refuses every live key on shape, one string
 * comparison in, with no database reached. That is the correct direction to fail in — a
 * sandbox key must never settle real money — and the banner is what stops somebody
 * debugging it for an afternoon.
 *
 * ## Shutdown
 *
 * `SIGINT` and `SIGTERM` close the listener and stop accepting. In-flight webhook deliveries
 * are bounded by their own 10-second timeout and are allowed to finish; a delivery killed
 * mid-flight is a row that says "no response" about a request the merchant may well have
 * received, which is worse than a slow shutdown.
 */
import {serve} from "@hono/node-server";

import {composeOperator} from "./compose.js";

const DEFAULT_PORT = 8787;

function main(): void {
  const {app, environment} = composeOperator();

  const port = Number(process.env["PLAZO_OPERATOR_PORT"] ?? DEFAULT_PORT);
  const hostname = process.env["PLAZO_OPERATOR_HOST"] ?? "127.0.0.1";

  const server = serve({fetch: app.fetch, port, hostname}, (info) => {
    // eslint-disable-next-line no-console
    console.log(
      `[plazo:operator] serving the '${environment}' environment on http://${hostname}:${info.port}\n` +
        "[plazo:operator] merchant plane wired: keys, rate limit, webhooks, replay, attestations, key.rotated\n" +
        "[plazo:operator] borrower (/me) and operator (/ops) planes answer 501 — their credentials are unbuilt",
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      // eslint-disable-next-line no-console
      console.log(`[plazo:operator] ${signal} — closing the listener, letting deliveries finish`);
      server.close(() => process.exit(0));
    });
  }
}

main();
