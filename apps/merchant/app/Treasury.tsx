import {ARC_CCTP_DOMAIN} from "@plazo/plan-core";

import {day, pct, usd, type Treasury as TreasuryPayload} from "./_data";

/**
 * The merchant's own registry row: bond, requirement, headroom, velocity, category.
 *
 * **The bond is shown with the part that arrived by withholding broken out**, because a
 * merchant who has never deposited anything and sees a bond of $118k will otherwise
 * conclude Plazo is holding money they never sent. They did send it: a slice of each of
 * their own settlements was diverted into their own bond while they are unseasoned
 * (DEC-09), and it comes back. Showing the total without the split makes the withholding
 * on the settlements screen look like a fee charged twice.
 *
 * **Headroom is computed and shown as a number, not left as a subtraction.** The bond
 * requirement scales with outstanding fronted exposure rather than being a flat entry
 * cost, so it moves every time the merchant originates. "How much can I withdraw" is the
 * only question anybody opens this section to answer.
 *
 * **When the category is `Escrowed`, the reason is on the screen and so is the way out.**
 * Escrow defaults on for an unseasoned merchant and the opt-out is governance-gated
 * (D-06), which means it is not a setting and there is no toggle to look for. A merchant
 * who wants instant settlement should be able to read what it takes rather than open a
 * support ticket to be told.
 */
export function Treasury({data}: {data: TreasuryPayload}) {
  const bond = BigInt(data.bond);
  const required = BigInt(data.requiredBond);
  const headroom = bond > required ? bond - required : 0n;
  const shortfall = required > bond ? required - bond : 0n;

  const cap = data.velocityCap === null ? null : BigInt(data.velocityCap);
  const used = BigInt(data.velocityUsed);
  const capHeadroom = cap === null ? null : cap > used ? cap - used : 0n;

  return (
    <section className="mb-5 border-2 border-ink bg-white p-5 shadow-[var(--shadow-card)]">
      <h2 className="mb-3 font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
        Treasury
      </h2>

      <Row
        label="Payout route"
        value={data.recipient}
        note={
          data.domain === ARC_CCTP_DOMAIN
            ? "domain 26 — Arc. Local settlement, paid as a plain transfer."
            : `domain ${data.domain} — cross-chain. Burned on Arc; you complete the mint.`
        }
      />

      <Row
        label="Bond posted"
        value={usd(data.bond)}
        note={`${usd(data.bondFromWithholding)} of it arrived by withholding from your own settlements, not by deposit`}
      />

      <Row
        label="Requirement"
        value={usd(data.requiredBond)}
        note={`scales with ${usd(data.outstandingFronted)} of outstanding fronted exposure — it moves every time you originate`}
      />

      <Row
        label={shortfall > 0n ? "Shortfall" : "Free to withdraw"}
        value={usd((shortfall > 0n ? shortfall : headroom).toString())}
        tone={shortfall > 0n ? "text-danger" : "text-green"}
        note={
          shortfall > 0n
            ? "origination is blocked until the bond clears its requirement"
            : "the excess over the requirement, withdrawable now"
        }
      />

      <Row
        label="Vesting withholding"
        value={data.vestingBps === 0 ? "none" : pct(data.vestingBps)}
        note={
          data.vestingBps === 0
            ? "your vesting window has elapsed — nothing is withheld from new settlements"
            : "diverted from each settlement into your own bond while the vesting window runs"
        }
      />

      <Row
        label="Velocity cap"
        value={cap === null ? "uncapped" : usd(data.velocityCap ?? "0")}
        note={
          cap === null
            ? "no cap applies once vesting has elapsed"
            : `${usd(data.velocityUsed)} used · ${usd((capHeadroom ?? 0n).toString())} of headroom in the current window`
        }
      />

      <Row
        label="Settlement category"
        value={data.settlementCategory}
        tone={data.settlementCategory === "Instant" ? "text-green" : "text-accent-ink"}
        note={
          data.settlementCategory === "Instant"
            ? "settles in full, minus MDR, within a block of checkout"
            : "held in escrow until you attest shipment"
        }
      />

      <Row
        label="KYB"
        value={data.kybVerified ? "attested" : "not attested"}
        tone={data.kybVerified ? "text-green" : "text-danger"}
        note={`registered ${day(data.registeredAt)}`}
      />

      {data.settlementCategory === "Escrowed" ? (
        <p className="mt-4 max-w-3xl font-body text-[length:var(--text-xs)] text-muted">
          <strong>Why you are escrowed, and what changes it.</strong> Escrow is the default
          for an unseasoned merchant, and the opt-out is governance-gated — it is not a
          setting on this page, and there is no toggle to find. The category is read once, at
          origination, and stamped on each settlement, so a change never reaches back to a
          plan that has already settled. Ship, attest, and season: the parameters governance
          weighs are the ones on this screen.
        </p>
      ) : null}
    </section>
  );
}

function Row({
  label,
  value,
  note,
  tone = "text-ink",
}: {
  label: string;
  value: string;
  note: string;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-rule py-2 last:border-b-0">
      <span className="font-body text-[length:var(--text-sm)] text-ink-soft">{label}</span>
      <span className="text-right">
        <span className={`font-mono text-[length:var(--text-base)] break-all ${tone}`}>{value}</span>
        <span className="block font-body text-[length:var(--text-xs)] text-faint">{note}</span>
      </span>
    </div>
  );
}
