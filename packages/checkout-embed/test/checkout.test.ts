import {afterEach, describe, expect, it, vi} from "vitest";

import {checkout} from "../src/checkout.js";

/**
 * The drop-in, under jsdom.
 *
 * Three of these tests are the security properties written down as assertions rather
 * than as comments: the session id is not in the DOM, a wrong-origin message is
 * ignored, and a right-origin-wrong-window message is ignored. The rest cover the
 * mechanics a merchant will notice if they break.
 *
 * jsdom does not load iframe content, so `frame.contentWindow` exists but is an empty
 * about:blank window. That is exactly what these tests want: it gives a real window
 * object to use as `event.source` without any of the frame's own script running.
 */

const ORIGIN = "https://checkout.plazo.test";
const PLAN_ID = `0x${"ab".repeat(32)}` as const;

/**
 * Deliver a message as the browser would.
 *
 * `MessageEvent`'s `origin` and `source` are read-only, so they are set through the
 * constructor rather than assigned — which is also the honest simulation, because in a
 * real browser they are set by the engine and are not forgeable from script.
 */
function deliver(data: unknown, origin: string, source: Window | null): void {
  window.dispatchEvent(new MessageEvent("message", {data, origin, source}));
}

function frameOf(container: HTMLElement): HTMLIFrameElement {
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("no frame was mounted");
  return frame;
}

let containers: HTMLElement[] = [];

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  return container;
}

afterEach(() => {
  for (const container of containers) container.remove();
  containers = [];
  document.body.innerHTML = "";
});

describe("checkout", () => {
  it("mounts one sandboxed frame against the configured origin", () => {
    const container = mount();
    checkout({
      sessionId: "s_one",
      origin: ORIGIN,
      onComplete: () => {},
      onCancel: () => {},
      container,
    });

    const frame = frameOf(container);
    expect(frame.src).toBe(`${ORIGIN}/`);
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-forms allow-same-origin allow-popups",
    );
    expect(frame.referrerPolicy).toBe("no-referrer");
    // A sandboxed frame that could navigate the storefront away is a phishing primitive.
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  });

  it("keeps the session id out of every attribute of the frame", () => {
    const container = mount();
    checkout({
      sessionId: "s_secret",
      origin: ORIGIN,
      onComplete: () => {},
      onCancel: () => {},
      container,
    });

    const frame = frameOf(container);
    expect(frame.outerHTML).not.toContain("s_secret");
    expect(frame.src).not.toContain("s_secret");
    // Belt and braces: nothing anywhere in the host document carries it either.
    expect(document.body.innerHTML).not.toContain("s_secret");
  });

  it("ignores a completion from the wrong origin", () => {
    const container = mount();
    const onComplete = vi.fn();
    checkout({sessionId: "s_two", origin: ORIGIN, onComplete, onCancel: () => {}, container});

    const frame = frameOf(container);
    deliver({type: "plazo:complete", planId: PLAN_ID}, "https://evil.test", frame.contentWindow);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("ignores a completion from the right origin but the wrong window", () => {
    const container = mount();
    const onComplete = vi.fn();
    checkout({sessionId: "s_three", origin: ORIGIN, onComplete, onCancel: () => {}, container});

    // A second frame on the merchant's page. It can post whatever it likes; what it
    // cannot do is be the window this handle is bound to.
    const impostor = document.createElement("iframe");
    document.body.append(impostor);

    deliver({type: "plazo:complete", planId: PLAN_ID}, ORIGIN, impostor.contentWindow);

    expect(onComplete).not.toHaveBeenCalled();
    impostor.remove();
  });

  it("surfaces a completion from the frame with the planId", () => {
    const container = mount();
    const onComplete = vi.fn();
    checkout({sessionId: "s_four", origin: ORIGIN, onComplete, onCancel: () => {}, container});

    const frame = frameOf(container);
    deliver({type: "plazo:complete", planId: PLAN_ID}, ORIGIN, frame.contentWindow);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(PLAN_ID);
  });

  it("surfaces a cancellation with its reason", () => {
    const container = mount();
    const onCancel = vi.fn();
    checkout({sessionId: "s_five", origin: ORIGIN, onComplete: () => {}, onCancel, container});

    const frame = frameOf(container);
    deliver({type: "plazo:cancelled", reason: "declined"}, ORIGIN, frame.contentWindow);

    expect(onCancel).toHaveBeenCalledWith("declined");
  });

  it("resizes the frame on plazo:resize", () => {
    const container = mount();
    checkout({
      sessionId: "s_six",
      origin: ORIGIN,
      onComplete: () => {},
      onCancel: () => {},
      container,
    });

    const frame = frameOf(container);
    expect(frame.style.height).toBe("0px");
    deliver({type: "plazo:resize", height: 640}, ORIGIN, frame.contentWindow);
    expect(frame.style.height).toBe("640px");
  });

  it("reports progress on plazo:state", () => {
    const container = mount();
    const onState = vi.fn();
    checkout({
      sessionId: "s_seven",
      origin: ORIGIN,
      onComplete: () => {},
      onCancel: () => {},
      onState,
      container,
    });

    const frame = frameOf(container);
    deliver({type: "plazo:state", step: "signing", total: 5, index: 2}, ORIGIN, frame.contentWindow);

    expect(onState).toHaveBeenCalledWith({step: "signing", total: 5, index: 2});
  });

  it("rejects a malformed message that claims a known type", () => {
    const container = mount();
    const onComplete = vi.fn();
    checkout({sessionId: "s_eight", origin: ORIGIN, onComplete, onCancel: () => {}, container});

    const frame = frameOf(container);
    // No planId at all, and a planId that is not one. A merchant handed `undefined`
    // here would look it up on chain, find nothing, and blame the chain.
    deliver({type: "plazo:complete"}, ORIGIN, frame.contentWindow);
    deliver({type: "plazo:complete", planId: "0xdeadbeef"}, ORIGIN, frame.contentWindow);

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("removes the frame on close and stops delivering", () => {
    const container = mount();
    const onComplete = vi.fn();
    const handle = checkout({
      sessionId: "s_nine",
      origin: ORIGIN,
      onComplete,
      onCancel: () => {},
      container,
    });

    const frame = handle.frame;
    handle.close();

    expect(container.querySelector("iframe")).toBeNull();
    deliver({type: "plazo:complete", planId: PLAN_ID}, ORIGIN, frame.contentWindow);
    expect(onComplete).not.toHaveBeenCalled();

    // Idempotent: a merchant closing twice is a double-clicked button, not an error.
    expect(() => handle.close()).not.toThrow();
  });

  it("replaces rather than stacks when called twice", () => {
    const container = mount();
    checkout({
      sessionId: "s_ten",
      origin: ORIGIN,
      onComplete: () => {},
      onCancel: () => {},
      container,
    });
    checkout({
      sessionId: "s_eleven",
      origin: ORIGIN,
      onComplete: () => {},
      onCancel: () => {},
      container,
    });

    expect(container.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("refuses to open without a session id or an origin", () => {
    const container = mount();
    expect(() =>
      checkout({
        sessionId: "",
        origin: ORIGIN,
        onComplete: () => {},
        onCancel: () => {},
        container,
      }),
    ).toThrow(/sessionId/);
    expect(() =>
      checkout({
        sessionId: "s_twelve",
        origin: "",
        onComplete: () => {},
        onCancel: () => {},
        container,
      }),
    ).toThrow(/origin/);
    expect(container.querySelector("iframe")).toBeNull();
  });
});
