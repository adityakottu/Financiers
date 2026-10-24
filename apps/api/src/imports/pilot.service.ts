import { Inject, Injectable } from '@nestjs/common';
import { Money } from '@fin/money';
import { AuditService } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { istToday } from '../common/dates';
import { badRequest, conflict, notFound, unprocessable } from '../common/errors';
import { DB_TOKEN, Db } from '../db/db';
import { parseAmount } from '../reconciliation/statement-parser';
import { COLUMNS } from './columns';
import { readSheet, RowError } from './imports.service';

const METHODS = ['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'] as const;
interface LegacyRow {
  row: number;
  loanRef: string;
  amount: string;
  method: string;
  receiptNo: string | null;
  collector: string | null;
}
export type LineStatus = 'MATCHED' | 'AMOUNT_DIFFERS' | 'METHOD_DIFFERS' | 'ONLY_IN_OLD' | 'ONLY_IN_SYSTEM' | 'UNKNOWN_LOAN';

/**
 * Pilot parallel run (doc 15): the pilot branch keeps its old process for 2–4 weeks. Each day the
 * old day sheet (collections per loan) is uploaded and compared with what was recorded in the app,
 * loan by loan and method by method. A day is signed off when the two agree, or with a written
 * explanation of every difference. The comparison is frozen at sign-off.
 */
@Injectable()
export class PilotService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private assertBranch(auth: AuthContext, branchId: string) {
    if (!scope.canAccessBranch(auth, branchId)) throw notFound('Branch');
  }

  async upload(ctx: RequestContext, branchId: string, date: string, file: Express.Multer.File) {
    this.assertBranch(ctx.auth, branchId);
    if (date > istToday()) throw unprocessable('FUTURE_DATE', 'The date cannot be in the future');
    const parsed = await readSheet(file.buffer, file.originalname, COLUMNS.PARALLEL);
    if (parsed.problems.length) throw unprocessable('BAD_FILE', parsed.problems[0]!, parsed.problems.map((m) => ({ row: 1, field: null, message: m })));
    const errors: RowError[] = [];
    const rows: LegacyRow[] = [];
    for (const r of parsed.rows) {
      const x = r.raw;
      const amount = parseAmount(x.amount);
      const method = (x.method ?? '').toUpperCase().replace(/\s+/g, '_');
      if (!x.loanRef) errors.push({ row: r.row, field: 'loan_ref', message: 'Required' });
      if (amount === null || !x.amount || /^-/.test(x.amount) || !Money.of(amount).isPositive()) errors.push({ row: r.row, field: 'amount', message: 'A positive amount (rupees, up to 2 decimals)' });
      if (!(METHODS as readonly string[]).includes(method)) errors.push({ row: r.row, field: 'method', message: 'CASH, UPI, BANK_TRANSFER or CHEQUE' });
      rows.push({ row: r.row, loanRef: x.loanRef ?? '', amount: amount ?? '0.00', method, receiptNo: x.receiptNo || null, collector: x.collector || null });
    }
    // The day sheet is compared as a whole: a file with bad rows is refused, never half-loaded.
    if (errors.length) throw unprocessable('INVALID_ROWS', `${errors.length} problem(s) in the file — fix them and upload again`, errors);

    const id = await this.db.transaction().execute(async (tx) => {
      const existing = await tx.selectFrom('parallel_run_days').select(['id', 'signed_off_at']).where('branch_id', '=', branchId).where('business_date', '=', date).forUpdate().executeTakeFirst();
      if (existing?.signed_off_at) throw conflict('SIGNED_OFF', 'This day is already signed off');
      const values = { file_name: file.originalname.slice(0, 200), legacy_rows: JSON.stringify(rows), uploaded_by: ctx.auth.userId, uploaded_at: new Date() };
      const row = existing
        ? await tx.updateTable('parallel_run_days').set(values).where('id', '=', existing.id).returning('id').executeTakeFirstOrThrow()
        : await tx.insertInto('parallel_run_days').values({ branch_id: branchId, business_date: date, ...values }).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(tx, ctx, { action: 'pilot.day_uploaded', entityType: 'parallel_run_day', entityId: row.id, branchId, newValues: { date, rows: rows.length, file: file.originalname, replaced: !!existing } });
      return row.id;
    });
    return this.day(ctx.auth, id);
  }

  /** The comparison, computed live (or as frozen at sign-off). */
  async day(auth: AuthContext, id: string) {
    const d = await this.db
      .selectFrom('parallel_run_days as p')
      .innerJoin('branches as b', 'b.id', 'p.branch_id')
      .innerJoin('users as u', 'u.id', 'p.uploaded_by')
      .leftJoin('users as s', 's.id', 'p.signed_off_by')
      .select(['p.id', 'p.branch_id', 'b.code as branch_code', 'p.business_date', 'p.file_name', 'p.legacy_rows', 'p.uploaded_at', 'u.full_name as uploaded_by_name', 'p.signed_off_at', 's.full_name as signed_off_by_name', 'p.sign_off_note', 'p.result'])
      .where('p.id', '=', id)
      .executeTakeFirst();
    if (!d) throw notFound('Day');
    this.assertBranch(auth, d.branch_id);
    const comparison = d.result ? (d.result as unknown as Awaited<ReturnType<PilotService['compare']>>) : await this.compare(d.branch_id, d.business_date, d.legacy_rows as unknown as LegacyRow[]);
    const { legacy_rows: _rows, result: _result, ...rest } = d;
    return { ...rest, frozen: !!d.result, comparison };
  }

  async compare(branchId: string, date: string, legacy: LegacyRow[]) {
    // Resolve the old sheet's loan references: legacy number or the app's loan number, in this branch.
    const refs = [...new Set(legacy.map((r) => r.loanRef))];
    const loans = refs.length
      ? await this.db
          .selectFrom('loans as l')
          .innerJoin('customers as c', 'c.id', 'l.customer_id')
          .select(['l.id', 'l.loan_no', 'l.legacy_no', 'c.full_name'])
          .where('l.branch_id', '=', branchId)
          .where((eb) => eb.or([eb('l.legacy_no', 'in', refs), eb('l.loan_no', 'in', refs)]))
          .execute()
      : [];
    const byRef = new Map<string, (typeof loans)[number]>();
    for (const l of loans) {
      byRef.set(l.loan_no, l);
      if (l.legacy_no) byRef.set(l.legacy_no, l);
    }
    const system = await this.db
      .selectFrom('payments as p')
      .innerJoin('loans as l', 'l.id', 'p.loan_id')
      .innerJoin('customers as c', 'c.id', 'l.customer_id')
      .leftJoin('receipts as r', 'r.payment_id', 'p.id')
      .leftJoin('employees as e', 'e.id', 'p.collected_by')
      .select(['p.loan_id', 'p.amount', 'p.method', 'r.receipt_no', 'e.full_name as collector', 'l.loan_no', 'l.legacy_no', 'c.full_name'])
      .where('p.branch_id', '=', branchId)
      .where('p.business_date', '=', date)
      .where('p.status', '<>', 'REVERSED')
      .execute();

    interface Side { amount: Money; methods: Map<string, Money>; receipts: string[] }
    const empty = (): Side => ({ amount: Money.zero(), methods: new Map(), receipts: [] });
    const lines = new Map<string, { loanId: string | null; loanNo: string | null; legacyNo: string | null; customer: string | null; old: Side; app: Side; ref: string }>();
    const unknown: { row: number; loanRef: string; amount: string; method: string; receiptNo: string | null }[] = [];
    for (const r of legacy) {
      const l = byRef.get(r.loanRef);
      if (!l) {
        unknown.push({ row: r.row, loanRef: r.loanRef, amount: r.amount, method: r.method, receiptNo: r.receiptNo });
        continue;
      }
      const line = lines.get(l.id) ?? { loanId: l.id, loanNo: l.loan_no, legacyNo: l.legacy_no, customer: l.full_name, old: empty(), app: empty(), ref: r.loanRef };
      line.old.amount = line.old.amount.plus(Money.of(r.amount));
      line.old.methods.set(r.method, (line.old.methods.get(r.method) ?? Money.zero()).plus(Money.of(r.amount)));
      if (r.receiptNo) line.old.receipts.push(r.receiptNo);
      lines.set(l.id, line);
    }
    for (const p of system) {
      const line = lines.get(p.loan_id) ?? { loanId: p.loan_id, loanNo: p.loan_no, legacyNo: p.legacy_no, customer: p.full_name, old: empty(), app: empty(), ref: p.legacy_no ?? p.loan_no };
      line.app.amount = line.app.amount.plus(Money.of(p.amount));
      line.app.methods.set(p.method, (line.app.methods.get(p.method) ?? Money.zero()).plus(Money.of(p.amount)));
      if (p.receipt_no) line.app.receipts.push(p.receipt_no);
      lines.set(p.loan_id, line);
    }
    const sameMethods = (a: Map<string, Money>, b: Map<string, Money>) => a.size === b.size && [...a].every(([k, v]) => b.get(k)?.eq(v));
    const out = [...lines.values()].map((l) => {
      const status: LineStatus = l.old.amount.isZero()
        ? 'ONLY_IN_SYSTEM'
        : l.app.amount.isZero()
          ? 'ONLY_IN_OLD'
          : !l.old.amount.eq(l.app.amount)
            ? 'AMOUNT_DIFFERS'
            : !sameMethods(l.old.methods, l.app.methods)
              ? 'METHOD_DIFFERS'
              : 'MATCHED';
      return {
        loanId: l.loanId,
        loanNo: l.loanNo,
        legacyNo: l.legacyNo,
        customer: l.customer,
        oldAmount: l.old.amount.toString(),
        appAmount: l.app.amount.toString(),
        difference: l.app.amount.minus(l.old.amount).toString(),
        oldMethods: Object.fromEntries([...l.old.methods].map(([k, v]) => [k, v.toString()])),
        appMethods: Object.fromEntries([...l.app.methods].map(([k, v]) => [k, v.toString()])),
        oldReceipts: l.old.receipts,
        appReceipts: l.app.receipts,
        status,
      };
    });
    out.sort((a, b) => Number(a.status === 'MATCHED') - Number(b.status === 'MATCHED') || (a.loanNo ?? '').localeCompare(b.loanNo ?? ''));
    const byMethod = METHODS.map((m) => {
      const old = Money.sum(legacy.filter((r) => r.method === m).map((r) => Money.of(r.amount)));
      const app = Money.sum(system.filter((p) => p.method === m).map((p) => Money.of(p.amount)));
      return { method: m, old: old.toString(), app: app.toString(), difference: app.minus(old).toString() };
    });
    const oldTotal = Money.sum(legacy.map((r) => Money.of(r.amount)));
    const appTotal = Money.sum(system.map((p) => Money.of(p.amount)));
    const bd = await this.db.selectFrom('business_days').select(['status']).where('branch_id', '=', branchId).where('business_date', '=', date).executeTakeFirst();
    const differences = out.filter((l) => l.status !== 'MATCHED').length + unknown.length;
    return {
      summary: {
        oldTotal: oldTotal.toString(),
        appTotal: appTotal.toString(),
        difference: appTotal.minus(oldTotal).toString(),
        oldRows: legacy.length,
        appPayments: system.length,
        matched: out.filter((l) => l.status === 'MATCHED').length,
        differences,
        dayClosedInApp: bd?.status === 'CLOSED',
      },
      byMethod,
      lines: out,
      unknown,
    };
  }

  async signOff(ctx: RequestContext, id: string, note: string | undefined) {
    return this.db.transaction().execute(async (tx) => {
      const d = await tx.selectFrom('parallel_run_days').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d) throw notFound('Day');
      this.assertBranch(ctx.auth, d.branch_id);
      if (d.signed_off_at) throw conflict('SIGNED_OFF', 'This day is already signed off');
      const result = await this.compare(d.branch_id, d.business_date, d.legacy_rows as unknown as LegacyRow[]);
      if (result.summary.differences > 0 && (!note || note.trim().length < 10)) {
        throw badRequest('NOTE_REQUIRED', `${result.summary.differences} difference(s): explain each one in the note before signing off`);
      }
      if (!result.summary.dayClosedInApp) throw unprocessable('DAY_OPEN', 'Close this day in the app (Reconciliation → Day close) before signing off the comparison');
      await tx.updateTable('parallel_run_days').set({ signed_off_by: ctx.auth.userId, signed_off_at: new Date(), sign_off_note: note?.trim() || null, result: JSON.stringify(result) }).where('id', '=', id).execute();
      await this.audit.record(tx, ctx, {
        action: 'pilot.day_signed_off',
        entityType: 'parallel_run_day',
        entityId: id,
        branchId: d.branch_id,
        newValues: { date: d.business_date, ...result.summary, note: note?.trim() || null },
      });
      return { id, signedOff: true, summary: result.summary };
    });
  }

  /** Days of one branch with their summaries, and how close the branch is to the pilot exit (F1: 10+ clean days). */
  async list(auth: AuthContext, branchId: string) {
    this.assertBranch(auth, branchId);
    const days = await this.db
      .selectFrom('parallel_run_days as p')
      .leftJoin('users as s', 's.id', 'p.signed_off_by')
      .select(['p.id', 'p.business_date', 'p.file_name', 'p.legacy_rows', 'p.result', 'p.signed_off_at', 's.full_name as signed_off_by_name', 'p.sign_off_note'])
      .where('p.branch_id', '=', branchId)
      .orderBy('p.business_date', 'desc')
      .limit(60)
      .execute();
    const data = [];
    for (const d of days) {
      const c = d.result ? (d.result as unknown as Awaited<ReturnType<PilotService['compare']>>) : await this.compare(branchId, d.business_date, d.legacy_rows as unknown as LegacyRow[]);
      data.push({ id: d.id, date: d.business_date, fileName: d.file_name, signedOffAt: d.signed_off_at, signedOffBy: d.signed_off_by_name, note: d.sign_off_note, summary: c.summary });
    }
    const signed = data.filter((d) => d.signedOffAt);
    return {
      data,
      exit: {
        signedOffDays: signed.length,
        cleanDays: signed.filter((d) => d.summary.differences === 0).length,
        explainedDays: signed.filter((d) => d.summary.differences > 0).length,
        target: 10,
      },
    };
  }
}
