import {
  ARC_CCTP_DOMAIN,
  CCTP_FINALITY_STANDARD,
  CCTP_MAX_FEE_FROM_ARC,
  GATEWAY_WITHDRAWAL_DELAY_SECONDS,
  usdc6,
} from "@plazo/plan-core";
import type {Usdc6} from "@plazo/plan-core";

import {
  SIGNER_KINDS,
  cctpDepositPlan,
  cctpRedeemPlan,
  signerClassAdvice,
  usdcDisplay,
} from "./_crosschain";
import type {GatewayInfo, RoutePlan, SignerKind, UnifiedBalance} from "./_crosschain";

/**
 * Getting in and getting out. XCH-01.
 *
 * The panel says the thing an LP surface usually leaves to a support ticket: **the two
 * directions are not the same**. In is Gateway or CCTP; out is CCTP. Gateway's
 * `initiateWithdrawal` is a fourteen-day non-attested escape hatch out of a unified
 * balance and is not a redemption route, and presenting it as one would understate the
 * wait by a week against Circle's own documentation, which says seven. The chain says
 * fourteen. The chain wins, and the figure on screen is divided out of the constant
 * rather than typed, so if Circle changes it the screen changes with it.
 *
 * Both deposit routes are shown **side by side, not behind a toggle**, with the
 * signer-class reason next to them. Gateway must statically verify a burn intent's
 * signature off-chain and be certain it is still valid at burn time, so it accepts EOA
 * signatures only — and DEC-01 keeps the tranche shares as transfer-restricted Reg-D
 * securities held by institutions, who overwhelmingly hold through multisigs. An
 * institutional lender discovering that mid-ceremony is a denial of service dressed as
 * a UX problem, so they read it first (D-14).
 *
 * Every value comes from `@plazo/plan-core` or from the payload. Money crosses as a
 * decimal string and is formatted at the leaf.
 */

const SECONDS_PER_DAY = 86_400;

/**
 * Used only to build the step list when no address is connected. It is never rendered:
 * the argument table is suppressed without an account, precisely so a zero
 * `mintRecipient` cannot appear on a screen next to the word "recipient".
 */
const UNSET_ADDRESS = `0x${"0".repeat(40)}` as `0x${string}`;

export interface CrossChainProps {
  info: GatewayInfo;
  /** Which wallet the lender holds through. Drives the route advice. */
  signer: SignerKind;
  /** Gateway's unified balance, when an address has been supplied. */
  balances?: UnifiedBalance;
  /** The lender's Arc address. Absent means the argument tables stay hidden. */
  account?: `0x${string}`;
  /** The CCTP domain the lender is bridging from, and the one they are leaving to. */
  sourceDomain?: number;
  destinationDomain?: number;
  amount?: Usdc6;
}

export function CrossChain({
  info,
  signer,
  balances,
  account,
  sourceDomain = 6,
  destinationDomain = 6,
  amount,
}: CrossChainProps) {
  const advice = signerClassAdvice(signer);
  const withdrawalDays = GATEWAY_WITHDRAWAL_DELAY_SECONDS / SECONDS_PER_DAY;
  const value = amount ?? usdc6(0n);

  const deposit = cctpDepositPlan({
    fromDomain: sourceDomain,
    amount: value,
    arcRecipient: account ?? UNSET_ADDRESS,
  });
  const redeem = cctpRedeemPlan({
    toDomain: destinationDomain === ARC_CCTP_DOMAIN ? 6 : destinationDomain,
    amount: value,
    recipient: account ?? UNSET_ADDRESS,
  });

  const balanceFor = (domain: number) =>
    balances?.balances.find((row) => row.domain === domain);

  return (
    <>
      {info.live ? null : (
        <div className="mb-5 border-2 border-rule-strong bg-paper-raised px-4 py-2 font-mono text-[length:var(--text-xs)] text-muted">
          SAMPLE DATA — set PLAZO_GATEWAY_API_URL to read live Gateway state. Heights below
          are frozen and an intent signed against one would already have expired.
        </div>
      )}

      <Panel title="Deposit from any chain">
        <p className="mb-3 font-body text-[length:var(--text-sm)] text-ink-soft">
          Arc is the destination — CCTP domain {ARC_CCTP_DOMAIN}. Your USDC can come from
          any of the {info.domains.length} chains Circle Gateway supports, by either of two
          routes. Which one is open to you depends on how you sign.
        </p>

        <div className="mb-4 grid grid-cols-2 gap-4">
          <Route
            title="Circle Gateway"
            available={advice.gatewayAvailable}
            summary="One signature. A burn intent authorises Gateway to debit your unified balance on the source chain and mint on Arc."
            lines={[
              "You sign EIP-712 typed data — a BurnIntent wrapping a TransferSpec.",
              "maxBlockHeight is read from Gateway at the moment you sign, never guessed ahead.",
              "Gateway credits Arc before the source burn settles, which is why it will not take a contract signature.",
            ]}
          />
          <Route
            title="CCTP two-step"
            available
            summary="Two transactions, no signer-class restriction. depositForBurn on the source chain, then a normal deposit on Arc."
            lines={deposit.steps.map((step) => `${step.call} — ${step.why}`)}
            args={account ? deposit.steps : undefined}
            argsPlaceholder="Connect an address to see the exact call arguments."
          />
        </div>

        <div className="mb-4 border-2 border-rule bg-paper-raised p-3">
          <div className="font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase">
            Your signer — {advice.label}
          </div>
          <p className="mt-1 font-body text-[length:var(--text-sm)] text-ink">{advice.reason}</p>
          <table className="mt-3 w-full">
            <tbody>
              {SIGNER_KINDS.map((kind) => {
                const row = signerClassAdvice(kind);
                return (
                  <tr key={kind} className="border-b border-rule last:border-b-0">
                    <td className="py-1 font-body text-[length:var(--text-xs)] text-ink-soft">
                      {row.label}
                    </td>
                    <td className="py-1 text-right font-mono text-[length:var(--text-2xs)] tracking-caps uppercase">
                      <span className={row.gatewayAvailable ? "text-green" : "text-danger"}>
                        Gateway {row.gatewayAvailable ? "Available" : "Unavailable"}
                      </span>
                      <span className="ml-3 text-green">CCTP Available</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <table className="w-full">
          <thead>
            <tr className="border-b-2 border-ink text-left">
              {["Source chain", "Domain", "Available", "Pending batch"].map((h) => (
                <th
                  key={h}
                  className="py-2 font-mono text-[length:var(--text-2xs)] tracking-caps text-muted uppercase"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {info.domains.map((row) => {
              const held = balanceFor(row.domain);
              const isArc = row.domain === ARC_CCTP_DOMAIN;
              return (
                <tr key={row.domain} className="border-b border-rule">
                  <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink">
                    {row.chain} {row.network}
                    {isArc ? (
                      <span className="ml-2 font-mono text-[length:var(--text-2xs)] tracking-caps text-green uppercase">
                        destination
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink-soft">
                    {row.domain}
                  </td>
                  <td className="py-2 font-mono text-[length:var(--text-xs)] text-ink">
                    {held ? `${usdcDisplay(held.balance)} USDC` : "—"}
                  </td>
                  <td className="py-2 font-mono text-[length:var(--text-xs)] text-faint">
                    {held ? usdcDisplay(held.pendingBatch) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <p className="mt-4 font-body text-[length:var(--text-xs)] text-muted">
          A deposit is pending until the epoch closes and confers no claim until then. If you
          bridge and then see no shares, that is the reason — the capital is queued for the
          next close, not lost, and it earns nothing in the interval.
        </p>
      </Panel>

      <Panel title="Redeem off Arc">
        <p className="mb-3 font-body text-[length:var(--text-sm)] text-ink-soft">
          <strong>CCTP is the route.</strong> Redeem the tranche position for USDC on Arc,
          then burn it to your destination domain. Fee {CCTP_MAX_FEE_FROM_ARC.toString()} —
          zero from Arc to every domain, measured as a balance delta on a real burn and not
          quoted from a fee oracle. It clears in seconds.
        </p>

        <ol className="mb-4">
          {redeem.steps.map((step) => (
            <li key={step.index} className="border-b border-rule py-2 last:border-b-0">
              <div className="font-mono text-[length:var(--text-sm)] text-ink">
                {step.index}. {step.call}
                <span className="ml-2 text-[length:var(--text-2xs)] tracking-caps text-muted uppercase">
                  on {step.where}
                </span>
              </div>
              <div className="font-body text-[length:var(--text-xs)] text-muted">{step.why}</div>
            </li>
          ))}
        </ol>

        <Row
          label="Finality threshold"
          value={String(CCTP_FINALITY_STANDARD)}
          note="standard — there is no fast toggle, because both thresholds price identically out of Arc"
        />
        <Row
          label="Gateway withdrawal, if you use one"
          value={`${withdrawalDays} days`}
          note="withdrawalDelay() read from the deployed contract, not from the documentation"
        />

        <p className="mt-4 font-body text-[length:var(--text-xs)] text-muted">
          Gateway&rsquo;s <span className="font-mono">initiateWithdrawal</span> →{" "}
          <span className="font-mono">withdraw</span> is the non-attested escape hatch out of
          a unified balance, not a transfer, and it takes {withdrawalDays} days. Circle&rsquo;s
          documentation says seven; the chain says {GATEWAY_WITHDRAWAL_DELAY_SECONDS} seconds.
          The chain is what will actually hold your money, so that is the number shown. Use it
          if Gateway is where your balance sits and CCTP is unavailable — not as a way out of
          a Plazo position.
        </p>

        <ul className="mt-3">
          {redeem.caveats.map((caveat) => (
            <li
              key={caveat}
              className="border-l-2 border-rule-strong py-1 pl-3 font-body text-[length:var(--text-xs)] text-faint"
            >
              {caveat}
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

function Route({
  title,
  available,
  summary,
  lines,
  args,
  argsPlaceholder,
}: {
  title: string;
  available: boolean;
  summary: string;
  lines: string[];
  /** Rendered only when an address is connected. */
  args?: RoutePlan["steps"] | undefined;
  /** What to say in place of the arguments. Absent means the card has none to show. */
  argsPlaceholder?: string;
}) {
  return (
    <div className="border-2 border-ink bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-baseline justify-between">
        <span className="font-display text-[length:var(--text-md)] font-bold text-ink">
          {title}
        </span>
        <span
          className={`font-mono text-[length:var(--text-2xs)] tracking-caps uppercase ${
            available ? "text-green" : "text-danger"
          }`}
        >
          {available ? "Available to you" : "Unavailable to you"}
        </span>
      </div>
      <p className="mt-1 font-body text-[length:var(--text-sm)] text-ink-soft">{summary}</p>
      <ul className="mt-2">
        {lines.map((line) => (
          <li key={line} className="py-1 font-body text-[length:var(--text-xs)] text-muted">
            {line}
          </li>
        ))}
      </ul>
      {args ? (
        <dl className="mt-2 border-t border-rule pt-2">
          {args.flatMap((step) =>
            Object.entries(step.args).map(([key, argValue]) => (
              <div key={`${step.index}-${key}`} className="flex justify-between gap-2 py-0.5">
                <dt className="font-mono text-[length:var(--text-2xs)] text-muted">{key}</dt>
                <dd className="truncate font-mono text-[length:var(--text-2xs)] text-ink">
                  {argValue}
                </dd>
              </div>
            )),
          )}
        </dl>
      ) : argsPlaceholder ? (
        <p className="mt-2 border-t border-rule pt-2 font-body text-[length:var(--text-2xs)] text-faint">
          {argsPlaceholder}
        </p>
      ) : null}
    </div>
  );
}

function Panel({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <section className="mb-5 border-2 border-ink bg-white p-5 shadow-[var(--shadow-card)]">
      <h2 className="mb-3 font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({label, value, note}: {label: string; value: string; note?: string}) {
  return (
    <div className="flex items-baseline justify-between border-b border-rule py-2 last:border-b-0">
      <span className="font-body text-[length:var(--text-sm)] text-ink-soft">{label}</span>
      <span className="text-right">
        <span className="font-mono text-[length:var(--text-base)] text-ink">{value}</span>
        {note ? (
          <span className="ml-2 font-body text-[length:var(--text-xs)] text-faint">{note}</span>
        ) : null}
      </span>
    </div>
  );
}
