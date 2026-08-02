/**
 * The drop-in. APP-06.
 *
 * A merchant adds one script tag and makes one call, and a buyer gets the hosted
 * checkout in an iframe on Plazo's own origin. That is the entire integration surface:
 * a session id the merchant already created server-side, the origin to frame, and two
 * callbacks. There is no option to configure the message channel, no option to relax
 * an origin check, and no option to pass the session id another way — every one of
 * those would be a knob whose only use is to weaken the thing it configures.
 *
 * ## The session id never touches the DOM
 *
 * It crosses in the `plazo:open` postMessage and nowhere else — not a query parameter, not
 * a fragment, not a `name` attribute, not a data attribute. DEC-20's union has exactly
 * that one variant for exactly this reason. A session id in the iframe's `src` is a
 * session id in the merchant's server logs, in their analytics, in the `Referer` of
 * every subresource the checkout page loads, and in any browser extension that can read
 * the DOM. `test/checkout.test.ts` asserts it appears nowhere in the frame's
 * `outerHTML`, so this stays true rather than merely being intended.
 *
 * ## Two checks on every inbound message, not one
 *
 * `event.origin` says which site spoke. `event.source` says which window. A merchant's
 * page is untrusted and may hold any number of frames — an ad slot, a chat widget, a
 * second Plazo instance, or something an attacker injected. Origin alone would admit a
 * `plazo:complete` from any of them that happened to load Plazo's origin, and a
 * merchant who fulfils an order on a forged completion has shipped goods for free.
 * Both checks live in `listen`; this module never reads `event` directly.
 *
 * ## What the callbacks are worth
 *
 * `onComplete` receives a `planId` — a public identifier, verifiable on chain. It is a
 * reference, not a receipt. A merchant fulfilling on the strength of the callback alone
 * is trusting a message from a frame; the callback is the cue to go and look, and the
 * chain is the answer. The webhook, which arrives signed and server-side, is the one to
 * fulfil on.
 */
import {listen, send, type CancelReason, type Step} from "./bridge.js";

declare global {
  interface Window {
    /** The drop-in's global, populated by whichever modules the bundle includes. */
    Plazo?: Record<string, unknown>;
  }
}

export interface CheckoutState {
  step: Step;
  total: number;
  index: number;
}

export interface CheckoutOptions {
  /**
   * A session the merchant's server already created. Opaque here.
   *
   * This is the only secret the embed handles, and it handles it by putting it in one
   * `postMessage` and forgetting it.
   */
  sessionId: string;
  /**
   * The checkout origin, e.g. `https://checkout.plazo.example`.
   *
   * Required, with no default, for the same reason `send` refuses to default
   * `targetOrigin`: a default would be used, and a wrong default would be a session id
   * posted to somebody else's origin. It is also the origin every inbound message is
   * checked against, so getting it wrong fails closed — the frame loads and nothing
   * else happens — rather than failing open.
   */
  origin: string;
  /** Terminal. `planId` is public; verify it on chain or wait for the webhook. */
  onComplete: (planId: `0x${string}`) => void;
  /** Terminal. A reason the merchant can act on. */
  onCancel: (reason: CancelReason) => void;
  /** Optional progress, for a host that wants to show its own spinner. */
  onState?: (state: CheckoutState) => void;
  /** Where to mount. Defaults to `document.body`. */
  container?: HTMLElement;
}

export interface CheckoutHandle {
  /** Remove the frame and stop listening. Safe to call more than once. */
  close(): void;
  /** The mounted frame, for a host that wants to style its container. */
  readonly frame: HTMLIFrameElement;
}

/**
 * The minimum sandbox that leaves a working checkout.
 *
 * `allow-same-origin` is here because the checkout page needs its own origin to have
 * storage and to be able to talk to its own API — a sandboxed frame without it is
 * opaque-origin and cannot do either. That is safe precisely because the frame is
 * cross-origin to the merchant: `allow-same-origin` restores the frame's *own* origin,
 * not the host's. `allow-top-navigation` is deliberately absent, so a compromised
 * checkout page cannot navigate the merchant's storefront away mid-purchase.
 */
const SANDBOX = "allow-scripts allow-forms allow-same-origin allow-popups";

/**
 * The one live instance.
 *
 * A merchant who calls `checkout` twice — a double-clicked button, a re-render — must
 * not end up with two frames. Two frames means two sessions racing for one order, and
 * the buyer sees whichever one happens to be on top. The second call replaces the
 * first.
 */
let active: {handle: CheckoutHandle; teardown: () => void} | null = null;

/**
 * Open the hosted checkout.
 *
 * @throws if `sessionId` or `origin` is missing. Failing loudly at the call site beats
 * mounting a frame that will never receive a session.
 */
export function checkout(options: CheckoutOptions): CheckoutHandle {
  if (typeof document === "undefined") {
    throw new Error("Plazo.checkout needs a browser document");
  }
  if (!options.sessionId) throw new Error("Plazo.checkout needs a sessionId");
  if (!options.origin) throw new Error("Plazo.checkout needs the checkout origin");

  const origin = new URL(options.origin).origin;

  // Replace rather than stack. See `active`.
  active?.teardown();

  const frame = document.createElement("iframe");
  frame.src = `${origin}/`;
  frame.title = "Plazo checkout";
  frame.setAttribute("sandbox", SANDBOX);
  frame.referrerPolicy = "no-referrer";
  frame.style.border = "0";
  frame.style.width = "100%";
  frame.style.height = "0px";
  frame.style.display = "block";

  (options.container ?? document.body).append(frame);

  /**
   * `plazo:open` goes out at most twice, and that is not belt-and-braces.
   *
   * On `load` the frame's document exists but its script may not have registered a
   * listener yet, so a single send there can be dropped silently. The frame's first
   * message proves the listener is live, so a send there always lands. Neither event
   * alone is reliable; both together are, and `plazo:open` is idempotent because the
   * session was created server-side and carries no state this call could duplicate.
   */
  let opened = 0;
  const open = () => {
    if (opened >= 2) return;
    opened += 1;
    send(frame, {type: "plazo:open", sessionId: options.sessionId}, origin);
  };

  const unlisten = listen(frame, origin, (message) => {
    open();
    switch (message.type) {
      case "plazo:resize":
        frame.style.height = `${message.height}px`;
        return;
      case "plazo:state":
        options.onState?.({step: message.step, total: message.total, index: message.index});
        return;
      case "plazo:complete":
        options.onComplete(message.planId);
        return;
      case "plazo:cancelled":
        options.onCancel(message.reason);
        return;
    }
  });

  frame.addEventListener("load", open);

  const teardown = () => {
    unlisten();
    frame.removeEventListener("load", open);
    frame.remove();
    if (active?.handle === handle) active = null;
  };

  const handle: CheckoutHandle = {
    frame,
    close: teardown,
  };

  active = {handle, teardown};
  return handle;
}

/**
 * Exposed for a merchant loading the bundle as a classic script.
 *
 * Merged rather than assigned, so loading `checkout` and `messaging` from separate
 * builds does not have one silently erase the other.
 */
if (typeof window !== "undefined") {
  window.Plazo = {...(window.Plazo ?? {}), checkout};
}
