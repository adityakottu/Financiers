import { Inject, Injectable } from '@nestjs/common';
import { Money } from '@fin/money';
import { AuditService } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { istToday } from '../common/dates';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { DB_TOKEN, Db, Tx } from '../db/db';
import { LedgerService } from '../ledger/ledger.service';
import { NumberingService } from '../numbering/numbering.service';
import { accountBalance } from './banking.service';

const NONE = '00000000-0000-0000-0000-000000000000';

export interface ExpenseInput {
  branchId: string;
  categoryId: string;
  amount: string;
  expenseDate: string;
  paidFrom: 'EMPLOYEE_CASH' | 'BRANCH_CASH' | 'BANK';
  accountId?: string;
  vendor?: string;
  billNo?: string;
  description: string;
}

/**
 * Expenses (doc 07 E9): submitted → approved at the branch → posted by an accountant. Whoever
 * submitted can neither approve nor post (DB CHECK + API). Posting is the only moment the books
 * change; a posted expense is corrected by reversal, never edited.
 */
@Injectable()
export class ExpensesService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  categories() {
    return this.db
      .selectFrom('expense_categories as c')
      .innerJoin('accounts as a', 'a.id', 'c.account_id')
      .select(['c.id', 'c.name', 'c.requires_bill', 'c.is_active', 'a.code as account_code', 'a.name as account_name'])
      .where('c.is_active', '=', true)
      .orderBy('c.name')
      .execute();
  }

  private async lock(tx: Tx, auth: AuthContext, id: string) {
    const e = await tx.selectFrom('expenses').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!e || !this.visible(auth, e)) throw notFound('Expense');
    return e;
  }

  private visible(auth: AuthContext, e: { branch_id: string; submitted_by: string }) {
    if (!auth.permissions.has('expense.view')) return e.submitted_by === auth.userId;
    return scope.canAccessBranch(auth, e.branch_id) || e.submitted_by === auth.userId;
  }

  async create(ctx: RequestContext, input: ExpenseInput) {
    // Collectors (assigned-loan scope) claim only their own cash, in their own branch (checked below).
    if (ctx.auth.scope === 'ASSIGNED') {
      if (input.paidFrom !== 'EMPLOYEE_CASH') throw forbidden('FORBIDDEN', 'Collectors can only claim expenses paid from their own cash in hand');
    } else scope.assertBranchWritable(ctx.auth, input.branchId);
    if (input.expenseDate > istToday()) throw unprocessable('FUTURE_DATE', 'The expense date cannot be in the future');
    return this.db.transaction().execute(async (tx) => {
      const branch = await tx.selectFrom('branches').select(['id', 'code', 'name']).where('id', '=', input.branchId).executeTakeFirst();
      if (!branch) throw notFound('Branch');
      const cat = await tx.selectFrom('expense_categories').select(['id', 'name', 'is_active']).where('id', '=', input.categoryId).executeTakeFirst();
      if (!cat?.is_active) throw unprocessable('VALIDATION_FAILED', 'Choose an expense category');
      let accountId: string;
      let employeeId: string | null = null;
      if (input.paidFrom === 'EMPLOYEE_CASH') {
        if (!ctx.auth.employeeId) throw unprocessable('NOT_AN_EMPLOYEE', 'Your sign-in is not linked to an employee, so you have no cash in hand to pay from');
        const emp = await tx.selectFrom('employees').select('branch_id').where('id', '=', ctx.auth.employeeId).executeTakeFirstOrThrow();
        if (emp.branch_id !== input.branchId) throw unprocessable('BRANCH_MISMATCH', 'Claim the expense in your own branch');
        employeeId = ctx.auth.employeeId;
        accountId = (await this.ledger.employeeCashAccount(tx, employeeId)).id;
      } else if (input.paidFrom === 'BRANCH_CASH') {
        await this.ledger.ensureBranchAccounts(tx, branch);
        accountId = (await tx.selectFrom('accounts').select('id').where('code', '=', `1110-${branch.code}`).executeTakeFirstOrThrow()).id;
      } else {
        const a = await tx.selectFrom('accounts').select('id').where('id', '=', input.accountId!).where('subtype', '=', 'BANK').where('is_active', '=', true).executeTakeFirst();
        if (!a) throw unprocessable('ACCOUNT_MISMATCH', 'Choose one of the company bank accounts');
        accountId = a.id;
      }
      const no = await this.numbering.next(tx, 'EXPENSE');
      const row = await tx
        .insertInto('expenses')
        .values({
          expense_no: no,
          branch_id: input.branchId,
          employee_id: employeeId,
          category_id: input.categoryId,
          amount: Money.of(input.amount).toString(),
          expense_date: input.expenseDate,
          paid_from: input.paidFrom,
          paid_from_account_id: accountId,
          vendor: input.vendor ?? null,
          bill_no: input.billNo ?? null,
          description: input.description,
          submitted_by: ctx.auth.userId,
        })
        .returning(['id', 'expense_no', 'status'])
        .executeTakeFirstOrThrow();
      await this.audit.record(tx, ctx, {
        action: 'expense.submitted',
        entityType: 'expense',
        entityId: row.id,
        branchId: input.branchId,
        newValues: { expenseNo: no, category: cat.name, amount: input.amount, paidFrom: input.paidFrom, date: input.expenseDate },
      });
      return row;
    });
  }

  async approve(ctx: RequestContext, id: string) {
    return this.db.transaction().execute(async (tx) => {
      const e = await this.lock(tx, ctx.auth, id);
      if (!scope.canAccessBranch(ctx.auth, e.branch_id)) throw notFound('Expense');
      if (e.status !== 'SUBMITTED') throw conflict('INVALID_STATE', `This expense is ${e.status.toLowerCase()}`);
      if (e.submitted_by === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'You submitted this expense, so someone else must approve it');
      await tx.updateTable('expenses').set({ status: 'APPROVED', approved_by: ctx.auth.userId, approved_at: new Date() }).where('id', '=', id).execute();
      await this.audit.record(tx, ctx, { action: 'expense.approved', entityType: 'expense', entityId: id, branchId: e.branch_id, oldValues: { status: e.status }, newValues: { status: 'APPROVED' } });
      return { id, status: 'APPROVED' };
    });
  }

  async post(ctx: RequestContext, id: string) {
    return this.db.transaction().execute(async (tx) => {
      const e = await this.lock(tx, ctx.auth, id);
      if (!scope.canAccessBranch(ctx.auth, e.branch_id)) throw notFound('Expense');
      if (e.status !== 'APPROVED') throw conflict('INVALID_STATE', e.status === 'SUBMITTED' ? 'The expense must be approved at the branch first' : `This expense is ${e.status.toLowerCase()}`);
      if (e.submitted_by === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'You submitted this expense, so someone else must post it');
      const cat = await tx.selectFrom('expense_categories').select(['name', 'account_id']).where('id', '=', e.category_id).executeTakeFirstOrThrow();
      const amount = Money.of(e.amount);
      if (e.paid_from === 'BRANCH_CASH') {
        // Branch cash can't go below zero: you cannot pay out cash the branch does not hold.
        await tx.selectFrom('accounts').select('id').where('id', '=', e.paid_from_account_id).forUpdate().execute();
        const held = await accountBalance(tx, e.paid_from_account_id);
        if (amount.gt(held)) throw unprocessable('INSUFFICIENT_CASH', `Branch cash holds ₹${held.format({ symbol: false })}; record the cash coming in first (deposit / hand-over), or pay from a bank account`, { available: held.toString() });
      }
      const entry = await this.ledger.post(tx, {
        entryType: 'EXPENSE',
        valueDate: e.expense_date,
        branchId: e.branch_id,
        sourceType: 'expense',
        sourceId: id,
        narration: `Expense ${e.expense_no}: ${cat.name} — ${e.description}`.slice(0, 500),
        lines: [
          { account: cat.account_id, debit: amount, employeeId: e.employee_id, memo: [e.vendor, e.bill_no && `bill ${e.bill_no}`].filter(Boolean).join(', ') || cat.name },
          { account: e.paid_from_account_id, credit: amount, employeeId: e.employee_id, memo: `Paid: ${e.expense_no}` },
        ],
        createdBy: ctx.auth.userId,
        approvedBy: e.approved_by,
      });
      await tx.updateTable('expenses').set({ status: 'POSTED', posted_by: ctx.auth.userId, posted_at: new Date(), journal_entry_id: entry.id }).where('id', '=', id).execute();
      await this.audit.record(tx, ctx, { action: 'expense.posted', entityType: 'expense', entityId: id, branchId: e.branch_id, oldValues: { status: 'APPROVED' }, newValues: { status: 'POSTED', journal: entry.entryNo } });
      return { id, status: 'POSTED', journalEntryNo: entry.entryNo };
    });
  }

  async reject(ctx: RequestContext, id: string, reason: string) {
    return this.db.transaction().execute(async (tx) => {
      const e = await this.lock(tx, ctx.auth, id);
      if (!scope.canAccessBranch(ctx.auth, e.branch_id)) throw notFound('Expense');
      if (!['SUBMITTED', 'APPROVED'].includes(e.status)) throw conflict('INVALID_STATE', `This expense is ${e.status.toLowerCase()}`);
      if (e.status === 'APPROVED' && !ctx.auth.permissions.has('expense.post')) throw forbidden();
      await tx.updateTable('expenses').set({ status: 'REJECTED', rejected_by: ctx.auth.userId, rejected_at: new Date(), reject_reason: reason }).where('id', '=', id).execute();
      await this.audit.record(tx, ctx, { action: 'expense.rejected', entityType: 'expense', entityId: id, branchId: e.branch_id, oldValues: { status: e.status }, newValues: { status: 'REJECTED', reason } });
      return { id, status: 'REJECTED' };
    });
  }

  async reverse(ctx: RequestContext, id: string, reason: string) {
    return this.db.transaction().execute(async (tx) => {
      const e = await this.lock(tx, ctx.auth, id);
      if (!scope.canAccessBranch(ctx.auth, e.branch_id)) throw notFound('Expense');
      if (e.status !== 'POSTED') throw conflict('INVALID_STATE', 'Only posted expenses can be reversed');
      if (e.submitted_by === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'You submitted this expense, so someone else must reverse it');
      const rev = await this.ledger.reverse(tx, e.journal_entry_id!, {
        valueDate: istToday(),
        narration: `Reversal of expense ${e.expense_no} — ${reason}`.slice(0, 500),
        createdBy: ctx.auth.userId,
        sourceType: 'expense',
        sourceId: id,
      });
      await tx
        .updateTable('expenses')
        .set({ status: 'REVERSED', reversed_by: ctx.auth.userId, reversed_at: new Date(), reverse_reason: reason, reversal_journal_entry_id: rev.id })
        .where('id', '=', id)
        .execute();
      await this.audit.record(tx, ctx, { action: 'expense.reversed', entityType: 'expense', entityId: id, branchId: e.branch_id, oldValues: { status: 'POSTED' }, newValues: { status: 'REVERSED', reason, journal: rev.entryNo } });
      return { id, status: 'REVERSED', journalEntryNo: rev.entryNo };
    });
  }

  async attachBill(ctx: RequestContext, id: string, fileId: string) {
    return this.db.transaction().execute(async (tx) => {
      const e = await this.lock(tx, ctx.auth, id);
      if (e.submitted_by !== ctx.auth.userId && !scope.canAccessBranch(ctx.auth, e.branch_id)) throw notFound('Expense');
      if (!['SUBMITTED', 'APPROVED'].includes(e.status)) throw conflict('INVALID_STATE', 'Bills can be attached until the expense is posted');
      await tx.updateTable('expenses').set({ file_id: fileId }).where('id', '=', id).execute();
      await this.audit.record(tx, ctx, { action: 'expense.bill_attached', entityType: 'expense', entityId: id, branchId: e.branch_id, newValues: { fileId } });
    });
  }

  async list(auth: AuthContext, q: { status?: string; branchId?: string; from?: string; to?: string; mine?: boolean; limit: number }) {
    let sel = this.db
      .selectFrom('expenses as e')
      .innerJoin('expense_categories as c', 'c.id', 'e.category_id')
      .innerJoin('branches as b', 'b.id', 'e.branch_id')
      .innerJoin('users as u', 'u.id', 'e.submitted_by')
      .select([
        'e.id', 'e.expense_no', 'e.amount', 'e.expense_date', 'e.status', 'e.paid_from', 'e.vendor', 'e.bill_no', 'e.description', 'e.submitted_by', 'e.submitted_at', 'e.file_id',
        'c.name as category', 'c.requires_bill', 'b.code as branch_code', 'u.full_name as submitted_by_name',
      ])
      .orderBy('e.submitted_at', 'desc')
      .limit(q.limit);
    const branches = scope.branchFilter(auth);
    if (q.mine || !auth.permissions.has('expense.view')) sel = sel.where('e.submitted_by', '=', auth.userId);
    else if (branches) sel = sel.where((eb) => eb.or([eb('e.branch_id', 'in', branches.length ? branches : [NONE]), eb('e.submitted_by', '=', auth.userId)]));
    if (q.status) sel = sel.where('e.status', '=', q.status);
    if (q.branchId) sel = sel.where('e.branch_id', '=', q.branchId);
    if (q.from) sel = sel.where('e.expense_date', '>=', q.from);
    if (q.to) sel = sel.where('e.expense_date', '<=', q.to);
    const rows = await sel.execute();
    return rows.map((r) => ({
      ...r,
      canApprove: r.status === 'SUBMITTED' && r.submitted_by !== auth.userId && auth.permissions.has('expense.approve'),
      canPost: r.status === 'APPROVED' && r.submitted_by !== auth.userId && auth.permissions.has('expense.post'),
    }));
  }

  async get(auth: AuthContext, id: string) {
    const e = await this.db
      .selectFrom('expenses as e')
      .innerJoin('expense_categories as c', 'c.id', 'e.category_id')
      .innerJoin('accounts as a', 'a.id', 'e.paid_from_account_id')
      .innerJoin('branches as b', 'b.id', 'e.branch_id')
      .selectAll('e')
      .select(['c.name as category', 'c.requires_bill', 'a.code as account_code', 'a.name as account_name', 'b.code as branch_code', 'b.name as branch_name'])
      .where('e.id', '=', id)
      .executeTakeFirst();
    if (!e || !this.visible(auth, e)) throw notFound('Expense');
    const ids = [e.submitted_by, e.approved_by, e.posted_by, e.rejected_by, e.reversed_by].filter((x): x is string => !!x);
    const users = await this.db.selectFrom('users').select(['id', 'full_name']).where('id', 'in', ids).execute();
    const name = (u: string | null) => users.find((x) => x.id === u)?.full_name ?? null;
    return {
      ...e,
      people: { submittedBy: name(e.submitted_by), approvedBy: name(e.approved_by), postedBy: name(e.posted_by), rejectedBy: name(e.rejected_by), reversedBy: name(e.reversed_by) },
      canApprove: e.status === 'SUBMITTED' && e.submitted_by !== auth.userId && auth.permissions.has('expense.approve') && scope.canAccessBranch(auth, e.branch_id),
      canPost: e.status === 'APPROVED' && e.submitted_by !== auth.userId && auth.permissions.has('expense.post') && scope.canAccessBranch(auth, e.branch_id),
      canReverse: e.status === 'POSTED' && e.submitted_by !== auth.userId && auth.permissions.has('expense.post') && scope.canAccessBranch(auth, e.branch_id),
    };
  }
}
