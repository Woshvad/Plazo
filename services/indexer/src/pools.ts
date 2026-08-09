/**
 * Row keys for a book that is no longer the only book.
 *
 * `capital.ts` and `origination.ts` import `ponder:registry` — a virtual module that
 * exists only inside the Ponder runtime — so nothing in either can be imported by a test.
 * These are the decisions worth cornering, lifted into a module a test can simply import,
 * the same split `settlement.ts` makes for the payout plane.
 *
 * ## What changed and why it is not cosmetic
 *
 * Phase 7 deploys a second `TranchedCreditPool` for the EURC corridor. Both books emit
 * the same ABI, both number their epochs from one, and both hand out redemption ticket 0
 * to whoever redeems first. Every key below used to be derived from the event arguments
 * alone; every one of them now begins with the emitting address.
 *
 * The failure this prevents is not a crash. `epoch` was keyed on `number`, so the second
 * book to close epoch 1 would have overwritten the first book's NAV through the same
 * upsert that was written to be idempotent — a lender's chart showing one book's price
 * under both books' names, with nothing anywhere raising an error. `lenderPosition` was
 * keyed on `tranche-holder`, so an allocator holding senior in both books would have had
 * one row carrying the sum of two balance sheets, denominated in neither currency.
 *
 * That is the concrete content of schema v5 being non-additive: no event changed, the
 * emitting address simply stopped being a constant.
 */

/** Lowercased, so a key never depends on how a provider cased a hex string. */
const lower = (address: `0x${string}`): string => address.toLowerCase();

/**
 * A lender's position in one tranche of one book.
 *
 * `pool` first, because the most common query is "everything in this book" and a prefix
 * scan is free.
 */
export const poolPositionId = (
  pool: `0x${string}`,
  tranche: number,
  holder: `0x${string}`,
): string => `${lower(pool)}-${tranche}-${lower(holder)}`;

/**
 * One redemption ticket.
 *
 * `index` is a per-tranche counter inside one pool and restarts at zero for each book,
 * so without the pool two lenders in two books share a ticket id on the same day.
 */
export const poolTicketId = (
  pool: `0x${string}`,
  tranche: number,
  holder: `0x${string}`,
  index: bigint,
): string => `${lower(pool)}-${tranche}-${lower(holder)}-${index}`;

/**
 * POOL-09's uniformity, checked **per book**.
 *
 * One fill per tranche per epoch at one rate. With two books in one table the check has
 * to be run inside a book: two correct rates in two pools' epoch 4 are two correct
 * epochs, and a check that ignored the pool would read them as one book charging two
 * redeemers differently — which is precisely the gate the liquidity fee replaced.
 *
 * Returns the offending `(pool, tranche, epoch)` groups, empty when uniform.
 */
export const nonUniformFills = (
  fills: {pool: `0x${string}`; tranche: number; epoch: bigint; feeBps: bigint}[],
): string[] => {
  const rates = new Map<string, Set<string>>();
  for (const fill of fills) {
    const key = `${lower(fill.pool)}-${fill.tranche}-${fill.epoch}`;
    const seen = rates.get(key) ?? new Set<string>();
    seen.add(fill.feeBps.toString());
    rates.set(key, seen);
  }
  return [...rates.entries()].filter(([, seen]) => seen.size > 1).map(([key]) => key);
};
