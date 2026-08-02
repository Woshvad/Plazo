import type {CSSProperties, ReactElement} from "react";

import type {Metadata} from "next";
import {IBM_Plex_Mono, Instrument_Sans, Space_Grotesk} from "next/font/google";

import {configuredThemeId, resolveTheme, themeStyle} from "./_theme";
import "./globals.css";

/**
 * Checkout self-hosts its fonts, and that is a security requirement rather than a
 * performance one.
 *
 * Every other surface links the same three families from Google. This one cannot: its
 * CSP is `font-src 'self'` with no third-party style origin, so a Google Fonts link is
 * blocked — which is exactly what should happen on the one origin whose job is to keep a
 * borrower's signing surface away from everything else. The first run of this page
 * proved it: the stylesheet was silently dropped and the type fell back to a system
 * stack.
 *
 * `next/font/google` downloads the files at build time and serves them from this origin,
 * so the policy stays tight and the type still matches the comp. The trade is that a
 * build needs network access once; the alternative was widening the policy on the page
 * that least deserves it.
 */
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display-loaded",
  display: "swap",
});

const body = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body-loaded",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono-loaded",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Plazo — checkout",
  description: "Sign once. The money moves on schedule.",
  /**
   * A checkout session is not a page anyone should arrive at from a search result, and
   * an indexed one is a phishing template wearing Plazo's own domain.
   */
  robots: {index: false, follow: false},
};

/**
 * The theme is resolved here and nowhere else. APP-07.
 *
 * Server-side, from the deployment's own configuration, into inline custom properties
 * on one wrapper element. Everything a PSP can repaint is inside that wrapper and is
 * exactly the four properties `_theme.ts` allows; everything that decides whether the
 * buyer can read who they are borrowing from is outside it, or insulated from it.
 *
 * The partner mark is rendered here rather than in the page because it is chrome and
 * because the decision is conditional: a deployment with no configured logo shows
 * Plazo's own wordmark, and a conditional belongs in TypeScript where it can be read,
 * not in CSS where it would have to be faked.
 */
export default function RootLayout({children}: {children: React.ReactNode}): ReactElement {
  const theme = resolveTheme(configuredThemeId());

  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <div data-plazo-theme={theme.id} style={themeStyle(theme) as CSSProperties}>
          {theme.logoUrl ? (
            <div className="mx-auto flex max-w-md items-center px-5 pt-5">
              <span
                aria-label={theme.label}
                role="img"
                className="block h-6 w-32 bg-contain bg-left bg-no-repeat"
                style={{backgroundImage: "var(--plazo-logo-url)"}}
              />
            </div>
          ) : null}
          {children}
        </div>
      </body>
    </html>
  );
}
