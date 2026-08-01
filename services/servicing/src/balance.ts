/**
 * What the borrower can actually pay with, and what they are about to be short of.
 *
 * XCH-03, XCH-04 and NOTIF-05. The most valuable few hundred lines in the servicing
 * stack, and the reason is mechanical rather than cosmetic: an EIP-3009 check debits
 * the borrower's **Arc ERC-20 balance** and nothing else. A Gateway unified balance on
 * another chain is not collectable by a check on Arc, however much it is worth.
 *
 * So a screen that shows a combined figure is showing a number that predicts nothing
 * about whether the next check clears — which is the only question the screen exists to
 * answer. Worse, at portfolio scale it makes the loss model measure wallet UX rather
 * than credit: a borrower with the money in the wrong place looks exactly like a
 * borrower without the money.
 *
 * DEC-19: one balance, and it is the collectable one. Anything held elsewhere is
 * displayed separately, labelled as not collectable, next to the action that would move
 * it.
 */

import type {Address} from "viem";

/** 6-decimal USDC, the unit an EIP-3009 `value` is denominated in. */
export type Usdc6 = bigint;

export interface BalanceSnapshot {
  readonly borrower: Address;
  /** What a check can debit today. */
  readonly collectable: Usdc6;
  /**
   * Held on other chains through Gateway. Never added to `collectable`.
   *
   * Present so the app can say "you have it, it is in the wrong place, here is the
   * button" — which is a materially different message from "you are short".
   */
  readonly elsewhere: Usdc6;
  readonly at: Date;
}

export interface UpcomingInstallment {
  readonly planId: `0x${string}`;
  readonly index: number;
  readonly amount: Usdc6;
  readonly dueAt: Date;
}

export interface Shortfall {
  readonly planId: `0x${string}`;
  readonly index: number;
  readonly dueAt: Date;
  /** What is owed. */
  readonly amount: Usdc6;
  /** What is missing. Always positive — a covered installment produces no shortfall. */
  readonly missing: Usdc6;
  /** Whether the money exists but is on the wrong chain. */
  readonly coveredByElsewhere: boolean;
}

export interface TopUp {
  readonly borrower: Address;
  /** What to move, sized to the whole horizon rather than to one installment. */
  readonly amount: Usdc6;
  /** The earliest due date this top-up is protecting. */
  readonly by: Date;
  readonly shortfalls: readonly Shortfall[];
  /** Whether a Gateway balance covers it, or the borrower has to fund from outside. */
  readonly source: "gateway" | "external";
}

/**
 * How far ahead to look. Two weeks is one Pay-in-4 interval, so a borrower always sees
 * the next due date and usually the one after it.
 */
export const DEFAULT_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Which upcoming installments the collectable balance will not cover.
 *
 * Installments are consumed in due order against one balance, because that is what a
 * keeper will actually do: the earliest check is collected first and the money is gone.
 * Sizing each installment against the *full* balance independently would report no
 * shortfall for a borrower who can cover any one of three payments but not all three —
 * which is precisely the borrower about to bounce.
 */
export function shortfalls(
  balance: BalanceSnapshot,
  upcoming: readonly UpcomingInstallment[],
  horizonMs: number = DEFAULT_HORIZON_MS,
): Shortfall[] {
  const cutoff = balance.at.getTime() + horizonMs;
  const inWindow = [...upcoming]
    .filter((i) => i.dueAt.getTime() <= cutoff)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());

  let remaining = balance.collectable;
  let elsewhere = balance.elsewhere;
  const found: Shortfall[] = [];

  for (const installment of inWindow) {
    if (remaining >= installment.amount) {
      remaining -= installment.amount;
      continue;
    }

    const missing = installment.amount - remaining;
    remaining = 0n;

    const covered = elsewhere >= missing;
    if (covered) elsewhere -= missing;

    found.push({
      planId: installment.planId,
      index: installment.index,
      dueAt: installment.dueAt,
      amount: installment.amount,
      missing,
      coveredByElsewhere: covered,
    });
  }

  return found;
}

/**
 * The one-tap top-up, sized to the whole horizon.
 *
 * XCH-04 says "sized to the shortfall", and the shortfall worth sizing to is the sum
 * across the window, not the next installment alone. A top-up that covers Tuesday and
 * leaves Friday short is two taps and one bounce, and the second tap is the one nobody
 * makes.
 *
 * Returns `null` when nothing is short. A screen that always shows a top-up button
 * teaches borrowers to ignore it, which costs exactly the times it mattered.
 */
export function sizeTopUp(
  balance: BalanceSnapshot,
  upcoming: readonly UpcomingInstallment[],
  horizonMs: number = DEFAULT_HORIZON_MS,
): TopUp | null {
  const found = shortfalls(balance, upcoming, horizonMs);
  if (found.length === 0) return null;

  const amount = found.reduce((sum, s) => sum + s.missing, 0n);
  const by = found.reduce(
    (earliest, s) => (s.dueAt < earliest ? s.dueAt : earliest),
    found[0]!.dueAt,
  );

  return {
    borrower: balance.borrower,
    amount,
    by,
    shortfalls: found,
    source: balance.elsewhere >= amount ? "gateway" : "external",
  };
}

/**
 * Whether a balance is worth surfacing at all.
 *
 * NOTIF-05 wants a shortfall surfaced *before* it becomes a bounce. This is the trigger:
 * something is due inside the window and the money is not there. It deliberately does
 * not fire on a borrower who is merely low — being low is not a problem until there is
 * something to pay.
 */
export function needsAttention(
  balance: BalanceSnapshot,
  upcoming: readonly UpcomingInstallment[],
  horizonMs: number = DEFAULT_HORIZON_MS,
): boolean {
  return shortfalls(balance, upcoming, horizonMs).length > 0;
}
