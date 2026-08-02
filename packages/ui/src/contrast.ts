/**
 * WCAG relative luminance and contrast ratio, over the palette in `tokens.ts`.
 *
 * This lives in the design system rather than in a surface for the same reason the
 * palette does: legibility is a property of a colour pair, and a surface that computed
 * it locally would compute it slightly differently by the third surface. One
 * implementation, consumed everywhere, is the whole premise of this package.
 *
 * ## Why a surface needs this at all
 *
 * Checkout is white-labelled (APP-07). A partner supplies an accent, and the creditor
 * disclosure has to stay readable no matter what they supply. "Readable" has to be a
 * number a test can assert on, or it is a code-review opinion that survives exactly
 * until the fourth partner asks for a tweak.
 *
 * ## An unreadable colour is one we cannot parse
 *
 * `parse` returns `null` for anything it does not understand and `contrastRatio` then
 * returns `0`, which fails every floor. That is the safe direction: a value nobody can
 * evaluate is treated as illegible rather than waved through. The alternative — throwing
 * — would turn a malformed partner colour into a 500 on a page a buyer is trying to
 * sign on.
 *
 * Both hex and `rgb()` forms are accepted because both arrive: hex from the token
 * tables, `rgb()` from `getComputedStyle`, which normalises everything it returns.
 *
 * Formula: WCAG 2.2, §Relative luminance and §Contrast ratio.
 */

/** The AA floor for body text. A standard, not a token — nothing may move it. */
export const WCAG_AA_NORMAL = 4.5;

/** The AA floor for large text, kept here so nobody re-derives it from memory. */
export const WCAG_AA_LARGE = 3;

type Channels = readonly [number, number, number];

const HEX_FORM = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_FORM = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i;

/**
 * A colour as three 0–255 channels, or `null`.
 *
 * Alpha is parsed and then ignored. Compositing a translucent foreground against an
 * unknown backdrop is a different calculation with a different answer, and pretending
 * otherwise would report a ratio that is not the one the eye gets. A surface that needs
 * a translucent disclosure has a bug, not a contrast question.
 */
export function parse(colour: string): Channels | null {
  const value = colour.trim();

  if (HEX_FORM.test(value)) {
    const body = value.slice(1);
    const wide = body.length >= 6;
    const at = (i: number): number => {
      const pair = wide ? body.slice(i * 2, i * 2 + 2) : body[i]!.repeat(2);
      return Number.parseInt(pair, 16);
    };
    return [at(0), at(1), at(2)];
  }

  const rgb = RGB_FORM.exec(value);
  if (rgb) {
    const channel = (raw: string | undefined): number => {
      const n = Number.parseFloat(raw ?? "");
      return Number.isFinite(n) ? Math.min(255, Math.max(0, n)) : Number.NaN;
    };
    const parsed: Channels = [channel(rgb[1]), channel(rgb[2]), channel(rgb[3])];
    return parsed.some((c) => Number.isNaN(c)) ? null : parsed;
  }

  return null;
}

/** WCAG relative luminance, 0 (black) to 1 (white). `NaN` for an unparseable colour. */
export function relativeLuminance(colour: string): number {
  const channels = parse(colour);
  if (!channels) return Number.NaN;

  const linear = channels.map((raw) => {
    const c = raw / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as unknown as Channels;

  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * The WCAG contrast ratio between two colours, 1 to 21.
 *
 * Returns `0` — below every floor there is — when either colour cannot be parsed.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (Number.isNaN(la) || Number.isNaN(lb)) return 0;

  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
