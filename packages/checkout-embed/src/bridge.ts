/**
 * The `postMessage` protocol between the hosted checkout and the merchant page —
 * the **host** side.
 *
 * This is a deliberate copy of the checkout app's `_bridge.ts`, not an import of it.
 * The embed is open source (D-21) and the checkout app is proprietary, so
 * `tools/check-boundaries.mjs` forbids the import outright: an open tree that reached
 * into `apps/` would produce a public repository that does not build. The copy is not
 * trusted, either — `test/bridge-parity.test.ts` reads the other file as text and
 * fails if the four declarations below have drifted by so much as a member.
 *
 * ## Why the shape is the security property
 *
 * **Nothing sensitive crosses, by construction rather than by discipline.** There is no
 * message shape that can carry a signature, a private key, a wallet handle, an
 * authorization payload or a session token *out* of the frame — not because the code is
 * careful, but because the union below has no variant that could hold one. The one
 * inbound variant that carries a session id goes merchant → checkout, over an explicit
 * target origin, and never the other way. A future message carrying a secret would have
 * to be added here **and** to `_bridge.ts`, in two diffs, where somebody would see it
 * (DEC-20).
 *
 * **Every message is origin-checked on both ends.** An explicit `targetOrigin` on send,
 * `event.origin` on receive — and, on this side, `event.source` as well. A merchant page
 * may hold several frames and any of them can post to the top document, so origin alone
 * is not an authentication of the sender. The checkout app does not need the source check
 * because it only ever talks to `window.parent`; the host does, because it has children.
 *
 * ## The direction reversal
 *
 * `send`/`listen` here are the mirror of the app's. The app sends `Outbound` to its
 * parent and listens for `Inbound`; the host sends `Inbound` to a frame and listens for
 * `Outbound`. Same union, opposite ends of the wire.
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
 * Send to the frame.
 *
 * `targetOrigin` is required and there is no default, for the same reason the app's
 * `send` refuses one: a helper that defaulted to `"*"` would be used, and every use
 * would be a message delivered to whoever the frame happens to have navigated to.
 * On this side the stake is higher — the only inbound variant carries the session id.
 */
export function send(frame: HTMLIFrameElement, message: Inbound, targetOrigin: string): void {
  const target = frame.contentWindow;
  if (!target) return;
  target.postMessage(message, targetOrigin);
}

/**
 * Listen to one frame, from one origin only.
 *
 * Returns the unsubscribe. Both checks are load-bearing and neither is sufficient
 * alone: `event.origin` establishes *which site* spoke, `event.source` establishes
 * *which window*. A hostile frame on the same merchant page cannot forge the first;
 * a same-origin sibling frame — an ad slot on the checkout origin, a second Plazo
 * instance — would pass it and fail the second.
 */
export function listen(
  frame: HTMLIFrameElement,
  expectedOrigin: string,
  handler: (message: Outbound) => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== expectedOrigin) return;
    if (event.source !== frame.contentWindow) return;
    if (!isOutbound(event.data)) return;
    handler(event.data);
  };

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/**
 * Whether a value is a message this protocol admits.
 *
 * A structural check rather than a cast. The data crossed a trust boundary, so its
 * shape is a claim; a handler that destructured `event.data.planId` without this would
 * hand `undefined` to a merchant's `onComplete` and let them look it up on chain.
 */
export function isOutbound(value: unknown): value is Outbound {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  switch (message["type"]) {
    case "plazo:resize":
      return typeof message["height"] === "number" && Number.isFinite(message["height"]);
    case "plazo:state":
      return (
        typeof message["step"] === "string" &&
        STEPS.includes(message["step"] as Step) &&
        typeof message["total"] === "number" &&
        typeof message["index"] === "number"
      );
    case "plazo:complete":
      return typeof message["planId"] === "string" && /^0x[0-9a-fA-F]{64}$/.test(message["planId"]);
    case "plazo:cancelled":
      return CANCEL_REASONS.includes(message["reason"] as CancelReason);
    default:
      return false;
  }
}

const CANCEL_REASONS: readonly CancelReason[] = ["declined", "abandoned", "expired", "unavailable"];
