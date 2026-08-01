/**
 * The `postMessage` protocol between the hosted checkout and the merchant page.
 *
 * CHKT-07's other half. The CSP decides who may frame this page; this decides what
 * crosses the frame, and the answer is: three message kinds, none of which carries
 * anything a merchant could sign with.
 *
 * **Nothing sensitive crosses, by construction rather than by discipline.** There is no
 * message shape that can carry a signature, a private key, a wallet handle, an
 * authorization payload or a session token — not because the code is careful, but
 * because the union type below has no variant that could hold one. A future message
 * carrying a secret would have to be added to this file, in a diff, where somebody would
 * see it.
 *
 * **Every message is origin-checked on both ends.** `event.origin` on receive, an
 * explicit `targetOrigin` on send. A `postMessage` to `"*"` is a broadcast to whoever
 * happens to be framing you, and "whoever happens to be framing you" is the threat this
 * app exists to contain.
 *
 * **The result is a reference, not a receipt.** `complete` carries a `planId` — a public
 * identifier the merchant can look up on chain and verify for themselves. It does not
 * carry an assertion from this page that the plan is good, because a merchant who
 * trusted a `postMessage` from a frame would be trusting whatever ended up in the frame.
 */

/** Checkout → merchant. */
export type Outbound =
  /** The embed should resize. The only thing this page asks the host to do. */
  | {type: "plazo:resize"; height: number}
  /** Where the borrower is in the ceremony, for a host that wants to show progress. */
  | {type: "plazo:state"; step: Step; total: number; index: number}
  /** Terminal. `planId` is public and independently verifiable on chain. */
  | {type: "plazo:complete"; planId: `0x${string}`}
  /** Terminal. A reason the merchant can act on, never a stack trace. */
  | {type: "plazo:cancelled"; reason: CancelReason};

/** Merchant → checkout. */
export type Inbound =
  /** Open a session the merchant has already created server-side. */
  | {type: "plazo:open"; sessionId: string}
  /** The buyer closed the modal on the host side. */
  | {type: "plazo:close"};

export type Step = "quote" | "identity" | "signing" | "settling" | "done";

export type CancelReason = "declined" | "abandoned" | "expired" | "unavailable";

export const STEPS: readonly Step[] = ["quote", "identity", "signing", "settling", "done"];

/**
 * Send to the host.
 *
 * `targetOrigin` is required and there is no default. A helper that defaulted to `"*"`
 * would be used, and every use would be a message delivered to whoever framed the page.
 */
export function send(message: Outbound, targetOrigin: string): void {
  if (typeof window === "undefined") return;
  if (window.parent === window) return;
  window.parent.postMessage(message, targetOrigin);
}

/**
 * Listen to the host, from one origin only.
 *
 * Returns the unsubscribe. The origin comes from the deployment's allowlist rather than
 * from the message itself — a handler that trusted `event.origin` to decide whether to
 * trust `event.origin` is not a check.
 */
export function listen(
  expectedOrigin: string,
  handler: (message: Inbound) => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== expectedOrigin) return;
    if (!isInbound(event.data)) return;
    handler(event.data);
  };

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

function isInbound(value: unknown): value is Inbound {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as {type?: unknown}).type;
  if (type === "plazo:close") return true;
  if (type === "plazo:open") return typeof (value as {sessionId?: unknown}).sessionId === "string";
  return false;
}

/**
 * Whether an origin is one this deployment will talk to.
 *
 * The same list the CSP's `frame-ancestors` is built from, so a merchant cannot be
 * allowed to frame the page and then refused a message, or the reverse.
 */
export function allowedOrigins(): string[] {
  const configured = process.env["NEXT_PUBLIC_PLAZO_FRAME_ANCESTORS"] ?? "";
  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
