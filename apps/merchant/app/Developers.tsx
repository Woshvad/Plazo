import {redirect} from "next/navigation";

import {
  post,
  stamp,
  type ApiKey,
  type Delivery,
  type DeliveryDetail,
  type Deliveries,
  type Endpoints,
  type Keys,
} from "./_data";

/**
 * MERCH-05's surface: keys, destinations, and the log that says whether they worked.
 *
 * Three things on this screen are stated rather than left to be discovered, because each
 * of them is a place a merchant otherwise concludes Plazo is broken.
 *
 * **A key secret is readable exactly once.** Not as a policy but as a mechanism: the API
 * returns it in one response and never again, so there is nothing to look up later. The
 * "once" here is enforced the same way — the secret is handed to a one-shot cell keyed by
 * an opaque token, the render consumes it, and a refresh shows nothing. A dashboard that
 * kept it in a URL, in component state or in a session would be a second place the secret
 * lives, and the whole design of the key store is that there is not one.
 *
 * **A replay carries a fresh `webhook-id`.** The receiver is told to dedupe on
 * `webhook-id`; "replay re-sends the original id" and that instruction are mutually
 * exclusive, and a correctly-implemented receiver would silently drop every replay while
 * the merchant reported that the button does nothing (Pitfall 8). Saying so on the button
 * is what makes the button trustworthy.
 *
 * **Nothing here promises delivery ordering.** Deliveries race, retries reorder, and a
 * ladder with jitter cannot be a sequence. Every payload carries the chain's
 * `blockNumber` and `logIndex`, which is the only ordering that is true anyway, because
 * it is the chain's.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The one-shot cell
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A freshly issued secret, held for exactly one read.
 *
 * **Why not a search parameter.** A redirect carrying the secret would put it in the
 * address bar, browser history, the access log of anything in front of this app and the
 * `Referer` of the next request — which is the same leak the operator API answers with a
 * 400 and an instruction to rotate. So the redirect carries an opaque token and the
 * secret stays on this side of it.
 *
 * **Why a module-level map is honest here and not sloppy.** It is process-local, so a
 * multi-replica deployment behind a round-robin load balancer would drop the read. That
 * failure mode is *lose the secret*, which is recoverable by rotating, and the
 * alternative — persisting it — is the thing that must not exist. The TTL is short for
 * the same reason: an unread cell is a secret sitting in memory for no one.
 */
const CREATED = new Map<string, {key: ApiKey; secret: string; at: number}>();
const CREATED_TTL_MS = 120_000;

export function holdCreatedKey(key: ApiKey, secret: string): string {
  const now = Date.now();
  for (const [token, held] of CREATED) if (now - held.at > CREATED_TTL_MS) CREATED.delete(token);

  const token = `oc_${crypto.randomUUID()}`;
  CREATED.set(token, {key, secret, at: now});
  return token;
}

/** Reads and **deletes**. A second call returns nothing, which is what "once" means. */
export function takeCreatedKey(token: string | undefined): {key: ApiKey; secret: string} | null {
  if (token === undefined) return null;
  const held = CREATED.get(token);
  CREATED.delete(token);
  if (held === undefined || Date.now() - held.at > CREATED_TTL_MS) return null;
  return {key: held.key, secret: held.secret};
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Issue a key. The credential never touches the browser's URL bar.
 *
 * A server action rather than a client fetch, so the merchant's API key stays on the
 * server. A dashboard that called the operator API from the browser would have to ship
 * the key to the browser, and a key in a browser is a key in an extension, a bookmarklet
 * and every script the page ever loads.
 */
export async function createKey(): Promise<void> {
  "use server";
  const issued = await post<{key: ApiKey; secret: string}>("origination", "/v1/keys");
  redirect(`/?created=${holdCreatedKey(issued.key, issued.secret)}#developers`);
}

/** Rotate, with an overlap. Both keys authenticate until the old one's `expiresAt`. */
export async function rotateKey(formData: FormData): Promise<void> {
  "use server";
  const keyId = String(formData.get("keyId") ?? "");
  const overlapDays = Number(formData.get("overlapDays") ?? 7);
  const rotation = await post<{key: ApiKey; secret: string; retired: ApiKey}>(
    "origination",
    `/v1/keys/${keyId}/rotate`,
    {overlapDays},
  );
  redirect(`/?created=${holdCreatedKey(rotation.key, rotation.secret)}#developers`);
}

/** Re-send a delivery. Same body, new `webhook-id`, new timestamp. */
export async function replayDelivery(formData: FormData): Promise<void> {
  "use server";
  const id = String(formData.get("deliveryId") ?? "");
  const result = await post<{deliveryId: string; webhookId: string}>(
    "servicing",
    `/v1/webhooks/deliveries/${id}/replay`,
  );
  redirect(`/?replayed=${encodeURIComponent(result.webhookId)}#developers`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────

export function Developers({
  keys,
  endpoints,
  deliveries,
  created,
  opened,
  replayedWebhookId,
  filter,
}: {
  keys: Keys;
  endpoints: Endpoints;
  deliveries: Deliveries;
  /** Present for exactly one render, immediately after issuing or rotating. */
  created?: {key: ApiKey; secret: string} | null | undefined;
  opened?: DeliveryDetail | null | undefined;
  replayedWebhookId?: string | undefined;
  filter: {event?: string | undefined; status?: string | undefined};
}) {
  const events = [...new Set(deliveries.deliveries.map((row) => row.event))].sort();

  return (
    <section id="developers" className="mb-5 border-2 border-ink bg-white p-5 shadow-[var(--shadow-card)]">
      <h2 className="mb-3 font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
        Developers
      </h2>

      {created ? <CreatedKey created={created} /> : null}

      <SubHead>API keys</SubHead>
      <table className="mb-2 w-full">
        <thead>
          <tr className="border-b-2 border-ink text-left">
            {["Key", "Created", "Lifecycle", "Rotated from", ""].map((heading) => (
              <th
                key={heading}
                className="py-2 font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {keys.keys.map((key) => (
            <KeyRow key={key.keyId} row={key} />
          ))}
        </tbody>
      </table>

      <form action={createKey} className="mb-5">
        <button
          type="submit"
          className="border-2 border-ink bg-accent px-3 py-1.5 font-display text-[length:var(--text-md)] font-semibold text-ink shadow-[var(--shadow-raised)]"
        >
          Issue a key
        </button>
        <span className="ml-3 font-body text-[length:var(--text-2xs)] text-muted">
          The secret is shown once, on the next screen, and cannot be recovered afterwards.
        </span>
      </form>

      <SubHead>Webhook destinations</SubHead>
      <table className="mb-2 w-full">
        <thead>
          <tr className="border-b-2 border-ink text-left">
            {["Endpoint", "URL", "Status", "Signing secrets"].map((heading) => (
              <th
                key={heading}
                className="py-2 font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {endpoints.endpoints.map((endpoint) => (
            <tr key={endpoint.id} data-endpoint={endpoint.id} className="border-b border-rule">
              <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink">{endpoint.id}</td>
              <td className="py-2 font-mono text-[length:var(--text-xs)] break-all text-ink-soft">
                {endpoint.url}
              </td>
              <td
                className={`py-2 font-mono text-[length:var(--text-2xs)] tracking-caps uppercase ${
                  endpoint.status === "active" ? "text-green" : "text-danger"
                }`}
              >
                {endpoint.status}
              </td>
              <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink-soft">
                {endpoint.signingSecretCount} live
                {endpoint.signingSecretCount > 1 ? " — rotating" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Verifying />

      <SubHead>Delivery log</SubHead>
      {replayedWebhookId === undefined ? null : (
        <p
          data-replayed={replayedWebhookId}
          className="mb-3 border-2 border-ink bg-accent-wash px-3 py-2 font-mono text-[length:var(--text-xs)] text-accent-ink"
        >
          Replayed. The new webhook-id is {replayedWebhookId} — your receiver will not dedupe
          it against the original.
        </p>
      )}

      <form method="get" className="mb-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase">
            Event
          </span>
          <select
            name="event"
            defaultValue={filter.event ?? ""}
            className="border-2 border-ink bg-paper px-2 py-1 font-mono text-[length:var(--text-xs)] text-ink"
          >
            <option value="">any</option>
            {events.map((event) => (
              <option key={event} value={event}>
                {event}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase">
            Outcome
          </span>
          <select
            name="deliveryStatus"
            defaultValue={filter.status ?? ""}
            className="border-2 border-ink bg-paper px-2 py-1 font-mono text-[length:var(--text-xs)] text-ink"
          >
            <option value="">any</option>
            <option value="ok">2xx</option>
            <option value="failed">not 2xx</option>
            <option value="never-sent">never sent</option>
          </select>
        </label>
        <button
          type="submit"
          className="border-2 border-ink bg-paper-raised px-3 py-1.5 font-display text-[length:var(--text-md)] font-semibold text-ink shadow-[var(--shadow-raised)]"
        >
          Filter
        </button>
      </form>

      {deliveries.deliveries.map((row) => (
        <DeliveryRow key={row.id} row={row} opened={opened?.id === row.id ? opened : null} />
      ))}

      <p className="mt-4 max-w-3xl font-body text-[length:var(--text-xs)] text-muted">
        <strong>No ordering is promised.</strong> Deliveries race and retries reorder, so the
        order these arrive in is not the order the events happened in. Every payload carries
        the chain&rsquo;s <span className="font-mono">blockNumber</span> and{" "}
        <span className="font-mono">logIndex</span>; order by those and you are ordering by
        the only sequence that is actually true.
      </p>
    </section>
  );
}

function SubHead({children}: {children: React.ReactNode}) {
  return (
    <h3 className="mt-4 mb-2 font-display text-[length:var(--text-lg)] font-bold text-ink first:mt-0">
      {children}
    </h3>
  );
}

/**
 * The one and only render of a secret.
 *
 * There is no copy button and no storage: the value is on the screen, and when the page
 * is left it is gone. The warning is plain rather than decorative because the recovery
 * path a merchant will look for does not exist and cannot be built — a recovery path is a
 * second place the secret lives.
 */
function CreatedKey({created}: {created: {key: ApiKey; secret: string}}) {
  return (
    <div
      data-created-key={created.key.keyId}
      className="mb-5 border-2 border-ink bg-accent-wash p-4 shadow-[var(--shadow-card)]"
    >
      <div className="font-display text-[length:var(--text-lg)] font-bold text-ink">
        Copy this now. It will not be shown again.
      </div>
      <p className="mt-1 mb-2 max-w-3xl font-body text-[length:var(--text-xs)] text-ink-soft">
        Plazo stores a hash of this secret and four characters for display. There is no
        endpoint that returns it and there is not going to be one. If you lose it, rotate the
        key — that is the recovery path, and it is the only one.
      </p>
      <textarea
        readOnly
        rows={2}
        value={created.secret}
        aria-label="new api key"
        className="w-full border-2 border-ink bg-white p-2 font-mono text-[length:var(--text-xs)] break-all text-ink"
      />
      <p className="mt-1 font-mono text-[length:var(--text-2xs)] text-muted">
        {created.key.keyId} · {created.key.environment}
        {created.key.rotatedFrom === null
          ? ""
          : ` · replaces ${created.key.rotatedFrom}, which keeps working until ${
              created.key.expiresAt === null ? "it is revoked" : stamp(created.key.expiresAt)
            }`}
      </p>
    </div>
  );
}

function KeyRow({row}: {row: ApiKey}) {
  const lifecycle =
    row.revokedAt !== null
      ? {label: `revoked ${stamp(row.revokedAt)}`, tone: "text-danger"}
      : row.expiresAt !== null
        ? {label: `retiring — works until ${stamp(row.expiresAt)}`, tone: "text-accent-ink"}
        : {label: "active", tone: "text-green"};

  return (
    <tr data-key-id={row.keyId} className="border-b border-rule">
      <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink">
        plazo_{row.environment}_{row.keyId}_…{row.last4}
      </td>
      <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink-soft">{stamp(row.createdAt)}</td>
      <td className={`py-2 font-mono text-[length:var(--text-2xs)] ${lifecycle.tone}`}>
        {lifecycle.label}
      </td>
      <td className="py-2 font-mono text-[length:var(--text-2xs)] text-ink-soft">
        {row.rotatedFrom ?? "—"}
      </td>
      <td className="py-2">
        {row.revokedAt === null ? (
          <form action={rotateKey} className="flex items-center gap-2">
            <input type="hidden" name="keyId" value={row.keyId} />
            <input
              name="overlapDays"
              defaultValue="7"
              inputMode="numeric"
              aria-label="overlap days"
              className="w-14 border-2 border-ink bg-paper px-1 py-0.5 font-mono text-[length:var(--text-2xs)] text-ink"
            />
            <button
              type="submit"
              className="border-2 border-ink bg-paper-raised px-2 py-1 font-display text-[length:var(--text-xs)] font-semibold text-ink"
            >
              Rotate
            </button>
            <span className="font-body text-[length:var(--text-2xs)] text-faint">
              days both keys work
            </span>
          </form>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * What a merchant verifies against.
 *
 * The signing secret itself is never rendered anywhere on this screen — only how many are
 * live, which is the number that changes during a rotation and the only thing about them
 * a dashboard needs to show (T-06-12-02).
 */
function Verifying() {
  return (
    <div className="mb-5 border-2 border-rule-strong bg-paper-raised p-3">
      <p className="max-w-3xl font-body text-[length:var(--text-xs)] text-ink-soft">
        Every delivery carries three headers: <span className="font-mono">webhook-id</span>,{" "}
        <span className="font-mono">webhook-timestamp</span> and{" "}
        <span className="font-mono">webhook-signature</span>. The signature is{" "}
        <span className="font-mono">v1,&lt;base64 hmac-sha256 over id.timestamp.body&gt;</span>,
        which is the Standard Webhooks scheme — your existing library will verify it without
        knowing anything about Plazo.
      </p>
      <ul className="mt-2 max-w-3xl list-disc pl-5 font-body text-[length:var(--text-xs)] text-muted">
        <li>
          Reject a timestamp more than <span className="font-mono">300</span> seconds from now,
          in <em>both</em> directions. A timestamp forged into the future stays valid for as
          long as the skew you allow.
        </li>
        <li>
          During a rotation you will receive <em>two</em> space-separated signatures in one
          header. Accept the delivery if either verifies — that is what makes a rotation not
          an outage, which is what makes rotations happen.
        </li>
        <li>
          Dedupe on <span className="font-mono">webhook-id</span>. It is unique per attempt
          and stable across retries of the same attempt.
        </li>
        <li>
          The signing secret is never shown here and never will be. It is readable once, when
          the destination is registered or its secret is rotated.
        </li>
      </ul>
    </div>
  );
}

function DeliveryRow({row, opened}: {row: Delivery; opened: DeliveryDetail | null}) {
  const outcome =
    row.responseStatus === null
      ? {label: "never sent", tone: "text-danger"}
      : row.responseStatus < 300
        ? {label: String(row.responseStatus), tone: "text-green"}
        : {label: String(row.responseStatus), tone: "text-danger"};

  return (
    <div
      data-delivery={row.id}
      data-outcome={outcome.label}
      className="border-b border-rule py-2 last:border-b-0"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[length:var(--text-xs)]">
        <span className="text-ink">{row.event}</span>
        <span className={outcome.tone}>{outcome.label}</span>
        <span className="text-ink-soft">attempt {row.attempt}</span>
        <span className="text-ink-soft">{row.latencyMs === null ? "—" : `${row.latencyMs}ms`}</span>
        <span className="text-muted">{stamp(row.sentAt)}</span>
        <span className="text-faint">{row.endpointId}</span>
        {row.replayOf === null ? null : (
          <span className="text-accent-ink">replay of {row.replayOf}</span>
        )}
        <a
          href={opened === null ? `/?delivery=${row.id}#developers` : "/#developers"}
          className="text-ink underline decoration-rule-strong underline-offset-2"
        >
          {opened === null ? "open" : "close"}
        </a>

        <form action={replayDelivery} className="inline">
          <input type="hidden" name="deliveryId" value={row.id} />
          <button
            type="submit"
            data-replay={row.id}
            className="border-2 border-ink bg-paper-raised px-2 py-0.5 font-display text-[length:var(--text-2xs)] font-semibold text-ink"
          >
            Replay
          </button>
        </form>
      </div>

      <div className="mt-1 font-mono text-[length:var(--text-2xs)] text-faint">
        webhook-id {row.webhookId} — a replay re-sends this body byte for byte under a{" "}
        <strong>fresh</strong> webhook-id and a fresh timestamp, so a receiver deduping
        correctly will not drop it.
      </div>

      {opened === null ? null : (
        <div data-bodies={opened.id} className="mt-2 grid grid-cols-2 gap-4">
          <Body label="request" value={opened.requestBody} />
          <Body label="response (truncated at 4 KB)" value={opened.responseBodyTruncated} />
        </div>
      )}
    </div>
  );
}

function Body({label, value}: {label: string; value: string | null}) {
  return (
    <div>
      <div className="font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase">
        {label}
      </div>
      <pre className="max-h-56 overflow-auto border-2 border-rule bg-paper-raised p-2 font-mono text-[length:var(--text-2xs)] whitespace-pre-wrap text-ink-soft">
        {value ?? "—"}
      </pre>
    </div>
  );
}
