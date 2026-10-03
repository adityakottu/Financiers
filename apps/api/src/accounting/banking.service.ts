import { Inject, Injectable } from '@nestjs/common';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { istToday } from '../common/dates';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { DB_TOKEN, Db, Executor } from '../db/db';
import { LedgerService } from '../ledger/ledger.service';
import { NumberingService } from '../numbering/numbering.service';

const CASHLIKE = ['CASH', 'EMPLOYEE_CASH'];

/** Balance of one account from the journal (debit-positive for asset accounts). */
export async function accountBalance(db: Executor, accountId: string, asOf?: string): Promise<Money> {
  const r = await sql<{ bal: string }>`
    SELECT coalesce(sum(l.debit - l.credit), 0)::text bal FROM journal_lines l
    ${asOf ? sql`JOIN journal_entries e ON e.id = l.entry_id AND e.value_date <= ${asOf}::date` : sql``}
    WHERE l.account_id = ${accountId}`.execute(db);
  return Money.of(r.rows[0]!.bal);
}

/**
 * Cash & bank movements (doc 07 E6): collector cash or branch cash paid into the bank or the
 * branch safe. Cash accounts can never go below zero: you cannot deposit cash you do not hold.
 */
@Injectable()
export class BankingService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  /** Cash, collector cash, bank, UPI clearing and cheques-in-hand accounts in scope, with balances. */
  async accounts(auth: AuthContext) {
    const branches = scope.branchFilter(auth);
    const rows = await sql<{ id: string; code: string; name: string; subtype: string; branch_id: string | null; branch_code: string | null; employee_id: string | null; balance: string; bank_name: string | null; account_no_last4: string | null }>`
      SELECT a.id, a.code, a.name, a.subtype, a.branch_id, b.code branch_code, a.employee_id,
             coalesce((SELECT sum(l.debit - l.credit) FROM journal_lines l WHERE l.account_id = a.id), 0)::text balance,
             ba.bank_name, ba.account_no_last4
      FROM accounts a
      LEFT JOIN branches b ON b.id = a.branch_id
      LEFT JOIN bank_accounts ba ON ba.account_id = a.id
      WHERE a.is_active AND a.subtype IN ('CASH', 'EMPLOYEE_CASH', 'BANK', 'UPI_CLEARING', 'CHEQUES_IN_HAND')
        ${branches ? sql`AND (a.branch_id = ANY(${branches.length ? branches : ['00000000-0000-0000-0000-000000000000']}::uuid[]) OR a.subtype = 'BANK')` : sql``}
      ORDER BY a.code`.execute(this.db);
    return rows.rows;
  }

  async recordDeposit(ctx: RequestContext, input: { fromAccountId: string; toAccountId: string; amount: string; depositedOn: string; slipNo?: string; notes?: string }) {
    if (input.depositedOn > istToday()) throw unprocessable('FUTURE_DATE', 'The deposit date cannot be in the future');
    return this.db.transaction().execute(async (tx) => {
      const [from, to] = await Promise.all(
        [input.fromAccountId, input.toAccountId].map((id) =>
          tx.selectFrom('accounts').select(['id', 'code', 'name', 'subtype', 'branch_id', 'employee_id', 'is_active']).where('id', '=', id).forUpdate().executeTakeFirst(),
        ),
      );
      if (!from?.is_active || !CASHLIKE.includes(from.subtype ?? '')) throw unprocessable('ACCOUNT_MISMATCH', 'Deposits come from a cash account (branch cash or a collector’s cash in hand)');
      if (!to?.is_active || !['BANK', 'CASH'].includes(to.subtype ?? '')) throw unprocessable('ACCOUNT_MISMATCH', 'Deposits go into a bank account or the branch cash safe');
      if (!from.branch_id || !scope.canAccessBranch(ctx.auth, from.branch_id)) throw notFound('Account');
      if (to.subtype === 'CASH' && to.branch_id !== from.branch_id) throw unprocessable('BRANCH_MISMATCH', 'Cash can only be handed over within the same branch');
      const amount = Money.of(input.amount);
      const held = await accountBalance(tx, from.id);
      if (amount.gt(held)) throw unprocessable('INSUFFICIENT_CASH', `${from.name} holds ₹${held.format({ symbol: false })}; you cannot deposit more than that`, { available: held.toString() });
      const no = await this.numbering.next(tx, 'DEPOSIT');
      const dep = await tx
        .insertInto('cash_deposits')
        .values({
          deposit_no: no,
          branch_id: from.branch_id,
          employee_id: from.employee_id,
          from_account_id: from.id,
          to_account_id: to.id,
          amount: amount.toString(),
          deposited_on: input.depositedOn,
          slip_no: input.slipNo ?? null,
          notes: input.notes ?? null,
          recorded_by: ctx.auth.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const entry = await this.ledger.post(tx, {
        entryType: 'DEPOSIT',
        valueDate: input.depositedOn,
        branchId: from.branch_id,
        sourceType: 'cash_deposit',
        sourceId: dep.id,
        narration: `${to.subtype === 'BANK' ? 'Cash deposited to bank' : 'Cash handed over to branch'} ${no}${input.slipNo ? ` (slip ${input.slipNo})` : ''}`,
        lines: [
          { account: to.id, debit: amount, memo: input.slipNo ? `Slip ${input.slipNo}` : no },
          { account: from.id, credit: amount, employeeId: from.employee_id, memo: no },
        ],
        createdBy: ctx.auth.userId,
      });
      await tx.updateTable('cash_deposits').set({ journal_entry_id: entry.id }).where('id', '=', dep.id).execute();
      await this.audit.record(tx, ctx, {
        action: 'deposit.recorded',
        entityType: 'cash_deposit',
        entityId: dep.id,
        branchId: from.branch_id,
        newValues: { depositNo: no, from: from.code, to: to.code, amount: amount.toString(), date: input.depositedOn, slip: input.slipNo ?? null, journal: entry.entryNo },
      });
      return { id: dep.id, depositNo: no, journalEntryNo: entry.entryNo };
    });
  }

  async reverseDeposit(ctx: RequestContext, id: string, reason: string) {
    return this.db.transaction().execute(async (tx) => {
      const d = await tx.selectFrom('cash_deposits').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d || !scope.canAccessBranch(ctx.auth, d.branch_id)) throw notFound('Deposit');
      if (d.status !== 'RECORDED') throw conflict('INVALID_STATE', 'This deposit is already reversed');
      if (d.recorded_by === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'You recorded this deposit, so someone else must reverse it');
      const rev = await this.ledger.reverse(tx, d.journal_entry_id!, { valueDate: istToday(), narration: `Reversal of deposit ${d.deposit_no} — ${reason}`.slice(0, 500), createdBy: ctx.auth.userId, sourceType: 'cash_deposit', sourceId: id });
      await tx.updateTable('cash_deposits').set({ status: 'REVERSED', reversed_by: ctx.auth.userId, reversed_at: new Date(), reverse_reason: reason, reversal_journal_entry_id: rev.id }).where('id', '=', id).execute();
      await this.audit.record(tx, ctx, { action: 'deposit.reversed', entityType: 'cash_deposit', entityId: id, branchId: d.branch_id, oldValues: { status: 'RECORDED' }, newValues: { status: 'REVERSED', reason, journal: rev.entryNo } });
      return { id, status: 'REVERSED' };
    });
  }

  async deposits(auth: AuthContext, q: { from?: string; to?: string; limit: number }) {
    const branches = scope.branchFilter(auth);
    let sel = this.db
      .selectFrom('cash_deposits as d')
      .innerJoin('accounts as f', 'f.id', 'd.from_account_id')
      .innerJoin('accounts as t', 't.id', 'd.to_account_id')
      .innerJoin('users as u', 'u.id', 'd.recorded_by')
      .innerJoin('branches as b', 'b.id', 'd.branch_id')
      .select([
        'd.id', 'd.deposit_no', 'd.amount', 'd.deposited_on', 'd.slip_no', 'd.notes', 'd.status', 'd.recorded_at', 'd.recorded_by', 'd.reverse_reason',
        'f.code as from_code', 'f.name as from_name', 't.code as to_code', 't.name as to_name', 'u.full_name as recorded_by_name', 'b.code as branch_code',
      ])
      .orderBy('d.recorded_at', 'desc')
      .limit(q.limit);
    if (branches) sel = sel.where('d.branch_id', 'in', branches.length ? branches : ['00000000-0000-0000-0000-000000000000']);
    if (q.from) sel = sel.where('d.deposited_on', '>=', q.from);
    if (q.to) sel = sel.where('d.deposited_on', '<=', q.to);
    return (await sel.execute()).map((d) => ({ ...d, canReverse: d.status === 'RECORDED' && d.recorded_by !== auth.userId && auth.permissions.has('deposit.record') }));
  }
}
