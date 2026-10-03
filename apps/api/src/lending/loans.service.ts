import { Inject, Injectable } from '@nestjs/common';
import {
  AssetInput,
  assetProblems,
  CATEGORY_LABELS,
  LoanCategory,
  LoanCreateInput,
  mask,
  productSchema,
} from '@fin/contracts';
import { computeFees, EngineError, FeeRule, generateSchedule, LoanTerms, Schedule } from '@fin/loan-engine';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { istToday } from '../common/dates';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { DB_TOKEN, Db, Executor, Tx, isUniqueViolation, pgConstraint } from '../db/db';
import { GL, LedgerService } from '../ledger/ledger.service';
import { fmtAmount, fmtDate, MessagingService } from '../messaging/messaging.service';
import { NumberingService } from '../numbering/numbering.service';

type ProductInput = z.infer<typeof productSchema>;
const NONE = '00000000-0000-0000-0000-000000000000';

export interface TermsInput {
  principal: string;
  annualRate: string;
  frequency: LoanTerms['frequency'];
  customIntervalDays?: number;
  numInstallments: number;
  disbursementDate: string;
  firstDueDate: string;
}

export function previewHash(s: Schedule): string {
  return createHash('sha256').update(JSON.stringify({ rows: s.rows, totals: s.totals, apr: s.apr })).digest('hex');
}

function engineError(e: unknown): never {
  if (e instanceof EngineError) throw unprocessable(`CALC_${e.code}`, e.message);
  throw e;
}

@Injectable()
export class LoansService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly numbering: NumberingService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly messaging: MessagingService,
  ) {}

  /* =========================== Products =========================== */

  listProducts(includeRetired = false) {
    let q = this.db.selectFrom('loan_products').selectAll().where('is_latest', '=', true).orderBy('category').orderBy('name');
    if (!includeRetired) q = q.where('status', '=', 'ACTIVE');
    return q.execute();
  }

  async product(id: string, db: Executor = this.db) {
    const p = await db.selectFrom('loan_products').selectAll().where('id', '=', id).executeTakeFirst();
    if (!p) throw notFound('Loan product');
    return p;
  }

  private productRow(p: ProductInput) {
    return {
      name: p.name,
      description: p.description ?? null,
      category: p.category,
      interest_method: p.interestMethod,
      rate_min: p.rateMin,
      rate_default: p.rateDefault,
      rate_max: p.rateMax,
      amount_min: p.amountMin,
      amount_max: p.amountMax,
      tenure_min: p.tenureMin,
      tenure_max: p.tenureMax,
      allowed_frequencies: p.allowedFrequencies,
      rounding_unit: p.roundingUnit,
      skip_sundays: p.skipSundays,
      fee_rules: JSON.stringify(p.feeRules),
      penalty_rule: JSON.stringify(p.penaltyRule),
      allocation_rule: JSON.stringify(p.allocationRule),
      max_ltv_pct: p.maxLtvPct ?? null,
      approval_limit: p.approvalLimit ?? null,
    };
  }

  async createProduct(ctx: RequestContext, p: ProductInput) {
    try {
      return await this.db.transaction().execute(async (tx) => {
        const row = await tx
          .insertInto('loan_products')
          .values({ ...this.productRow(p), code: p.code, version: 1, created_by: ctx.auth.userId })
          .returning(['id', 'code', 'version'])
          .executeTakeFirstOrThrow();
        await this.audit.record(tx, ctx, { action: 'product.created', entityType: 'loan_product', entityId: row.id, newValues: p });
        return row;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('DUPLICATE_CODE', `Product code ${p.code} already exists`);
      throw e;
    }
  }

  /** Products are versioned: a change creates version n+1; loans keep the version they were made with. */
  async updateProduct(ctx: RequestContext, id: string, p: ProductInput) {
    return this.db.transaction().execute(async (tx) => {
      const cur = await tx.selectFrom('loan_products').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw notFound('Loan product');
      if (!cur.is_latest) throw conflict('NOT_LATEST', 'Only the latest version of a product can be changed');
      if (p.code !== cur.code) throw badRequest('CODE_IMMUTABLE', 'Product code cannot change');
      await tx.updateTable('loan_products').set({ is_latest: false }).where('id', '=', id).execute();
      const row = await tx
        .insertInto('loan_products')
        .values({ ...this.productRow(p), code: cur.code, version: cur.version + 1, created_by: ctx.auth.userId })
        .returning(['id', 'code', 'version'])
        .executeTakeFirstOrThrow();
      const next = this.productRow(p);
      const before = { ...cur, fee_rules: JSON.stringify(cur.fee_rules), penalty_rule: JSON.stringify(cur.penalty_rule), allocation_rule: JSON.stringify(cur.allocation_rule) };
      const d = diff(before as unknown as Record<string, unknown>, next);
      await this.audit.record(tx, ctx, {
        action: 'product.versioned',
        entityType: 'loan_product',
        entityId: row.id,
        oldValues: { version: cur.version, ...d.oldValues },
        newValues: { version: row.version, ...d.newValues },
      });
      return row;
    });
  }

  async setProductStatus(ctx: RequestContext, id: string, status: 'ACTIVE' | 'RETIRED') {
    await this.db.transaction().execute(async (tx) => {
      const r = await tx.updateTable('loan_products').set({ status }).where('id', '=', id).where('is_latest', '=', true).executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw notFound('Loan product');
      await this.audit.record(tx, ctx, { action: status === 'RETIRED' ? 'product.retired' : 'product.reactivated', entityType: 'loan_product', entityId: id });
    });
  }

  /* =========================== Calculation =========================== */

  termsFor(product: { interest_method: string; rounding_unit: string; skip_sundays: boolean; fee_rules: unknown }, t: TermsInput): LoanTerms {
    return {
      principal: t.principal,
      annualRate: t.annualRate,
      method: product.interest_method as LoanTerms['method'],
      frequency: t.frequency,
      customIntervalDays: t.customIntervalDays,
      numInstallments: t.numInstallments,
      disbursementDate: t.disbursementDate,
      firstDueDate: t.firstDueDate,
      roundingUnit: product.rounding_unit as LoanTerms['roundingUnit'],
      skipSundays: t.frequency === 'DAILY' && product.skip_sundays,
      fees: computeFees(product.fee_rules as FeeRule[], t.principal),
    };
  }

  /** Product limits are hard rules, not warnings: a loan outside them cannot be created. */
  productViolations(
    p: { rate_min: string; rate_max: string; amount_min: string; amount_max: string; tenure_min: number; tenure_max: number; allowed_frequencies: string[]; max_ltv_pct: string | null; status: string },
    t: TermsInput,
    assetValue?: string,
  ): { path: string; message: string }[] {
    const out: { path: string; message: string }[] = [];
    const r = Number(t.annualRate);
    if (p.status !== 'ACTIVE') out.push({ path: 'productId', message: 'This product is retired' });
    if (r < Number(p.rate_min) || r > Number(p.rate_max)) out.push({ path: 'annualRate', message: `Rate must be between ${Number(p.rate_min)}% and ${Number(p.rate_max)}%` });
    const P = Money.of(t.principal);
    if (P.lt(Money.of(p.amount_min)) || P.gt(Money.of(p.amount_max))) out.push({ path: 'principal', message: `Amount must be between ₹${Number(p.amount_min).toLocaleString('en-IN')} and ₹${Number(p.amount_max).toLocaleString('en-IN')}` });
    if (t.numInstallments < p.tenure_min || t.numInstallments > p.tenure_max) out.push({ path: 'numInstallments', message: `Installments must be between ${p.tenure_min} and ${p.tenure_max}` });
    if (!p.allowed_frequencies.includes(t.frequency)) out.push({ path: 'frequency', message: `This product allows ${p.allowed_frequencies.join(', ').toLowerCase()} installments` });
    if (p.max_ltv_pct && assetValue && Money.of(assetValue).isPositive()) {
      const ltv = P.toDecimal().dividedBy(assetValue).times(100);
      if (ltv.greaterThan(p.max_ltv_pct)) out.push({ path: 'principal', message: `Loan is ${ltv.toFixed(1)}% of asset value; this product allows at most ${Number(p.max_ltv_pct)}%` });
    }
    return out;
  }

  async preview(productId: string, t: TermsInput, assetValue?: string) {
    const p = await this.product(productId);
    let schedule: Schedule;
    try {
      schedule = generateSchedule(this.termsFor(p, t));
    } catch (e) {
      engineError(e);
    }
    return {
      product: { id: p.id, code: p.code, name: p.name, version: p.version, interestMethod: p.interest_method },
      violations: this.productViolations(p, t, assetValue),
      schedule,
      previewHash: previewHash(schedule),
    };
  }

  freeCalculate(terms: LoanTerms) {
    try {
      const schedule = generateSchedule(terms);
      return { schedule, previewHash: previewHash(schedule) };
    } catch (e) {
      engineError(e);
    }
  }

  /* =========================== Scope =========================== */

  scoped(db: Executor, auth: AuthContext) {
    let q = db.selectFrom('loans as l').innerJoin('customers as c', 'c.id', 'l.customer_id').innerJoin('branches as b', 'b.id', 'l.branch_id');
    if (auth.scope === 'ASSIGNED') q = q.where('l.assigned_collector_id', '=', auth.employeeId ?? NONE);
    else {
      const branches = scope.branchFilter(auth);
      if (branches) q = q.where('l.branch_id', 'in', branches.length ? branches : [NONE]);
    }
    return q;
  }

  private async lockLoan(tx: Tx, auth: AuthContext, id: string) {
    const loan = await this.scoped(tx, auth).selectAll('l').where('l.id', '=', id).forUpdate('l').executeTakeFirst();
    if (!loan) throw notFound('Loan');
    return loan;
  }

  /* =========================== Create =========================== */

  async create(tx: Tx, ctx: RequestContext, input: LoanCreateInput) {
    const customer = await tx
      .selectFrom('customers')
      .select(['id', 'branch_id', 'status', 'full_name', 'customer_no'])
      .where('id', '=', input.customerId)
      .executeTakeFirst();
    if (!customer || !scope.canAccessBranch(ctx.auth, customer.branch_id)) throw notFound('Customer');
    if (customer.status !== 'ACTIVE') throw unprocessable('CUSTOMER_NOT_ACTIVE', 'Loans can only be created for active customers');
    const product = await this.product(input.productId, tx);
    if (!product.is_latest) throw unprocessable('PRODUCT_OUTDATED', 'This product has a newer version. Reload and try again.');
    const assetValue = input.asset.assetValue;
    const violations = this.productViolations(product, input, assetValue);
    if (violations.length) throw badRequest('VALIDATION_FAILED', violations[0]!.message, violations);
    const assetIssues = assetProblems(product.category as LoanCategory, input.asset);
    if (Object.keys(assetIssues).length) {
      throw badRequest('VALIDATION_FAILED', Object.values(assetIssues)[0]!, Object.entries(assetIssues).map(([k, m]) => ({ path: `asset.${k}`, message: m })));
    }
    let schedule: Schedule;
    try {
      schedule = generateSchedule(this.termsFor(product, input));
    } catch (e) {
      engineError(e);
    }
    if (input.previewHash && input.previewHash !== previewHash(schedule)) {
      throw conflict('PREVIEW_CHANGED', 'The schedule changed since your preview (for example the product was updated). Review the new schedule.');
    }

    const branch = await tx.selectFrom('branches').select(['id', 'code']).where('id', '=', customer.branch_id).executeTakeFirstOrThrow();
    const loanNo = await this.numbering.next(tx, 'LOAN', { branchCode: branch.code });
    const T = schedule.totals;
    const loan = await tx
      .insertInto('loans')
      .values({
        loan_no: loanNo,
        customer_id: customer.id,
        branch_id: branch.id,
        product_id: product.id,
        category: product.category,
        asset_value: assetValue ?? null,
        down_payment: input.downPayment ?? '0',
        principal: T.principal,
        annual_rate: input.annualRate,
        interest_method: product.interest_method,
        frequency: input.frequency,
        custom_interval_days: input.customIntervalDays ?? null,
        num_installments: input.numInstallments,
        rounding_unit: product.rounding_unit,
        skip_sundays: schedule.terms.skipSundays ?? false,
        disbursement_date: input.disbursementDate,
        first_due_date: input.firstDueDate,
        maturity_date: schedule.maturityDate,
        fees: JSON.stringify(schedule.terms.fees),
        penalty_rule: JSON.stringify(product.penalty_rule),
        allocation_rule: JSON.stringify(product.allocation_rule),
        total_interest: T.interest,
        total_fees: T.fees,
        total_gst: T.gst,
        fees_deducted: T.feesDeducted,
        fees_in_installments: T.feesInInstallments,
        total_payable: T.totalPayable,
        installment_amount: T.installmentAmount,
        net_disbursement: T.netDisbursed,
        apr: schedule.apr,
        engine_version: schedule.engineVersion,
        calc_snapshot: JSON.stringify({ terms: schedule.terms, engineVersion: schedule.engineVersion, previewHash: previewHash(schedule) }),
        created_by: ctx.auth.userId,
      })
      .returning(['id', 'loan_no'])
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('loan_installments')
      .values(
        schedule.rows.map((r) => ({
          loan_id: loan.id,
          installment_no: r.no,
          due_date: r.dueDate,
          opening_principal: r.openingPrincipal,
          closing_principal: r.closingPrincipal,
          principal_due: r.principal,
          interest_due: r.interest,
          fees_due: r.fees,
        })),
      )
      .execute();

    const asset = await this.insertAsset(tx, ctx, { loanId: loan.id, customerId: customer.id, branchId: branch.id, category: product.category }, input.asset);
    await this.event(tx, customer.id, loan.id, ctx.auth.userId, 'LOAN_CREATED', `Loan ${loan.loan_no} created: ₹${Number(T.principal).toLocaleString('en-IN')} ${CATEGORY_LABELS[product.category as LoanCategory]}`);
    await this.audit.record(tx, ctx, {
      action: 'loan.created',
      entityType: 'loan',
      entityId: loan.id,
      branchId: branch.id,
      newValues: {
        loanNo: loan.loan_no,
        customerNo: customer.customer_no,
        product: `${product.code} v${product.version}`,
        principal: T.principal,
        annualRate: input.annualRate,
        method: product.interest_method,
        frequency: input.frequency,
        installments: input.numInstallments,
        totalPayable: T.totalPayable,
        apr: schedule.apr,
        assetNo: asset.asset_no,
      },
    });
    return { id: loan.id, loanNo: loan.loan_no, assetNo: asset.asset_no };
  }

  private async insertAsset(tx: Tx, ctx: RequestContext, ref: { loanId: string; customerId: string; branchId: string; category: string }, a: AssetInput) {
    const assetNo = await this.numbering.next(tx, 'ASSET');
    try {
      const row = await tx
        .insertInto('assets')
        .values({
          asset_no: assetNo,
          loan_id: ref.loanId,
          customer_id: ref.customerId,
          branch_id: ref.branchId,
          category: ref.category,
          description: a.description ?? null,
          make: a.make ?? null,
          model: a.model ?? null,
          variant: a.variant ?? null,
          manufacture_year: a.manufactureYear ?? null,
          colour: a.colour ?? null,
          serial_no: a.serialNo ?? null,
          registration_no: a.registrationNo ?? null,
          chassis_no: a.chassisNo ?? null,
          engine_no: a.engineNo ?? null,
          vehicle_type: a.vehicleType ?? null,
          asset_value: a.assetValue ?? null,
          purchase_price: a.purchasePrice ?? null,
          purchase_date: a.purchaseDate ?? null,
          dealer_name: a.dealerName ?? null,
          invoice_no: a.invoiceNo ?? null,
          hypothecation_marked: a.hypothecationMarked,
          insurer: a.insurer ?? null,
          insurance_policy_no: a.insurancePolicyNo ?? null,
          insurance_expiry: a.insuranceExpiry ?? null,
          permit_no: a.permitNo ?? null,
          permit_expiry: a.permitExpiry ?? null,
          fitness_expiry: a.fitnessExpiry ?? null,
          tax_valid_till: a.taxValidTill ?? null,
          created_by: ctx.auth.userId,
          updated_by: ctx.auth.userId,
        })
        .returning(['id', 'asset_no'])
        .executeTakeFirstOrThrow();
      await tx.insertInto('asset_events').values({ asset_id: row.id, to_status: 'PENDING', reason: 'Loan application created', actor_id: ctx.auth.userId }).execute();
      return row;
    } catch (e) {
      if (isUniqueViolation(e)) {
        const which = pgConstraint(e)?.includes('chassis') ? 'chassis number' : 'registration number';
        throw conflict('ASSET_ALREADY_FINANCED', `A vehicle with this ${which} already has a live loan`);
      }
      throw e;
    }
  }

  async event(tx: Executor, customerId: string, loanId: string, actorId: string, type: string, summary: string) {
    await tx.insertInto('customer_events').values({ customer_id: customerId, loan_id: loanId, actor_id: actorId, event_type: type, summary, ref_type: 'loan', ref_id: loanId }).execute();
  }

  /* =========================== Workflow =========================== */

  private async transition(
    ctx: RequestContext,
    id: string,
    from: string[],
    apply: (tx: Tx, loan: Awaited<ReturnType<LoansService['lockLoan']>>) => Promise<{ to: string; action: string; summary: string; values?: Record<string, unknown>; set?: Record<string, unknown> }>,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const loan = await this.lockLoan(tx, ctx.auth, id);
      if (!from.includes(loan.status)) {
        throw conflict('INVALID_STATE', `This loan is ${loan.status.replace(/_/g, ' ').toLowerCase()}; that action is not possible now`);
      }
      const r = await apply(tx, loan);
      await tx
        .updateTable('loans')
        .set({ ...(r.set ?? {}), status: r.to, version: loan.version + 1, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      await this.event(tx, loan.customer_id, id, ctx.auth.userId, r.action.replace('loan.', 'LOAN_').toUpperCase(), r.summary);
      await this.audit.record(tx, ctx, {
        action: r.action,
        entityType: 'loan',
        entityId: id,
        branchId: loan.branch_id,
        oldValues: { status: loan.status },
        newValues: { status: r.to, ...(r.values ?? {}) },
      });
      return { id, status: r.to };
    });
  }

  submit(ctx: RequestContext, id: string) {
    return this.transition(ctx, id, ['DRAFT'], async (_tx, loan) => ({
      to: 'PENDING_APPROVAL',
      action: 'loan.submitted',
      summary: `Loan ${loan.loan_no} submitted for approval`,
      set: { submitted_by: ctx.auth.userId, submitted_at: new Date() },
    }));
  }

  approve(ctx: RequestContext, id: string, note?: string) {
    return this.transition(ctx, id, ['PENDING_APPROVAL'], async (tx, loan) => {
      await this.assertCanDecide(tx, ctx, loan);
      const kyc = await tx.selectFrom('customers').select('kyc_status').where('id', '=', loan.customer_id).executeTakeFirstOrThrow();
      if (kyc.kyc_status !== 'VERIFIED') {
        throw unprocessable('KYC_NOT_VERIFIED', 'The customer’s KYC must be verified before the loan can be approved');
      }
      return {
        to: 'APPROVED',
        action: 'loan.approved',
        summary: `Loan ${loan.loan_no} approved`,
        values: { note: note ?? null },
        set: { approved_by: ctx.auth.userId, approved_at: new Date(), decision_note: note ?? null },
      };
    });
  }

  reject(ctx: RequestContext, id: string, note: string) {
    return this.transition(ctx, id, ['PENDING_APPROVAL'], async (tx, loan) => {
      await this.assertCanDecide(tx, ctx, loan);
      await this.closeAsset(tx, ctx, id, 'CANCELLED', 'Loan rejected');
      return {
        to: 'REJECTED',
        action: 'loan.rejected',
        summary: `Loan ${loan.loan_no} rejected: ${note}`,
        values: { note },
        set: { rejected_by: ctx.auth.userId, rejected_at: new Date(), decision_note: note },
      };
    });
  }

  cancel(ctx: RequestContext, id: string, reason: string) {
    return this.transition(ctx, id, ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'], async (tx, loan) => {
      await this.closeAsset(tx, ctx, id, 'CANCELLED', 'Loan cancelled');
      return {
        to: 'CANCELLED',
        action: 'loan.cancelled',
        summary: `Loan ${loan.loan_no} cancelled: ${reason}`,
        values: { reason },
        set: { cancelled_by: ctx.auth.userId, cancelled_at: new Date(), cancel_reason: reason },
      };
    });
  }

  /** Maker-checker, and the product's approval limit. */
  private async assertCanDecide(tx: Tx, ctx: RequestContext, loan: { created_by: string; product_id: string; principal: string }) {
    if (loan.created_by === ctx.auth.userId) {
      throw forbidden('MAKER_CHECKER', 'You created this loan, so someone else must approve or reject it');
    }
    const product = await this.product(loan.product_id, tx);
    if (product.approval_limit && Money.of(loan.principal).gt(Money.of(product.approval_limit)) && !ctx.auth.permissions.has('loan.approve_high')) {
      throw forbidden('APPROVAL_LIMIT', `Loans above ₹${Number(product.approval_limit).toLocaleString('en-IN')} need Management approval`);
    }
  }

  private async closeAsset(tx: Tx, ctx: RequestContext, loanId: string, to: string, reason: string) {
    const assets = await tx.selectFrom('assets').select(['id', 'status']).where('loan_id', '=', loanId).execute();
    for (const a of assets) {
      await tx.updateTable('assets').set({ status: to, updated_at: new Date(), updated_by: ctx.auth.userId }).where('id', '=', a.id).execute();
      await tx.insertInto('asset_events').values({ asset_id: a.id, from_status: a.status, to_status: to, reason, actor_id: ctx.auth.userId }).execute();
    }
  }

  /* =========================== Disbursement =========================== */

  /**
   * E1 (doc 07 §3): Dr Loan Receivable (principal); Cr cash/bank (net paid out);
   * Cr fee income + GST output for deducted fees; fees added to installment 1 become
   * Fees Receivable. One balanced entry, in the same transaction as the status change.
   */
  async disburse(tx: Tx, ctx: RequestContext, id: string, d: { accountId: string; mode: string; reference?: string; disbursedOn: string }) {
    const loan = await this.lockLoan(tx, ctx.auth, id);
    if (loan.status !== 'APPROVED') throw conflict('INVALID_STATE', 'Only approved loans can be disbursed');
    const today = istToday();
    if (d.disbursedOn > today) throw unprocessable('FUTURE_DATE', 'Disbursement date cannot be in the future');
    if (d.disbursedOn >= loan.first_due_date) throw unprocessable('AFTER_FIRST_DUE', 'Disbursement must be before the first installment date');
    const account = await this.ledger.assertPayoutAccount(tx, d.accountId, loan.branch_id, d.mode);

    const fees = loan.fees as unknown as { code: string; label?: string; amount: string; gstAmount?: string; mode: string }[];
    const principal = Money.of(loan.principal);
    const lines = [
      { account: GL.LOAN_RECEIVABLE, debit: principal, loanId: id, customerId: loan.customer_id, memo: 'Principal' },
      { account: account.id, credit: Money.of(loan.net_disbursement), loanId: id, memo: `Paid to customer (${d.mode.toLowerCase().replace('_', ' ')})` },
    ] as Parameters<LedgerService['post']>[1]['lines'];
    for (const f of fees) {
      const amount = Money.of(f.amount);
      const gst = Money.of(f.gstAmount ?? '0');
      if (f.mode === 'ADD_TO_FIRST_INSTALLMENT') {
        lines.push({ account: GL.FEES_RECEIVABLE, debit: amount.plus(gst), loanId: id, customerId: loan.customer_id, memo: `${f.label ?? f.code} (with installment 1)` });
      }
      lines.push({ account: GL.feeIncome(f.code), credit: amount, loanId: id, memo: f.label ?? f.code });
      if (gst.isPositive()) lines.push({ account: GL.GST_OUTPUT, credit: gst, loanId: id, memo: `GST on ${f.label ?? f.code}` });
    }
    const entry = await this.ledger.post(tx, {
      entryType: 'DISBURSEMENT',
      valueDate: d.disbursedOn,
      branchId: loan.branch_id,
      sourceType: 'loan',
      sourceId: id,
      narration: `Disbursement of loan ${loan.loan_no}`,
      lines,
      createdBy: ctx.auth.userId,
    });

    for (const f of fees) {
      await tx
        .insertInto('loan_charges')
        .values({
          loan_id: id,
          charge_type: 'FEE',
          code: f.code,
          description: f.label ?? f.code,
          amount: f.amount,
          gst_amount: f.gstAmount ?? '0',
          collection_mode: f.mode,
          assessed_on: d.disbursedOn,
          status: f.mode === 'DEDUCT_FROM_DISBURSAL' ? 'DEDUCTED' : 'OPEN',
          journal_entry_id: entry.id,
        })
        .execute();
    }
    await tx
      .updateTable('loans')
      .set({
        status: 'ACTIVE',
        disbursed_at: new Date(),
        disbursed_on: d.disbursedOn,
        disbursement_account_id: account.id,
        disbursement_mode: d.mode,
        disbursement_reference: d.reference ?? null,
        disbursement_journal_id: entry.id,
        version: loan.version + 1,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    const assets = await tx.selectFrom('assets').select(['id', 'status']).where('loan_id', '=', id).execute();
    for (const a of assets) {
      await tx.updateTable('assets').set({ status: 'ACTIVE', updated_at: new Date() }).where('id', '=', a.id).execute();
      await tx.insertInto('asset_events').values({ asset_id: a.id, from_status: a.status, to_status: 'ACTIVE', reason: 'Loan disbursed', actor_id: ctx.auth.userId }).execute();
    }
    await this.refreshBalances(tx, [id], today);
    await this.event(tx, loan.customer_id, id, ctx.auth.userId, 'LOAN_DISBURSED', `Loan ${loan.loan_no} disbursed: ₹${Number(loan.net_disbursement).toLocaleString('en-IN')} paid (${d.mode.toLowerCase().replace('_', ' ')})`);
    await this.audit.record(tx, ctx, {
      action: 'loan.disbursed',
      entityType: 'loan',
      entityId: id,
      branchId: loan.branch_id,
      oldValues: { status: 'APPROVED' },
      newValues: { status: 'ACTIVE', disbursedOn: d.disbursedOn, account: account.code, mode: d.mode, reference: d.reference ?? null, netPaid: loan.net_disbursement, journal: entry.entryNo },
    });
    const customer = await tx.selectFrom('customers').select('full_name').where('id', '=', loan.customer_id).executeTakeFirstOrThrow();
    const first = await tx.selectFrom('loan_installments').select(['total_due', 'due_date']).where('loan_id', '=', id).where('installment_no', '=', 1).executeTakeFirstOrThrow();
    await this.messaging.notify(tx, {
      eventCode: 'LOAN_DISBURSED',
      customerId: loan.customer_id,
      loanId: id,
      vars: { name: customer.full_name, loan_no: loan.loan_no, amount: fmtAmount(loan.principal), installment: fmtAmount(first.total_due ?? '0'), due_date: fmtDate(first.due_date) },
      triggeredBy: 'AUTO',
      createdBy: ctx.auth.userId,
      dedupeKey: `DISB:${id}`,
    });
    return { id, status: 'ACTIVE', journalEntryNo: entry.entryNo };
  }

  /* =========================== Balances =========================== */

  /**
   * Recompute the loan's summary balances from its installments (the source of truth for dues).
   * Called in the same transaction as every change, and nightly for every active loan.
   */
  async refreshBalances(db: Executor, loanIds: string[] | 'ALL_ACTIVE', today: string) {
    await sql`
      WITH s AS (
        SELECT i.loan_id,
          sum(i.principal_due - i.principal_paid) AS principal_os,
          sum(CASE WHEN i.interest_accrued_at IS NOT NULL THEN i.interest_due - i.interest_paid ELSE 0 END) AS interest_os,
          sum(i.fees_due - i.fees_paid) AS fees_os,
          sum(i.penalty_due - i.penalty_paid) AS penalty_os,
          sum(i.total_due - i.total_paid) AS balance,
          sum(CASE WHEN i.due_date < ${today}::date THEN i.total_due - i.total_paid ELSE 0 END) AS overdue,
          coalesce(max(CASE WHEN i.due_date < ${today}::date AND i.total_due > i.total_paid THEN ${today}::date - i.due_date END), 0) AS dpd,
          min(i.due_date) FILTER (WHERE i.due_date >= ${today}::date AND i.total_due > i.total_paid) AS next_due
        FROM loan_installments i
        WHERE i.status <> 'RESCHEDULED'
          AND i.loan_id IN (SELECT id FROM loans WHERE status = 'ACTIVE' ${loanIds === 'ALL_ACTIVE' ? sql`` : sql`AND id = ANY(${loanIds}::uuid[])`})
        GROUP BY i.loan_id
      )
      UPDATE loans l SET
        principal_outstanding = s.principal_os,
        interest_outstanding = s.interest_os,
        fees_outstanding = s.fees_os,
        penalty_outstanding = s.penalty_os,
        balance_payable = s.balance,
        overdue_amount = s.overdue,
        dpd = s.dpd,
        next_due_date = s.next_due,
        next_due_amount = (SELECT i.total_due - i.total_paid FROM loan_installments i
                           WHERE i.loan_id = l.id AND i.due_date = s.next_due AND i.status <> 'RESCHEDULED' LIMIT 1),
        updated_at = now()
      FROM s WHERE s.loan_id = l.id`.execute(db);
  }

  /* =========================== Reads =========================== */

  async list(auth: AuthContext, q: { limit: number; cursor?: string; q?: string; status?: string; category?: string; branchId?: string; customerId?: string; overdueOnly?: string }) {
    let sel = this.scoped(this.db, auth)
      .select([
        'l.id',
        'l.loan_no',
        'l.status',
        'l.category',
        'l.principal',
        'l.annual_rate',
        'l.interest_method',
        'l.frequency',
        'l.num_installments',
        'l.installment_amount',
        'l.balance_payable',
        'l.principal_outstanding',
        'l.overdue_amount',
        'l.dpd',
        'l.next_due_date',
        'l.next_due_amount',
        'l.created_at',
        'l.disbursed_on',
        'c.id as customer_id',
        'c.full_name as customer_name',
        'c.customer_no',
        'b.code as branch_code',
        (eb) =>
          eb
            .selectFrom('assets as a')
            .select(sql<string>`coalesce(a.registration_no, nullif(concat_ws(' ', a.make, a.model), ''), a.description)`.as('x'))
            .whereRef('a.loan_id', '=', 'l.id')
            .limit(1)
            .as('asset_label'),
      ])
      .orderBy('l.id', 'desc')
      .limit(q.limit + 1);
    if (q.cursor) sel = sel.where('l.id', '<', q.cursor);
    if (q.status) sel = sel.where('l.status', '=', q.status);
    if (q.category) sel = sel.where('l.category', '=', q.category);
    if (q.branchId) sel = sel.where('l.branch_id', '=', q.branchId);
    if (q.customerId) sel = sel.where('l.customer_id', '=', q.customerId);
    if (q.overdueOnly === 'true') sel = sel.where('l.dpd', '>', 0);
    if (q.q) {
      const t = q.q.replace(/[%_\\]/g, '');
      sel = sel.where((eb) => eb.or([eb('l.loan_no', 'ilike', `%${t}%`), eb('c.full_name', 'ilike', `%${t}%`), eb('c.customer_no', 'ilike', `${t}%`)]));
    }
    const rows = await sel.execute();
    const hasMore = rows.length > q.limit;
    const data = rows.slice(0, q.limit);
    return { data, nextCursor: hasMore ? data[data.length - 1]!.id : null };
  }

  async get(auth: AuthContext, id: string) {
    const l = await this.scoped(this.db, auth)
      .selectAll('l')
      .select(['c.full_name as customer_name', 'c.customer_no', 'c.mobile as customer_mobile', 'c.kyc_status as customer_kyc', 'b.code as branch_code', 'b.name as branch_name'])
      .where('l.id', '=', id)
      .executeTakeFirst();
    if (!l) throw notFound('Loan');
    const [product, installments, assets, charges, users, account] = await Promise.all([
      this.product(l.product_id),
      this.db.selectFrom('loan_installments').selectAll().where('loan_id', '=', id).where('status', '<>', 'RESCHEDULED').orderBy('installment_no').execute(),
      this.db.selectFrom('assets').selectAll().where('loan_id', '=', id).execute(),
      this.db.selectFrom('loan_charges').selectAll().where('loan_id', '=', id).orderBy('assessed_on').orderBy('created_at').execute(),
      this.db
        .selectFrom('users')
        .select(['id', 'full_name'])
        .where('id', 'in', [l.created_by, l.approved_by, l.rejected_by, l.submitted_by, l.cancelled_by].filter((x): x is string => !!x).concat(NONE))
        .execute(),
      l.disbursement_account_id ? this.db.selectFrom('accounts').select(['code', 'name']).where('id', '=', l.disbursement_account_id).executeTakeFirst() : undefined,
    ]);
    const name = (uid: string | null) => users.find((u) => u.id === uid)?.full_name ?? null;
    return {
      ...l,
      customer_mobile: auth.permissions.has('customer.view_contact') ? l.customer_mobile : mask.mobile(l.customer_mobile),
      calc_snapshot: undefined,
      product: { id: product.id, code: product.code, name: product.name, version: product.version, approvalLimit: product.approval_limit },
      installments,
      assets,
      charges,
      people: {
        createdBy: name(l.created_by),
        submittedBy: name(l.submitted_by),
        approvedBy: name(l.approved_by),
        rejectedBy: name(l.rejected_by),
        cancelledBy: name(l.cancelled_by),
      },
      disbursementAccount: account ?? null,
      canDecide: l.created_by !== auth.userId,
    };
  }

  async assetById(auth: AuthContext, assetId: string) {
    const a = await this.db.selectFrom('assets').selectAll().where('id', '=', assetId).executeTakeFirst();
    if (!a) throw notFound('Asset');
    await this.get(auth, a.loan_id); // scope check
    return a;
  }
}
