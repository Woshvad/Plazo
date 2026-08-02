import type {CSSProperties} from "react";

import {COLORS} from "@plazo/ui";
import {contrastRatio, WCAG_AA_NORMAL} from "@plazo/ui/contrast";
import {renderToStaticMarkup} from "react-dom/server";
import {beforeEach, describe, expect, it, vi} from "vitest";

import Checkout from "../app/page";
import {resolveTheme, SHIPPED_THEMES, themeStyle} from "../app/_theme";

/**
 * The creditor disclosure survives every theme this deployment ships. APP-07, D-22.
 *
 * The loop over `SHIPPED_THEMES` is the whole point. A test that named three themes by
 * hand would pass forever while a fourth was added beside it; iterating the record means
 * adding a theme without a passing contrast assertion is not something a contributor can
 * do by accident, because the loop finds it.
 *
 * Everything here is asserted from **computed style**, not from markup. An attacker — or,
 * far more likely, a partner-integration branch under deadline — would not delete this
 * element. They would leave it exactly where it is and make it invisible, and a test that
 * only checked the HTML contained a sentence would go green through all eight ways that
 * happens.
 *
 * `renderToStaticMarkup` into jsdom rather than a React testing library, per DEC-35. The
 * render is static, the assertions are `getComputedStyle`, and jsdom answers that on
 * parsed markup exactly as it does on a mounted tree. See `vitest.config.ts`.
 */

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** Render the checkout page inside a themed wrapper, exactly as `layout.tsx` does. */
function renderUnder(themeId: string, extra?: Record<string, string>): HTMLElement {
  const theme = resolveTheme(themeId, extra);
  document.body.innerHTML = renderToStaticMarkup(
    <div data-plazo-theme={theme.id} style={themeStyle(theme) as CSSProperties}>
      <Checkout />
    </div>,
  );
  return document.body;
}

function disclosureIn(root: HTMLElement): HTMLElement {
  const found = root.querySelectorAll("[data-plazo-creditor]");
  expect(found, "the creditor disclosure must render exactly once").toHaveLength(1);
  return found[0] as HTMLElement;
}

describe.each(Object.keys(SHIPPED_THEMES))("under the %s theme", (themeId) => {
  it("renders exactly one creditor disclosure, with text in it", () => {
    const node = disclosureIn(renderUnder(themeId));
    expect(node.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("is not concealed by any of the properties that conceal without deleting", () => {
    const node = disclosureIn(renderUnder(themeId));
    const style = getComputedStyle(node);

    // No `|| default` anywhere below. jsdom resolves every one of these to a real
    // value on this element — it even converts the rem to `11px` — so a fallback would
    // only ever paper over the case where the declaration went missing.
    expect(style.display, "display: none is concealment").not.toBe("none");
    expect(style.visibility, "visibility: hidden is concealment").not.toBe("hidden");
    expect(Number.parseFloat(style.opacity)).toBeGreaterThan(0);
    expect(Number.parseFloat(style.fontSize)).toBeGreaterThan(0);
    // Off-screen is concealment too, and it needs a positioning context to achieve.
    expect(style.position).toBe("static");
    expect(style.transform).toBe("none");
  });

  it("clears the AA contrast floor on its own resolved pair", () => {
    const node = disclosureIn(renderUnder(themeId));
    const style = getComputedStyle(node);
    const ratio = contrastRatio(style.color, style.backgroundColor);

    expect(
      ratio,
      `the disclosure renders ${style.color} on ${style.backgroundColor} at ${ratio.toFixed(2)}:1, under the ${WCAG_AA_NORMAL} floor — the buyer cannot read who the creditor is`,
    ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });

  it("paints the same pair whatever the theme is, because it reads no theme token", () => {
    const style = getComputedStyle(disclosureIn(renderUnder(themeId)));
    const plazo = getComputedStyle(disclosureIn(renderUnder("plazo")));

    expect(style.color).toBe(plazo.color);
    expect(style.backgroundColor).toBe(plazo.backgroundColor);
  });

  it("sits outside every step branch, as a direct child of the page", () => {
    // Each step of the ceremony renders its own `<section>`. The disclosure being a
    // direct child of `<main>` is what "renders on every step" means structurally — a
    // conditional would have to wrap it, and wrapping it turns the presence assertion
    // above red. That deliberate-failure check was run; see the plan SUMMARY.
    const node = disclosureIn(renderUnder(themeId));
    expect(node.parentElement?.tagName).toBe("MAIN");
  });

  it("has a legible primary control, so the accent is not a way to hide the button", () => {
    const theme = resolveTheme(themeId);
    const accent = theme.tokens["--plazo-accent"]!;
    const ratio = contrastRatio(theme.onAccent, accent);

    expect(
      ratio,
      `theme "${themeId}" paints ${theme.onAccent} on ${accent} at ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
  });
});

/**
 * The adversarial half. A property that cannot be made to fail is not being tested.
 */
describe("a theme that is trying", () => {
  it("cannot fade the accent away and take the disclosure with it", () => {
    const root = renderUnder("plazo", {"--plazo-accent": "transparent"});
    const style = getComputedStyle(disclosureIn(root));

    // `transparent` is not a hex, so the accent guard refuses it and the default is
    // used. The disclosure is unaffected either way, which is the property: it does
    // not read the accent, so there is nothing for a transparent one to do to it.
    expect(resolveTheme("plazo", {"--plazo-accent": "transparent"}).dropped).toBe(1);
    expect(contrastRatio(style.color, style.backgroundColor)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL,
    );
  });

  it("cannot smuggle `display: none` through an off-allowlist token", () => {
    const attempt = {
      display: "none",
      "--plazo-display": "none",
      "--plazo-creditor-display": "none",
    };

    expect(resolveTheme("plazo", attempt).dropped).toBe(3);

    const style = getComputedStyle(disclosureIn(renderUnder("plazo", attempt)));
    expect(style.display).toBe("block");
    expect(style.visibility).toBe("visible");
  });

  it("cannot repaint the disclosure by supplying a colour token", () => {
    const attempt = {color: COLORS.white, "--plazo-color": COLORS.white};
    const root = renderUnder("plazo", attempt);
    const style = getComputedStyle(disclosureIn(root));

    expect(resolveTheme("plazo", attempt).dropped).toBe(2);
    expect(contrastRatio(style.color, style.backgroundColor)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL,
    );
  });

  it("cannot blank the disclosure by configuring an empty string", () => {
    vi.stubEnv("NEXT_PUBLIC_PLAZO_CREDITOR_DISCLOSURE", "   ");
    const node = disclosureIn(renderUnder("plazo"));

    expect(node.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    vi.unstubAllEnvs();
  });
});

describe("the wording", () => {
  it("comes from configuration, so counsel can supply it without a code change", () => {
    // D-22: this plan builds the slot. It does not decide what goes in it, and it
    // asserts nothing about the sentence beyond that whatever is configured renders.
    const wording = "Credit provided by Plazo. Partner is not the creditor.";
    vi.stubEnv("NEXT_PUBLIC_PLAZO_CREDITOR_DISCLOSURE", wording);

    expect(disclosureIn(renderUnder("partner-dark")).textContent).toBe(wording);
    vi.unstubAllEnvs();
  });
});
