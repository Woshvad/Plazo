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

/** Every size the comp uses, in px. A size outside this set is a mistake. */
export const TYPE_SCALE = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24, 26, 34, 64] as const;

/** Two radii, and only two. */
export const RADII = {edge: 2, pill: 999} as const;

export const BORDER_WIDTHS = [1, 2] as const;

/** Hard offsets, no blur. Depth is displacement, the way a print block sits. */
export const SHADOW_OFFSETS = [0, 3, 4, 5, 6, 8] as const;

/** Colours permitted to appear as literals anywhere in the tree. */
export const ALLOWED_LITERAL_HEXES: readonly string[] = Object.freeze(
  Object.values(COLORS).map((c) => c.toUpperCase()),
);

export type ColorToken = keyof typeof COLORS;
