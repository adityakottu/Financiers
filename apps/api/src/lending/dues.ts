import { Money } from '@fin/money';
import { sql } from 'kysely';
import type { Tx } from '../db/db';
import { GL, LedgerService } from '../ledger/ledger.service';

/**
 * Status of every open installment of active loans as of `date` (all active loans, or just
 * `loanIds`). Used by the nightly job and in the same transaction as every payment or reversal.
 */
export async function rollStatuses(tx: Tx, date: string, loanIds?: string[]): Promise<number> {
  const r = await sql`
    UPDATE loan_installments i SET
      status = CASE
        WHEN i.total_paid >= i.total_due THEN 'PAID'
        WHEN i.due_date < ${date}::date THEN 'OVERDUE'
        WHEN i.total_paid > 0 THEN 'PARTIALLY_PAID'
        WHEN i.due_date = ${date}::date THEN 'DUE_TODAY'
        ELSE 'UPCOMING' END,
      days_overdue = CASE WHEN i.due_date < ${date}::date AND i.total_paid < i.total_due THEN ${date}::date - i.due_date ELSE 0 END,
      paid_on = CASE WHEN i.total_paid >= i.total_due THEN coalesce(i.paid_on, ${date}::date) ELSE NULL END
    FROM loans l
    WHERE l.id = i.loan_id AND l.status = 'ACTIVE' AND i.status NOT IN ('WAIVED', 'RESCHEDULED')
      ${loanIds ? sql`AND l.id = ANY(${loanIds}::uuid[])` : sql``}
      AND (i.status <> 'PAID' OR i.total_paid < i.total_due)`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

/**
 * E2 — interest accrual on due date (decision D1). One entry per loan per run, a line pair per
 * installment. `throughDate` defaults to `date`; on full settlement (foreclosure) a payment accrues
 * the remaining schedule at once, dated `date`.
 */
export async function accrueInterest(
  tx: Tx,
  ledger: LedgerService,
  date: string,
  opts: { loanIds?: string[]; throughDate?: string; reason?: string } = {},
): Promise<{ installments: number; entries: number }> {
  let q = tx
    .selectFrom('loan_installments as i')
    .innerJoin('loans as l', 'l.id', 'i.loan_id')
    .select(['i.id', 'i.loan_id', 'i.installment_no', 'i.interest_due', 'i.due_date', 'l.loan_no', 'l.branch_id', 'l.customer_id'])
    .where('l.status', '=', 'ACTIVE')
    .where('i.status', '<>', 'RESCHEDULED')
    .where('i.interest_accrued_at', 'is', null)
    .where('i.due_date', '<=', opts.throughDate ?? date)
    .orderBy('i.loan_id')
    .orderBy('i.installment_no');
  if (opts.loanIds) q = q.where('i.loan_id', 'in', opts.loanIds);
  const due = await q.execute();
  const byLoan = new Map<string, typeof due>();
  for (const i of due) byLoan.set(i.loan_id, [...(byLoan.get(i.loan_id) ?? []), i]);
  let entries = 0;
  for (const [loanId, items] of byLoan) {
    const withInterest = items.filter((i) => Money.of(i.interest_due).isPositive());
    if (withInterest.length) {
      const first = items[0]!;
      await ledger.post(tx, {
        entryType: 'ACCRUAL',
        valueDate: date,
        branchId: first.branch_id,
        sourceType: 'loan',
        sourceId: loanId,
        narration: `${opts.reason ?? 'Interest due'} on loan ${first.loan_no} (installment ${withInterest.map((i) => i.installment_no).join(', ')})`,
        lines: withInterest.flatMap((i) => [
          { account: GL.INTEREST_RECEIVABLE, debit: Money.of(i.interest_due), loanId, customerId: first.customer_id, memo: `Installment ${i.installment_no} due ${i.due_date}` },
          { account: GL.INTEREST_INCOME, credit: Money.of(i.interest_due), loanId, memo: `Installment ${i.installment_no}` },
        ]),
        createdBy: null,
      });
      entries++;
    }
    await tx.updateTable('loan_installments').set({ interest_accrued_at: new Date() }).where('id', 'in', items.map((i) => i.id)).execute();
  }
  return { installments: due.length, entries };
}
