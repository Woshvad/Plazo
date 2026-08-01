import type {Metadata} from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Plazo — yield",
  description: "What the book holds, what it is worth, and when you can leave.",
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <head>
        {/*
          Self-hosted in production. Loaded from Google here because the shell is a
          local verification surface, and checkout runs under a strict CSP that will
          not permit a third-party font origin.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
