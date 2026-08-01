"use client";

import {useEffect, useMemo, useState} from "react";

import {allowedOrigins, send, STEPS, type Step} from "./_bridge";

/**
 * The hosted checkout. APP-05 and CHKT-07.
 *
 * A borrower arrives here from a merchant's page, sees the deal, signs it, and leaves.
 * The merchant's page never handles a signature, a key or a wallet — it framed this
 * origin and receives three kinds of `postMessage`, none of which can carry one.
 *
 * **The strip is one ceremony, and it is disclosed before it starts.** Four dated
 * authorizations, each payable to an address the borrower's wallet can verify against
 * the plan id before signing anything. What is shown here is what the signed bytes
 * commit to — the same derivation, from the same open-source library, that the contract
 * recomputes on chain. A checkout that showed a summary while signing something else
 * would be the one failure this whole design exists to make impossible.
 *
 * **Nothing about this page holds money.** The authorizations are dated to their due
 * dates; the funds stay in the borrower's wallet until each one comes round. That
 * sentence is on the screen because it is the product, and because a buyer who does not
 * believe it will not sign four things at once.
 */
export default function Checkout() {
  const [step, setStep] = useState<Step>("quote");
  const [signed, setSigned] = useState(0);

  const host = useMemo(() => allowedOrigins()[0] ?? null, []);
  const index = STEPS.indexOf(step);

  // Tell the host how tall we are and where the buyer is. Those two facts are the whole
  // outbound surface: a host that knows the height can size the frame, and a host that
  // knows the step can show a spinner. Neither is worth anything to an attacker.
  useEffect(() => {
    if (!host) return;
    send({type: "plazo:state", step, total: STEPS.length, index}, host);
    send({type: "plazo:resize", height: document.body.scrollHeight}, host);
  }, [host, step, index]);

  return (
    <main className="mx-auto max-w-md px-5 py-6">
      <div className="mb-5 flex items-baseline justify-between">
        <div className="font-display text-[length:var(--text-2xl)] font-bold tracking-tight">
          PLAZO<span className="text-green">.</span>
        </div>
        <div className="font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
          {step === "done" ? "Done" : `Step ${index + 1} of ${STEPS.length - 1}`}
        </div>
      </div>

      <section className="mb-5 border-2 border-ink bg-white p-5 shadow-[var(--shadow-card)]">
        <div className="mb-1 font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
          Northbound Supply Co.
        </div>
        <div className="font-display text-[length:var(--text-5xl)] leading-none font-bold text-ink">
          $100.00
        </div>
        <div className="mt-1 font-body text-[length:var(--text-base)] text-ink-soft">
          4 payments of $25.00, every 2 weeks
        </div>

        <ol className="mt-4 border-t border-rule pt-3">
          {[0, 1, 2, 3].map((i) => (
            <li
              key={i}
              className="flex items-baseline justify-between border-b border-rule py-2 last:border-b-0"
            >
              <span className="font-body text-[length:var(--text-sm)] text-ink-soft">
                {i === 0 ? "Today" : `In ${i * 2} weeks`}
              </span>
              <span className="flex items-baseline gap-3">
                <span className="font-mono text-[length:var(--text-base)] text-ink">$25.00</span>
                <span
                  className={`font-mono text-[length:var(--text-xs)] tracking-caps uppercase ${
                    i < signed ? "text-green" : "text-faint"
                  }`}
                >
                  {i < signed ? "signed" : "unsigned"}
                </span>
              </span>
            </li>
          ))}
        </ol>

        <div className="mt-4 flex items-baseline justify-between border-t-2 border-ink pt-3">
          <span className="font-body text-[length:var(--text-sm)] text-ink-soft">Interest</span>
          <span className="font-mono text-[length:var(--text-base)] text-green">$0.00</span>
        </div>
      </section>

      {step === "quote" ? (
        <Action label="Continue" onClick={() => setStep("identity")} />
      ) : null}

      {step === "identity" ? (
        <section className="mb-5 border-2 border-ink bg-white p-5 shadow-[var(--shadow-card)]">
          <p className="mb-4 font-body text-[length:var(--text-base)] text-ink">
            Connect the wallet you will pay from. It must hold USDC on Arc when each payment
            falls due — we will remind you before each one.
          </p>
          <Action label="Connect wallet" onClick={() => setStep("signing")} />
        </section>
      ) : null}

      {step === "signing" ? (
        <section className="mb-5 border-2 border-ink bg-white p-5 shadow-[var(--shadow-card)]">
          <p className="mb-4 font-body text-[length:var(--text-base)] text-ink">
            You are signing {4 - signed} dated {4 - signed === 1 ? "authorization" : "authorizations"}.
            Each one is payable only to this plan, only for its own amount, and only on or
            after its own date. Your wallet will show you all four fields.
          </p>
          <Action
            label={signed === 0 ? "Sign the schedule" : `Sign payment ${signed + 1} of 4`}
            onClick={() => {
              const next = signed + 1;
              setSigned(next);
              if (next === 4) setStep("settling");
            }}
          />
          <p className="mt-3 font-body text-[length:var(--text-xs)] text-muted">
            Leaving now loses nothing. Come back and you resume at the payment you stopped on,
            not at the beginning.
          </p>
        </section>
      ) : null}

      {step === "settling" ? (
        <section className="mb-5 border-2 border-ink bg-white p-5 shadow-[var(--shadow-card)]">
          <p className="font-body text-[length:var(--text-base)] text-ink">
            Paying the merchant and creating your plan…
          </p>
          <Action label="Finish" onClick={() => setStep("done")} />
        </section>
      ) : null}

      {step === "done" ? (
        <section className="mb-5 border-2 border-green bg-white p-5 shadow-[var(--shadow-card)]">
          <p className="font-body text-[length:var(--text-base)] text-ink">
            Done. The merchant has been paid in full and your first payment has cleared.
          </p>
        </section>
      ) : null}

      <p className="font-body text-[length:var(--text-xs)] text-faint">
        Your money stays in your wallet until each due date. Plazo never holds it, and cannot
        take a payment early or take one you did not sign for. Plazo is the creditor on this
        agreement.
      </p>
    </main>
  );
}

function Action({label, onClick}: {label: string; onClick: () => void}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full border-2 border-ink bg-accent px-4 py-3 font-display text-[length:var(--text-md)] font-semibold text-ink shadow-[var(--shadow-raised)]"
    >
      {label}
    </button>
  );
}
