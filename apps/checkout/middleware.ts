import {NextResponse, type NextRequest} from "next/server";

/**
 * The security boundary. CHKT-07.
 *
 * The requirement is that checkout runs on its own origin under a strict CSP and talks
 * to the merchant page only by `postMessage`, so the merchant page never handles a
 * signature, a key or a wallet. That is not a deployment note — it is enforced here, on
 * every response, because a header set in one place is a header somebody can forget in
 * another.
 *
 * **`frame-ancestors` is the load-bearing directive.** It decides who may put this page
 * in an iframe, and it is the only thing standing between a hosted checkout and a
 * clickjacked one. It is *not* `*`: an allowlist is read from configuration, and an
 * unconfigured deployment permits nothing rather than everything. That is the correct
 * failure direction — a merchant whose domain is missing sees a blank frame and calls
 * support, where the alternative is a checkout any site on the internet can wrap.
 *
 * `X-Frame-Options` is deliberately *not* set. It cannot express an allowlist, so the
 * only value that would not break the embed is `ALLOWALL`, which is worse than nothing.
 * Every browser Plazo supports honours `frame-ancestors`.
 *
 * **No inline script without a nonce.** A per-request nonce rather than
 * `unsafe-inline`, because the whole point of this origin is that a script injected into
 * the page cannot read the borrower's signing surface, and `unsafe-inline` gives that
 * away for the convenience of one style tag.
 *
 * **`connect-src` is 'self'.** The page talks to Plazo's own API and to nothing else.
 * A wallet that needs an outbound origin is added here explicitly, one host at a time,
 * so the list is a decision rather than a default.
 */

/** Merchant origins permitted to frame this page. Empty means nobody. */
const FRAME_ANCESTORS = (process.env["PLAZO_FRAME_ANCESTORS"] ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * React's development build calls `eval` to reconstruct stack frames across the
 * server/client boundary. Production never does.
 *
 * So the carve-out is scoped to the development build and to nothing else, and it is a
 * literal comparison against `NODE_ENV` rather than a configuration flag — a switch an
 * operator can set is a switch that will eventually be set in production, and
 * `unsafe-eval` on the page holding a borrower's signing surface is the last policy
 * anybody should be able to relax by accident.
 */
const DEV_EVAL = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

function policy(nonce: string): string {
  const ancestors = FRAME_ANCESTORS.length > 0 ? FRAME_ANCESTORS.join(" ") : "'none'";

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${DEV_EVAL}`,
    // Tailwind emits a style element. `unsafe-inline` for styles is a far smaller
    // surface than for scripts, and the alternative is a nonce Next cannot thread
    // through the CSS pipeline.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}

export function middleware(request: NextRequest) {
  const nonce = crypto.randomUUID().replace(/-/g, "");

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);

  const response = NextResponse.next({request: {headers}});

  response.headers.set("Content-Security-Policy", policy(nonce));
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  // The merchant page must not be able to reach into this document, and this document
  // must not be able to reach into the opener. `postMessage` is the whole channel.
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
