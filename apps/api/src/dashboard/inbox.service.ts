import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { scope } from '../auth/access.service';
import type { AuthContext } from '../auth/context';
import { DB_TOKEN, Db } from '../db/db';

const NONE = '00000000-0000-0000-0000-000000000000';

export interface InboxItem {
  key: string;
  title: string;
  detail: string;
  count: number;
  href: string;
  tone: 'warn' | 'info' | 'ok';
}

/**
 * Notification centre v1: what is waiting for this person's decision, computed live from the
 * same tables as the work itself (so it is never stale and never needs clearing). Only items the
 * user has the permission to act on, in their branches, and never their own requests.
 */
@Injectable()
export class InboxService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async items(auth: AuthContext): Promise<InboxItem[]> {
    const p = (x: Parameters<typeof auth.permissions.has>[0]) => auth.permissions.has(x);
    const b = scope.branchFilter(auth);
    const ids = auth.scope === 'ASSIGNED' ? [NONE] : b ? (b.length ? b : [NONE]) : null;
    const br = (col: string) => (ids ? sql`AND ${sql.ref(col)} = ANY(${ids}::uuid[])` : sql``);
    const me = auth.userId;
    type Q = ReturnType<typeof sql<{ n: number }>>;
    const defs: { key: string; title: string; detail: string; href: string; tone: InboxItem['tone']; q: () => Q }[] = [];
    // The query is a thunk: it runs only for items this user can act on.
    const add = (cond: boolean, key: string, title: string, detail: string, href: string, q: () => Q, tone: InboxItem['tone'] = 'warn') => {
      if (cond) defs.push({ key, title, detail, href, tone, q });
    };

    add(p('loan.approve'), 'loans', 'Loans to approve', 'Applications submitted by someone else', '/loans?status=PENDING_APPROVAL',
      () => sql<{ n: number }>`SELECT count(*)::int n FROM loans l WHERE l.status = 'PENDING_APPROVAL' AND l.submitted_by IS DISTINCT FROM ${me} ${br('l.branch_id')}`);
    add(p('payment.reverse_approve'), 'reversals', 'Payment reversals to decide', 'Asked by a collector or branch staff', '/payments?tab=reversals',
      () => sql<{ n: number }>`SELECT count(*)::int n FROM payment_reversals r JOIN payments x ON x.id = r.payment_id WHERE r.status = 'REQUESTED' AND r.requested_by <> ${me} ${br('x.branch_id')}`);
    add(p('expense.approve'), 'expenses-approve', 'Expenses to approve', 'Claims waiting at the branch', '/expenses',
      () => sql<{ n: number }>`SELECT count(*)::int n FROM expenses x WHERE x.status = 'SUBMITTED' AND x.submitted_by <> ${me} ${br('x.branch_id')}`);
    add(p('expense.post'), 'expenses-post', 'Expenses to post', 'Approved, not yet in the books', '/expenses',
      () => sql<{ n: number }>`SELECT count(*)::int n FROM expenses x WHERE x.status = 'APPROVED' AND x.submitted_by <> ${me} ${br('x.branch_id')}`);
    add(p('journal.approve'), 'journals', 'Manual journals to approve', 'Prepared by another accountant', '/journals',
      () => sql<{ n: number }>`SELECT count(*)::int n FROM manual_journals j WHERE j.status = 'PENDING' AND j.created_by <> ${me} ${ids ? sql`AND (j.branch_id IS NULL OR j.branch_id = ANY(${ids}::uuid[]))` : sql``}`);
    add(p('difference.approve'), 'differences', 'Cash differences to approve', 'Shortages and excesses explained at day end', '/reconciliation',
      () => sql<{ n: number }>`SELECT count(*)::int n FROM settlement_differences d JOIN employee_settlements s ON s.id = d.settlement_id WHERE d.status = 'PENDING' AND d.recorded_by <> ${me} ${br('s.branch_id')}`);
    add(p('day.reopen'), 'reopen', 'Day reopen requests', 'Closed business days someone wants reopened', '/reconciliation',
      () => sql<{ n: number }>`SELECT count(*)::int n FROM business_days d WHERE d.status = 'CLOSED' AND d.reopen_requested_by IS NOT NULL AND d.reopen_requested_by <> ${me} ${br('d.branch_id')}`);
    add(p('recon.match'), 'statement', 'Bank lines to match', 'Statement lines not matched or explained', '/reconciliation',
      () => sql<{ n: number }>`SELECT count(*)::int n FROM bank_statement_lines s JOIN accounts a ON a.id = s.account_id WHERE s.match_status IN ('UNMATCHED', 'SUGGESTED') ${ids ? sql`AND (a.branch_id IS NULL OR a.branch_id = ANY(${ids}::uuid[]))` : sql``}`, 'info');
    add(p('recovery.approve'), 'recovery', 'Recovery decisions', 'Stage moves and asset sales waiting for approval', '/recovery',
      () => sql<{ n: number }>`SELECT ((SELECT count(*) FROM recovery_cases rc WHERE rc.requested_stage IS NOT NULL AND rc.requested_by <> ${me} ${br('rc.branch_id')})
        + (SELECT count(*) FROM asset_sales s JOIN loans l ON l.id = s.loan_id WHERE s.status = 'PENDING' AND s.requested_by <> ${me} ${br('l.branch_id')}))::int n`);
    add(p('loan.write_off'), 'write-offs', 'Write-offs to decide', 'Loans proposed for write-off', '/recovery',
      () => sql<{ n: number }>`SELECT count(*)::int n FROM loan_write_offs w JOIN loans l ON l.id = w.loan_id WHERE w.status = 'PENDING' AND w.requested_by <> ${me} ${br('l.branch_id')}`);
    add(p('recovery.manage'), 'no-case', 'Overdue loans without a recovery case', 'Past due and not yet being worked as a case', '/recovery',
      () => sql<{ n: number }>`SELECT count(*)::int n FROM loans l WHERE l.status = 'ACTIVE' AND l.dpd > 30 AND NOT EXISTS (SELECT 1 FROM recovery_cases r WHERE r.loan_id = l.id AND r.status = 'OPEN') ${br('l.branch_id')}`, 'info');
    add(p('jobs.run') || p('audit.view'), 'integrity', 'Integrity check failed', 'The last ledger / audit integrity check found a problem — see the runbook', '/admin/system',
      () => sql<{ n: number }>`SELECT (CASE WHEN (SELECT ok FROM integrity_runs WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1) = false THEN 1 ELSE 0 END)::int n`);
    add(true, 'exports', 'Exports ready', 'Large reports prepared in the background', '/reports',
      () => sql<{ n: number }>`SELECT count(*)::int n FROM export_jobs j WHERE j.requested_by = ${me} AND j.status = 'DONE' AND j.finished_at > now() - interval '1 day'`, 'ok');

    const items = await Promise.all(defs.map(async ({ q, ...d }) => ({ ...d, count: (await q().execute(this.db)).rows[0]?.n ?? 0 })));
    return items.filter((i) => i.count > 0);
  }
}
