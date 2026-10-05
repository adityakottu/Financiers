import { Inject, Injectable } from '@nestjs/common';
import { customerCreateSchema, loanCreateSchema, type CustomerCreateInput, type LoanCreateInput } from '@fin/contracts';
import { Money } from '@fin/money';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { istToday } from '../common/dates';
import { ApiError, badRequest, conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { CustomersService } from '../customers/customers.service';
import { DB_TOKEN, Db, Executor, Tx, isUniqueViolation } from '../db/db';
import { rollStatuses } from '../lending/dues';
import { LoansService } from '../lending/loans.service';
import { GL, LedgerService } from '../ledger/ledger.service';
import { NumberingService } from '../numbering/numbering.service';
import { parseAmount, parseCsv, parseDate, xlsxRows } from '../reconciliation/statement-parser';
import { COLUMNS, ImportColumn, mapHeader } from './columns';

export type ImportKind = 'CUSTOMERS' | 'LOANS';
export interface RowError {
  row: number;
  field: string | null;
  message: string;
}
type Raw = Record<string, string>;
interface Parsed {
  rows: { row: number; raw: Raw }[];
  problems: string[];
}

const MAX_ROWS = { CUSTOMERS: 20_000, LOANS: 2_000 } as const;
const ROLLBACK = Symbol('dry-run');

/** Read the first sheet (xlsx) or a CSV into keyed rows; row numbers as the user sees them. */
export async function readSheet(buf: Buffer, fileName: string, cols: ImportColumn[]): Promise<Parsed> {
  const isXlsx = buf.subarray(0, 2).toString() === 'PK' || /\.xlsx$/i.test(fileName);
  let all: string[][];
  try {
    all = isXlsx ? await xlsxRows(buf) : parseCsv(buf.toString('utf8').replace(/^﻿/, ''));
  } catch {
    return { rows: [], problems: ['The file could not be read. Save it as .xlsx or .csv from the template.'] };
  }
  if (!all.length) return { rows: [], problems: ['The file is empty'] };
  const { keys, problems } = mapHeader(all[0]!, cols);
  const rows = all.slice(1).map((vals, i) => {
    const raw: Raw = {};
    keys.forEach((k, j) => {
      if (k) raw[k] = (vals[j] ?? '').trim();
    });
    return { row: i + 2, raw };
  });
  return { rows: rows.filter((r) => Object.values(r.raw).some((v) => v !== '')), problems };
}

const header = (cols: ImportColumn[], key: string) => cols.find((c) => c.key === key)?.header ?? key;

/**
 * Data migration from the old system (doc 15, Phase 9; E15 in doc 07).
 *
 * Upload → every row validated (for loans, by actually creating them inside a transaction that is
 * rolled back, so the checks are exactly the real ones) → a different person confirms with step-up
 * → the same work runs for real in one transaction: all rows or none. Nothing invalid is imported
 * silently: customers with errors are left out only when the confirmer accepts that explicitly;
 * loans are imported only when every row is valid.
 */
@Injectable()
export class ImportsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly customers: CustomersService,
    private readonly loans: LoansService,
    private readonly ledger: LedgerService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  /* ============================ templates ============================ */

  async template(kind: ImportKind | 'PARALLEL'): Promise<Buffer> {
    const cols = COLUMNS[kind];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(kind === 'CUSTOMERS' ? 'Customers' : kind === 'LOANS' ? 'Loans' : 'Collections');
    const h = ws.addRow(cols.map((c) => (c.required ? `${c.header}*` : c.header)));
    h.font = { bold: true };
    cols.forEach((c, i) => {
      ws.getColumn(i + 1).width = Math.max(14, c.header.length + 4);
      ws.getColumn(i + 1).numFmt = '@'; // text: keeps leading zeros and stops Excel turning numbers into dates
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const help = wb.addWorksheet('How to fill');
    help.addRow(['Column', 'Required', 'What to enter', 'Example']).font = { bold: true };
    for (const c of cols) help.addRow([c.header, c.required ? 'Yes' : '', c.note, c.example]);
    help.addRow([]);
    help.addRow(['Fill the first sheet only, one row per record, from row 2. Dates as DD/MM/YYYY. Amounts in rupees without ₹ (1,23,456.50 is fine).']);
    if (kind === 'CUSTOMERS') help.addRow(['Do not add ID numbers (Aadhaar, PAN, voter ID…): they are refused. Collect KYC in the app.']);
    if (kind === 'LOANS') help.addRow(['Import customers first. Each loan’s principal_outstanding must equal the app’s schedule after the paid installments, or the row is refused.']);
    help.getColumn(1).width = 24;
    help.getColumn(3).width = 90;
    help.getColumn(4).width = 20;
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /* ============================ upload ============================ */

  async upload(ctx: RequestContext, kind: ImportKind, file: Express.Multer.File, cutoverDate?: string) {
    const sha = createHash('sha256').update(file.buffer).digest('hex');
    const done = await this.db.selectFrom('import_batches').select('batch_no').where('kind', '=', kind).where('file_sha256', '=', sha).where('status', '=', 'CONFIRMED').executeTakeFirst();
    if (done) throw conflict('ALREADY_IMPORTED', `This file was already imported (${done.batch_no})`);
    const cols = COLUMNS[kind];
    const parsed = await readSheet(file.buffer, file.originalname, cols);
    if (parsed.problems.length) throw unprocessable('BAD_FILE', parsed.problems[0]!, parsed.problems.map((m) => ({ row: 1, field: null, message: m })));
    if (!parsed.rows.length) throw unprocessable('EMPTY_FILE', 'The file has no rows below the header');
    if (parsed.rows.length > MAX_ROWS[kind]) throw unprocessable('TOO_MANY_ROWS', `At most ${MAX_ROWS[kind].toLocaleString('en-IN')} rows per file — split it (for example by branch)`);
    if (kind === 'LOANS') {
      if (!cutoverDate) throw badRequest('VALIDATION_FAILED', 'Give the cut-over date: the day the old balances are true at');
      if (cutoverDate > istToday()) throw unprocessable('FUTURE_DATE', 'The cut-over date cannot be in the future');
    }

    const v = kind === 'CUSTOMERS' ? await this.validateCustomers(ctx, parsed.rows) : await this.validateLoans(ctx, parsed.rows, cutoverDate!);
    const status = v.valid.length === 0 ? 'REJECTED' : 'VALIDATED';
    const batch = await this.db.transaction().execute(async (tx) => {
      const batchNo = await this.numbering.next(tx, 'IMPORT');
      const b = await tx
        .insertInto('import_batches')
        .values({
          batch_no: batchNo,
          kind,
          file_name: file.originalname.slice(0, 200),
          file_sha256: sha,
          cutover_date: cutoverDate ?? null,
          status,
          rows_total: parsed.rows.length,
          rows_valid: v.valid.length,
          rows_invalid: parsed.rows.length - v.valid.length,
          errors: JSON.stringify(v.errors),
          // Rows that will never be imported are not kept (data minimisation).
          rows: JSON.stringify(status === 'REJECTED' ? [] : v.valid),
          totals: JSON.stringify(v.totals),
          uploaded_by: ctx.auth.userId,
        })
        .returning(['id', 'batch_no'])
        .executeTakeFirstOrThrow();
      await this.audit.record(tx, ctx, {
        action: 'import.uploaded',
        entityType: 'import_batch',
        entityId: b.id,
        newValues: { batchNo: b.batch_no, kind, file: file.originalname, rows: parsed.rows.length, valid: v.valid.length, invalid: parsed.rows.length - v.valid.length, cutoverDate: cutoverDate ?? null, totals: v.totals },
      });
      return b;
    });
    return this.get(ctx.auth, batch.id);
  }

  /* ---------------------------- customers ---------------------------- */

  private async normaliseCustomer(db: Executor, auth: AuthContext, r: { row: number; raw: Raw }) {
    const cols = COLUMNS.CUSTOMERS;
    const errors: RowError[] = [];
    const x = r.raw;
    const branch = x.branchCode ? await db.selectFrom('branches').select(['id', 'is_active']).where('code', '=', x.branchCode.toUpperCase()).executeTakeFirst() : undefined;
    if (!branch) errors.push({ row: r.row, field: 'branch_code', message: `Unknown branch "${x.branchCode ?? ''}"` });
    else if (!scope.canAccessBranch(auth, branch.id)) errors.push({ row: r.row, field: 'branch_code', message: 'You cannot import into this branch' });
    let dob: string | undefined;
    if (x.dob) {
      dob = parseDate(x.dob, 'DD/MM/YYYY') ?? undefined;
      if (!dob) errors.push({ row: r.row, field: 'dob', message: 'Not a date (DD/MM/YYYY)' });
    }
    const opt = /^(y|yes|true|1)$/i.test(x.whatsappOptIn ?? '');
    if (x.whatsappOptIn && !opt && !/^(n|no|false|0)$/i.test(x.whatsappOptIn)) errors.push({ row: r.row, field: 'whatsapp_opt_in', message: 'Y or N' });
    const input = {
      branchId: branch?.id ?? '00000000-0000-0000-0000-000000000000',
      fullName: x.fullName,
      mobile: x.mobile,
      relationType: x.relationType?.toUpperCase() || undefined,
      relationName: x.relationName || undefined,
      dob,
      gender: x.gender?.toUpperCase() || undefined,
      altMobile: x.altMobile || undefined,
      addressLine1: x.addressLine1 || undefined,
      addressLine2: x.addressLine2 || undefined,
      villageTown: x.villageTown || undefined,
      mandal: x.mandal || undefined,
      district: x.district || undefined,
      state: x.state || undefined,
      pincode: x.pincode || undefined,
      occupation: x.occupation || undefined,
      whatsappOptIn: opt,
    };
    const p = customerCreateSchema.safeParse(input);
    if (!p.success) for (const i of p.error.issues) errors.push({ row: r.row, field: header(cols, String(i.path[0] ?? '')), message: i.message });
    if (!x.legacyNo) errors.push({ row: r.row, field: 'legacy_no', message: 'Required' });
    return { errors, value: p.success ? { ...p.data, legacyNo: x.legacyNo } : null };
  }

  private async validateCustomers(ctx: RequestContext, rows: { row: number; raw: Raw }[]) {
    const errors: RowError[] = [];
    const valid: (CustomerCreateInput & { legacyNo: string; row: number })[] = [];
    const seen = new Map<string, number>();
    const legacy = rows.map((r) => r.raw.legacyNo).filter(Boolean);
    const existing = new Map(
      legacy.length ? (await this.db.selectFrom('customers').select(['legacy_no', 'customer_no']).where('legacy_no', 'in', legacy).execute()).map((e) => [e.legacy_no!, e.customer_no]) : [],
    );
    for (const r of rows) {
      const n = await this.normaliseCustomer(this.db, ctx.auth, r);
      const lno = r.raw.legacyNo;
      if (lno && seen.has(lno)) n.errors.push({ row: r.row, field: 'legacy_no', message: `Same legacy number as row ${seen.get(lno)}` });
      if (lno && existing.has(lno)) n.errors.push({ row: r.row, field: 'legacy_no', message: `Already imported as ${existing.get(lno)}` });
      if (lno) seen.set(lno, r.row);
      if (n.value && !n.errors.length) {
        const twin = await this.db.selectFrom('customers').select('customer_no').where('mobile', '=', n.value.mobile).where(sql<boolean>`lower(full_name) = lower(${n.value.fullName})`).executeTakeFirst();
        if (twin) n.errors.push({ row: r.row, field: 'full_name', message: `Same name and mobile as existing customer ${twin.customer_no}` });
      }
      if (n.errors.length || !n.value) errors.push(...n.errors);
      else valid.push({ ...n.value, row: r.row });
    }
    const byBranch: Record<string, number> = {};
    for (const v of valid) byBranch[v.branchId] = (byBranch[v.branchId] ?? 0) + 1;
    return { errors, valid, totals: { customers: valid.length } };
  }

  private async createCustomer(tx: Tx, ctx: RequestContext, v: CustomerCreateInput & { legacyNo: string }) {
    const { legacyNo, ...input } = v;
    const c = await this.customers.create(tx, ctx, customerCreateSchema.parse(input));
    await tx.updateTable('customers').set({ legacy_no: legacyNo }).where('id', '=', c!.id).execute();
    return { id: c!.id, customerNo: c!.customerNo, legacyNo };
  }

  /* ------------------------------ loans ------------------------------ */

  private normaliseLoan(r: { row: number; raw: Raw }) {
    const cols = COLUMNS.LOANS;
    const x = r.raw;
    const errors: RowError[] = [];
    const amount = (key: string, required: boolean) => {
      const v = x[key] ?? '';
      if (v === '') {
        if (required) errors.push({ row: r.row, field: header(cols, key), message: 'Required' });
        return undefined;
      }
      const a = parseAmount(v);
      if (a === null || /^-/.test(v)) errors.push({ row: r.row, field: header(cols, key), message: 'Not an amount (rupees, up to 2 decimals)' });
      return a ?? undefined;
    };
    const count = (key: string, required: boolean) => {
      const v = x[key] ?? '';
      if (v === '') {
        if (required) errors.push({ row: r.row, field: header(cols, key), message: 'Required' });
        return undefined;
      }
      if (!/^\d{1,4}$/.test(v)) errors.push({ row: r.row, field: header(cols, key), message: 'A whole number' });
      return Number(v);
    };
    const date = (key: string) => {
      const d = x[key] ? parseDate(x[key]!, 'DD/MM/YYYY') : null;
      if (!d) errors.push({ row: r.row, field: header(cols, key), message: x[key] ? 'Not a date (DD/MM/YYYY)' : 'Required' });
      return d ?? '';
    };
    for (const k of ['legacyNo', 'customerRef', 'productCode', 'annualRate', 'frequency'] as const) if (!x[k]) errors.push({ row: r.row, field: header(cols, k), message: 'Required' });
    const terms = {
      principal: amount('principal', true),
      annualRate: x.annualRate,
      frequency: x.frequency?.toUpperCase(),
      customIntervalDays: x.customIntervalDays ? Number(x.customIntervalDays) : undefined,
      numInstallments: count('numInstallments', true),
      disbursementDate: date('disbursementDate'),
      firstDueDate: date('firstDueDate'),
    };
    const asset = Object.fromEntries(
      Object.entries({
        description: x.assetDescription,
        make: x.assetMake,
        model: x.assetModel,
        manufactureYear: x.manufactureYear,
        registrationNo: x.registrationNo,
        chassisNo: x.chassisNo,
        engineNo: x.engineNo,
        serialNo: x.serialNo,
        assetValue: x.assetValue ? (parseAmount(x.assetValue) ?? x.assetValue) : undefined,
      }).filter(([, v]) => v !== undefined && v !== ''),
    );
    const extra = {
      legacyNo: x.legacyNo ?? '',
      customerRef: x.customerRef ?? '',
      productCode: (x.productCode ?? '').toUpperCase(),
      installmentAmount: amount('installmentAmount', false),
      installmentsPaid: count('installmentsPaid', true) ?? 0,
      partPaid: amount('partPaid', false) ?? '0.00',
      principalOutstanding: amount('principalOutstanding', true) ?? '0.00',
      penaltyOutstanding: amount('penaltyOutstanding', false) ?? '0.00',
    };
    // The real schema, with placeholder ids (resolved later), so messages match the loan form.
    const p = loanCreateSchema.safeParse({ customerId: '00000000-0000-0000-0000-000000000000', productId: '00000000-0000-0000-0000-000000000000', ...terms, asset });
    if (!p.success && !errors.length) {
      for (const i of p.error.issues) {
        const k = i.path[0] === 'asset' ? `asset${String(i.path[1] ?? '').replace(/^./, (c) => c.toUpperCase())}` : String(i.path[0] ?? '');
        const map: Record<string, string> = { assetDescription: 'asset_description', assetMake: 'asset_make', assetModel: 'asset_model', assetManufactureYear: 'manufacture_year', assetRegistrationNo: 'registration_no', assetChassisNo: 'chassis_no', assetEngineNo: 'engine_no', assetSerialNo: 'serial_no', assetAssetValue: 'asset_value' };
        errors.push({ row: r.row, field: map[k] ?? header(cols, k), message: i.message });
      }
    }
    return { errors, value: p.success && !errors.length ? { row: r.row, input: p.data, ...extra } : null };
  }

  private async validateLoans(ctx: RequestContext, rows: { row: number; raw: Raw }[], cutover: string) {
    const errors: RowError[] = [];
    const candidates: NonNullable<ReturnType<ImportsService['normaliseLoan']>['value']>[] = [];
    const seen = new Map<string, number>();
    for (const r of rows) {
      const n = this.normaliseLoan(r);
      const lno = r.raw.legacyNo;
      if (lno && seen.has(lno)) n.errors.push({ row: r.row, field: 'legacy_loan_no', message: `Same legacy number as row ${seen.get(lno)}` });
      if (lno) seen.set(lno, r.row);
      if (n.errors.length || !n.value) errors.push(...n.errors);
      else candidates.push(n.value);
    }
    // Create every loan for real inside a transaction that is then rolled back: the checks are
    // exactly the ones the confirmation will run (product limits, schedule, duplicates, balances).
    const valid: typeof candidates = [];
    const totals = { loans: 0, principal: Money.zero(), interest: Money.zero(), fees: Money.zero(), penalty: Money.zero() };
    await this.dryRun(async (tx) => {
      for (const c of candidates) {
        await sql`SAVEPOINT import_row`.execute(tx);
        try {
          const res = await this.applyLoan(tx, ctx, c, cutover, null);
          await sql`RELEASE SAVEPOINT import_row`.execute(tx);
          valid.push(c);
          totals.loans++;
          totals.principal = totals.principal.plus(res.principal);
          totals.interest = totals.interest.plus(res.interest);
          totals.fees = totals.fees.plus(res.fees);
          totals.penalty = totals.penalty.plus(res.penalty);
        } catch (e) {
          await sql`ROLLBACK TO SAVEPOINT import_row`.execute(tx);
          errors.push({ row: c.row, field: fieldOf(e), message: messageOf(e) });
        }
      }
    });
    errors.sort((a, b) => a.row - b.row);
    return {
      errors,
      valid,
      totals: {
        loans: totals.loans,
        principal: totals.principal.toString(),
        interest: totals.interest.toString(),
        fees: totals.fees.toString(),
        penalty: totals.penalty.toString(),
        total: totals.principal.plus(totals.interest).plus(totals.fees).plus(totals.penalty).toString(),
      },
    };
  }

  private async dryRun(work: (tx: Tx) => Promise<void>) {
    try {
      await this.db.transaction().execute(async (tx) => {
        await work(tx);
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
  }

  /**
   * One running loan from the old system: created on the product's real schedule, the installments
   * paid by the cut-over marked paid, then E15 — Dr 1310/1320/1330/1340 / Cr 3900 Opening Balance
   * Equity — for exactly what is outstanding. Interest on installments due by the cut-over is
   * treated as already accrued (it is in the opening 1320); later installments accrue as usual.
   */
  private async applyLoan(
    tx: Tx,
    ctx: RequestContext,
    c: { legacyNo: string; customerRef: string; productCode: string; input: Omit<LoanCreateInput, 'customerId' | 'productId'>; installmentAmount?: string; installmentsPaid: number; partPaid: string; principalOutstanding: string; penaltyOutstanding: string },
    cutover: string,
    /** On confirmation: who prepared (uploaded) and who approved (confirmed). Null in the dry run. */
    approval: { makerId: string; approverId: string } | null,
  ) {
    if (await tx.selectFrom('loans').select('id').where('legacy_no', '=', c.legacyNo).executeTakeFirst()) throw conflict('DUPLICATE', 'This legacy loan number is already in the app', { field: 'legacy_loan_no' });
    const customer = await tx
      .selectFrom('customers')
      .select(['id'])
      .where((eb) => eb.or([eb('legacy_no', '=', c.customerRef), eb('customer_no', '=', c.customerRef)]))
      .executeTakeFirst();
    if (!customer) throw unprocessable('CUSTOMER_NOT_FOUND', `No customer "${c.customerRef}" — import customers first`, { field: 'customer_ref' });
    const product = await tx.selectFrom('loan_products').select('id').where('code', '=', c.productCode).where('is_latest', '=', true).executeTakeFirst();
    if (!product) throw unprocessable('PRODUCT_NOT_FOUND', `No product with code "${c.productCode}"`, { field: 'product_code' });
    if (c.input.disbursementDate >= cutover) throw unprocessable('AFTER_CUTOVER', 'Disbursed on or after the cut-over date: enter it as a new loan in the app instead', { field: 'disbursement_date' });

    const created = await this.loans.create(tx, ctx, { ...c.input, customerId: customer.id, productId: product.id } as LoanCreateInput);
    const loan = await tx.selectFrom('loans').select(['id', 'loan_no', 'branch_id', 'customer_id', 'installment_amount']).where('id', '=', created.id).executeTakeFirstOrThrow();
    if (c.installmentAmount && !Money.of(c.installmentAmount).eq(Money.of(loan.installment_amount))) {
      throw unprocessable('INSTALLMENT_DIFFERS', `The app's installment is ₹${loan.installment_amount}, the old system's ₹${c.installmentAmount}. Check the rate, method (product) and frequency.`, { field: 'installment_amount' });
    }
    const inst = await tx.selectFrom('loan_installments').selectAll().where('loan_id', '=', loan.id).orderBy('installment_no').execute();
    if (c.installmentsPaid >= inst.length) throw unprocessable('FULLY_PAID', `All ${inst.length} installments paid — closed loans are not imported`, { field: 'installments_paid' });
    if (c.installmentsPaid > 0) {
      await tx
        .updateTable('loan_installments')
        .set((eb) => ({ principal_paid: eb.ref('principal_due'), interest_paid: eb.ref('interest_due'), fees_paid: eb.ref('fees_due'), paid_on: sql`least(due_date, ${cutover}::date)`, interest_accrued_at: new Date() }))
        .where('loan_id', '=', loan.id)
        .where('installment_no', '<=', c.installmentsPaid)
        .execute();
    }
    const part = Money.of(c.partPaid);
    if (part.isPositive()) {
      const next = inst[c.installmentsPaid]!;
      const due = Money.of(next.principal_due).plus(Money.of(next.interest_due)).plus(Money.of(next.fees_due));
      if (!part.lt(due)) throw unprocessable('PART_PAID_TOO_HIGH', `part_paid must be less than installment ${next.installment_no} (₹${due.toString()}); count it as paid instead`, { field: 'part_paid' });
      // Same order as the default allocation: fees, then interest, then principal.
      const fees = part.min(Money.of(next.fees_due));
      const interest = part.minus(fees).min(Money.of(next.interest_due));
      const principal = part.minus(fees).minus(interest);
      await tx
        .updateTable('loan_installments')
        .set({ fees_paid: fees.toString(), interest_paid: interest.toString(), principal_paid: principal.toString() })
        .where('id', '=', next.id)
        .execute();
    }
    // Interest already due (and any interest paid ahead) is in the opening 1320, not accrued again.
    await tx
      .updateTable('loan_installments')
      .set({ interest_accrued_at: new Date() })
      .where('loan_id', '=', loan.id)
      .where('interest_accrued_at', 'is', null)
      .where((eb) => eb.or([eb('due_date', '<=', cutover), eb('interest_paid', '>', '0')]))
      .execute();

    const penalty = Money.of(c.penaltyOutstanding);
    let penaltyCharge: string | null = null;
    if (penalty.isPositive()) {
      const overdue = await tx
        .selectFrom('loan_installments')
        .select(['id', 'installment_no'])
        .where('loan_id', '=', loan.id)
        .where('due_date', '<', cutover)
        .where(sql<boolean>`total_paid < total_due`)
        .orderBy('installment_no')
        .executeTakeFirst();
      if (!overdue) throw unprocessable('NO_OVERDUE', 'Penal charges need an installment overdue at the cut-over', { field: 'penalty_outstanding' });
      penaltyCharge = (
        await tx
          .insertInto('loan_charges')
          .values({ loan_id: loan.id, installment_id: overdue.id, charge_type: 'PENALTY', code: 'MIGRATED', description: `Penal charges brought over from the old system (installment ${overdue.installment_no})`, amount: penalty.toString(), assessed_on: cutover })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await tx
        .updateTable('loan_installments')
        .set((eb) => ({ penalty_due: eb('penalty_due', '+', penalty.toString()) }))
        .where('id', '=', overdue.id)
        .execute();
    }

    const today = istToday();
    await tx
      .updateTable('loans')
      .set({
        status: 'ACTIVE',
        legacy_no: c.legacyNo,
        migrated_on: cutover,
        disbursed_on: c.input.disbursementDate,
        disbursed_at: new Date(),
        submitted_at: new Date(),
        ...(approval ? { created_by: approval.makerId, approved_by: approval.approverId, approved_at: new Date() } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', loan.id)
      .execute();
    const assets = await tx.selectFrom('assets').select(['id', 'status']).where('loan_id', '=', loan.id).execute();
    for (const a of assets) {
      await tx.updateTable('assets').set({ status: 'ACTIVE', updated_at: new Date() }).where('id', '=', a.id).execute();
      await tx.insertInto('asset_events').values({ asset_id: a.id, from_status: a.status, to_status: 'ACTIVE', reason: 'Running loan brought over from the old system', actor_id: ctx.auth.userId }).execute();
    }
    await rollStatuses(tx, today, [loan.id]);
    await this.loans.refreshBalances(tx, [loan.id], today);
    const bal = await tx.selectFrom('loans').select(['principal_outstanding', 'interest_outstanding', 'fees_outstanding', 'penalty_outstanding']).where('id', '=', loan.id).executeTakeFirstOrThrow();
    const P = Money.of(bal.principal_outstanding);
    if (!P.eq(Money.of(c.principalOutstanding))) {
      throw unprocessable('OUTSTANDING_DIFFERS', `After ${c.installmentsPaid} paid installment(s)${part.isPositive() ? ` and ₹${part.toString()} part-paid` : ''} the app's principal outstanding is ₹${P.toString()}; the old ledger says ₹${c.principalOutstanding}`, { field: 'principal_outstanding' });
    }
    const I = Money.of(bal.interest_outstanding);
    const F = Money.of(bal.fees_outstanding);
    const N = Money.of(bal.penalty_outstanding);
    const total = P.plus(I).plus(F).plus(N);
    const lines = [
      { account: GL.LOAN_RECEIVABLE, debit: P, memo: 'Principal outstanding' },
      { account: GL.INTEREST_RECEIVABLE, debit: I, memo: 'Interest due, unpaid' },
      { account: GL.FEES_RECEIVABLE, debit: F, memo: 'Fees unpaid' },
      { account: GL.PENAL_RECEIVABLE, debit: N, memo: 'Penal charges unpaid' },
    ]
      .filter((l) => l.debit.isPositive())
      .map((l) => ({ ...l, loanId: loan.id, customerId: loan.customer_id }));
    const entry = await this.ledger.post(tx, {
      entryType: 'OPENING',
      valueDate: cutover,
      branchId: loan.branch_id,
      sourceType: 'loan',
      sourceId: loan.id,
      narration: `Opening balance of loan ${loan.loan_no} (old system ${c.legacyNo}) at cut-over`,
      lines: [...lines, { account: GL.OPENING_EQUITY, credit: total, memo: `Loan ${c.legacyNo}` }],
      createdBy: ctx.auth.userId,
    });
    if (penaltyCharge) await tx.updateTable('loan_charges').set({ journal_entry_id: entry.id }).where('id', '=', penaltyCharge).execute();
    await this.loans.event(tx, loan.customer_id, loan.id, ctx.auth.userId, 'LOAN_MIGRATED', `Loan ${loan.loan_no} brought over from the old system (${c.legacyNo}); ₹${total.format({ symbol: false })} outstanding at cut-over`);
    await this.audit.record(tx, ctx, {
      action: 'loan.migrated',
      entityType: 'loan',
      entityId: loan.id,
      branchId: loan.branch_id,
      newValues: { loanNo: loan.loan_no, legacyNo: c.legacyNo, cutover, installmentsPaid: c.installmentsPaid, partPaid: part.toString(), principal: P.toString(), interest: I.toString(), fees: F.toString(), penalty: N.toString(), journal: entry.entryNo },
    });
    return { id: loan.id, loanNo: loan.loan_no, legacyNo: c.legacyNo, principal: P, interest: I, fees: F, penalty: N, entryNo: entry.entryNo };
  }

  /* ============================ confirm / cancel ============================ */

  async confirm(ctx: RequestContext, id: string, acceptInvalid: boolean) {
    try {
      return await this.db.transaction().execute(async (tx) => {
        const b = await tx.selectFrom('import_batches').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!b) throw notFound('Import');
        if (b.status !== 'VALIDATED') throw conflict('INVALID_STATE', `This import is ${b.status.toLowerCase()}`);
        if (b.uploaded_by === ctx.auth.userId) throw forbidden('SAME_PERSON', 'A different person must confirm the import (four eyes)');
        if (b.rows_invalid > 0 && b.kind === 'LOANS') throw unprocessable('HAS_ERRORS', 'Every loan row must be valid. Fix the rows listed and upload the file again.');
        if (b.rows_invalid > 0 && !acceptInvalid) throw unprocessable('HAS_ERRORS', `${b.rows_invalid} row(s) have errors and will not be imported. Confirm that you accept this, or fix them and upload again.`);
        const rows = b.rows as unknown as Record<string, unknown>[];
        const created: Record<string, string>[] = [];
        let totals: Record<string, string | number> = { ...(b.totals as Record<string, string | number>) };
        if (b.kind === 'CUSTOMERS') {
          for (const r of rows) {
            const { row, ...v } = r as unknown as CustomerCreateInput & { legacyNo: string; row: number };
            try {
              created.push(await this.createCustomer(tx, ctx, v));
            } catch (e) {
              throw unprocessable('IMPORT_CHANGED', `Row ${row}: ${messageOf(e)} — upload the file again`);
            }
          }
        } else {
          const sum = { principal: Money.zero(), interest: Money.zero(), fees: Money.zero(), penalty: Money.zero() };
          for (const r of rows) {
            const c = r as unknown as Parameters<ImportsService['applyLoan']>[2] & { row: number };
            try {
              // The uploader prepared the loan; the confirmer approved it (maker ≠ checker on the loan too).
              const res = await this.applyLoan(tx, ctx, c, b.cutover_date!, { makerId: b.uploaded_by, approverId: ctx.auth.userId });
              created.push({ id: res.id, loanNo: res.loanNo, legacyNo: res.legacyNo, journal: res.entryNo });
              sum.principal = sum.principal.plus(res.principal);
              sum.interest = sum.interest.plus(res.interest);
              sum.fees = sum.fees.plus(res.fees);
              sum.penalty = sum.penalty.plus(res.penalty);
            } catch (e) {
              throw unprocessable('IMPORT_CHANGED', `Row ${c.row}: ${messageOf(e)} — upload the file again`);
            }
          }
          totals = { loans: created.length, principal: sum.principal.toString(), interest: sum.interest.toString(), fees: sum.fees.toString(), penalty: sum.penalty.toString(), total: sum.principal.plus(sum.interest).plus(sum.fees).plus(sum.penalty).toString() };
        }
        await tx
          .updateTable('import_batches')
          .set({ status: 'CONFIRMED', confirmed_by: ctx.auth.userId, confirmed_at: new Date(), totals: JSON.stringify(totals), result: JSON.stringify({ created }) })
          .where('id', '=', id)
          .execute();
        await this.audit.record(tx, ctx, {
          action: 'import.confirmed',
          entityType: 'import_batch',
          entityId: id,
          newValues: { batchNo: b.batch_no, kind: b.kind, created: created.length, skippedInvalid: b.rows_invalid, cutoverDate: b.cutover_date, totals },
        });
        return { id, batchNo: b.batch_no, status: 'CONFIRMED', created: created.length, totals };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('ALREADY_IMPORTED', 'This file was already imported');
      throw e;
    }
  }

  async cancel(ctx: RequestContext, id: string) {
    return this.db.transaction().execute(async (tx) => {
      const b = await tx.selectFrom('import_batches').select(['id', 'status', 'batch_no']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!b) throw notFound('Import');
      if (b.status !== 'VALIDATED' && b.status !== 'REJECTED') throw conflict('INVALID_STATE', `This import is ${b.status.toLowerCase()}`);
      // Rows that will never be imported are not kept (data minimisation); errors stay as the record.
      await tx.updateTable('import_batches').set({ status: 'CANCELLED', rows: JSON.stringify([]) }).where('id', '=', id).execute();
      await this.audit.record(tx, ctx, { action: 'import.cancelled', entityType: 'import_batch', entityId: id, newValues: { batchNo: b.batch_no } });
      return { id, status: 'CANCELLED' };
    });
  }

  /* ============================ reads ============================ */

  async list() {
    return this.db
      .selectFrom('import_batches as i')
      .innerJoin('users as u', 'u.id', 'i.uploaded_by')
      .leftJoin('users as c', 'c.id', 'i.confirmed_by')
      .select(['i.id', 'i.batch_no', 'i.kind', 'i.file_name', 'i.cutover_date', 'i.status', 'i.rows_total', 'i.rows_valid', 'i.rows_invalid', 'i.totals', 'i.uploaded_at', 'i.confirmed_at', 'i.uploaded_by', 'u.full_name as uploaded_by_name', 'c.full_name as confirmed_by_name'])
      .orderBy('i.uploaded_at', 'desc')
      .limit(100)
      .execute();
  }

  async get(_auth: AuthContext, id: string) {
    const b = await this.db
      .selectFrom('import_batches as i')
      .innerJoin('users as u', 'u.id', 'i.uploaded_by')
      .leftJoin('users as c', 'c.id', 'i.confirmed_by')
      .select(['i.id', 'i.batch_no', 'i.kind', 'i.file_name', 'i.cutover_date', 'i.status', 'i.rows_total', 'i.rows_valid', 'i.rows_invalid', 'i.errors', 'i.totals', 'i.result', 'i.uploaded_at', 'i.confirmed_at', 'i.uploaded_by', 'u.full_name as uploaded_by_name', 'c.full_name as confirmed_by_name'])
      .where('i.id', '=', id)
      .executeTakeFirst();
    if (!b) throw notFound('Import');
    return b;
  }

  async errorsXlsx(id: string): Promise<{ name: string; buffer: Buffer }> {
    const b = await this.db.selectFrom('import_batches').select(['batch_no', 'kind', 'file_name', 'errors']).where('id', '=', id).executeTakeFirst();
    if (!b) throw notFound('Import');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Rows to fix');
    ws.addRow([`${b.batch_no} · ${b.file_name}`]).font = { bold: true };
    ws.addRow([]);
    ws.addRow(['Row in your file', 'Column', 'Problem']).font = { bold: true };
    for (const e of b.errors as unknown as RowError[]) ws.addRow([e.row, e.field ?? '', e.message]);
    ws.getColumn(1).width = 16;
    ws.getColumn(2).width = 24;
    ws.getColumn(3).width = 100;
    ws.views = [{ state: 'frozen', ySplit: 3 }];
    return { name: `${b.batch_no}-errors.xlsx`, buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
  }
}

function messageOf(e: unknown): string {
  if (e instanceof ApiError) return (e.getResponse() as { message: string }).message;
  if (isUniqueViolation(e)) return 'Duplicate (already in the app)';
  throw e;
}
function fieldOf(e: unknown): string | null {
  if (e instanceof ApiError) {
    const d = e.details as { field?: string } | { path: string }[] | undefined;
    if (d && !Array.isArray(d) && 'field' in d) return d.field ?? null;
    if (Array.isArray(d) && d[0]?.path) return d[0].path;
  }
  return null;
}
