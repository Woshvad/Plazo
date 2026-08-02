/**
 * The Developers and Treasury screens.
 *
 * The load-bearing assertion here is about a **secret**, and it is asserted twice because
 * "shown exactly once" is two different claims:
 *
 * 1. *The view* renders it when it is handed one and does not render it otherwise. That is
 *    the component half, and it is what stops a re-render of the list from leaking it.
 * 2. *The cell* it comes from hands it over once and never again. That is the mechanism
 *    half, and without it the first claim is only true until somebody presses refresh.
 *
 * The rest is the set of statements this screen makes that a merchant will act on and
 * would be harmed by being wrong: that a replay carries a fresh `webhook-id`, that no
 * signing secret is on the page, and that the bond requirement and its headroom are
 * shown as numbers rather than as a subtraction the reader has to do.
 */

import {renderToStaticMarkup} from "react-dom/server";
import {beforeEach, describe, expect, it} from "vitest";

import {Developers, holdCreatedKey, takeCreatedKey} from "../app/Developers";
import {Treasury} from "../app/Treasury";
import {
  deliveries,
  deliveryDetail,
  endpoints,
  keys,
  treasury,
  type ApiKey,
  type Deliveries,
  type Endpoints,
  type Keys,
  type Treasury as TreasuryPayload,
} from "../app/_data";

const SECRET = "plazo_sandbox_a7150cd2e9b34f68_Kf3xQ-nP_2Wxm";

let keyList: Keys;
let endpointList: Endpoints;
let log: Deliveries;
let book: TreasuryPayload;

beforeEach(async () => {
  [keyList, endpointList, log, book] = await Promise.all([
    keys(),
    endpoints(),
    deliveries(),
    treasury(),
  ]);
  document.body.innerHTML = "";
});

function render(overrides: Partial<Parameters<typeof Developers>[0]> = {}): HTMLElement {
  document.body.innerHTML = renderToStaticMarkup(
    <Developers
      keys={keyList}
      endpoints={endpointList}
      deliveries={log}
      filter={{}}
      {...overrides}
    />,
  );
  return document.body;
}

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// ─────────────────────────────────────────────────────────────────────────────

describe("a freshly issued secret", () => {
  it("renders exactly once when the view is handed one", () => {
    const key = keyList.keys[1]!;
    const root = render({created: {key, secret: SECRET}});

    expect(occurrences(root.innerHTML, SECRET)).toBe(1);
    expect(root.querySelector(`[data-created-key="${key.keyId}"]`)).not.toBeNull();
    expect(root.textContent).toMatch(/will not be shown again/i);
  });

  it("does not appear when the list is re-rendered without it", () => {
    const key = keyList.keys[1]!;
    render({created: {key, secret: SECRET}});
    const again = render({created: null});

    expect(again.innerHTML).not.toContain(SECRET);
    expect(again.querySelector("[data-created-key]")).toBeNull();
    // The key itself is still listed. Only the secret is gone.
    expect(again.querySelector(`[data-key-id="${key.keyId}"]`)).not.toBeNull();
  });

  it("is handed over by the one-shot cell once and then never again", () => {
    const key = keyList.keys[1]!;
    const token = holdCreatedKey(key, SECRET);

    expect(takeCreatedKey(token)?.secret).toBe(SECRET);
    expect(takeCreatedKey(token)).toBeNull();
    expect(takeCreatedKey(undefined)).toBeNull();
    expect(takeCreatedKey("oc_not-a-token")).toBeNull();
  });

  it("names the overlap on a rotation, so the merchant knows how long the old key lives", () => {
    const rotated: ApiKey = {
      ...keyList.keys[1]!,
      rotatedFrom: "3f9c2a71b04e8d55",
      expiresAt: "2026-08-09T10:41:03.000Z",
    };
    const root = render({created: {key: rotated, secret: SECRET}});

    expect(root.textContent).toContain("replaces 3f9c2a71b04e8d55");
    expect(root.textContent).toContain("2026-08-09");
  });
});

describe("no secret is on the screen that should not be", () => {
  it("renders no signing secret for any endpoint, only how many are live", () => {
    const root = render();

    expect(root.innerHTML.toLowerCase()).not.toContain("whsec");
    for (const endpoint of endpointList.endpoints) {
      expect(root.querySelector(`[data-endpoint="${endpoint.id}"]`)).not.toBeNull();
    }
    expect(root.textContent).toMatch(/2 live — rotating/);
    expect(root.textContent).toMatch(/signing secret is never shown here/i);
  });

  it("shows only the last four characters of an API key, never the secret", () => {
    const root = render();
    for (const key of keyList.keys) {
      expect(root.textContent).toContain(`…${key.last4}`);
    }
    expect(root.innerHTML).not.toContain(SECRET);
  });
});

describe("the delivery log", () => {
  it("states that a replay carries a fresh webhook-id, on every row", () => {
    const root = render();
    const rows = [...root.querySelectorAll("[data-delivery]")];

    expect(rows.length).toBe(log.deliveries.length);
    for (const row of rows) {
      expect(row.textContent).toMatch(/fresh.{0,20}webhook-id/s);
    }
    expect(root.querySelectorAll("[data-replay]").length).toBe(log.deliveries.length);
  });

  it("shows the failures, which is the only reason a merchant opens it", () => {
    const root = render();
    const outcomes = [...root.querySelectorAll("[data-delivery]")].map(
      (node) => (node as HTMLElement).dataset["outcome"],
    );

    expect(outcomes).toContain("500");
    expect(outcomes).toContain("never sent");
  });

  it("loads the bodies only for the row that was opened", async () => {
    const opened = await deliveryDetail("dlv_7f21c1");
    expect(opened).not.toBeNull();

    const root = render({opened});
    const panes = [...root.querySelectorAll("[data-bodies]")];
    expect(panes).toHaveLength(1);
    expect((panes[0] as HTMLElement).dataset["bodies"]).toBe("dlv_7f21c1");
    expect(panes[0]?.textContent).toContain("payout.dispatched");
    expect(panes[0]?.textContent).toContain("502 Bad Gateway");
  });

  it("reports the new webhook-id after a replay rather than saying only that it worked", () => {
    const root = render({replayedWebhookId: "msg_11111111-2222-3333-4444-555555555555"});
    const notice = root.querySelector("[data-replayed]");

    expect(notice?.textContent).toContain("msg_11111111-2222-3333-4444-555555555555");
    expect(notice?.textContent).toMatch(/will not dedupe/i);
  });

  it("promises no ordering and points at the chain's instead", () => {
    const root = render();
    expect(root.textContent).toMatch(/No ordering is promised/);
    expect(root.textContent).toContain("blockNumber");
    expect(root.textContent).toContain("logIndex");
  });

  it("tells the merchant what to verify: three headers, the format, and the window", () => {
    const root = render();
    const text = root.textContent ?? "";

    expect(text).toContain("webhook-timestamp");
    expect(text).toContain("webhook-signature");
    expect(text).toContain("v1,<base64 hmac-sha256 over id.timestamp.body>");
    expect(text).toContain("300");
    expect(text).toMatch(/two.{0,30}space-separated signatures/s);
  });
});

describe("Treasury", () => {
  it("shows the requirement and the headroom as numbers, not as a subtraction", () => {
    document.body.innerHTML = renderToStaticMarkup(<Treasury data={book} />);
    const text = document.body.textContent ?? "";

    expect(text).toContain("Requirement");
    expect(text).toContain("Free to withdraw");
    // 118.40 posted against a 96.50 requirement leaves 21.90.
    expect(text).toContain("$21.90");
  });

  it("breaks out the part of the bond that arrived by withholding", () => {
    document.body.innerHTML = renderToStaticMarkup(<Treasury data={book} />);
    expect(document.body.textContent).toMatch(/arrived by withholding from your own settlements/);
    // 51_216_000 units. `usd` truncates rather than rounds, matching apps/lender: a
    // display that rounded up would show a merchant a cent of bond they do not have.
    expect(document.body.textContent).toContain("$51.21");
  });

  it("names a shortfall as a shortfall rather than as negative headroom", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <Treasury data={{...book, bond: "10000000"}} />,
    );
    const text = document.body.textContent ?? "";

    expect(text).toContain("Shortfall");
    expect(text).not.toContain("Free to withdraw");
    expect(text).toMatch(/origination is blocked/);
  });

  it("says why an escrowed merchant is escrowed and that the opt-out is governance-gated", () => {
    document.body.innerHTML = renderToStaticMarkup(<Treasury data={book} />);
    expect(document.body.textContent).toMatch(/governance-gated/);
    expect(document.body.textContent).toMatch(/not a setting on this page/);
  });

  it("drops that explanation once the merchant settles instantly", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <Treasury data={{...book, settlementCategory: "Instant"}} />,
    );
    expect(document.body.textContent).not.toMatch(/governance-gated/);
    expect(document.body.textContent).toMatch(/within a block of checkout/);
  });

  it("shows the velocity headroom rather than only the cap", () => {
    document.body.innerHTML = renderToStaticMarkup(<Treasury data={book} />);
    // 2,500.00 cap less 965.00 used.
    expect(document.body.textContent).toContain("$1,535.00 of headroom");
  });
});
