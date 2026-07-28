/**
 * Database schema separation.
 *
 * "PII never touches the chain" is only auditable if the boundary is somewhere a
 * machine can check. Two Postgres schemas:
 *
 *   `chain`    — everything derived from indexed logs. Reproducible from the chain
 *                alone. Contains no personal data, by construction rather than by
 *                convention, because nothing on the chain carries any.
 *
 *   `operator` — the private side. The plan-to-borrower mapping, KYC artefacts,
 *                underwriting features, FX quotes, notification delivery logs.
 *                Subject to correction, deletion and consent expiry.
 *
 * The join key between them is `planId`. That is the entire linkage, and it is
 * exactly what a deletion request severs.
 */

export const CHAIN_SCHEMA = "chain" as const;
export const OPERATOR_SCHEMA = "operator" as const;

/**
 * Column-name shapes that must never appear in the `chain` schema.
 *
 * A migration-time check, not a lint. Reviewers approve migrations quickly and a
 * column called `email` in the wrong schema is one careless PR away from a
 * permanent, unerasable record.
 */
export const PII_COLUMN_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bemail\b/,
  /\bphone\b/,
  /\bssn\b/,
  /\btax id\b/,
  /\b(first|last|full|legal) name\b/,
  /\bdate of birth\b/,
  /\bdob\b/,
  /\baddress line\b/,
  /\bpostal code\b/,
  /\bip address\b/,
  /\bpassport (number|no)\b/,
  /\bnational id\b/,
  /\bkyc\b/,
  /\bdocument (id|number)\b/,
]);

/**
 * Underscores are word characters, so `\bssn\b` does not match `borrower_ssn` and
 * `\bphone\b` does not match `phone_number` — the two most likely column names in
 * the corpus. Normalising to space-separated words before matching is what makes
 * the patterns mean what they read as.
 */
function normalizeColumnName(column: string): string {
  return column
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

export interface ColumnRef {
  schema: string;
  table: string;
  column: string;
}

export interface SeparationViolation extends ColumnRef {
  pattern: string;
}

/**
 * Reject PII-shaped columns in the chain schema.
 *
 * Deliberately pattern-based rather than exhaustive. It cannot prove the absence of
 * personal data — nothing can — but it catches the realistic failure, which is
 * someone adding a convenient denormalised column to the schema that is easiest to
 * query.
 */
export function checkSchemaSeparation(columns: readonly ColumnRef[]): SeparationViolation[] {
  const violations: SeparationViolation[] = [];
  for (const column of columns) {
    if (column.schema !== CHAIN_SCHEMA) continue;
    const normalized = normalizeColumnName(column.column);
    for (const pattern of PII_COLUMN_PATTERNS) {
      if (pattern.test(normalized)) {
        violations.push({...column, pattern: pattern.source});
        break;
      }
    }
  }
  return violations;
}

/**
 * Cohort snapshot.
 *
 * Arc has published no testnet reset policy. The network has been live since
 * 2025-10-28 with over 150 million transactions, which is weak evidence against a
 * wipe and no guarantee — and the loss calibration this project depends on is
 * measured cohort data, which a reset would destroy.
 *
 * So cohort state is snapshotted continuously into the `operator` schema rather
 * than treating the chain as the analytics store. It also happens to be the right
 * shape regardless: LP reporting should not be a `eth_getLogs` sweep bounded to
 * 10,000 blocks.
 */
export interface CohortSnapshot {
  /** Origination cohort, as `YYYY-MM`. */
  cohort: string;
  takenAtBlock: bigint;
  takenAt: Date;
  plansOriginated: number;
  plansRepaid: number;
  plansDelinquent: number;
  plansChargedOff: number;
  principalOriginated: bigint;
  principalOutstanding: bigint;
  principalChargedOff: bigint;
  /** First-payment defaults — the kill-switch input, tracked separately. */
  firstPaymentDefaults: number;
  /** New-wallet defaults, separated so the switch cannot be cheaply griefed. */
  newWalletDefaults: number;
  seasonedWalletDefaults: number;
}

/** Charge-offs as a share of principal originated, in basis points. */
export function chargeOffRateBps(snapshot: CohortSnapshot): number {
  if (snapshot.principalOriginated === 0n) return 0;
  return Number((snapshot.principalChargedOff * 10_000n) / snapshot.principalOriginated);
}

/**
 * First-payment default rate in basis points.
 *
 * The kill-switch input. Throttling must be graduated rather than binary and
 * conditional on cohort size — a switch that trips on a three-plan cohort is a
 * switch an attacker can flip for the price of three plans.
 */
export function firstPaymentDefaultBps(snapshot: CohortSnapshot): number {
  if (snapshot.plansOriginated === 0) return 0;
  return Math.round((snapshot.firstPaymentDefaults / snapshot.plansOriginated) * 10_000);
}

/** Cohorts below this size do not move the kill switch. */
export const MIN_COHORT_FOR_KILL_SWITCH = 50;
