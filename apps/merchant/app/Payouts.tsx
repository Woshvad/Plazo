import {ARC_CCTP_DOMAIN, ARC_TESTNET_EXPLORER} from "@plazo/plan-core";

import {
  dataUrl,
  shortId,
  stamp,
  usd,
  type Attestation,
  type Attestations,
  type Settlement,
  type Settlements,
} from "./_data";

/**
 * Where the money went, and — off Arc — how the merchant finishes the job themselves.
 *
 * **D-12 is the whole reason this screen exists.** Plazo holds no gas token on any chain
 * but Arc, so the last mile of a cross-chain payout is the merchant's:
 * `MessageTransmitterV2.receiveMessage(message, attestation)` on the destination chain.
 * A payouts screen that showed "dispatched" and stopped would be a dead end — the money
 * is burned on Arc, the mint has not happened, and nothing on the page tells the merchant
 * that they are the one who has to do it. So the message bytes and the attestation are
 * here, downloadable, next to the sentence explaining why.
 *
 * `destinationCaller` is the zero address on every burn Plazo dispatches, which means the
 * mint is **permissionless**: anyone holding these two values can complete it. A merchant
 * without a funded wallet on the destination chain can hand them to somebody who has one,
 * and the funds still land at the recipient the burn named. That is worth saying out loud
 * rather than leaving as a property of CCTP nobody reads.
 *
 * **Every identifier on this screen is a transaction hash.** A CCTP v2 burn emits a
 * **zero** nonce; the real `eventNonce` only comes back from Iris at attestation (finding
 * 28 / DEC-31). A UI that showed the on-chain nonce would print the same zero on every
 * row, and a merchant would reasonably conclude the burns had collided.
 *
 * The origination hash and the burn hash are both shown and are never the same column
 * (DEC-51): the origination is the merchant's key back to their own order, the burn is
 * Circle's key to the attestation.
 */

/** How this screen groups a payout, from the two sources together. */
type Stage = "settled" | "queued" | "dispatched" | "attested";

const STAGE_NOTE: Record<Stage, string> = {
  settled:
    "Paid on Arc. Domain 26 has no CCTP route to itself, so a local settlement is a plain transfer and never a burn — there is nothing to attest and nothing for you to do.",
  queued:
    "Burned nothing yet. The settlement is on the router's queue; `dispatch()` carries no role, so you or anyone else may crank it rather than waiting for Plazo.",
  dispatched:
    "Burned on Arc, not yet attested by Circle. Nothing is lost — the message exists on chain and Iris will attest it; the poll count below is how long it has been asked.",
  attested:
    "Ready to mint. Take the two values below to the destination chain and call receiveMessage. Nobody else is going to.",
};

function stageOf(row: Settlement, attestation: Attestation | undefined): Stage {
  if (row.payoutStatus === "queued") return "queued";
  if (row.payoutStatus !== "dispatched") return "settled";
  return attestation?.message != null && attestation.attestation != null ? "attested" : "dispatched";
}

export function Payouts({
  settlements,
  attestations,
}: {
  settlements: Settlements;
  attestations: Attestations;
}) {
  const byPlan = new Map(attestations.attestations.map((row) => [row.planId, row]));
  const grouped: Record<Stage, {row: Settlement; attestation: Attestation | undefined}[]> = {
    settled: [],
    queued: [],
    dispatched: [],
    attested: [],
  };

  for (const row of settlements.settlements) {
    const attestation = byPlan.get(row.planId);
    grouped[stageOf(row, attestation)].push({row, attestation});
  }

  return (
    <section className="mb-5 border-2 border-ink bg-white p-5 shadow-[var(--shadow-card)]">
      <h2 className="mb-3 font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
        Payouts
      </h2>

      {(["attested", "dispatched", "queued", "settled"] as const).map((stage) => {
        const rows = grouped[stage];
        if (rows.length === 0) return null;

        return (
          <div key={stage} data-stage={stage} className="mb-5 last:mb-0">
            <div className="flex items-baseline gap-3 border-b-2 border-ink pb-1">
              <span className="font-display text-[length:var(--text-lg)] font-bold text-ink">
                {stage}
              </span>
              <span className="font-mono text-[length:var(--text-2xs)] text-muted">
                {rows.length} payout{rows.length === 1 ? "" : "s"}
              </span>
            </div>
            <p className="mt-1.5 mb-3 max-w-3xl font-body text-[length:var(--text-xs)] text-muted">
              {STAGE_NOTE[stage]}
            </p>

            {rows.map(({row, attestation}) => (
              <div key={row.planId} data-plan={row.planId} className="border-b border-rule py-3 last:border-b-0">
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-[length:var(--text-sm)] font-semibold text-ink">
                    {row.externalId ?? shortId(row.planId)}
                  </span>
                  <span className="font-mono text-[length:var(--text-sm)] text-ink">{usd(row.net)}</span>
                </div>

                <dl className="mt-1 grid grid-cols-[9rem_1fr] gap-x-3 font-mono text-[length:var(--text-2xs)]">
                  <Term label="Destination" />
                  <dd className="text-ink-soft">
                    domain {row.payoutDomain ?? "—"}
                    {row.payoutDomain === ARC_CCTP_DOMAIN ? " (Arc — local, no burn)" : ""}
                  </dd>

                  <Term label="Origination tx" />
                  <dd className="break-all text-ink-soft">
                    {row.txHash === null ? "—" : <Explorer hash={row.txHash} />}
                  </dd>

                  <Term label="Burn tx" />
                  <dd className="break-all text-ink-soft">
                    {row.dispatchTxHash === null ? (
                      <span className="text-faint">not dispatched</span>
                    ) : (
                      <Explorer hash={row.dispatchTxHash} />
                    )}
                  </dd>

                  {attestation === undefined ? null : (
                    <>
                      <Term label="Iris polls" />
                      <dd className="text-ink-soft">
                        {attestation.attempts}
                        {attestation.polledAt === null ? "" : ` · last ${stamp(attestation.polledAt)}`}
                      </dd>
                    </>
                  )}
                </dl>

                {stage === "attested" && attestation ? <Mint attestation={attestation} /> : null}
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}

function Term({label}: {label: string}) {
  return <dt className="tracking-caps text-muted uppercase">{label}</dt>;
}

/**
 * The burn, on Arc's explorer.
 *
 * The hash is the identifier, deliberately and not incidentally — see the module note on
 * DEC-31. Iris is asked by transaction hash for the same reason.
 */
function Explorer({hash}: {hash: string}) {
  return (
    <a
      href={`${ARC_TESTNET_EXPLORER}/tx/${hash}`}
      className="underline decoration-rule-strong underline-offset-2"
      rel="noreferrer"
      target="_blank"
    >
      {hash}
    </a>
  );
}

/**
 * The two values that finish the payout, and the instruction for using them.
 *
 * Both are rendered in full in a selectable field **and** offered as a download, because
 * a CCTP message is several hundred bytes of hex and nobody retypes one correctly. The
 * download is a `data:` URL on an `<a download>`: no script, no clipboard permission, and
 * nothing leaves the page to produce it.
 *
 * The destination `MessageTransmitterV2` address is deliberately **not** guessed. Arc's is
 * quoted from `@plazo/plan-core` as the address the burn came *from*; the address to call
 * on the destination chain is Circle's published one for that domain, and printing a
 * confident wrong address here would send a merchant's `receiveMessage` into a contract
 * that is not one.
 */
function Mint({attestation}: {attestation: Attestation}) {
  const message = attestation.message ?? "";
  const signature = attestation.attestation ?? "";

  return (
    <div className="mt-3 border-2 border-rule-strong bg-paper-raised p-3">
      <p className="mb-2 max-w-3xl font-body text-[length:var(--text-xs)] text-ink-soft">
        Call <span className="font-mono">MessageTransmitterV2.receiveMessage(message, attestation)</span>{" "}
        on the chain for domain {attestation.domain}, using Circle&rsquo;s published
        MessageTransmitterV2 address for that domain. Plazo holds no gas token on any chain
        but Arc, so this last step is yours by design rather than by omission — and because{" "}
        <span className="font-mono">destinationCaller</span> is the zero address, anyone can
        make the call. The USDC lands at the recipient the burn already named either way, so
        handing these two values to somebody with a funded wallet is safe.
      </p>

      <Field label="message" value={message} filename={`plazo-${attestation.txHash}-message.txt`} />
      <Field
        label="attestation"
        value={signature}
        filename={`plazo-${attestation.txHash}-attestation.txt`}
      />
    </div>
  );
}

function Field({label, value, filename}: {label: string; value: string; filename: string}) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase">
          {label} · {(value.length - 2) / 2} bytes
        </span>
        <a
          href={dataUrl(value)}
          download={filename}
          className="font-mono text-[length:var(--text-2xs)] text-ink underline decoration-rule-strong underline-offset-2"
        >
          download
        </a>
      </div>
      <textarea
        readOnly
        rows={3}
        value={value}
        aria-label={label}
        className="w-full border-2 border-ink bg-white p-2 font-mono text-[length:var(--text-2xs)] break-all text-ink"
      />
    </div>
  );
}
