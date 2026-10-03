import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import type { Db } from '../db/db';

export interface CheckResult {
  code: string;
  label: string;
  ok: boolean;
  /** Plain-language finding; on failure, what is wrong and where to look. */
  detail: string;
  /** Up to 20 offending references (entry numbers, loan numbers, account codes). */
  samples?: string[];
}

/**
 * Ledger / sub-ledger / audit integrity (docs 07 §7, 11 §6, 12 §6, 14 §4). Read-only; safe on a
 * live database or a restored copy. Every check states plainly what it proved or what broke.
 */
export async function runIntegrityChecks(db: Db): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const add = (r: CheckResult) => out.push(r);

  // 1. Every journal entry balances.
  const unbalanced = await sql<{ entry_no: string }>`
    SELECT e.entry_no FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
    GROUP BY e.id, e.entry_no HAVING sum(l.debit) <> sum(l.credit) LIMIT 20`.execute(db);
  const entries = await sql<{ n: string }>`SELECT count(*)::text n FROM journal_entries`.execute(db);
  add({ code: 'ENTRIES_BALANCED', label: 'Every journal entry balances', ok: unbalanced.rows.length === 0, detail: unbalanced.rows.length ? `${unbalanced.rows.length}+ entries have debits ≠ credits` : `${entries.rows[0]!.n} entries checked`, samples: unbalanced.rows.map((r) => r.entry_no) });

  // 2. Trial balance.
  const tb = await sql<{ dr: string; cr: string }>`SELECT coalesce(sum(debit), 0)::text dr, coalesce(sum(credit), 0)::text cr FROM journal_lines`.execute(db);
  add({ code: 'TRIAL_BALANCE', label: 'Trial balance balances', ok: tb.rows[0]!.dr === tb.rows[0]!.cr, detail: `debits ₹${tb.rows[0]!.dr} · credits ₹${tb.rows[0]!.cr}` });

  // 3. Loan sub-ledger = ledger, per loan and per receivable account (control accounts tie out).
  const sub = await sql<{ loan_no: string; code: string; ledger: string; loan: string }>`
    WITH led AS (
      SELECT l.loan_id, a.code, sum(l.debit - l.credit) bal FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.loan_id IS NOT NULL AND a.code IN ('1310', '1320', '1330', '1340', '2200') GROUP BY l.loan_id, a.code),
    loan AS (
      SELECT id, loan_no, status, unnest(ARRAY['1310', '1320', '1330', '1340', '2200']) code,
        unnest(ARRAY[
          CASE WHEN status = 'ACTIVE' THEN principal_outstanding ELSE 0 END,
          CASE WHEN status = 'ACTIVE' THEN interest_outstanding ELSE 0 END,
          CASE WHEN status = 'ACTIVE' THEN fees_outstanding ELSE 0 END,
          CASE WHEN status = 'ACTIVE' THEN penalty_outstanding ELSE 0 END,
          -advance_balance]) expected
      FROM loans WHERE status IN ('ACTIVE', 'CLOSED', 'WRITTEN_OFF'))
    SELECT loan.loan_no, loan.code, coalesce(led.bal, 0)::text ledger, loan.expected::text loan
    FROM loan LEFT JOIN led ON led.loan_id = loan.id AND led.code = loan.code
    WHERE coalesce(led.bal, 0) <> loan.expected LIMIT 20`.execute(db);
  const loans = await sql<{ n: string }>`SELECT count(*)::text n FROM loans WHERE status IN ('ACTIVE', 'CLOSED', 'WRITTEN_OFF')`.execute(db);
  add({
    code: 'LOAN_SUBLEDGER',
    label: 'Loan balances equal the ledger (1310–1340, 2200)',
    ok: sub.rows.length === 0,
    detail: sub.rows.length ? `${sub.rows.length}+ loan/account pairs differ` : `${loans.rows[0]!.n} loans × 5 accounts agree`,
    samples: sub.rows.map((r) => `${r.loan_no} ${r.code}: ledger ${r.ledger} vs loan ${r.loan}`),
  });

  // 4. Control accounts: total receivables in the ledger = total on active loans.
  const ctl = await sql<{ ledger: string; loans: string }>`
    SELECT (SELECT coalesce(sum(l.debit - l.credit), 0) FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code IN ('1310', '1320', '1330', '1340'))::text ledger,
      (SELECT coalesce(sum(principal_outstanding + interest_outstanding + fees_outstanding + penalty_outstanding), 0) FROM loans WHERE status = 'ACTIVE')::text loans`.execute(db);
  add({ code: 'RECEIVABLE_CONTROL', label: 'Loan receivable control accounts = loan book', ok: ctl.rows[0]!.ledger === ctl.rows[0]!.loans, detail: `ledger ₹${ctl.rows[0]!.ledger} · loans ₹${ctl.rows[0]!.loans}` });

  // 5. Every live payment is journaled for its amount, allocated in full, and has a receipt.
  const pay = await sql<{ payment_no: string; problem: string }>`
    SELECT p.payment_no, CASE
        WHEN p.journal_entry_id IS NULL THEN 'no journal entry'
        WHEN (SELECT coalesce(sum(debit), 0) FROM journal_lines l WHERE l.entry_id = p.journal_entry_id) <> p.amount THEN 'journal amount differs'
        WHEN NOT p.is_post_write_off AND (SELECT coalesce(sum(amount), 0) FROM payment_allocations a WHERE a.payment_id = p.id) <> p.amount THEN 'allocations differ from amount'
        WHEN NOT EXISTS (SELECT 1 FROM receipts r WHERE r.payment_id = p.id) THEN 'no receipt'
      END problem
    FROM payments p WHERE p.status <> 'REVERSED' AND (
      p.journal_entry_id IS NULL
      OR (SELECT coalesce(sum(debit), 0) FROM journal_lines l WHERE l.entry_id = p.journal_entry_id) <> p.amount
      OR (NOT p.is_post_write_off AND (SELECT coalesce(sum(amount), 0) FROM payment_allocations a WHERE a.payment_id = p.id) <> p.amount)
      OR NOT EXISTS (SELECT 1 FROM receipts r WHERE r.payment_id = p.id))
    LIMIT 20`.execute(db);
  const pays = await sql<{ n: string }>`SELECT count(*)::text n FROM payments WHERE status <> 'REVERSED'`.execute(db);
  add({ code: 'PAYMENTS', label: 'Payments: journaled, fully allocated, receipted', ok: pay.rows.length === 0, detail: pay.rows.length ? `${pay.rows.length}+ payments have a problem` : `${pays.rows[0]!.n} payments checked`, samples: pay.rows.map((r) => `${r.payment_no}: ${r.problem}`) });

  // 6. Reversed payments have their mirror entry.
  const rev = await sql<{ payment_no: string }>`
    SELECT p.payment_no FROM payments p WHERE p.status = 'REVERSED'
      AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.reverses_entry_id = p.journal_entry_id) LIMIT 20`.execute(db);
  add({ code: 'REVERSALS', label: 'Every reversed payment has a mirror journal entry', ok: rev.rows.length === 0, detail: rev.rows.length ? `${rev.rows.length}+ reversed payments without a reversal entry` : 'all reversals mirrored', samples: rev.rows.map((r) => r.payment_no) });

  // 7. Cash can never be negative.
  const cash = await sql<{ code: string; bal: string }>`
    SELECT a.code, sum(l.debit - l.credit)::text bal FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE a.subtype IN ('CASH', 'EMPLOYEE_CASH') GROUP BY a.code HAVING sum(l.debit - l.credit) < 0 LIMIT 20`.execute(db);
  add({ code: 'CASH_NOT_NEGATIVE', label: 'No cash account is below zero', ok: cash.rows.length === 0, detail: cash.rows.length ? `${cash.rows.length} cash accounts are negative` : 'all branch and collector cash ≥ 0', samples: cash.rows.map((r) => `${r.code}: ₹${r.bal}`) });

  // 8. The audit trail has not been altered.
  const chain = await new AuditService(db).verifyChain();
  add({ code: 'AUDIT_CHAIN', label: 'Audit trail hash chain intact', ok: chain.ok, detail: chain.ok ? `${chain.checked} audit records verified` : `chain breaks at audit record ${chain.brokenAtId} (after ${chain.checked} good records)`, samples: chain.brokenAtId ? [chain.brokenAtId] : [] });

  return out;
}
