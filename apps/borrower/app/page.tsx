import {Card, Header, Row, SampleBanner, Shell} from "./_chrome";
import {summary, usd, when, shortId} from "./_data";

/**
 * The borrower's home screen. APP-02, XCH-03, XCH-04, NOTIF-05.
 *
 * The whole screen is arranged around one question: will the next payment clear? Which
 * is why the two balances are separated and never summed.
 *
 * **DEC-19, in the layout.** An EIP-3009 check debits the Arc ERC-20 balance and
 * nothing else. A Gateway balance on another chain is real money the borrower owns and
 * is not money a check can take, so a combined figure would be a number that predicts
 * nothing about the only thing this screen exists to predict. It is shown, separately,
 * next to the button that would move it — because "you are short" and "your money is in
 * the wrong place" are different problems with different fixes, and a borrower told the
 * first when it is the second will go and find money they already have.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const data = await summary();

  return (
    <>
      <Header active="plans" />
      <Shell>
        {data.live ? null : <SampleBanner />}

        <div className="mb-6 flex items-end justify-between">
          <div>
            <div className="font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
              Collectable on Arc
            </div>
            <div className="font-display text-[length:var(--text-5xl)] leading-none font-bold text-ink">
              {usd(data.balance.collectable)}
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[length:var(--text-xs)] tracking-caps text-muted uppercase">
              Held elsewhere
            </div>
            <div className="font-mono text-[length:var(--text-xl)] text-ink-soft">
              {usd(data.balance.elsewhere)}
            </div>
            <div className="font-body text-[length:var(--text-xs)] text-faint">
              not collectable until you move it
            </div>
          </div>
        </div>

        {data.topUp ? (
          <Card tone="attention" title="Before your next payment">
            <p className="mb-3 font-body text-[length:var(--text-base)] text-ink">
              You are <strong className="font-mono">{usd(data.topUp.amount)}</strong> short of what
              is due by <strong>{when(data.topUp.by)}</strong>.{" "}
              {data.topUp.source === "gateway"
                ? "You already have it — it is on another chain."
                : "You will need to add funds."}
            </p>
            <button
              type="button"
              className="border-2 border-ink bg-accent px-4 py-2 font-display text-[length:var(--text-md)] font-semibold text-ink shadow-[var(--shadow-raised)]"
            >
              {data.topUp.source === "gateway"
                ? `Move ${usd(data.topUp.amount)} to Arc`
                : `Add ${usd(data.topUp.amount)}`}
            </button>
            <p className="mt-3 font-body text-[length:var(--text-xs)] text-muted">
              Sized to everything due in the next two weeks, not just the next payment — a
              top-up that covers Tuesday and leaves Friday short is two taps and one bounce.
            </p>
          </Card>
        ) : (
          <Card title="Before your next payment">
            <p className="font-body text-[length:var(--text-base)] text-green">
              Everything due in the next two weeks is covered.
            </p>
          </Card>
        )}

        <Card title="Coming up">
          {data.upcoming.length === 0 ? (
            <p className="font-body text-[length:var(--text-sm)] text-muted">Nothing scheduled.</p>
          ) : (
            data.upcoming.map((item) => (
              <Row
                key={`${item.planId}-${item.index}`}
                label={`${when(item.dueAt)} — payment ${item.index + 1}`}
                value={usd(item.amount)}
                note={shortId(item.planId)}
              />
            ))
          )}
        </Card>

        <Card title="Your plans">
          {data.plans.length === 0 ? (
            <p className="font-body text-[length:var(--text-sm)] text-muted">No plans yet.</p>
          ) : (
            data.plans.map((plan) => (
              <Row
                key={plan.planId}
                label={shortId(plan.planId)}
                value={usd(plan.outstanding)}
                note={plan.state}
              />
            ))
          )}
        </Card>

        <p className="mt-8 font-body text-[length:var(--text-xs)] text-faint">
          Your money stays in your wallet until each due date. Nothing here holds it, and
          nothing here can move it early — every payment is an authorization you signed,
          dated to the day it is owed.
        </p>
      </Shell>
    </>
  );
}
