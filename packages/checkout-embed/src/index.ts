/**
 * `@plazo/checkout-embed` — the drop-in.
 *
 * Two surfaces, one script tag. `checkout` opens the hosted checkout in an iframe on
 * Plazo's own origin (APP-06); `messaging` renders the pre-cart line on a product page
 * and, when the buyer has a wallet connected, the limit the router would actually
 * enforce (CHKT-06).
 *
 * Apache-2.0, and that is a design decision rather than a default (D-21). This code
 * runs in the buyer's browser, where it is readable regardless; a proprietary licence
 * would buy nothing and would cost the posture the rest of the protocol is built on.
 * A merchant can read what they paste into their checkout page, and a buyer can read
 * what reads their limit.
 */
export * from "./bridge.js";
