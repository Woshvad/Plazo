import {COLORS, FONT_STACKS, WHITE_LABEL} from "@plazo/ui";
import {contrastRatio, WCAG_AA_NORMAL} from "@plazo/ui/contrast";
import {beforeEach, describe, expect, it, vi} from "vitest";

import {
  accentIsLegible,
  configuredThemeId,
  DEFAULT_THEME_ID,
  resolveTheme,
  SHIPPED_THEMES,
  signThemeId,
  THEMEABLE,
  themeStyle,
  verifySignedThemeId,
} from "../app/_theme";

/**
 * The theme resolver. APP-07, and the half of D-22 that is about what a partner can
 * reach rather than what they cannot.
 *
 * Every test here is a refusal. That is deliberate: the resolver's job is not to apply
 * a theme — applying a theme is a spread — it is to decline the values that would turn
 * white-labelling into concealment, and a suite that only checked the happy path would
 * pass against a resolver with no checks in it at all.
 */

// `console.warn` fires on every refusal by design. Silence it so a suite that is
// mostly refusals does not read as a suite that is mostly broken.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("THEMEABLE", () => {
  it("is closed at exactly four properties", () => {
    expect(Object.keys(THEMEABLE)).toHaveLength(4);
    expect(Object.keys(THEMEABLE).sort()).toEqual([
      "--plazo-accent",
      "--plazo-font-sans",
      "--plazo-logo-url",
      "--plazo-radius",
    ]);
  });

  it("contains none of the eight properties that hide an element", () => {
    // Not a spelling check. Each of these conceals without deleting, and the whole
    // requirement is that the disclosure cannot be concealed.
    for (const forbidden of [
      "display",
      "visibility",
      "opacity",
      "position",
      "z-index",
      "font-size",
      "color",
      "transform",
    ]) {
      const matches = Object.keys(THEMEABLE).filter((property) => property.includes(forbidden));
      expect(matches, `"${forbidden}" is reachable through ${matches.join(", ")}`).toEqual([]);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(THEMEABLE)).toBe(true);
  });
});

describe("resolveTheme", () => {
  it("drops a property that is not on the allowlist, and counts it", () => {
    const resolved = resolveTheme(DEFAULT_THEME_ID, {"--plazo-shadow": "none"});

    expect(resolved.dropped).toBe(1);
    expect(Object.keys(resolved.tokens)).toHaveLength(4);
    expect(resolved.tokens).not.toHaveProperty("--plazo-shadow");
  });

  it("drops an attempt to reach `display` through a token name", () => {
    const resolved = resolveTheme(DEFAULT_THEME_ID, {
      display: "none",
      "--plazo-display": "none",
      "--plazo-accent-display": "none",
    });

    expect(resolved.dropped).toBe(3);
    for (const attempted of ["display", "--plazo-display", "--plazo-accent-display"]) {
      expect(resolved.tokens).not.toHaveProperty(attempted);
    }
    // `--plazo-logo-url` is the one property whose *default* is `none`, and it is a
    // background image rather than a `display`. Everything else kept its own default.
    expect(resolved.tokens["--plazo-accent"]).toBe(COLORS.accent);
    expect(resolved.tokens["--plazo-logo-url"]).toBe("none");
  });

  it("drops a malformed colour and keeps the default accent", () => {
    const resolved = resolveTheme(DEFAULT_THEME_ID, {
      "--plazo-accent": "transparent",
    });

    expect(resolved.dropped).toBe(1);
    expect(resolved.tokens["--plazo-accent"]).toBe(COLORS.accent);
  });

  it("drops a colour that is syntactically a function call", () => {
    // `rgb(0 0 0 / 0)` is a valid CSS colour and a fully transparent one. Hex-only is
    // the guard, and this is the value it exists to refuse.
    const resolved = resolveTheme(DEFAULT_THEME_ID, {"--plazo-accent": "rgb(0 0 0 / 0)"});

    expect(resolved.dropped).toBe(1);
    expect(resolved.tokens["--plazo-accent"]).toBe(COLORS.accent);
  });

  it("drops a radius that is not a length", () => {
    const resolved = resolveTheme(DEFAULT_THEME_ID, {"--plazo-radius": "9999999px"});

    expect(resolved.dropped).toBe(1);
    expect(resolved.tokens["--plazo-radius"]).toBe(SHIPPED_THEMES[DEFAULT_THEME_ID]!.overrides["--plazo-radius"]);
  });

  it("drops a font stack carrying anything that could close the value", () => {
    for (const attempt of [
      "sans-serif; position: fixed",
      "url(https://example.test/x)",
      "}html{opacity:0}",
    ]) {
      const resolved = resolveTheme(DEFAULT_THEME_ID, {"--plazo-font-sans": attempt});
      expect(resolved.dropped, attempt).toBe(1);
      expect(resolved.tokens["--plazo-font-sans"]).toBe(FONT_STACKS.body);
    }
  });

  it("refuses a logo on an origin nobody approved, and takes one that is approved", () => {
    const approved = "https://cdn.partner.test/mark.svg";

    const refused = resolveTheme(DEFAULT_THEME_ID, {"--plazo-logo-url": approved});
    expect(refused.dropped).toBe(1);
    expect(refused.logoUrl).toBeNull();
    expect(refused.tokens["--plazo-logo-url"]).toBe("none");

    vi.stubEnv("PLAZO_ASSET_ORIGINS", "https://cdn.partner.test");
    const taken = resolveTheme(DEFAULT_THEME_ID, {"--plazo-logo-url": approved});
    expect(taken.dropped).toBe(0);
    expect(taken.logoUrl).toBe(approved);
    expect(taken.tokens["--plazo-logo-url"]).toBe(`url("${approved}")`);

    // Same origin allowlist, wrong scheme. `http:` is a downgrade on a signing page.
    const insecure = resolveTheme(DEFAULT_THEME_ID, {"--plazo-logo-url": "http://cdn.partner.test/m.svg"});
    expect(insecure.dropped).toBe(1);
    vi.unstubAllEnvs();
  });

  it("returns the default map for an unknown theme id rather than throwing", () => {
    const unknown = resolveTheme("a-theme-that-does-not-exist");

    expect(unknown.id).toBe(DEFAULT_THEME_ID);
    expect(unknown.dropped).toBe(0);
    expect(unknown.tokens["--plazo-accent"]).toBe(COLORS.accent);
  });

  it("returns the default map for no id at all", () => {
    expect(resolveTheme().id).toBe(DEFAULT_THEME_ID);
    expect(resolveTheme(undefined).surface).toBe(WHITE_LABEL.plazo.surface);
  });

  it("always returns every allowlisted property, whatever was supplied", () => {
    for (const id of Object.keys(SHIPPED_THEMES)) {
      const resolved = resolveTheme(id);
      expect(Object.keys(resolved.tokens).sort()).toEqual(Object.keys(THEMEABLE).sort());
      for (const value of Object.values(resolved.tokens)) {
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  it("carries the theme's own surface and accent ink, which a partner cannot set", () => {
    const dark = resolveTheme("partner-dark", {
      "--plazo-surface": COLORS.white,
      "--plazo-on-accent": COLORS.white,
    });

    expect(dark.dropped).toBe(2);
    expect(dark.surface).toBe(WHITE_LABEL.partnerDark.surface);
    expect(dark.onAccent).toBe(WHITE_LABEL.partnerDark.onAccent);
    expect(themeStyle(dark)["--plazo-surface"]).toBe(WHITE_LABEL.partnerDark.surface);
  });
});

describe("SHIPPED_THEMES", () => {
  it("ships at least a default and two materially different partner examples", () => {
    const ids = Object.keys(SHIPPED_THEMES);
    expect(ids).toContain(DEFAULT_THEME_ID);
    expect(ids.length).toBeGreaterThanOrEqual(3);

    const accents = new Set(ids.map((id) => resolveTheme(id).tokens["--plazo-accent"]));
    expect(accents.size).toBe(ids.length);
  });

  it("has a legible accent pair in every theme", () => {
    for (const [id, theme] of Object.entries(SHIPPED_THEMES)) {
      const accent = resolveTheme(id).tokens["--plazo-accent"]!;
      const ratio = contrastRatio(theme.onAccent, accent);
      expect(
        accentIsLegible(theme),
        `theme "${id}" paints ${theme.onAccent} on ${accent} at ${ratio.toFixed(2)}:1, under the ${WCAG_AA_NORMAL} floor — its primary control cannot be read`,
      ).toBe(true);
    }
  });
});

describe("the theme id", () => {
  it("falls back to Plazo's own when unconfigured or unknown", () => {
    expect(configuredThemeId()).toBe(DEFAULT_THEME_ID);

    vi.stubEnv("PLAZO_THEME", "not-a-theme");
    expect(configuredThemeId()).toBe(DEFAULT_THEME_ID);

    vi.stubEnv("PLAZO_THEME", "partner-dark");
    expect(configuredThemeId()).toBe("partner-dark");
    vi.unstubAllEnvs();
  });

  it("accepts only a correctly signed id from a session record", () => {
    vi.stubEnv("PLAZO_THEME_SECRET", "a-secret-that-only-the-operator-holds");

    expect(verifySignedThemeId(signThemeId("partner-light"))).toBe("partner-light");

    // The three things a framing page could try.
    expect(verifySignedThemeId("partner-light")).toBeUndefined();
    expect(verifySignedThemeId("partner-light.deadbeef")).toBeUndefined();
    expect(
      verifySignedThemeId(`partner-dark.${signThemeId("partner-light").split(".")[1]}`),
    ).toBeUndefined();

    // A signature over an id that names no shipped theme is still refused.
    expect(verifySignedThemeId(signThemeId("not-a-theme"))).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("refuses everything when no secret is configured", () => {
    expect(verifySignedThemeId("partner-light.00")).toBeUndefined();
    expect(verifySignedThemeId(undefined)).toBeUndefined();
  });
});
