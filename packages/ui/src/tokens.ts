/**
 * The design tokens as data.
 *
 * `theme.css` is what the browser consumes. This is what the enforcement tooling
 * consumes: `tools/check-design-tokens.mjs` uses these values to tell a token
 * reference from a hardcoded literal, so the "no surface holds a local colour,
 * type, or spacing value" rule is a build failure rather than a review comment.
 *
 * Extracted from `Plazo app review screens/Plazo.dc.html`, which is binding.
 */

export const COLORS = {
  paper: "#F6F2EA",
  paperRaised: "#EFEAE0",
  white: "#FFFFFF",
  ink: "#141412",
  inkSoft: "#565248",
  muted: "#6F6A5E",
  faint: "#8A8474",
  rule: "#D9D2C3",
  ruleStrong: "#B9B09C",
  green: "#0E7C4A",
  danger: "#D64528",
  accent: "#FFD23F",
  accentInk: "#946300",
  accentWash: "#FBF0D2",
} as const;

export const FONTS = {
  display: "Space Grotesk",
  mono: "IBM Plex Mono",
  body: "Instrument Sans",
} as const;

/**
 * The families as complete CSS stacks, matching `--font-*` in `theme.css` exactly.
 *
 * `FONTS` above is the family name for tooling to recognise. This is what an element
 * that must set its own `font-family` inline actually assigns. The two are kept
 * adjacent so a stack that drifts from the stylesheet is visible in one diff.
 */
export const FONT_STACKS = {
  display: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace',
  body: '"Instrument Sans", ui-sans-serif, system-ui, sans-serif',
} as const;

/** Every size the comp uses, in px. A size outside this set is a mistake. */
export const TYPE_SCALE = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 26, 34, 64] as const;

/**
 * The type scale as CSS lengths, keyed the way `theme.css` names them.
 *
 * Duplication with the stylesheet is deliberate and narrow: an element whose size must
 * survive any external cascade has to declare it inline, and an inline declaration
 * cannot reference a Tailwind utility. The values are here so it still cannot invent
 * one.
 */
export const TYPE_SIZES = {
  micro: "0.5625rem",
  "2xs": "0.625rem",
  xs: "0.6875rem",
  sm: "0.75rem",
  base: "0.8125rem",
  md: "0.875rem",
  lg: "1rem",
  xl: "1.0625rem",
  "2xl": "1.1875rem",
  "3xl": "1.375rem",
  "4xl": "1.5rem",
  "5xl": "2.125rem",
  hero: "4rem",
} as const;

/** Two radii, and only two. */
export const RADII = {edge: 2, pill: 999} as const;

/** The same two radii as CSS lengths, for anything that sets a radius inline. */
export const RADIUS_LENGTHS = {edge: `${RADII.edge}px`, pill: `${RADII.pill}px`} as const;

export const BORDER_WIDTHS = [1, 2] as const;

/** The border widths as CSS lengths, matching `--border-*` in `theme.css`. */
export const BORDER_LENGTHS = {hairline: "1px", rule: "2px"} as const;

/**
 * The white-label palette. APP-07.
 *
 * A PSP may repaint checkout's chrome. The values they may repaint it *with* are
 * colours, and colours live here — `tools/check-design-tokens.mjs` fails a hex literal
 * anywhere under `apps/`, and a partner's accent is still a colour even when the
 * partner picked it.
 *
 * Each named theme carries the pair it is legible as: the accent, and the ink that goes
 * on top of the accent. They are declared together because they are only meaningful
 * together — an accent with no stated foreground is an accent somebody will eventually
 * put `--color-ink` on and ship an unreadable button.
 *
 * `surface` is **not** in checkout's themeable allowlist. A background is the single
 * most effective way to hide text, so the partner selects a named theme and Plazo owns
 * what that theme is painted on.
 *
 * The two partner entries are examples, not customers: one light, one dark, with
 * materially different accents, so the contrast assertion in checkout's test suite has
 * something real to iterate over.
 */
export const WHITE_LABEL = {
  /** Plazo's own. Unset, unknown and refused all resolve here. */
  plazo: {
    accent: COLORS.accent,
    onAccent: COLORS.ink,
    surface: COLORS.paper,
    fontSans: FONT_STACKS.body,
  },
  /** A light partner: a saturated blue, reversed out to white. */
  partnerLight: {
    accent: "#1B4DE4",
    onAccent: COLORS.white,
    surface: COLORS.white,
    fontSans: FONT_STACKS.display,
  },
  /** A dark partner: a mint accent on near-black, keeping ink on the accent. */
  partnerDark: {
    accent: "#7DF9C4",
    onAccent: COLORS.ink,
    surface: "#12140F",
    fontSans: FONT_STACKS.mono,
  },
} as const;

/** Hard offsets, no blur. Depth is displacement, the way a print block sits. */
export const SHADOW_OFFSETS = [0, 3, 4, 5, 6, 8] as const;

/** Colours permitted to appear as literals anywhere in the tree. */
export const ALLOWED_LITERAL_HEXES: readonly string[] = Object.freeze([
  ...Object.values(COLORS).map((c) => c.toUpperCase()),
  ...Object.values(WHITE_LABEL).flatMap((theme) =>
    Object.values(theme)
      .filter((value) => value.startsWith("#"))
      .map((c) => c.toUpperCase()),
  ),
]);

export type ColorToken = keyof typeof COLORS;
