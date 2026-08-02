import {createHmac, timingSafeEqual} from "node:crypto";

import {COLORS, RADIUS_LENGTHS, WHITE_LABEL} from "@plazo/ui";
import {contrastRatio, WCAG_AA_NORMAL} from "@plazo/ui/contrast";

/**
 * White-label chrome for the hosted checkout. APP-07.
 *
 * A PSP may repaint this page. What they may repaint is four presentational values and
 * nothing else, and the reason the number is four rather than "whatever they ask for"
 * is that this is the page a buyer signs a credit agreement on. REQUIREMENTS.md's Out
 * of Scope says it directly: "Fully invisible white-label — the buyer is signing a
 * credit agreement; concealing the creditor is a disclosure violation in every consumer
 * regime."
 *
 * So this file builds the *slot*, not the string (D-22). It decides what a partner can
 * reach; `_CreditorDisclosure.tsx` decides what they cannot. Neither invents a
 * compliance requirement about wording, size or proximity — that is counsel's call and
 * it arrives through configuration.
 *
 * ## Why an allowlist and not a denylist
 *
 * A denylist grows a hole every time `packages/ui` adds a token, and nobody revisits
 * the denylist when they add one. The hole is always the one that hides text. A closed
 * allowlist has the opposite failure: a new design-system token is non-themeable by
 * default and a partner has to ask, which is a conversation rather than an incident.
 *
 * ## The eight properties that may never be themeable
 *
 * `display`, `visibility`, `opacity`, `position`, `z-index`, `font-size`, `color` and
 * `transform`. Those are the eight ways an element gets hidden without being deleted —
 * collapsed, made invisible, faded to nothing, moved off screen, buried under another
 * layer, shrunk to nothing, painted the colour of its own background, or scaled to
 * zero. Adding any of them to `THEMEABLE` re-opens the whole requirement. If a partner
 * needs one, the answer is no.
 *
 * ## Where the theme id comes from, and where it does not
 *
 * Server-side, from the deployment's own configuration or from a signed id on the
 * session record. Never a query parameter, never a `postMessage`, never a header the
 * embedding page can set. `_bridge.ts` has no theme variant and must not gain one
 * (DEC-20) — a theme the framing page can choose is a theme an attacker who has
 * compromised the framing page can choose, and the first thing they would choose is a
 * chrome that does not say who the creditor is.
 */

// ─── The allowlist ──────────────────────────────────────────────────────────

/** Whether a partner-supplied value is acceptable for one themeable property. */
type Guard = (value: string) => boolean;

/** Hex only. Every other colour notation is a parser, and a parser is a way in. */
const COLOUR_FORM = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A small non-negative length. Three digits and two units is the whole vocabulary. */
const LENGTH_FORM = /^(?:0|[0-9]{1,3}(?:\.[0-9]{1,3})?(?:px|rem))$/;

/** Family names, quotes, commas, spaces, hyphens. Nothing that could close a value. */
const FONT_FORM = /^[A-Za-z0-9 ,"'-]{1,160}$/;

const isColour: Guard = (value) => COLOUR_FORM.test(value);

const isLength: Guard = (value) => LENGTH_FORM.test(value);

const isFontStack: Guard = (value) => FONT_FORM.test(value) && !/url|expression|@/i.test(value);

/**
 * An absolute HTTPS URL on an origin this deployment has been told to serve assets
 * from. T-06-04-04.
 *
 * A logo is a request the buyer's browser makes while they are mid-signature, so an
 * unconstrained URL is an attacker learning that a specific buyer reached a specific
 * step — and, with a redirect, rather more than that. `PLAZO_ASSET_ORIGINS` permits
 * nothing when unconfigured, matching `frame-ancestors` in `middleware.ts`: a partner
 * whose origin is missing sees Plazo's own wordmark and calls support, where the
 * alternative is a checkout that fetches from anywhere.
 */
const isAssetUrl: Guard = (value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return assetOrigins().includes(url.origin);
};

function assetOrigins(): string[] {
  return (process.env["PLAZO_ASSET_ORIGINS"] ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * The closed set. Exactly four, and the count is asserted in `theme.test.ts`.
 *
 * Accent, corner radius, a logo slot and a font stack. That is a partner's whole
 * surface: the colour of the primary control, how sharp its corners are, whose mark
 * sits at the top, and what the prose is set in.
 */
export const THEMEABLE: Readonly<Record<string, Guard>> = Object.freeze({
  "--plazo-accent": isColour,
  "--plazo-radius": isLength,
  "--plazo-logo-url": isAssetUrl,
  "--plazo-font-sans": isFontStack,
});

/** The property names, as a type, so a typo is a build error. */
export type ThemeableProperty = keyof typeof THEMEABLE;

// ─── The shipped themes ─────────────────────────────────────────────────────

export interface ShippedTheme {
  readonly id: string;
  readonly label: string;
  /** Painted behind the page. Theme-owned, never partner-supplied. */
  readonly surface: string;
  /** The ink that goes on `--plazo-accent`. Theme-owned for the same reason. */
  readonly onAccent: string;
  /** What the partner asked for, before any of it has been checked. */
  readonly overrides: Readonly<Record<string, string>>;
}

export const DEFAULT_THEME_ID = "plazo";

/**
 * Every theme this deployment ships.
 *
 * `creditor-disclosure.test.tsx` iterates this record, so a fifth theme cannot be added
 * without a passing presence and contrast assertion — the loop finds it automatically.
 * That is the point of the record being the source rather than a list in the test.
 *
 * Each entry's own accent pair is asserted legible too. An accent that vanishes into
 * its surface is an invisible primary button, and a checkout whose only control cannot
 * be seen is a checkout nobody completes.
 */
export const SHIPPED_THEMES: Readonly<Record<string, ShippedTheme>> = Object.freeze({
  plazo: {
    id: "plazo",
    label: "Plazo",
    surface: WHITE_LABEL.plazo.surface,
    onAccent: WHITE_LABEL.plazo.onAccent,
    overrides: Object.freeze({
      "--plazo-accent": WHITE_LABEL.plazo.accent,
      "--plazo-radius": RADIUS_LENGTHS.edge,
      "--plazo-font-sans": WHITE_LABEL.plazo.fontSans,
    }),
  },
  "partner-light": {
    id: "partner-light",
    label: "Partner (light)",
    surface: WHITE_LABEL.partnerLight.surface,
    onAccent: WHITE_LABEL.partnerLight.onAccent,
    overrides: Object.freeze({
      "--plazo-accent": WHITE_LABEL.partnerLight.accent,
      "--plazo-radius": "6px",
      "--plazo-font-sans": WHITE_LABEL.partnerLight.fontSans,
    }),
  },
  "partner-dark": {
    id: "partner-dark",
    label: "Partner (dark)",
    surface: WHITE_LABEL.partnerDark.surface,
    onAccent: WHITE_LABEL.partnerDark.onAccent,
    overrides: Object.freeze({
      "--plazo-accent": WHITE_LABEL.partnerDark.accent,
      "--plazo-radius": "0",
      "--plazo-font-sans": WHITE_LABEL.partnerDark.fontSans,
    }),
  },
});

/** What every theme falls back to, property by property. */
const DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  "--plazo-accent": COLORS.accent,
  "--plazo-radius": RADIUS_LENGTHS.edge,
  "--plazo-logo-url": "none",
  "--plazo-font-sans": WHITE_LABEL.plazo.fontSans,
});

// ─── Resolution ─────────────────────────────────────────────────────────────

export interface ResolvedTheme {
  readonly id: string;
  readonly label: string;
  readonly surface: string;
  readonly onAccent: string;
  /** Exactly the allowlisted properties, every one of them present. */
  readonly tokens: Readonly<Record<string, string>>;
  /** The partner logo, already checked, or `null` for Plazo's own mark. */
  readonly logoUrl: string | null;
  /** How many supplied values were refused. Non-zero is a misconfiguration. */
  readonly dropped: number;
}

/**
 * Resolve a theme id, and any partner overrides, to a token map.
 *
 * Server-side and total. An unknown id returns the default map rather than throwing,
 * because a bad theme id is a configuration mistake and the correct response to a
 * configuration mistake on a signing page is Plazo's own chrome, not a 500.
 *
 * Anything outside `THEMEABLE` is dropped and counted. Anything inside it that fails
 * its own check — a colour that is not a colour, a length that is not a length, a logo
 * on an origin nobody approved — is dropped and counted too, and the default is used.
 * The count is logged once per render rather than per value, because a partner who
 * misconfigured one property has probably misconfigured several and a log line each
 * teaches an operator to ignore them.
 */
export function resolveTheme(
  themeId?: string | undefined,
  extra?: Readonly<Record<string, string>> | undefined,
): ResolvedTheme {
  const theme = SHIPPED_THEMES[themeId ?? DEFAULT_THEME_ID] ?? SHIPPED_THEMES[DEFAULT_THEME_ID]!;

  const tokens: Record<string, string> = {...DEFAULTS};
  let dropped = 0;

  for (const supplied of [theme.overrides, extra ?? {}]) {
    for (const [property, value] of Object.entries(supplied)) {
      const guard = Object.hasOwn(THEMEABLE, property) ? THEMEABLE[property] : undefined;
      if (!guard || typeof value !== "string" || !guard(value)) {
        dropped++;
        continue;
      }
      tokens[property] = value;
    }
  }

  const logo = tokens["--plazo-logo-url"];
  const logoUrl = logo && logo !== "none" ? logo : null;
  // A custom property consumed by `background-image` has to carry its own function
  // wrapper. The URL was parsed by `new URL` before it got here, which percent-encodes
  // every quote, so there is nothing left in it that could close the string early.
  tokens["--plazo-logo-url"] = logoUrl ? `url("${logoUrl}")` : "none";

  if (dropped > 0) {
    console.warn(`[plazo] theme "${theme.id}": ${dropped} supplied value(s) refused`);
  }

  return {
    id: theme.id,
    label: theme.label,
    surface: theme.surface,
    onAccent: theme.onAccent,
    tokens: Object.freeze(tokens),
    logoUrl,
    dropped,
  };
}

/**
 * The resolved theme as inline custom properties for one wrapper element.
 *
 * Inline rather than a stylesheet because the theme is per-deployment and resolved at
 * request time; a stylesheet would need a rebuild per partner. `--plazo-surface` and
 * `--plazo-on-accent` ride along even though a partner cannot set them, because the
 * page still has to be painted with them.
 */
export function themeStyle(theme: ResolvedTheme): Record<string, string> {
  return {
    ...theme.tokens,
    "--plazo-surface": theme.surface,
    "--plazo-on-accent": theme.onAccent,
    background: theme.surface,
  };
}

/**
 * Whether a shipped theme's own accent pair clears the AA floor.
 *
 * Not a guard on partner input — the accent guard above is — but a guard on Plazo. The
 * test iterates `SHIPPED_THEMES` through this, so a fourth theme whose accent and its
 * own ink are the same colour cannot be merged.
 */
export function accentIsLegible(theme: ShippedTheme): boolean {
  const accent = theme.overrides["--plazo-accent"] ?? DEFAULTS["--plazo-accent"]!;
  return contrastRatio(theme.onAccent, accent) >= WCAG_AA_NORMAL;
}

// ─── Where the id comes from ────────────────────────────────────────────────

/**
 * The theme this deployment is configured for.
 *
 * `PLAZO_THEME` carries no `NEXT_PUBLIC_` prefix deliberately: it is read on the server
 * and never shipped to the browser, so there is no build-time inlining and no way for
 * page script — Plazo's or anybody else's — to observe or change it. An id that names
 * no shipped theme resolves to Plazo's own.
 */
export function configuredThemeId(): string {
  const configured = (process.env["PLAZO_THEME"] ?? "").trim();
  return Object.hasOwn(SHIPPED_THEMES, configured) ? configured : DEFAULT_THEME_ID;
}

/**
 * Verify a theme id that arrived on a session record.
 *
 * The session is created server-side by `services/origination` before the frame ever
 * loads, which is what makes the id trustworthy — but the record travels, and a record
 * that travels is a record somebody will eventually try to edit. So the id is carried
 * as `id.signature`, an HMAC-SHA256 over the id under `PLAZO_THEME_SECRET`, and
 * anything that does not verify returns `undefined` and lands on the default.
 *
 * Returns `undefined` rather than throwing, and returns `undefined` when no secret is
 * configured. Unsigned means unverified means Plazo's own chrome — the same failure
 * direction as `frame-ancestors` permitting nobody.
 */
export function verifySignedThemeId(claim?: string | undefined): string | undefined {
  const secret = process.env["PLAZO_THEME_SECRET"] ?? "";
  if (!secret || !claim) return undefined;

  const cut = claim.lastIndexOf(".");
  if (cut <= 0) return undefined;

  const id = claim.slice(0, cut);
  const offered = Buffer.from(claim.slice(cut + 1), "hex");
  const expected = createHmac("sha256", secret).update(id).digest();
  if (offered.length !== expected.length) return undefined;
  if (!timingSafeEqual(offered, expected)) return undefined;

  return Object.hasOwn(SHIPPED_THEMES, id) ? id : undefined;
}

/** Produce the `id.signature` pair the session record should carry. */
export function signThemeId(id: string): string {
  const secret = process.env["PLAZO_THEME_SECRET"] ?? "";
  return `${id}.${createHmac("sha256", secret).update(id).digest("hex")}`;
}
