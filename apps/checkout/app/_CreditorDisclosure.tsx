import type {CSSProperties, ReactElement} from "react";

import {BORDER_LENGTHS, COLORS, FONT_STACKS, RADIUS_LENGTHS, TYPE_SIZES} from "@plazo/ui";
import {contrastRatio, WCAG_AA_NORMAL} from "@plazo/ui/contrast";

/**
 * Who the creditor is. APP-07, and the half of it that is not negotiable.
 *
 * A PSP may repaint this page (`_theme.ts`). They may not make this element go away.
 * REQUIREMENTS.md's Out of Scope is explicit — "Fully invisible white-label — the buyer
 * is signing a credit agreement; concealing the creditor is a disclosure violation in
 * every consumer regime" — and a requirement that lives only in a document is a
 * requirement that will be tested for the first time when the fourth partner asks for
 * a tweak.
 *
 * ## The slot is code. The string is configuration. (D-22)
 *
 * Nothing here invents a compliance requirement about wording, type size or proximity.
 * That is counsel's call, and it arrives through
 * `NEXT_PUBLIC_PLAZO_CREDITOR_DISCLOSURE` without a code change. What is built here is
 * the property counsel cannot supply by writing a sentence: that the sentence renders,
 * on every step, legibly, whatever the partner's theme says.
 *
 * A blank or whitespace-only value falls back to the compiled default rather than
 * rendering nothing. "Set the environment variable to an empty string" is otherwise the
 * concealment path, and it is the easiest one to reach by accident.
 *
 * ## Why it takes no props at all
 *
 * Not one. No suppression flag, no variant, no style passthrough, and in particular no
 * way to hand it a class — a component that accepts a class accepts `hidden`, and it
 * accepts it from whoever renders it, which is a decision made two files away from
 * anyone auditing this one.
 *
 * ## Why every value is inline
 *
 * The theme reaches this subtree as inherited custom properties. This element reads
 * none of them: its colours, its family, its size and the five properties that hide an
 * element are literals resolved at render, so there is no `var()` for a theme to
 * substitute into. An inline declaration also outranks any stylesheet rule of equal
 * specificity, which matters because the failure being defended against is not a
 * partner writing CSS — they cannot — but a future contributor adding a rule here that
 * a theme then reaches.
 *
 * ## The contrast floor lives here, not in a token
 *
 * A floor expressed as a token is a floor a theme can move. It is a constant in this
 * module, checked against this element's own resolved pair at render, and if the pair
 * fails the element falls back to the system default and renders anyway. It never
 * renders nothing: an unreadable disclosure is a bug, a missing one is a violation.
 */

/** WCAG AA for body text. Fixed here so nothing outside this file can lower it. */
const FLOOR = WCAG_AA_NORMAL;

/** What the element paints itself. Fixed palette values, no themeable property. */
const BACKGROUND = COLORS.white;

/** Foregrounds in preference order. The first that clears the floor is used. */
const FOREGROUNDS = [COLORS.ink, COLORS.inkSoft] as const;

/** Where an element that cannot find a legible pair lands. Ink on white, always. */
const FALLBACK = {foreground: COLORS.ink, background: COLORS.white} as const;

/**
 * Counsel supplies the real wording. This is the plain fact, and it is here so that a
 * deployment which forgot to configure the string still discloses the creditor.
 */
const DEFAULT_TEXT = "Plazo is the creditor on this agreement.";

function legiblePair(): {foreground: string; background: string} {
  const found = FOREGROUNDS.find((foreground) => contrastRatio(foreground, BACKGROUND) >= FLOOR);
  return found ? {foreground: found, background: BACKGROUND} : FALLBACK;
}

export function CreditorDisclosure(): ReactElement {
  const {foreground, background} = legiblePair();
  const configured = (process.env["NEXT_PUBLIC_PLAZO_CREDITOR_DISCLOSURE"] ?? "").trim();

  const style: CSSProperties = {
    // The five that conceal without deleting, pinned. None is themeable; each is set
    // anyway, because "not reachable today" and "not reachable" are different claims.
    display: "block",
    visibility: "visible",
    opacity: 1,
    position: "static",
    transform: "none",

    color: foreground,
    backgroundColor: background,
    fontFamily: FONT_STACKS.body,
    fontSize: TYPE_SIZES.xs,
    lineHeight: 1.5,
    padding: "0.75rem 1rem",
    marginTop: "1.25rem",
    border: `${BORDER_LENGTHS.rule} solid ${COLORS.ink}`,
    borderRadius: RADIUS_LENGTHS.edge,
  };

  return (
    <section data-plazo-creditor="" style={style}>
      {configured.length > 0 ? configured : DEFAULT_TEXT}
    </section>
  );
}
