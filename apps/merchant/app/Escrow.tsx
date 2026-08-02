"use client";

import {useState} from "react";

import {day, shortId, until, usd, type EscrowRow, type Escrows} from "./_data";

/**
 * MERCH-04's screen: which settlements are held, until when, and who can move them.
 *
 * **Both exits are permissionless and the screen says so** (D-07, GOV-08). `release()`
 * after the post-shipment timer and `refundToPool()` after the attestation deadline carry
 * no role at all — a merchant waiting for Plazo to release their own settlement is
 * waiting for nothing, and a merchant who never attests will see the money go back to the
 * pool on a deadline they could read in advance. An escrow only an operator can release
 * is an operator on the settlement path, which is the thing this whole design refuses.
 *
 * **The tracking number never leaves this page.** `attestShipment` takes a `bytes32`
 * commitment, and that is not an implementation detail — a tracking number resolves, for
 * anybody who asks the carrier, to where a named borrower lives, which makes a cleartext
 * one in a public log a borrower's home address that no erasure request can reach (D-07).
 * So the commitment is computed **in the browser** from a salt that is also generated in
 * the browser, and neither the number nor the salt is ever sent to Plazo, put in a URL, or
 * written to a form that posts.
 *
 * The scheme is `sha256("plazo.carrier.v1" ‖ salt ‖ trackingNumber)`, computed with Web
 * Crypto — no dependency, and no hashing library on a page that handles a secret. It is
 * SHA-256 rather than keccak because `SubtleCrypto` has no keccak, nothing on chain
 * verifies the derivation (the contract stores whatever `bytes32` it is handed), and
 * adding a hashing package to a browser bundle to match a function no verifier calls
 * would be a dependency bought for a resemblance.
 *
 * **This is a commitment, not a concealment, and the screen says that too.** Tracking
 * numbers are low-entropy; anyone who holds the salt can confirm a guess. The salt is
 * what makes that impossible for everyone who does not, which is why the merchant is told
 * to keep it and told that losing it means the commitment can never be opened again.
 */
export function Escrow({data}: {data: Escrows}) {
  return (
    <section className="mb-5 border-2 border-ink bg-white p-5 shadow-[var(--shadow-card)]">
      <h2 className="mb-3 font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
        Held settlements
      </h2>

      <p className="mb-4 max-w-3xl font-body text-[length:var(--text-xs)] text-muted">
        Physical goods settle into escrow rather than instantly. Attest that the goods
        shipped and the release timer starts; leave it past the attestation deadline and the
        settlement returns to the pool. Both moves are permissionless — <span className="font-mono">release()</span>{" "}
        and <span className="font-mono">refundToPool()</span> carry no role, so you never
        need Plazo to act for you, and neither does anybody else.
      </p>

      {data.escrows.map((row) => (
        <Row key={row.planId} row={row} now={data.now} />
      ))}
    </section>
  );
}

function Row({row, now}: {row: EscrowRow; now: number}) {
  const exit = exitFor(row, now);

  return (
    <div data-plan={row.planId} data-state={row.state} className="border-b border-rule py-3 last:border-b-0">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[length:var(--text-sm)] font-semibold text-ink">
          {row.externalId ?? shortId(row.planId)}
        </span>
        <span className="font-mono text-[length:var(--text-sm)] text-ink">{usd(row.amount)}</span>
      </div>

      <dl className="mt-1 grid grid-cols-[13rem_1fr] gap-x-3 font-mono text-[length:var(--text-2xs)]">
        <dt className="tracking-caps text-muted uppercase">State</dt>
        <dd className={row.state === "returned" ? "text-danger" : "text-green"}>{row.state}</dd>

        <dt className="tracking-caps text-muted uppercase">Attestation deadline</dt>
        <dd className="text-ink-soft">
          {day(row.returnableAt)}
          {row.state === "held"
            ? ` · ${row.returnableAt > now ? `${until(row.returnableAt - now)} left` : `${until(now - row.returnableAt)} ago`}`
            : ""}
        </dd>

        <dt className="tracking-caps text-muted uppercase">Release timer</dt>
        <dd className="text-ink-soft">
          {row.releasableAt === 0 ? (
            <span className="text-faint">not started — nothing attested</span>
          ) : (
            `${day(row.releasableAt)} · ${
              row.releasableAt > now ? `${until(row.releasableAt - now)} left` : "elapsed"
            }`
          )}
        </dd>

        <dt className="tracking-caps text-muted uppercase">Available now</dt>
        <dd data-exit={exit.action} className="text-ink">
          {exit.label}
        </dd>

        {row.carrierRef === null ? null : (
          <>
            <dt className="tracking-caps text-muted uppercase">Commitment</dt>
            <dd className="break-all text-ink-soft">{row.carrierRef}</dd>
          </>
        )}

        {row.disputeEligible ? (
          <>
            <dt className="tracking-caps text-muted uppercase">Dispute</dt>
            <dd className="text-danger">
              open to anyone — this settlement went back for non-attestation
            </dd>
          </>
        ) : null}
      </dl>

      {row.state === "held" ? <Attest planId={row.planId} /> : null}
    </div>
  );
}

/** Which exit is open, and to whom. Both are open to anyone; only the timers gate them. */
function exitFor(row: EscrowRow, now: number): {action: string; label: string} {
  if (row.state === "released") return {action: "none", label: "released — paid out to your route"};
  if (row.state === "returned") {
    return {action: "none", label: "returned to the pool — the deadline passed unattested"};
  }
  if (row.state === "attested") {
    return row.releasableAt <= now
      ? {action: "release", label: "release() — callable by anyone, including you"}
      : {action: "wait", label: `release() opens in ${until(row.releasableAt - now)}, to anyone`};
  }
  return row.returnableAt <= now
    ? {action: "refundToPool", label: "refundToPool() — callable by anyone; attesting now is too late"}
    : {action: "attest", label: `attest shipment — ${until(row.returnableAt - now)} before it returns`};
}

/**
 * The commitment widget.
 *
 * There is no `<form action>` and no `name` on either input, deliberately: an input with
 * a name inside a form is one stray submit away from a tracking number in a query string,
 * an access log and a `Referer` header. Nothing here submits anything.
 */
function Attest({planId}: {planId: string}) {
  const [tracking, setTracking] = useState("");
  const [salt, setSalt] = useState("");
  const [commitment, setCommitment] = useState("");
  const [error, setError] = useState("");

  const newSalt = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    setSalt(hex(bytes));
    setCommitment("");
  };

  const compute = async () => {
    setError("");
    if (tracking === "" || salt === "") {
      setError("A tracking number and a salt are both required. Generate a salt first.");
      return;
    }
    try {
      const preimage = new TextEncoder().encode(`plazo.carrier.v1${salt}${tracking}`);
      const digest = await crypto.subtle.digest("SHA-256", preimage);
      setCommitment(hex(new Uint8Array(digest)));
    } catch {
      setError(
        "Web Crypto is unavailable. It needs a secure context — https, or localhost — which is also the only context this page should be handling a tracking number in.",
      );
    }
  };

  return (
    <div className="mt-3 border-2 border-rule-strong bg-paper-raised p-3">
      <p className="mb-2 max-w-3xl font-body text-[length:var(--text-xs)] text-ink-soft">
        <strong>The tracking number stays in this browser.</strong> It is never sent to
        Plazo, never put in a URL and never submitted anywhere. What goes on chain is a{" "}
        <span className="font-mono">bytes32</span> commitment computed here, because a
        tracking number is a delivery address by proxy — it resolves, for anybody who asks
        the carrier, to where your customer lives.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase">
            Tracking number
          </span>
          <input
            value={tracking}
            onChange={(event) => setTracking(event.target.value)}
            autoComplete="off"
            className="w-64 border-2 border-ink bg-white px-2 py-1 font-mono text-[length:var(--text-xs)] text-ink"
          />
        </label>

        <button
          type="button"
          onClick={newSalt}
          className="border-2 border-ink bg-paper px-3 py-1.5 font-display text-[length:var(--text-md)] font-semibold text-ink shadow-[var(--shadow-raised)]"
        >
          Generate salt
        </button>

        <button
          type="button"
          onClick={compute}
          className="border-2 border-ink bg-accent px-3 py-1.5 font-display text-[length:var(--text-md)] font-semibold text-ink shadow-[var(--shadow-raised)]"
        >
          Compute commitment
        </button>
      </div>

      {salt === "" ? null : (
        <p className="mt-2 font-mono text-[length:var(--text-2xs)] break-all text-ink-soft">
          <span className="tracking-caps text-muted uppercase">salt</span> {salt}
          <span className="block font-body text-muted">
            Keep this. Without it nobody — including you — can ever show which shipment the
            commitment was for. Without it nobody else can test a guess either, which is the
            trade: this is a commitment, not a disguise, and tracking numbers are guessable.
          </span>
        </p>
      )}

      {error === "" ? null : (
        <p className="mt-2 max-w-3xl font-body text-[length:var(--text-xs)] text-danger">{error}</p>
      )}

      {commitment === "" ? null : (
        <p className="mt-2 font-mono text-[length:var(--text-2xs)] break-all text-ink">
          <span className="tracking-caps text-muted uppercase">carrierRef</span> 0x{commitment}
          <span className="block font-body text-muted">
            Call <span className="font-mono">SettlementEscrow.attestShipment({shortId(planId)}, 0x…)</span>{" "}
            with it. Only you can attest; everything after that is open to anyone.
          </span>
        </p>
      )}
    </div>
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
