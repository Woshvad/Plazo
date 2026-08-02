/**
 * `MerchantPlane.emit` — the seam that turns a credential event into a signed webhook.
 *
 * ## Why this could not live in either service
 *
 * `key.rotated` is D-18's, and D-18 is the one piece of the merchant plane that was
 * specified and not delivered end to end. The reason is structural rather than an
 * oversight: the key store is `@plazo/origination`'s, the webhook fan-out is
 * `@plazo/servicing`'s, and DEC-64 forbids a dependency between them in either direction —
 * a cycle in the operator plane is worse than a hole in it. So `MerchantPlane.emit` is an
 * optional injected method with no implementation anywhere, and until something held both
 * halves a merchant saw a rotation in their dashboard and never in their inbox.
 *
 * This file is that something. It is eleven lines of glue and it is the whole reason the
 * composition root is worth building.
 *
 * ## Every destination is re-validated, on this path too
 *
 * `fanout` calls `deliver`, `deliver` calls `assertDeliverable`, and `assertDeliverable`
 * resolves the hostname and checks **every** address it gets back — on this send, not on
 * the registration that happened last month. Nothing here reaches around that, and nothing
 * here may: a webhook URL is chosen by the merchant and fetched from inside Plazo's
 * network, so the composition root adding a second, unguarded send path would reopen the
 * highest-severity control in the layer (T-06-06-01, T-06-06-02).
 *
 * ## A credential event carries identifiers, never a credential
 *
 * The payload comes from `emitKeyRotated` in the origination API and is a
 * `Record<string, string | null>` of key ids, a tail and an expiry. The new secret is in
 * the HTTP response to the caller and nowhere else. A webhook goes to a URL the merchant
 * chose, over a channel whose far end Plazo does not control; a live credential in it is a
 * credential handed to whoever most recently edited that destination.
 */
import {fanout, type DeliveryDeps, type WebhookDeliveryOutcome} from "@plazo/servicing";
import type {MerchantEvent} from "@plazo/origination";

export interface MerchantEventEmitterOptions {
  /**
   * Everything `deliver` needs: the servicing handle, and the injected `fetch`, clock and
   * resolver that let a test assert a real send without owning DNS.
   */
  readonly delivery: DeliveryDeps;
  /**
   * Called once per fan-out with the outcomes. The default does nothing.
   *
   * There is no logging in here on purpose. A payload's field names are the merchant's and
   * a URL is theirs too; what to record about a delivery is a deployment's decision, and
   * this file having an opinion would put it in every deployment.
   */
  readonly onDelivered?: ((event: MerchantEvent, outcomes: WebhookDeliveryOutcome[]) => void) | undefined;
}

/**
 * Build the emitter.
 *
 * The returned function never throws. `deliver` already turns a refused destination, a
 * timeout and a 500 into rows rather than exceptions, and `fanout` skips a merchant with no
 * destination registered — which is a merchant who has not asked for webhooks, not a
 * failure. What remains is a database that has gone away mid-request, and reporting that as
 * a failed *rotation* would tell a merchant their key did not move when it did.
 */
export function merchantEventEmitter(
  options: MerchantEventEmitterOptions,
): (event: MerchantEvent) => Promise<void> {
  return async (event: MerchantEvent): Promise<void> => {
    try {
      const outcomes = await fanout(options.delivery, event.merchantId, {
        event: event.event,
        data: event.payload,
      });
      options.onDelivered?.(event, outcomes);
    } catch {
      // See above. The delivery log holds every attempt that got as far as being one.
    }
  };
}
