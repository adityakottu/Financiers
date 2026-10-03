import { Money } from '@fin/money';

export const PENALTY_TYPES = ['NONE', 'FLAT_PER_INSTALLMENT', 'PCT_OF_OVERDUE_PER_DAY', 'PCT_PA_ON_OVERDUE'] as const;
export type PenaltyType = (typeof PENALTY_TYPES)[number];

export interface PenaltyRule {
  type: PenaltyType;
  /** Amount (FLAT) or percent (PCT_*). */
  value: string;
  graceDays: number;
  /** Optional maximum total penal charge per installment. */
  cap?: string | null;
}

/**
 * Penal charge to assess for one installment on one day (doc 06 §8). Charged as a separate
 * component — never added to principal, never compounded ⚖.
 *
 * FLAT_PER_INSTALLMENT is charged once, on the first day past the grace period.
 * The PCT_* types accrue daily on the overdue (unpaid, past-due) amount.
 */
export function penaltyForDay(
  rule: PenaltyRule,
  s: { daysOverdue: number; overdueAmount: string; alreadyCharged: string },
): Money {
  if (rule.type === 'NONE' || s.daysOverdue <= rule.graceDays) return Money.zero();
  const overdue = Money.of(s.overdueAmount);
  if (!overdue.isPositive()) return Money.zero();
  const already = Money.of(s.alreadyCharged);
  let amount: Money;
  switch (rule.type) {
    case 'FLAT_PER_INSTALLMENT':
      amount = already.isPositive() ? Money.zero() : Money.of(rule.value);
      break;
    case 'PCT_OF_OVERDUE_PER_DAY':
      amount = overdue.times(Money.of(rule.value).toDecimal().dividedBy(100));
      break;
    case 'PCT_PA_ON_OVERDUE':
      amount = overdue.times(Money.of(rule.value).toDecimal().dividedBy(100).dividedBy(365));
      break;
  }
  if (rule.cap) {
    const room = Money.of(rule.cap).minus(already);
    if (!room.isPositive()) return Money.zero();
    amount = amount.min(room);
  }
  return amount;
}
