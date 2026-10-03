import { Inject, Injectable } from '@nestjs/common';
import { Money } from '@fin/money';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { scope } from '../auth/access.service';
import type { AuthContext } from '../auth/context';
import { DB_TOKEN, Db } from '../db/db';

const NONE = '00000000-0000-0000-0000-000000000000';

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  normal_balance: string;
  subtype: string | null;
  parent_id: string | null;
  is_postable: boolean;
  opening: string;
  debit: string;
  credit: string;
}

/** Natural-sign balance: positive when the account carries its normal balance. */
const natural = (normal: string, dr: Money, cr: Money) => (normal === 'DEBIT' ? dr.minus(cr) : cr.minus(dr));

/**
 * Books and statements derived only from journal lines (doc 07 §5): day book, cash & bank
 * summaries, trial balance, profit & loss and balance sheet. Branch-scoped users see their
 * branches' lines.
 */
@Injectable()
export class BooksService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  private branchFilter(auth: AuthContext, branchId?: string) {
    if (branchId) return scope.canAccessBranch(auth, branchId) ? [branchId] : [NONE];
    const b = scope.branchFilter(auth);
    return b ? (b.length ? b : [NONE]) : null;
  }

  /** Opening (before `from`), movements within [from, to], per postable account. */
  private async movements(auth: AuthContext, from: string | null, to: string, branchId?: string, subtypes?: string[]) {
    const branches = this.branchFilter(auth, branchId);
    const rows = await sql<AccountRow>`
      SELECT a.id, a.code, a.name, a.type, a.normal_balance, a.subtype, a.parent_id, a.is_postable,
        coalesce(sum(CASE WHEN ${from ? sql`e.value_date < ${from}::date` : sql`false`} THEN l.debit - l.credit END), 0)::text AS opening,
        coalesce(sum(CASE WHEN ${from ? sql`e.value_date >= ${from}::date AND` : sql``} e.value_date <= ${to}::date THEN l.debit END), 0)::text AS debit,
        coalesce(sum(CASE WHEN ${from ? sql`e.value_date >= ${from}::date AND` : sql``} e.value_date <= ${to}::date THEN l.credit END), 0)::text AS credit
      FROM accounts a
      LEFT JOIN journal_lines l ON l.account_id = a.id ${branches ? sql`AND l.branch_id = ANY(${branches}::uuid[])` : sql``}
      LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.value_date <= ${to}::date
      WHERE a.is_active AND a.is_postable ${subtypes ? sql`AND a.subtype = ANY(${subtypes}::text[])` : sql``}
      GROUP BY a.id ORDER BY a.code`.execute(this.db);
    return rows.rows;
  }

  /** Opening + receipts − payments = closing, per cash / bank account (doc 07 §5). */
  async accountSummaries(auth: AuthContext, from: string, to: string, branchId?: string) {
    const rows = await this.movements(auth, from, to, branchId, ['CASH', 'EMPLOYEE_CASH', 'BANK', 'UPI_CLEARING', 'CHEQUES_IN_HAND']);
    const data = rows.map((r) => {
      const opening = Money.of(r.opening);
      const closing = opening.plus(Money.of(r.debit)).minus(Money.of(r.credit));
      return { id: r.id, code: r.code, name: r.name, subtype: r.subtype, opening: opening.toString(), receipts: r.debit, payments: r.credit, closing: closing.toString() };
    });
    const sum = (k: 'opening' | 'receipts' | 'payments' | 'closing') => Money.sum(data.map((d) => Money.of(d[k]))).toString();
    return { from, to, data, totals: { opening: sum('opening'), receipts: sum('receipts'), payments: sum('payments'), closing: sum('closing') } };
  }

  /** Every entry for one value date, with its lines. */
  async dayBook(auth: AuthContext, date: string, branchId?: string) {
    const branches = this.branchFilter(auth, branchId);
    const entries = await this.db
      .selectFrom('journal_entries as e')
      .leftJoin('branches as b', 'b.id', 'e.branch_id')
      .select(['e.id', 'e.entry_no', 'e.entry_type', 'e.narration', 'e.posted_at', 'b.code as branch_code'])
      .where('e.value_date', '=', date)
      .$if(!!branches, (q) => q.where('e.branch_id', 'in', branches!))
      .orderBy('e.posted_at')
      .execute();
    const lines = entries.length
      ? await this.db
          .selectFrom('journal_lines as l')
          .innerJoin('accounts as a', 'a.id', 'l.account_id')
          .select(['l.entry_id', 'l.line_no', 'a.code', 'a.name', 'l.debit', 'l.credit', 'l.memo'])
          .where('l.entry_id', 'in', entries.map((e) => e.id))
          .orderBy('l.line_no')
          .execute()
      : [];
    const total = Money.sum(lines.map((l) => Money.of(l.debit))).toString();
    return { date, total, entries: entries.map((e) => ({ ...e, lines: lines.filter((l) => l.entry_id === e.id) })) };
  }

  async trialBalance(auth: AuthContext, asOf: string, branchId?: string) {
    const rows = await this.movements(auth, null, asOf, branchId);
    const data = rows
      .map((r) => {
        const net = Money.of(r.debit).minus(Money.of(r.credit));
        return { id: r.id, code: r.code, name: r.name, type: r.type, debit: net.isPositive() ? net.toString() : '0.00', credit: net.isNegative() ? Money.zero().minus(net).toString() : '0.00' };
      })
      .filter((r) => r.debit !== '0.00' || r.credit !== '0.00');
    const debit = Money.sum(data.map((d) => Money.of(d.debit)));
    const credit = Money.sum(data.map((d) => Money.of(d.credit)));
    return { asOf, data, totals: { debit: debit.toString(), credit: credit.toString(), balanced: debit.eq(credit) } };
  }

  async profitAndLoss(auth: AuthContext, from: string, to: string, branchId?: string) {
    const rows = (await this.movements(auth, from, to, branchId)).filter((r) => r.type === 'INCOME' || r.type === 'EXPENSE');
    const line = (r: AccountRow) => ({ id: r.id, code: r.code, name: r.name, amount: natural(r.normal_balance, Money.of(r.debit), Money.of(r.credit)).toString() });
    const income = rows.filter((r) => r.type === 'INCOME').map(line).filter((l) => l.amount !== '0.00');
    const expenses = rows.filter((r) => r.type === 'EXPENSE').map(line).filter((l) => l.amount !== '0.00');
    const ti = Money.sum(income.map((l) => Money.of(l.amount)));
    const te = Money.sum(expenses.map((l) => Money.of(l.amount)));
    return { from, to, income, expenses, totals: { income: ti.toString(), expenses: te.toString(), net: ti.minus(te).toString() } };
  }

  /**
   * Assets = Liabilities + Equity + profit not yet closed to retained earnings. The year-end
   * closing entry is prepared with your CA ⚖; until then current profit shows on its own line.
   */
  async balanceSheet(auth: AuthContext, asOf: string, branchId?: string) {
    const rows = await this.movements(auth, null, asOf, branchId);
    const bal = (r: AccountRow) => natural(r.normal_balance, Money.of(r.debit), Money.of(r.credit));
    const section = (type: string) => rows.filter((r) => r.type === type).map((r) => ({ id: r.id, code: r.code, name: r.name, amount: bal(r).toString() })).filter((l) => l.amount !== '0.00');
    const assets = section('ASSET');
    const liabilities = section('LIABILITY');
    const equity = section('EQUITY');
    const profit = Money.sum(rows.filter((r) => r.type === 'INCOME').map(bal)).minus(Money.sum(rows.filter((r) => r.type === 'EXPENSE').map(bal)));
    const ta = Money.sum(assets.map((a) => Money.of(a.amount)));
    const tl = Money.sum(liabilities.map((a) => Money.of(a.amount)));
    const te = Money.sum(equity.map((a) => Money.of(a.amount)));
    return {
      asOf,
      assets,
      liabilities,
      equity,
      profit: profit.toString(),
      totals: { assets: ta.toString(), liabilities: tl.toString(), equity: te.toString(), liabilitiesAndEquity: tl.plus(te).plus(profit).toString(), balanced: ta.eq(tl.plus(te).plus(profit)) },
    };
  }

  /* ---------------------------- Excel ---------------------------- */

  /** Company header, report name, filters, generated time, frozen header, Indian number format. */
  async xlsx(title: string, filters: string, columns: { header: string; key: string; width: number; money?: boolean }[], rows: Record<string, string | number | null>[], totals?: Record<string, string>) {
    const company = await this.db.selectFrom('companies').select(['legal_name', 'trade_name']).executeTakeFirst();
    const wb = new ExcelJS.Workbook();
    wb.creator = company?.trade_name ?? company?.legal_name ?? 'Financiers';
    const ws = wb.addWorksheet(title.slice(0, 31));
    ws.addRow([company?.trade_name ?? company?.legal_name ?? '']).font = { bold: true, size: 13 };
    ws.addRow([title]).font = { bold: true, size: 12 };
    ws.addRow([filters]);
    ws.addRow([`Generated ${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date())} IST`]).font = { color: { argb: 'FF666666' }, size: 9 };
    ws.addRow([]);
    const header = ws.addRow(columns.map((c) => c.header));
    header.font = { bold: true };
    header.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F5' } }));
    ws.views = [{ state: 'frozen', ySplit: 6 }];
    columns.forEach((c, i) => (ws.getColumn(i + 1).width = c.width));
    const fmt = '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00';
    const add = (r: Record<string, string | number | null>, bold = false) => {
      const row = ws.addRow(columns.map((c) => (c.money && r[c.key] !== null && r[c.key] !== undefined && r[c.key] !== '' ? Number(r[c.key]) : r[c.key] ?? '')));
      columns.forEach((c, i) => c.money && (row.getCell(i + 1).numFmt = fmt));
      if (bold) row.font = { bold: true };
    };
    rows.forEach((r) => add(r));
    if (totals) add(totals, true);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
