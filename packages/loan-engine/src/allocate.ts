import { Money } from '@fin/money';
import { EngineError } from './types';

export const ALLOCATION_ORDER_COMPONENTS = ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'] as const;
export type DueComponent = (typeof ALLOCATION_ORDER_COMPONENTS)[number];
export type AllocationComponent = DueComponent | 'ADVANCE';

export interface AllocationRule {
  mode: 'INSTALLMENT_WISE' | 'COMPONENT_WISE';
  /** Each of PENALTY, FEE, INTEREST, PRINCIPAL exactly once. */
  order: DueComponent[];
  excessHandling: 'ADVANCE' | 'REJECT';
}

/** Outstanding (unpaid) amounts of one installment, per component. Decimal strings. */
export interface OpenInstallment {
  id: string;
  no: number;
  dueDate: string;
  penalty: string;
  fee: string;
  interest: string;
  principal: string;
}

export interface AllocationLine {
  /** Null for ADVANCE. */
  installmentId: string | null;
  installmentNo: number | null;
  component: AllocationComponent;
  amount: string;
  seq: number;
}

export interface Allocation {
  lines: AllocationLine[];
  /** Part of the payment that settled nothing and went to customer advance. */
  advance: string;
}

const KEY: Record<DueComponent, keyof OpenInstallment> = { PENALTY: 'penalty', FEE: 'fee', INTEREST: 'interest', PRINCIPAL: 'principal' };

/**
 * Decide which dues a payment settles (doc 08 §3). Pure and deterministic: the same inputs give
 * the same lines regardless of input order.
 *
 * Only installments due on or before `asOf` are eligible. Paying ahead is not applied to future
 * installments here (their interest has not been earned yet); it becomes a customer advance that is
 * applied automatically on the due date (doc 07 E4/E5).
 */
export function allocate(items: OpenInstallment[], amount: string, rule: AllocationRule, asOf: string): Allocation {
  const total = Money.of(amount);
  if (!total.isPositive()) throw new EngineError('INVALID_AMOUNT', 'Payment amount must be positive');
  if (!total.roundTo('0.01').eq(total)) throw new EngineError('INVALID_AMOUNT', 'Payment amount cannot have more than 2 decimals');
  if (new Set(rule.order).size !== 4 || !ALLOCATION_ORDER_COMPONENTS.every((c) => rule.order.includes(c))) {
    throw new EngineError('INVALID_RULE', 'Allocation order must list each component exactly once');
  }

  const eligible = items
    .filter((i) => i.dueDate <= asOf)
    .slice()
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.no - b.no || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

  const slots: { inst: OpenInstallment; component: DueComponent; outstanding: Money }[] = [];
  if (rule.mode === 'INSTALLMENT_WISE') {
    for (const inst of eligible) for (const c of rule.order) slots.push({ inst, component: c, outstanding: Money.of(inst[KEY[c]] as string) });
  } else {
    for (const c of rule.order) for (const inst of eligible) slots.push({ inst, component: c, outstanding: Money.of(inst[KEY[c]] as string) });
  }

  const lines: AllocationLine[] = [];
  let remaining = total;
  for (const s of slots) {
    if (!remaining.isPositive()) break;
    if (s.outstanding.isNegative()) throw new EngineError('INVALID_INPUT', `Installment ${s.inst.no} has a negative ${s.component.toLowerCase()} balance`);
    const take = remaining.min(s.outstanding);
    if (take.isPositive()) {
      lines.push({ installmentId: s.inst.id, installmentNo: s.inst.no, component: s.component, amount: take.toString(), seq: lines.length + 1 });
      remaining = remaining.minus(take);
    }
  }

  if (remaining.isPositive()) {
    if (rule.excessHandling === 'REJECT') {
      throw new EngineError('OVERPAYMENT_NOT_ALLOWED', `₹${remaining.toString()} is more than what is due; this product does not accept advance payments`);
    }
    lines.push({ installmentId: null, installmentNo: null, component: 'ADVANCE', amount: remaining.toString(), seq: lines.length + 1 });
  }
  return { lines, advance: remaining.isPositive() ? remaining.toString() : '0.00' };
}
