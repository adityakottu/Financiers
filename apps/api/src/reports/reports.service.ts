import { Inject, Injectable, Logger } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { BooksService } from '../accounting/books.service';
import { AuditService } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { istToday } from '../common/dates';
import { forbidden, notFound, parse, unprocessable } from '../common/errors';
import { DB_TOKEN, Db } from '../db/db';
import { REPORT_BY_NAME, REPORTS } from './catalogue';
import { RenderMeta, toPdf, toXlsx, totalsRow } from './render';
import { Filters, filtersSchema, NONE, ReportDef, ReportResult, RunContext } from './types';

export type ExportFormat = 'xlsx' | 'pdf';
const FILTER_LABELS: Partial<Record<keyof Filters, string>> = { category: 'Category', method: 'Method', status: 'Status', bucket: 'DPD', range: 'Due' };
const dmy = (d: string) => d.split('-').reverse().join('/');

/**
 * Named reports (doc 10) over one engine: scoped to the user's branches (collectors: their own
 * work), filters remembered per user, every export audited. Large exports run as background jobs.
 */
@Injectable()
export class ReportsService {
  private readonly log = new Logger('Reports');
  /** Exports above this many rows run in the background (doc 10: > 10k rows → job). */
  static syncRowLimit = 10_000;
  private running = new Set<Promise<void>>();

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly books: BooksService,
    private readonly audit: AuditService,
  ) {}

  private def(auth: AuthContext, name: string): ReportDef {
    const d = REPORT_BY_NAME.get(name);
    if (!d) throw notFound('Report');
    if (!auth.permissions.has(d.permission)) throw forbidden('FORBIDDEN', 'You do not have access to this report');
    return d;
  }

  async catalogue(auth: AuthContext) {
    const saved = await this.db.selectFrom('report_preferences').select(['report', 'filters']).where('user_id', '=', auth.userId).execute();
    const prefs = new Map(saved.map((s) => [s.report, s.filters as Filters]));
    const today = istToday();
    return {
      canExport: auth.permissions.has('export.data'),
      canCaPack: auth.permissions.has('report.accounting') && auth.permissions.has('export.data'),
      reports: REPORTS.filter((r) => auth.permissions.has(r.permission)).map((r) => ({
        name: r.name,
        title: r.title,
        group: r.group,
        description: r.description,
        filters: r.filters,
        required: r.required ?? [],
        defaults: r.defaults?.(today) ?? {},
        saved: prefs.get(r.name) ?? null,
      })),
    };
  }

  /** Validated filters with defaults applied, limited to the ones the report takes. */
  resolve(d: ReportDef, raw: unknown): Filters {
    const input = parse(filtersSchema, raw ?? {});
    const f: Filters = { ...(d.defaults?.(istToday()) ?? {}) };
    for (const k of d.filters) if (input[k] !== undefined) (f as Record<string, unknown>)[k] = input[k];
    for (const k of d.required ?? []) if (!f[k]) throw unprocessable('FILTER_REQUIRED', `Choose ${k === 'accountId' ? 'an account' : k}`, { field: k });
    if (f.from && f.to && f.from > f.to) throw unprocessable('BAD_RANGE', 'The start date is after the end date');
    if (f.from && f.to && (Date.parse(f.to) - Date.parse(f.from)) / 86_400_000 > 3660) throw unprocessable('BAD_RANGE', 'Choose a range of at most ten years');
    return f;
  }

  private context(auth: AuthContext, f: Filters): RunContext {
    const own = auth.scope === 'ASSIGNED';
    let branches: string[] | null;
    if (own) branches = null; // collectors are limited by their own employee id instead
    else if (f.branchId) branches = scope.canAccessBranch(auth, f.branchId) ? [f.branchId] : [NONE];
    else {
      const b = scope.branchFilter(auth);
      branches = b ? (b.length ? b : [NONE]) : null;
    }
    return { db: this.db, books: this.books, auth, today: istToday(), branches, ownEmployeeId: own ? (auth.employeeId ?? NONE) : null };
  }

  async run(ctx: RequestContext, name: string, raw: unknown, remember = true) {
    const d = this.def(ctx.auth, name);
    const f = this.resolve(d, raw);
    const result = await d.run(this.context(ctx.auth, f), f);
    if (remember) {
      const stored = JSON.stringify(Object.fromEntries(Object.entries(f).filter(([k]) => !['from', 'to', 'asOf'].includes(k) || (raw as Record<string, unknown>)?.[k])));
      await this.db
        .insertInto('report_preferences')
        .values({ user_id: ctx.auth.userId, report: name, filters: stored })
        .onConflict((oc) => oc.columns(['user_id', 'report']).doUpdateSet({ filters: stored, updated_at: new Date() }))
        .execute();
    }
    return { report: { name: d.name, title: d.title, group: d.group, description: d.description }, filters: f, ...result, totals: totalsRow(result) };
  }

  /**
   * Internal: a report's result for dashboards, scoped like the user but without the per-report
   * permission check (the dashboard permission already applies) and without remembering filters.
   */
  async compute(auth: AuthContext, name: string, raw: Partial<Filters>) {
    const d = REPORT_BY_NAME.get(name)!;
    const f = this.resolve(d, raw);
    const r = await d.run(this.context(auth, f), f);
    return { ...r, totals: totalsRow(r) };
  }

  private async meta(auth: AuthContext, d: ReportDef, f: Filters): Promise<RenderMeta> {
    const company = await this.db.selectFrom('companies').select(['legal_name', 'trade_name']).executeTakeFirst();
    const user = await this.db.selectFrom('users').select('full_name').where('id', '=', auth.userId).executeTakeFirst();
    const parts: string[] = [];
    if (f.from && f.to) parts.push(`${dmy(f.from)} to ${dmy(f.to)}`);
    if (f.asOf) parts.push(d.name === 'day-book' ? dmy(f.asOf) : `As of ${dmy(f.asOf)}`);
    if (f.branchId) parts.push(`Branch: ${(await this.db.selectFrom('branches').select('code').where('id', '=', f.branchId).executeTakeFirst())?.code ?? '—'}`);
    else if (auth.scope === 'ASSIGNED') parts.push('My collections');
    else parts.push(auth.scope === 'ALL' ? 'All branches' : 'My branches');
    if (f.employeeId) parts.push(`Employee: ${(await this.db.selectFrom('employees').select('full_name').where('id', '=', f.employeeId).executeTakeFirst())?.full_name ?? '—'}`);
    if (f.accountId) parts.push(`Account: ${(await this.db.selectFrom('accounts').select(['code', 'name']).where('id', '=', f.accountId).executeTakeFirst())?.name ?? '—'}`);
    for (const [k, label] of Object.entries(FILTER_LABELS)) if (f[k as keyof Filters]) parts.push(`${label}: ${f[k as keyof Filters]}`);
    return { company: company?.trade_name ?? company?.legal_name ?? 'Financiers', title: d.title, filters: parts.join(' · '), generatedAt: new Date(), generatedBy: user?.full_name ?? '' };
  }

  private async render(format: ExportFormat, meta: RenderMeta, r: ReportResult) {
    return format === 'pdf' ? toPdf(meta, r) : Buffer.from(await (await toXlsx(meta, r)).xlsx.writeBuffer());
  }

  fileName(name: string, f: Filters, format: ExportFormat) {
    const stamp = f.from && f.to ? `${f.from}_${f.to}` : (f.asOf ?? istToday());
    return `${name}-${stamp}.${format}`;
  }

  /** A file now, or a background job when the report is large. Audited either way (doc 05). */
  async export(ctx: RequestContext, name: string, format: ExportFormat, raw: unknown): Promise<{ file: Buffer; fileName: string } | { jobId: string }> {
    if (!ctx.auth.permissions.has('export.data')) throw forbidden('FORBIDDEN', 'You cannot download reports');
    const d = this.def(ctx.auth, name);
    const f = this.resolve(d, raw);
    const result = await d.run(this.context(ctx.auth, f), f);
    if (result.rows.length > ReportsService.syncRowLimit) {
      const job = await this.db.insertInto('export_jobs').values({ report: name, format, filters: JSON.stringify(f), requested_by: ctx.auth.userId }).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(this.db, ctx, { action: 'report.export_queued', entityType: 'export_job', entityId: job.id, newValues: { report: name, format, filters: f, rows: result.rows.length } });
      this.track(this.process(job.id, ctx.auth));
      return { jobId: job.id };
    }
    const file = await this.render(format, await this.meta(ctx.auth, d, f), result);
    await this.audit.record(this.db, ctx, { action: 'report.exported', entityType: 'report', entityId: name, newValues: { format, filters: f, rows: result.rows.length } });
    return { file, fileName: this.fileName(name, f, format) };
  }

  private track(p: Promise<void>) {
    this.running.add(p);
    void p.finally(() => this.running.delete(p));
  }

  /** Wait for background exports (tests, graceful shutdown). */
  async drain() {
    await Promise.all([...this.running]);
  }

  private async process(id: string, auth: AuthContext) {
    try {
      const job = await this.db.updateTable('export_jobs').set({ status: 'RUNNING', started_at: new Date() }).where('id', '=', id).where('status', '=', 'QUEUED').returning(['report', 'format', 'filters']).executeTakeFirst();
      if (!job) return;
      const d = REPORT_BY_NAME.get(job.report)!;
      const f = job.filters as Filters;
      const result = await d.run(this.context(auth, f), f);
      const file = await this.render(job.format as ExportFormat, await this.meta(auth, d, f), result);
      await this.db.updateTable('export_jobs').set({ status: 'DONE', finished_at: new Date(), row_count: result.rows.length, file_name: this.fileName(job.report, f, job.format as ExportFormat), content: file }).where('id', '=', id).execute();
    } catch (e) {
      this.log.error(`export ${id} failed: ${(e as Error).message}`);
      await this.db.updateTable('export_jobs').set({ status: 'FAILED', finished_at: new Date(), error: 'The export failed. Try again, or narrow the filters.' }).where('id', '=', id).execute();
    }
  }

  async jobs(auth: AuthContext) {
    return this.db
      .selectFrom('export_jobs')
      .select(['id', 'report', 'format', 'status', 'requested_at', 'finished_at', 'row_count', 'file_name', 'error', 'expires_at'])
      .where('requested_by', '=', auth.userId)
      .where('expires_at', '>', new Date())
      .orderBy('requested_at', 'desc')
      .limit(50)
      .execute();
  }

  /** Only the person who asked for an export can download it. */
  async download(ctx: RequestContext, id: string) {
    const job = await this.db.selectFrom('export_jobs').select(['report', 'format', 'status', 'file_name', 'content', 'requested_by', 'row_count']).where('id', '=', id).where('expires_at', '>', new Date()).executeTakeFirst();
    if (!job || job.requested_by !== ctx.auth.userId) throw notFound('Export');
    if (job.status !== 'DONE' || !job.content) throw unprocessable('NOT_READY', job.status === 'FAILED' ? 'This export failed' : 'This export is still being prepared');
    await this.audit.record(this.db, ctx, { action: 'report.export_downloaded', entityType: 'export_job', entityId: id, newValues: { report: job.report, rows: job.row_count } });
    return { file: Buffer.from(job.content), fileName: job.file_name!, format: job.format as ExportFormat };
  }

  /**
   * The accountant's pack for an external CA: one workbook, one sheet per statement, for a period
   * (and the balance-sheet date = its end), with a contents sheet stating the basis.
   */
  async caPack(ctx: RequestContext, raw: unknown) {
    if (!ctx.auth.permissions.has('report.accounting') || !ctx.auth.permissions.has('export.data')) throw forbidden('FORBIDDEN', 'You cannot download the CA pack');
    const base = parse(filtersSchema.pick({ from: true, to: true, branchId: true }), raw ?? {});
    const today = istToday();
    const f: Filters = { from: base.from ?? `${today.slice(0, 8)}01`, to: base.to ?? today, branchId: base.branchId };
    if (f.from! > f.to!) throw unprocessable('BAD_RANGE', 'The start date is after the end date');
    const sheets: [string, string, Filters][] = [
      ['trial-balance', 'Trial balance', { asOf: f.to, branchId: f.branchId }],
      ['profit-loss', 'Profit & loss', f],
      ['balance-sheet', 'Balance sheet', { asOf: f.to, branchId: f.branchId }],
      ['cash-bank-book', 'Cash & bank book', f],
      ['receivables-ageing', 'Receivables ageing', { branchId: f.branchId }],
      ['outstanding-by-loan', 'Loan receivables', { branchId: f.branchId }],
      ['expense-register', 'Expense register', f],
      ['loans-written-off', 'Write-offs', f],
      ['recon-adjustments', 'Cash differences', f],
    ];
    const company = await this.db.selectFrom('companies').select(['legal_name', 'trade_name', 'gstin']).executeTakeFirst();
    const wb = new ExcelJS.Workbook();
    const cover = wb.addWorksheet('Contents');
    cover.addRow([company?.legal_name ?? 'Financiers']).font = { bold: true, size: 14 };
    if (company?.gstin) cover.addRow([`GSTIN ${company.gstin}`]);
    cover.addRow([`Accounts pack for ${dmy(f.from!)} to ${dmy(f.to!)}${f.branchId ? ' (one branch)' : ''}`]).font = { bold: true };
    cover.addRow([`Prepared ${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date())} IST from the general ledger; every figure is derived from posted journal entries.`]);
    cover.addRow(['Basis: accrual — interest is income when an installment falls due (decision D1 ⚖). Profit not yet closed to reserves is shown separately on the balance sheet.']);
    cover.addRow([]);
    cover.addRow(['Sheet', 'Contents']).font = { bold: true };
    cover.getColumn(1).width = 26;
    cover.getColumn(2).width = 90;
    const summary: Record<string, number> = {};
    for (const [name, title, filters] of sheets) {
      if (!REPORT_BY_NAME.get(name)) continue;
      const d = REPORT_BY_NAME.get(name)!;
      if (!ctx.auth.permissions.has(d.permission)) continue;
      const rf = this.resolve(d, filters);
      const r = await d.run(this.context(ctx.auth, rf), rf);
      summary[name] = r.rows.length;
      await toXlsx(await this.meta(ctx.auth, d, rf), r, wb, title);
      cover.addRow([title, d.description]);
    }
    await this.audit.record(this.db, ctx, { action: 'report.ca_pack', entityType: 'report', entityId: 'ca-pack', newValues: { filters: f, sheets: summary } });
    return { file: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `ca-pack-${f.from}_${f.to}.xlsx` };
  }
}
