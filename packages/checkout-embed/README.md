# @plazo/checkout-embed

The Plazo drop-in. One script tag and one call gives a merchant a hosted checkout
(`APP-06`); one more call renders the pre-cart line and, when the buyer has a wallet
connected, the limit the credit router would actually enforce (`CHKT-06`).

Apache-2.0. This is the one Plazo package whose licence is a design decision rather
than a default: it runs in the buyer's browser, where it is readable regardless, so a
proprietary licence would buy nothing and cost the posture the rest of the protocol is
built on. A merchant can read what they paste into their checkout page.

---

## Checkout

```html
<script src="https://js.plazo.example/v1/plazo.js"
        integrity="sha384-REPLACE_WITH_THE_PUBLISHED_HASH_FOR_THIS_EXACT_URL"
        crossorigin="anonymous"></script>

<script>
  document.querySelector("#pay-with-plazo").addEventListener("click", async () => {
    // Your server creates the session. The browser never sees your API key.
    const {sessionId} = await fetch("/checkout/plazo-session", {method: "POST"})
      .then((r) => r.json());

    Plazo.checkout({
      sessionId,
      origin: "https://checkout.plazo.example",
      onComplete: (planId) => { window.location = `/order/complete?plan=${planId}`; },
      onCancel: (reason) => { console.warn("plazo cancelled:", reason); },
    });
  });
</script>
```

That is the whole integration. The option bag is `sessionId`, `origin`, `onComplete`,
`onCancel`, and optionally `onState` and `container`. There is no option to configure
the message channel and no option to relax an origin check, because the only use for
either would be to weaken the thing it configures.

`checkout` returns a handle with `close()`. Calling `checkout` twice without closing
replaces the frame rather than stacking a second one.

### `onComplete` is a reference, not a receipt

`planId` is a public identifier you can look up on chain. It arrives over `postMessage`
from a frame, which means it is a cue to go and look — not proof. **Fulfil on the
signed webhook**, which reaches your server, or on your own read of the chain. A
merchant who ships goods on the strength of a `postMessage` alone has trusted whatever
ended up in the frame.

### What crosses the frame boundary

Four messages out (`plazo:resize`, `plazo:state`, `plazo:complete`, `plazo:cancelled`)
and two in (`plazo:open`, `plazo:close`). None of the outbound four has a field that
could hold a signature, a private key, a wallet handle, an authorization payload or a
session token — not because the code is careful but because the union type has no
variant that could. Adding one would be a diff in two files.

**The session id crosses only in `plazo:open`.** It is never a query parameter, a
fragment, a `name` attribute or a data attribute, so it is not in your server logs, not
in your analytics, and not in the `Referer` of anything the checkout page loads. There
is a test asserting it appears nowhere in the frame's `outerHTML`.

**Every inbound message is checked against both `event.origin` and `event.source`.**
Origin says which site spoke; source says which window. Your page may hold other frames
— an ad slot, a chat widget, something injected — and origin alone would let any of
them forge a completion.

### Your origin must be on the checkout allowlist

The checkout page sets `frame-ancestors` from a configured allowlist and an
unconfigured deployment permits **nobody**, not everybody. If your storefront origin is
not on it the frame will render blank. That is the correct failure direction; tell your
Plazo contact the exact origin, scheme and port included.

---

## Pre-cart messaging

```html
<div id="plazo-message"></div>
<script>
  Plazo.messaging({
    element: document.querySelector("#plazo-message"),
    cartTotal: 12000n,          // 6-decimal USDC — $120.00
    installmentCount: 4,
    merchant: "0xYourMerchantAddress",
    router: "0xCheckoutRouter",
    pool:   "0xTranchedCreditPool",
    wallet: connectedWallet,    // optional; omit and the limit half is skipped
  });
</script>
```

Without a wallet this renders the arithmetic every incumbent renders. With one it reads
`CheckoutRouter.maxPrincipalFor` **in the buyer's browser, against the public RPC**, and
shows the buyer their own headroom.

Two rules the implementation enforces and you should know about:

1. **Never pass a wallet address your server collected**, and never send the returned
   limit back to your server. One buyer reading their own limit is fine; harvesting
   limits is the harm this design exists to prevent.
2. **There is no batch form.** No function in this module accepts an array of
   addresses, and adding one would be adding the enumeration primitive back.

A zero limit renders "Pay in 4 available at checkout", never "$0 available". Zero is
what the router returns when the corridor is paused or the book is thin, and rendering
it as a figure would turn your product page into a public gauge of Plazo's
capitalisation. An RPC failure renders the wallet-free copy and never an error — a
product page must not break because a public endpoint shed a request.

---

## Building the bundle

```sh
pnpm --filter @plazo/checkout-embed build
```

That runs `tsc` and then `scripts/bundle.mjs`, and writes three artefacts into `dist/`:

| Artefact | What it is |
| --- | --- |
| `dist/plazo.js` | The bundle. A classic script (IIFE), minified, every dependency resolved. This is the file the URLs below serve. |
| `dist/plazo.js.map` | An external source map. **Not referenced from the bundle** — attaching it is a deliberate act, not a second fetch on every page load. |
| `dist/manifest.json` | The SRI hash, the byte counts, and the headers each URL must carry. |

`dist/` is gitignored and stays that way. An SRI hash committed to a repository is a hash
that drifts from the bytes it names, and a wrong `integrity=` is worse than none: the
browser silently refuses to execute the script and the merchant experiences it as "Plazo
is broken on my checkout page", with nothing in the console that says why. The hash is a
build output and it travels in the same file as the URL it belongs to.

Verify it yourself — the command is in the manifest, and this package is open source so
that "reproducible" is something you can check rather than something we assert:

```sh
openssl dgst -sha384 -binary dist/plazo.js | openssl base64 -A
```

### It is a classic script on purpose

`type="module"` is deferred by definition, so `window.Plazo` would not exist when your own
inline handler runs — intermittently, depending on network timing, and presenting as
`Plazo is not defined`. An IIFE executes where it is parsed.

### Weight, stated rather than discovered

The bundle is roughly **283 kB raw, 89 kB gzip, 70 kB brotli**, and almost all of it is
`viem`, which is here for exactly one call: the `CheckoutRouter.maxPrincipalFor` read
behind the pre-cart widget. On a checkout page that is a reasonable trade. On a product
page it is heavy, and the honest answer today is to load it on the pages that need it. A
checkout-only build with no chain read is the obvious next move and has not been made.

---

## Serving the script

### `v1/plazo.js` is pinned and immutable; `/plazo.js` tracks latest

| URL | Contents | Use it when |
| --- | --- | --- |
| `https://js.plazo.example/v1/plazo.js` | **Immutable.** The bytes at this URL never change. A new build gets a new URL. | Always, on a production checkout page. |
| `https://js.plazo.example/plazo.js` | Tracks latest. Changes without notice. | A sandbox, a spike, a demo. |

This is not a versioning nicety. A mutable script tag on a checkout page is a standing
permission for someone else to push unreviewed code into your PCI scope — every page
load re-fetches whatever is at that URL, and neither you nor your assessor reviewed it.
Pin the URL and pair it with `integrity=`:

```html
<script src="https://js.plazo.example/v1/plazo.js"
        integrity="sha384-…"
        crossorigin="anonymous"></script>
```

The SRI hash for each pinned URL is `integrity` in `dist/manifest.json`, produced by the
build and reproducible with the `openssl` command above — the package is open source
precisely so that "reproducible" is a thing you can check rather than a thing we assert.
`crossorigin="anonymous"` is **required** for the browser to enforce `integrity` on a
cross-origin script; omit it and the tag looks pinned while being exactly as mutable as it
was before.

### Headers on the serving origin

These are not a description of an intention. They are `SERVING` in
[`src/serving.ts`](src/serving.ts), the build copies them verbatim into
`dist/manifest.json`, and `test/bundle.test.ts` asserts that this README still agrees with
them. **A deploy should read the manifest rather than this list.**

- `Cross-Origin-Resource-Policy: cross-origin` — the bundle is meant to be loaded by
  merchant pages, so it declares that explicitly rather than relying on the default.
- `Content-Security-Policy: default-src 'none'; sandbox` — a static asset origin needs
  no capabilities at all, and saying so limits what a compromise of it can reach.
- `Cache-Control: public, max-age=31536000, immutable` on `/v1/plazo.js` only. The
  immutable URL is what makes a year-long cache safe; `/plazo.js` gets
  `public, max-age=300`.
- `X-Content-Type-Options: nosniff`.
- `Content-Type: application/javascript; charset=utf-8`.

If your own page runs a CSP — and a checkout page should — you will need
`script-src https://js.plazo.example` and `frame-src https://checkout.plazo.example`.

---

## Development

```sh
pnpm --filter @plazo/checkout-embed build       # tsc, then the browser bundle and its SRI
pnpm --filter @plazo/checkout-embed bundle      # the bundle alone, against existing tsc output
pnpm --filter @plazo/checkout-embed test        # vitest under jsdom
pnpm --filter @plazo/checkout-embed typecheck
pnpm boundary                                   # asserts this tree imports nothing closed
```

`test/bundle.test.ts` builds the bundle if it is missing rather than skipping, evaluates
the shipped bytes in jsdom, and asserts the published hash recomputes from them. A skipped
bundle test reads exactly like a passing one.

The embed carries its own copy of the `postMessage` union rather than importing it from
the checkout app, because the licence boundary forbids an open package from depending on
a proprietary one. `test/bridge-parity.test.ts` reads the app's copy as text and fails
if the two have drifted, so the duplication is checked rather than trusted.
