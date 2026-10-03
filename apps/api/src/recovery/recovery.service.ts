import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { recoveryActionSchema, recoveryOpenSchema, repossessSchema, saleRequestSchema, stageDefinitionSchema } from '@fin/contracts';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { istToday } from '../common/dates';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { DB_TOKEN, Db, Executor, Tx } from '../db/db';
import { PaymentsService } from '../collections/payments.service';
import { GL, LedgerService } from '../ledger/ledger.service';
import { LoansService } from '../lending/loans.service';
import { NumberingService } from '../numbering/numbering.service';

const NONE = '00000000-0000-0000-0000-000000000000';
/** Stage codes the module itself relies on (seeded; they can be renamed or disabled, not removed). */
const REPOSSESSION_STAGE = 'REPOSSESSION';
const RESOLVED_STAGE = 'RESOLVED';
const WRITTEN_OFF_STAGE = 'WRITTEN_OFF';

type CaseRow = { id: string; case_no: string; loan_id: string; branch_id: string; stage: string; status: string; requested_stage: string | null; requested_by: string | null; version: number };

/**
 * Recovery (docs 01 §Recovery, 07 E13–E14). Cases follow configurable stages; moves into an
 * approval stage, repossession sale and write-off each need a second person. Repossession is
 * recorded as custody of the asset (no posting) ⚖; the sale proceeds settle the loan through the
 * advance, so the loan sub-ledger and the ledger always agree; a write-off removes exactly the
 * receivables on the books (E13).
 */
@Injectable()
export class RecoveryService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly loans: LoansService,
    private readonly payments: PaymentsService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------- Configuration ---------------------------- */

  async stages() {
    return this.db.selectFrom('recovery_stage_definitions').selectAll().orderBy('sort_order').execute();
  }

  async saveStage(ctx: RequestContext, d: z.infer<typeof stageDefinitionSchema>) {
    await this.db.transaction().execute(async (tx) => {
      const codes = new Set((await tx.selectFrom('recovery_stage_definitions').select('code').execute()).map((r) => r.code));
      codes.add(d.code);
      const unknown = d.allowedNext.filter((c) => !codes.has(c));
      if (unknown.length) throw unprocessable('UNKNOWN_STAGE', `Unknown next stage: ${unknown.join(', ')}`);
      if (d.isTerminal && d.allowedNext.length) throw unprocessable('TERMINAL_HAS_NEXT', 'A closing stage cannot lead to another stage');
      if ([WRITTEN_OFF_STAGE, RESOLVED_STAGE, REPOSSESSION_STAGE].includes(d.code) && !d.active) throw unprocessable('STAGE_REQUIRED', 'This stage is used by the system and cannot be disabled');
      if (d.code === WRITTEN_OFF_STAGE && (!d.isTerminal || !d.requiresApproval)) throw unprocessable('STAGE_REQUIRED', 'Written off must stay a closing stage that needs approval');
      const before = await tx.selectFrom('recovery_stage_definitions').selectAll().where('code', '=', d.code).executeTakeFirst();
      const values = { name: d.name, description: d.description ?? null, sort_order: d.sortOrder, requires_approval: d.requiresApproval, is_terminal: d.isTerminal, allowed_next: d.allowedNext, active: d.active, updated_at: new Date(), updated_by: ctx.auth.userId };
      await tx
        .insertInto('recovery_stage_definitions')
        .values({ code: d.code, ...values })
        .onConflict((oc) => oc.column('code').doUpdateSet(values))
        .execute();
      await this.audit.record(tx, ctx, { action: before ? 'recovery.stage_changed' : 'recovery.stage_created', entityType: 'recovery_stage', entityId: d.code, oldValues: before ?? undefined, newValues: d });
    });
    return this.stages();
  }

  async settings() {
    const c = await this.db.selectFrom('companies').select('recovery_auto_open_dpd').executeTakeFirstOrThrow();
    return { autoOpenDpd: c.recovery_auto_open_dpd };
  }

  async saveSettings(ctx: RequestContext, autoOpenDpd: number) {
    await this.db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom('companies').select(['id', 'recovery_auto_open_dpd']).forUpdate().executeTakeFirstOrThrow();
      await tx.updateTable('companies').set({ recovery_auto_open_dpd: autoOpenDpd }).where('id', '=', before.id).execute();
      await this.audit.record(tx, ctx, { action: 'recovery.settings_changed', entityType: 'company', entityId: before.id, oldValues: { autoOpenDpd: before.recovery_auto_open_dpd }, newValues: { autoOpenDpd } });
    });
    return this.settings();
  }

  /* ---------------------------- Reading ---------------------------- */

  private scopedCases(db: Executor, auth: AuthContext) {
    return this.loans
      .scoped(db, auth)
      .innerJoin('recovery_cases as rc', 'rc.loan_id', 'l.id')
      .innerJoin('recovery_stage_definitions as sd', 'sd.code', 'rc.stage')
      .leftJoin('employees as owner', 'owner.id', 'rc.owner_employee_id');
  }

  async list(auth: AuthContext, q: { status?: string; stage?: string; branchId?: string; bucket?: string; q?: string; limit?: number }) {
    const rows = await this.scopedCases(this.db, auth)
      .select([
        'rc.id', 'rc.case_no', 'rc.stage', 'sd.name as stage_name', 'rc.status', 'rc.opened_at', 'rc.dpd_at_open', 'rc.requested_stage', 'rc.closed_at',
        'l.id as loan_id', 'l.loan_no', 'l.status as loan_status', 'l.dpd', 'l.overdue_amount', 'l.balance_payable', 'l.principal_outstanding', 'l.category',
        'c.full_name as customer_name', 'c.customer_no', 'b.code as branch_code', 'owner.full_name as owner_name',
        sql<string | null>`(SELECT max(a.at) FROM recovery_actions a WHERE a.case_id = rc.id AND a.action_type IN ('NOTE','CALL','VISIT'))::text`.as('last_contact_at'),
        sql<number>`(SELECT count(*) FROM assets a WHERE a.loan_id = l.id AND a.status = 'REPOSSESSED')::int`.as('repossessed_assets'),
      ])
      .$if(!!q.status, (qb) => qb.where('rc.status', '=', q.status!))
      .$if(!!q.stage, (qb) => qb.where('rc.stage', '=', q.stage!))
      .$if(!!q.branchId, (qb) => qb.where('l.branch_id', '=', q.branchId!))
      .$if(!!q.bucket, (qb) => {
        const r = { DPD_1_30: [1, 30], DPD_31_60: [31, 60], DPD_61_90: [61, 90], DPD_90_PLUS: [91, 100000] }[q.bucket!] ?? [0, 0];
        return qb.where('l.dpd', '>=', r[0]!).where('l.dpd', '<=', r[1]!);
      })
      .$if(!!q.q, (qb) => qb.where((eb) => eb.or([eb('l.loan_no', 'ilike', `%${q.q}%`), eb('c.full_name', 'ilike', `%${q.q}%`), eb('rc.case_no', 'ilike', `%${q.q}%`)])))
      .orderBy('rc.status', 'desc')
      .orderBy('l.dpd', 'desc')
      .limit(Math.min(q.limit ?? 200, 500))
      .execute();
    const buckets = await this.loans
      .scoped(this.db, auth)
      .select([
        sql<number>`count(*) FILTER (WHERE l.dpd BETWEEN 1 AND 30)::int`.as('DPD_1_30'),
        sql<number>`count(*) FILTER (WHERE l.dpd BETWEEN 31 AND 60)::int`.as('DPD_31_60'),
        sql<number>`count(*) FILTER (WHERE l.dpd BETWEEN 61 AND 90)::int`.as('DPD_61_90'),
        sql<number>`count(*) FILTER (WHERE l.dpd > 90)::int`.as('DPD_90_PLUS'),
        sql<number>`count(*) FILTER (WHERE l.dpd > 0 AND NOT EXISTS (SELECT 1 FROM recovery_cases r WHERE r.loan_id = l.id AND r.status = 'OPEN'))::int`.as('overdue_without_case'),
      ])
      .where('l.status', '=', 'ACTIVE')
      .executeTakeFirstOrThrow();
    return { data: rows, buckets };
  }

  /** Overdue active loans without an open case (candidates for opening one). */
  async candidates(auth: AuthContext) {
    return this.loans
      .scoped(this.db, auth)
      .select(['l.id', 'l.loan_no', 'l.dpd', 'l.overdue_amount', 'c.full_name as customer_name', 'b.code as branch_code'])
      .where('l.status', '=', 'ACTIVE')
      .where('l.dpd', '>', 0)
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('recovery_cases as r').select('r.id').whereRef('r.loan_id', '=', 'l.id').where('r.status', '=', 'OPEN'))))
      .orderBy('l.dpd', 'desc')
      .limit(200)
      .execute();
  }

  async get(auth: AuthContext, id: string) {
    const rc = await this.scopedCases(this.db, auth)
      .selectAll('rc')
      .select([
        'sd.name as stage_name', 'sd.allowed_next', 'sd.is_terminal', 'owner.full_name as owner_name',
        'l.loan_no', 'l.status as loan_status', 'l.dpd', 'l.overdue_amount', 'l.balance_payable', 'l.principal_outstanding', 'l.interest_outstanding', 'l.advance_balance', 'l.next_due_date', 'l.next_due_amount', 'l.category',
        'c.id as customer_id', 'c.full_name as customer_name', 'c.customer_no', 'b.code as branch_code', 'b.name as branch_name',
      ])
      .where('rc.id', '=', id)
      .executeTakeFirst();
    if (!rc) throw notFound('Recovery case');
    const [defs, actions, assets, sales, writeOffs, requester] = await Promise.all([
      this.stages(),
      this.db.selectFrom('recovery_actions as a').leftJoin('users as u', 'u.id', 'a.actor_id').select(['a.id', 'a.action_type', 'a.at', 'a.summary', 'a.details', 'u.full_name as actor_name']).where('a.case_id', '=', id).orderBy('a.at', 'desc').execute(),
      this.db
        .selectFrom('assets as a')
        .leftJoin('asset_repossessions as r', (j) => j.onRef('r.asset_id', '=', 'a.id').on('r.released_on', 'is', null))
        .select(['a.id', 'a.asset_no', 'a.status', 'a.category', 'a.make', 'a.model', 'a.registration_no', 'a.asset_value', 'r.id as repossession_id', 'r.repossessed_on', 'r.location', 'r.condition_notes', 'r.valuation'])
        .where('a.loan_id', '=', rc.loan_id)
        .where('a.status', '<>', 'CANCELLED')
        .execute(),
      this.db.selectFrom('asset_sales as s').leftJoin('users as u', 'u.id', 's.requested_by').leftJoin('users as d', 'd.id', 's.decided_by').leftJoin('accounts as ac', 'ac.id', 's.account_id').selectAll('s').select(['u.full_name as requested_by_name', 'd.full_name as decided_by_name', 'ac.name as account_name']).where('s.loan_id', '=', rc.loan_id).orderBy('s.requested_at', 'desc').execute(),
      this.db.selectFrom('loan_write_offs as w').leftJoin('users as u', 'u.id', 'w.requested_by').leftJoin('users as d', 'd.id', 'w.decided_by').selectAll('w').select(['u.full_name as requested_by_name', 'd.full_name as decided_by_name']).where('w.loan_id', '=', rc.loan_id).orderBy('w.requested_at', 'desc').execute(),
      rc.requested_by ? this.db.selectFrom('users').select('full_name').where('id', '=', rc.requested_by).executeTakeFirst() : undefined,
    ]);
    const byCode = new Map(defs.map((d) => [d.code, d]));
    const next = rc.status === 'OPEN' ? rc.allowed_next.map((c) => byCode.get(c)).filter((d): d is NonNullable<typeof d> => !!d && d.active && d.code !== WRITTEN_OFF_STAGE) : [];
    const p = auth.permissions;
    const me = auth.userId;
    return {
      ...rc,
      requested_by_name: requester?.full_name ?? null,
      nextStages: next.map((d) => ({ code: d.code, name: d.name, requiresApproval: d.requires_approval, isTerminal: d.is_terminal })),
      actions,
      assets,
      sales,
      writeOffs,
      can: {
        note: p.has('recovery.note') && rc.status === 'OPEN',
        manage: p.has('recovery.manage') && rc.status === 'OPEN' && auth.scope !== 'ASSIGNED',
        decideStage: p.has('recovery.approve') && !!rc.requested_stage && rc.requested_by !== me,
        repossess: p.has('recovery.manage') && rc.status === 'OPEN' && rc.stage === REPOSSESSION_STAGE && auth.scope !== 'ASSIGNED',
        decideSale: p.has('recovery.approve'),
        requestWriteOff: p.has('loan.write_off_request') && rc.status === 'OPEN' && rc.loan_status === 'ACTIVE' && !writeOffs.some((w) => w.status === 'PENDING'),
        decideWriteOff: p.has('loan.write_off'),
        me,
      },
    };
  }

  /* ---------------------------- Cases ---------------------------- */

  private async lockCase(tx: Tx, auth: AuthContext, id: string): Promise<CaseRow & { customer_id: string; loan_no: string; loan_status: string }> {
    const rc = await this.loans
      .scoped(tx, auth)
      .innerJoin('recovery_cases as rc', 'rc.loan_id', 'l.id')
      .select(['rc.id', 'rc.case_no', 'rc.loan_id', 'rc.branch_id', 'rc.stage', 'rc.status', 'rc.requested_stage', 'rc.requested_by', 'rc.version', 'l.customer_id', 'l.loan_no', 'l.status as loan_status'])
      .where('rc.id', '=', id)
      .forUpdate('rc')
      .executeTakeFirst();
    if (!rc) throw notFound('Recovery case');
    return rc;
  }

  private async act(tx: Tx, caseId: string, actorId: string | null, type: string, summary: string, details: Record<string, unknown> = {}) {
    await tx.insertInto('recovery_actions').values({ case_id: caseId, actor_id: actorId, action_type: type, summary: summary.slice(0, 1000), details: JSON.stringify(details) }).execute();
  }

  private async firstStage(db: Executor) {
    const s = await db.selectFrom('recovery_stage_definitions').select('code').where('active', '=', true).where('is_terminal', '=', false).where('requires_approval', '=', false).orderBy('sort_order').executeTakeFirst();
    if (!s) throw unprocessable('NO_STAGE', 'No active starting stage is configured for recovery');
    return s.code;
  }

  private async insertCase(tx: Tx, loan: { id: string; branch_id: string; branch_code: string; dpd: number; overdue_amount: string; assigned_collector_id: string | null }, openedBy: string | null, note: string, ownerEmployeeId?: string | null) {
    const caseNo = await this.numbering.next(tx, 'RECOVERY', { branchCode: loan.branch_code });
    const stage = await this.firstStage(tx);
    const rc = await tx
      .insertInto('recovery_cases')
      .values({ case_no: caseNo, loan_id: loan.id, branch_id: loan.branch_id, stage, opened_by: openedBy, dpd_at_open: loan.dpd, overdue_at_open: loan.overdue_amount, owner_employee_id: ownerEmployeeId ?? loan.assigned_collector_id })
      .returning(['id', 'case_no'])
      .executeTakeFirstOrThrow();
    await this.act(tx, rc.id, openedBy, 'OPENED', note, { dpd: loan.dpd, overdue: loan.overdue_amount, stage });
    return rc;
  }

  async open(ctx: RequestContext, input: z.infer<typeof recoveryOpenSchema>) {
    return this.db.transaction().execute(async (tx) => {
      const loan = await this.loans
        .scoped(tx, ctx.auth)
        .select(['l.id', 'l.branch_id', 'b.code as branch_code', 'l.status', 'l.dpd', 'l.overdue_amount', 'l.assigned_collector_id', 'l.loan_no', 'l.customer_id'])
        .where('l.id', '=', input.loanId)
        .forUpdate('l')
        .executeTakeFirst();
      if (!loan) throw notFound('Loan');
      scope.assertBranchWritable(ctx.auth, loan.branch_id);
      if (loan.status !== 'ACTIVE') throw conflict('LOAN_NOT_ACTIVE', 'Recovery cases are opened on active loans');
      if (loan.dpd <= 0) throw unprocessable('NOT_OVERDUE', 'This loan has nothing overdue');
      const existing = await tx.selectFrom('recovery_cases').select('case_no').where('loan_id', '=', loan.id).where('status', '=', 'OPEN').executeTakeFirst();
      if (existing) throw conflict('CASE_OPEN', `Case ${existing.case_no} is already open for this loan`);
      if (input.ownerEmployeeId) {
        const e = await tx.selectFrom('employees').select(['branch_id', 'status']).where('id', '=', input.ownerEmployeeId).executeTakeFirst();
        if (!e || e.status !== 'ACTIVE' || e.branch_id !== loan.branch_id) throw unprocessable('OWNER_INVALID', 'The owner must be an active employee of the loan’s branch');
      }
      const rc = await this.insertCase(tx, loan, ctx.auth.userId, input.note, input.ownerEmployeeId);
      await this.loans.event(tx, loan.customer_id, loan.id, ctx.auth.userId, 'RECOVERY_OPENED', `Recovery case ${rc.case_no} opened at ${loan.dpd} days past due`);
      await this.audit.record(tx, ctx, { action: 'recovery.opened', entityType: 'recovery_case', entityId: rc.id, branchId: loan.branch_id, newValues: { caseNo: rc.case_no, loan: loan.loan_no, dpd: loan.dpd } });
      return rc;
    });
  }

  /** Nightly: open a case for every active loan at or beyond the configured days past due. */
  async autoOpen(tx: Tx, date: string) {
    const { recovery_auto_open_dpd: dpd } = await tx.selectFrom('companies').select('recovery_auto_open_dpd').executeTakeFirstOrThrow();
    if (!dpd) return 0;
    const loans = await tx
      .selectFrom('loans as l')
      .innerJoin('branches as b', 'b.id', 'l.branch_id')
      .select(['l.id', 'l.branch_id', 'b.code as branch_code', 'l.dpd', 'l.overdue_amount', 'l.assigned_collector_id', 'l.customer_id'])
      .where('l.status', '=', 'ACTIVE')
      .where('l.dpd', '>=', dpd)
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('recovery_cases as r').select('r.id').whereRef('r.loan_id', '=', 'l.id').where('r.status', '=', 'OPEN'))))
      .orderBy('l.loan_no')
      .execute();
    for (const l of loans) {
      const rc = await this.insertCase(tx, l, null, `Opened automatically: ${l.dpd} days past due (threshold ${dpd})`);
      await tx.insertInto('customer_events').values({ customer_id: l.customer_id, loan_id: l.id, actor_id: null, event_type: 'RECOVERY_OPENED', summary: `Recovery case ${rc.case_no} opened automatically at ${l.dpd} days past due`, ref_type: 'loan', ref_id: l.id }).execute();
    }
    if (loans.length) await this.audit.recordAs(tx, { userId: null }, { action: 'recovery.auto_opened', entityType: 'job', entityId: date, newValues: { cases: loans.length, threshold: dpd } });
    return loans.length;
  }

  async addAction(ctx: RequestContext, id: string, input: z.infer<typeof recoveryActionSchema>) {
    return this.db.transaction().execute(async (tx) => {
      const rc = await this.lockCase(tx, ctx.auth, id);
      if (rc.status !== 'OPEN') throw conflict('CASE_CLOSED', 'This case is closed');
      await this.act(tx, rc.id, ctx.auth.userId, input.type, input.summary);
      return { ok: true };
    });
  }

  async setOwner(ctx: RequestContext, id: string, ownerEmployeeId: string) {
    return this.db.transaction().execute(async (tx) => {
      const rc = await this.lockCase(tx, ctx.auth, id);
      scope.assertBranchWritable(ctx.auth, rc.branch_id);
      const e = await tx.selectFrom('employees').select(['full_name', 'branch_id', 'status']).where('id', '=', ownerEmployeeId).executeTakeFirst();
      if (!e || e.status !== 'ACTIVE' || e.branch_id !== rc.branch_id) throw unprocessable('OWNER_INVALID', 'The owner must be an active employee of the loan’s branch');
      await tx.updateTable('recovery_cases').set((eb) => ({ owner_employee_id: ownerEmployeeId, version: eb('version', '+', 1) })).where('id', '=', id).execute();
      await this.act(tx, id, ctx.auth.userId, 'NOTE', `Case handed to ${e.full_name}`);
      return { ok: true };
    });
  }

  private async applyStage(tx: Tx, ctx: RequestContext, rc: CaseRow, to: { code: string; name: string; is_terminal: boolean }, note: string, approvedFrom?: string) {
    await tx
      .updateTable('recovery_cases')
      .set((eb) => ({
        stage: to.code,
        requested_stage: null,
        requested_by: null,
        requested_at: null,
        request_note: null,
        version: eb('version', '+', 1),
        ...(to.is_terminal ? { status: 'CLOSED', closed_at: new Date(), closed_by: ctx.auth.userId, close_reason: note } : {}),
      }))
      .where('id', '=', rc.id)
      .execute();
    await this.act(tx, rc.id, ctx.auth.userId, 'STAGE_CHANGED', `${approvedFrom ? 'Approved: ' : ''}moved to ${to.name} — ${note}`, { from: rc.stage, to: to.code, requestedBy: approvedFrom ?? null });
    if (to.is_terminal) await this.act(tx, rc.id, ctx.auth.userId, 'CLOSED', `Case closed at ${to.name}`);
  }

  async moveStage(ctx: RequestContext, id: string, input: { stage: string; note: string }) {
    return this.db.transaction().execute(async (tx) => {
      const rc = await this.lockCase(tx, ctx.auth, id);
      scope.assertBranchWritable(ctx.auth, rc.branch_id);
      if (rc.status !== 'OPEN') throw conflict('CASE_CLOSED', 'This case is closed');
      if (rc.requested_stage) throw conflict('REQUEST_PENDING', 'A stage change is already waiting for approval');
      if (input.stage === WRITTEN_OFF_STAGE) throw unprocessable('USE_WRITE_OFF', 'Ask for a write-off instead; the case closes when it is approved');
      const [from, to] = await Promise.all([
        tx.selectFrom('recovery_stage_definitions').selectAll().where('code', '=', rc.stage).executeTakeFirstOrThrow(),
        tx.selectFrom('recovery_stage_definitions').selectAll().where('code', '=', input.stage).executeTakeFirst(),
      ]);
      if (!to || !to.active) throw unprocessable('UNKNOWN_STAGE', 'This stage does not exist or is disabled');
      if (!from.allowed_next.includes(to.code)) throw unprocessable('STAGE_NOT_ALLOWED', `From ${from.name} a case can move to: ${from.allowed_next.join(', ') || 'nothing'}`);
      if (to.code === RESOLVED_STAGE) {
        const l = await tx.selectFrom('loans').select(['dpd', 'status']).where('id', '=', rc.loan_id).executeTakeFirstOrThrow();
        if (l.status === 'ACTIVE' && l.dpd > 0) throw unprocessable('STILL_OVERDUE', 'The loan is still overdue; it can be marked resolved once the overdue dues are paid');
      }
      if (to.requires_approval) {
        await tx.updateTable('recovery_cases').set((eb) => ({ requested_stage: to.code, requested_by: ctx.auth.userId, requested_at: new Date(), request_note: input.note, version: eb('version', '+', 1) })).where('id', '=', id).execute();
        await this.act(tx, id, ctx.auth.userId, 'STAGE_REQUESTED', `Asked to move to ${to.name} — ${input.note}`, { to: to.code });
        await this.audit.record(tx, ctx, { action: 'recovery.stage_requested', entityType: 'recovery_case', entityId: id, branchId: rc.branch_id, newValues: { to: to.code } });
        return { requested: true };
      }
      await this.applyStage(tx, ctx, rc, to, input.note);
      await this.audit.record(tx, ctx, { action: 'recovery.stage_moved', entityType: 'recovery_case', entityId: id, branchId: rc.branch_id, oldValues: { stage: rc.stage }, newValues: { stage: to.code } });
      return { requested: false };
    });
  }

  async decideStage(ctx: RequestContext, id: string, approve: boolean, note?: string) {
    return this.db.transaction().execute(async (tx) => {
      const rc = await this.lockCase(tx, ctx.auth, id);
      if (!rc.requested_stage) throw conflict('NO_REQUEST', 'No stage change is waiting for approval');
      if (rc.requested_by === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'You asked for this move, so someone else must decide');
      const to = await tx.selectFrom('recovery_stage_definitions').selectAll().where('code', '=', rc.requested_stage).executeTakeFirstOrThrow();
      if (approve) {
        await this.applyStage(tx, ctx, rc, to, note || 'approved', rc.requested_by!);
      } else {
        await tx.updateTable('recovery_cases').set((eb) => ({ requested_stage: null, requested_by: null, requested_at: null, request_note: null, version: eb('version', '+', 1) })).where('id', '=', id).execute();
        await this.act(tx, id, ctx.auth.userId, 'STAGE_REJECTED', `Move to ${to.name} not approved${note ? ` — ${note}` : ''}`, { to: to.code });
      }
      await this.audit.record(tx, ctx, { action: approve ? 'recovery.stage_approved' : 'recovery.stage_rejected', entityType: 'recovery_case', entityId: id, branchId: rc.branch_id, newValues: { to: to.code, note: note ?? null } });
      return { ok: true };
    });
  }

  async close(ctx: RequestContext, id: string, reason: string) {
    return this.db.transaction().execute(async (tx) => {
      const rc = await this.lockCase(tx, ctx.auth, id);
      scope.assertBranchWritable(ctx.auth, rc.branch_id);
      if (rc.status !== 'OPEN') throw conflict('CASE_CLOSED', 'This case is already closed');
      const held = await tx.selectFrom('assets').select('asset_no').where('loan_id', '=', rc.loan_id).where('status', '=', 'REPOSSESSED').executeTakeFirst();
      if (held) throw conflict('ASSET_HELD', `Asset ${held.asset_no} is repossessed; release it or sell it before closing the case`);
      if (rc.requested_stage) throw conflict('REQUEST_PENDING', 'A stage change is waiting for approval');
      await tx.updateTable('recovery_cases').set((eb) => ({ status: 'CLOSED', closed_at: new Date(), closed_by: ctx.auth.userId, close_reason: reason, version: eb('version', '+', 1) })).where('id', '=', id).execute();
      await this.act(tx, id, ctx.auth.userId, 'CLOSED', `Case closed — ${reason}`);
      await this.audit.record(tx, ctx, { action: 'recovery.closed', entityType: 'recovery_case', entityId: id, branchId: rc.branch_id, newValues: { reason } });
      return { ok: true };
    });
  }

  /* ---------------------------- Repossession (custody only) ---------------------------- */

  private async assetFor(tx: Tx, loanId: string, assetId: string) {
    const a = await tx.selectFrom('assets').selectAll().where('id', '=', assetId).where('loan_id', '=', loanId).forUpdate().executeTakeFirst();
    if (!a) throw notFound('Asset');
    return a;
  }

  private assetLabel(a: { make: string | null; model: string | null; registration_no: string | null; asset_no: string }) {
    return [a.make, a.model, a.registration_no].filter(Boolean).join(' ') || a.asset_no;
  }

  async repossess(ctx: RequestContext, caseId: string, input: z.infer<typeof repossessSchema>) {
    return this.db.transaction().execute(async (tx) => {
      const rc = await this.lockCase(tx, ctx.auth, caseId);
      scope.assertBranchWritable(ctx.auth, rc.branch_id);
      if (rc.status !== 'OPEN') throw conflict('CASE_CLOSED', 'This case is closed');
      if (rc.stage !== REPOSSESSION_STAGE) throw unprocessable('STAGE_REQUIRED', 'Repossession can be recorded only after the case has been approved into the Repossession stage');
      if (input.repossessedOn > istToday()) throw unprocessable('FUTURE_DATE', 'The repossession date cannot be in the future');
      const a = await this.assetFor(tx, rc.loan_id, input.assetId);
      if (a.status !== 'ACTIVE') throw conflict('ASSET_STATE', `This asset is ${a.status.toLowerCase()}`);
      await tx.insertInto('asset_repossessions').values({ asset_id: a.id, loan_id: rc.loan_id, case_id: rc.id, repossessed_on: input.repossessedOn, location: input.location, condition_notes: input.conditionNotes, valuation: input.valuation ?? null, recorded_by: ctx.auth.userId }).execute();
      await tx.updateTable('assets').set({ status: 'REPOSSESSED', updated_at: new Date() }).where('id', '=', a.id).execute();
      await tx.insertInto('asset_events').values({ asset_id: a.id, from_status: 'ACTIVE', to_status: 'REPOSSESSED', reason: `Recovery case ${rc.case_no}: kept at ${input.location}`, actor_id: ctx.auth.userId }).execute();
      const label = this.assetLabel(a);
      await this.act(tx, rc.id, ctx.auth.userId, 'REPOSSESSED', `${label} repossessed on ${input.repossessedOn.split('-').reverse().join('/')}, kept at ${input.location}`, { assetId: a.id, valuation: input.valuation ?? null });
      await this.loans.event(tx, rc.customer_id, rc.loan_id, ctx.auth.userId, 'ASSET_REPOSSESSED', `${label} repossessed (case ${rc.case_no})`);
      await this.audit.record(tx, ctx, { action: 'asset.repossessed', entityType: 'asset', entityId: a.id, branchId: rc.branch_id, oldValues: { status: 'ACTIVE' }, newValues: { status: 'REPOSSESSED', on: input.repossessedOn, location: input.location, valuation: input.valuation ?? null } });
      return { ok: true };
    });
  }

  async release(ctx: RequestContext, caseId: string, assetId: string, reason: string) {
    return this.db.transaction().execute(async (tx) => {
      const rc = await this.lockCase(tx, ctx.auth, caseId);
      scope.assertBranchWritable(ctx.auth, rc.branch_id);
      const a = await this.assetFor(tx, rc.loan_id, assetId);
      if (a.status !== 'REPOSSESSED') throw conflict('ASSET_STATE', 'This asset is not repossessed');
      const pending = await tx.selectFrom('asset_sales').select('sale_no').where('asset_id', '=', a.id).where('status', '=', 'PENDING').executeTakeFirst();
      if (pending) throw conflict('SALE_PENDING', `Sale ${pending.sale_no} is waiting for approval; reject it first`);
      await tx.updateTable('asset_repossessions').set({ released_on: istToday(), released_by: ctx.auth.userId, release_reason: reason }).where('asset_id', '=', a.id).where('released_on', 'is', null).execute();
      await tx.updateTable('assets').set({ status: 'ACTIVE', updated_at: new Date() }).where('id', '=', a.id).execute();
      await tx.insertInto('asset_events').values({ asset_id: a.id, from_status: 'REPOSSESSED', to_status: 'ACTIVE', reason: `Released to the customer: ${reason}`, actor_id: ctx.auth.userId }).execute();
      await this.act(tx, rc.id, ctx.auth.userId, 'RELEASED', `${this.assetLabel(a)} released — ${reason}`, { assetId: a.id });
      await this.audit.record(tx, ctx, { action: 'asset.released', entityType: 'asset', entityId: a.id, branchId: rc.branch_id, oldValues: { status: 'REPOSSESSED' }, newValues: { status: 'ACTIVE', reason } });
      return { ok: true };
    });
  }

  /* ---------------------------- Sale (E14) ---------------------------- */

  async requestSale(ctx: RequestContext, caseId: string, input: z.infer<typeof saleRequestSchema>) {
    return this.db.transaction().execute(async (tx) => {
      const rc = await this.lockCase(tx, ctx.auth, caseId);
      scope.assertBranchWritable(ctx.auth, rc.branch_id);
      if (rc.loan_status !== 'ACTIVE') throw conflict('LOAN_NOT_ACTIVE', 'The loan is not active');
      if (input.soldOn > istToday()) throw unprocessable('FUTURE_DATE', 'The sale date cannot be in the future');
      const a = await this.assetFor(tx, rc.loan_id, input.assetId);
      if (a.status !== 'REPOSSESSED') throw conflict('ASSET_STATE', 'Only a repossessed asset can be sold');
      const acct = await tx.selectFrom('accounts').select(['id', 'subtype', 'is_active']).where('id', '=', input.accountId).executeTakeFirst();
      if (!acct || acct.subtype !== 'BANK' || !acct.is_active) throw unprocessable('ACCOUNT_INVALID', 'Sale money must be received in a bank account');
      const saleNo = await this.numbering.next(tx, 'SALE');
      const s = await tx
        .insertInto('asset_sales')
        .values({ sale_no: saleNo, asset_id: a.id, loan_id: rc.loan_id, case_id: rc.id, sale_price: input.salePrice, sold_on: input.soldOn, buyer_name: input.buyerName, buyer_reference: input.buyerReference ?? null, account_id: input.accountId, notes: input.notes ?? null, requested_by: ctx.auth.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.act(tx, rc.id, ctx.auth.userId, 'SALE_REQUESTED', `Sale ${saleNo}: ${this.assetLabel(a)} to ${input.buyerName} for ₹${Money.of(input.salePrice).format({ symbol: false })}`, { saleId: s.id });
      await this.audit.record(tx, ctx, { action: 'asset.sale_requested', entityType: 'asset_sale', entityId: s.id, branchId: rc.branch_id, newValues: { saleNo, price: input.salePrice, buyer: input.buyerName, on: input.soldOn } });
      return { id: s.id, saleNo };
    });
  }

  async decideSale(ctx: RequestContext, saleId: string, approve: boolean, note?: string) {
    return this.db.transaction().execute(async (tx) => {
      const s = await tx.selectFrom('asset_sales').selectAll().where('id', '=', saleId).forUpdate().executeTakeFirst();
      if (!s) throw notFound('Sale');
      const rc = s.case_id ? await this.lockCase(tx, ctx.auth, s.case_id) : null;
      if (!rc) throw notFound('Sale');
      if (s.status !== 'PENDING') throw conflict('INVALID_STATE', `This sale is ${s.status.toLowerCase()}`);
      if (s.requested_by === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'You asked for this sale, so someone else must approve it');
      const a = await this.assetFor(tx, s.loan_id, s.asset_id);
      if (!approve) {
        await tx.updateTable('asset_sales').set({ status: 'REJECTED', decided_by: ctx.auth.userId, decided_at: new Date(), decision_note: note ?? null }).where('id', '=', s.id).execute();
        await this.act(tx, rc.id, ctx.auth.userId, 'SALE_REJECTED', `Sale ${s.sale_no} not approved${note ? ` — ${note}` : ''}`, { saleId: s.id });
        await this.audit.record(tx, ctx, { action: 'asset.sale_rejected', entityType: 'asset_sale', entityId: s.id, branchId: rc.branch_id, newValues: { note: note ?? null } });
        return { ok: true };
      }
      if (a.status !== 'REPOSSESSED') throw conflict('ASSET_STATE', 'The asset is no longer repossessed');
      const r = await this.payments.applySaleProceeds(tx, ctx, s.loan_id, { id: s.id, saleNo: s.sale_no, amount: s.sale_price, accountId: s.account_id, date: s.sold_on, assetLabel: this.assetLabel(a) });
      await tx.updateTable('asset_sales').set({ status: 'APPROVED', decided_by: ctx.auth.userId, decided_at: new Date(), decision_note: note ?? null, applied_amount: Money.of(s.sale_price).minus(Money.of(r.surplus)).minus(Money.of(r.heldForLater)).toString(), surplus_amount: r.surplus, journal_entry_id: r.journalEntryId }).where('id', '=', s.id).execute();
      await tx.updateTable('asset_repossessions').set({ released_on: s.sold_on, released_by: ctx.auth.userId, release_reason: `Sold (${s.sale_no})` }).where('asset_id', '=', a.id).where('released_on', 'is', null).execute();
      await tx.updateTable('assets').set({ status: 'SOLD', updated_at: new Date() }).where('id', '=', a.id).execute();
      await tx.insertInto('asset_events').values({ asset_id: a.id, from_status: 'REPOSSESSED', to_status: 'SOLD', reason: `Sale ${s.sale_no} to ${s.buyer_name}`, actor_id: ctx.auth.userId }).execute();
      const tail = r.closed ? (Money.of(r.surplus).isPositive() ? `; loan settled, ₹${Money.of(r.surplus).format({ symbol: false })} surplus owed to the customer` : '; loan settled') : `; ₹${Money.of(r.heldForLater).format({ symbol: false })} held for installments not yet due — balance still receivable`;
      await this.act(tx, rc.id, ctx.auth.userId, 'SALE_APPROVED', `Sale ${s.sale_no} approved: ₹${Money.of(s.sale_price).format({ symbol: false })} received${tail}`, { saleId: s.id, ...r });
      await this.loans.event(tx, rc.customer_id, s.loan_id, ctx.auth.userId, 'ASSET_SOLD', `Repossessed ${this.assetLabel(a)} sold for ₹${Money.of(s.sale_price).format({ symbol: false })} (${s.sale_no})${tail}`);
      if (r.closed && rc.status === 'OPEN') {
        const resolved = await tx.selectFrom('recovery_stage_definitions').select(['code', 'name', 'is_terminal']).where('code', '=', RESOLVED_STAGE).executeTakeFirstOrThrow();
        await this.applyStage(tx, ctx, rc, resolved, `Loan settled from sale ${s.sale_no}`);
      }
      await this.audit.record(tx, ctx, { action: 'asset.sale_approved', entityType: 'asset_sale', entityId: s.id, branchId: rc.branch_id, newValues: { saleNo: s.sale_no, price: s.sale_price, ...r } });
      return { ok: true, ...r };
    });
  }

  /* ---------------------------- Write-off (E13) ---------------------------- */

  async requestWriteOff(ctx: RequestContext, caseId: string, reason: string) {
    return this.db.transaction().execute(async (tx) => {
      const rc = await this.lockCase(tx, ctx.auth, caseId);
      scope.assertBranchWritable(ctx.auth, rc.branch_id);
      if (rc.status !== 'OPEN') throw conflict('CASE_CLOSED', 'This case is closed');
      if (rc.loan_status !== 'ACTIVE') throw conflict('LOAN_NOT_ACTIVE', 'The loan is not active');
      await this.assertWriteOffPossible(tx, rc.loan_id);
      const w = await tx.insertInto('loan_write_offs').values({ loan_id: rc.loan_id, case_id: rc.id, reason, requested_by: ctx.auth.userId }).returning('id').executeTakeFirstOrThrow();
      await this.act(tx, rc.id, ctx.auth.userId, 'WRITE_OFF_REQUESTED', `Write-off requested — ${reason}`, { writeOffId: w.id });
      await this.audit.record(tx, ctx, { action: 'loan.write_off_requested', entityType: 'loan', entityId: rc.loan_id, branchId: rc.branch_id, newValues: { reason } });
      return { id: w.id };
    });
  }

  private async assertWriteOffPossible(tx: Tx, loanId: string) {
    const pending = await tx.selectFrom('loan_write_offs').select('id').where('loan_id', '=', loanId).where('status', 'in', ['PENDING', 'APPROVED']).executeTakeFirst();
    if (pending) throw conflict('WRITE_OFF_EXISTS', 'A write-off is already requested for this loan');
    const reversal = await tx.selectFrom('payments').select('payment_no').where('loan_id', '=', loanId).where('status', '=', 'REVERSAL_PENDING').executeTakeFirst();
    if (reversal) throw conflict('REVERSAL_PENDING', `Decide the reversal of payment ${reversal.payment_no} first`);
    const cheque = await tx.selectFrom('payments').select('payment_no').where('loan_id', '=', loanId).where('method', '=', 'CHEQUE').where('status', '=', 'POSTED').where('cheque_status', 'in', ['RECEIVED', 'DEPOSITED']).executeTakeFirst();
    if (cheque) throw conflict('CHEQUE_UNCLEARED', `Cheque on payment ${cheque.payment_no} has not cleared yet`);
    const sale = await tx.selectFrom('asset_sales').select('sale_no').where('loan_id', '=', loanId).where('status', '=', 'PENDING').executeTakeFirst();
    if (sale) throw conflict('SALE_PENDING', `Sale ${sale.sale_no} is waiting for approval`);
  }

  /** Receivable balances on the books for one loan (debit-positive), and its advance (credit-positive). */
  async loanBalances(db: Executor, loanId: string) {
    const rows = await sql<{ code: string; bal: string }>`
      SELECT a.code, coalesce(sum(l.debit - l.credit), 0)::text bal FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.loan_id = ${loanId} AND a.code IN (${sql.join([GL.LOAN_RECEIVABLE, GL.INTEREST_RECEIVABLE, GL.FEES_RECEIVABLE, GL.PENAL_RECEIVABLE, GL.CUSTOMER_ADVANCE])})
      GROUP BY a.code`.execute(db);
    const b = (c: string) => Money.of(rows.rows.find((r) => r.code === c)?.bal ?? '0');
    return { principal: b(GL.LOAN_RECEIVABLE), interest: b(GL.INTEREST_RECEIVABLE), fees: b(GL.FEES_RECEIVABLE), penalty: b(GL.PENAL_RECEIVABLE), advance: Money.zero().minus(b(GL.CUSTOMER_ADVANCE)) };
  }

  async decideWriteOff(ctx: RequestContext, id: string, approve: boolean, note?: string) {
    return this.db.transaction().execute(async (tx) => {
      const w = await tx.selectFrom('loan_write_offs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!w) throw notFound('Write-off');
      const loan = await this.loans.scoped(tx, ctx.auth).select(['l.id', 'l.loan_no', 'l.status', 'l.branch_id', 'l.customer_id']).where('l.id', '=', w.loan_id).forUpdate('l').executeTakeFirst();
      if (!loan) throw notFound('Write-off');
      if (w.status !== 'PENDING') throw conflict('INVALID_STATE', `This write-off is ${w.status.toLowerCase()}`);
      if (w.requested_by === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'You asked for this write-off, so someone else must approve it');
      const rc = w.case_id ? await tx.selectFrom('recovery_cases').select(['id', 'case_no', 'loan_id', 'branch_id', 'stage', 'status', 'requested_stage', 'requested_by', 'version']).where('id', '=', w.case_id).forUpdate().executeTakeFirst() : undefined;
      if (!approve) {
        await tx.updateTable('loan_write_offs').set({ status: 'REJECTED', decided_by: ctx.auth.userId, decided_at: new Date(), decision_note: note ?? null }).where('id', '=', id).execute();
        if (rc) await this.act(tx, rc.id, ctx.auth.userId, 'WRITE_OFF_REJECTED', `Write-off not approved${note ? ` — ${note}` : ''}`);
        await this.audit.record(tx, ctx, { action: 'loan.write_off_rejected', entityType: 'loan', entityId: loan.id, branchId: loan.branch_id, newValues: { note: note ?? null } });
        return { ok: true };
      }
      if (loan.status !== 'ACTIVE') throw conflict('LOAN_NOT_ACTIVE', 'The loan is no longer active');
      const today = istToday();
      const b = await this.loanBalances(tx, loan.id);
      const receivable = Money.sum([b.principal, b.interest, b.fees, b.penalty]);
      const advanceUsed = b.advance.min(receivable);
      const amount = receivable.minus(advanceUsed);
      if (!amount.isPositive()) throw unprocessable('NOTHING_TO_WRITE_OFF', 'Nothing remains receivable on the books for this loan');
      const lines = [
        ...(advanceUsed.isPositive() ? [{ account: GL.CUSTOMER_ADVANCE, debit: advanceUsed, loanId: loan.id, customerId: loan.customer_id, memo: 'Advance held, used against the dues' }] : []),
        { account: GL.BAD_DEBTS, debit: amount, loanId: loan.id, customerId: loan.customer_id, memo: 'Written off' },
        ...([['principal', GL.LOAN_RECEIVABLE, 'Principal'], ['interest', GL.INTEREST_RECEIVABLE, 'Interest accrued'], ['fees', GL.FEES_RECEIVABLE, 'Fees'], ['penalty', GL.PENAL_RECEIVABLE, 'Penal charges']] as const)
          .filter(([k]) => b[k].isPositive())
          .map(([k, code, memo]) => ({ account: code, credit: b[k], loanId: loan.id, customerId: loan.customer_id, memo })),
      ];
      const entry = await this.ledger.post(tx, { entryType: 'WRITE_OFF', valueDate: today, branchId: loan.branch_id, sourceType: 'loan_write_off', sourceId: id, narration: `Write-off of loan ${loan.loan_no}`, lines, createdBy: ctx.auth.userId });
      await tx
        .updateTable('loan_write_offs')
        .set({ status: 'APPROVED', decided_by: ctx.auth.userId, decided_at: new Date(), decision_note: note ?? null, written_off_on: today, principal: b.principal.toString(), interest: b.interest.toString(), fees: b.fees.toString(), penalty: b.penalty.toString(), advance_used: advanceUsed.toString(), amount: amount.toString(), journal_entry_id: entry.id })
        .where('id', '=', id)
        .execute();
      await tx.updateTable('loans').set((eb) => ({ status: 'WRITTEN_OFF', written_off_at: new Date(), advance_balance: eb('advance_balance', '-', advanceUsed.toString()), next_due_date: null, next_due_amount: null, version: eb('version', '+', 1), updated_at: new Date() })).where('id', '=', loan.id).execute();
      const assets = await tx.selectFrom('assets').select('id').where('loan_id', '=', loan.id).where('status', '=', 'ACTIVE').execute();
      for (const a of assets) {
        await tx.updateTable('assets').set({ status: 'WRITTEN_OFF', updated_at: new Date() }).where('id', '=', a.id).execute();
        await tx.insertInto('asset_events').values({ asset_id: a.id, from_status: 'ACTIVE', to_status: 'WRITTEN_OFF', reason: `Loan ${loan.loan_no} written off`, actor_id: ctx.auth.userId }).execute();
      }
      const summary = `Loan written off: ₹${amount.format({ symbol: false })} to bad debts (journal ${entry.entryNo})`;
      if (rc) {
        await this.act(tx, rc.id, ctx.auth.userId, 'WRITTEN_OFF', summary, { writeOffId: id, amount: amount.toString() });
        if (rc.status === 'OPEN') {
          const stage = await tx.selectFrom('recovery_stage_definitions').select(['code', 'name', 'is_terminal']).where('code', '=', WRITTEN_OFF_STAGE).executeTakeFirstOrThrow();
          await this.applyStage(tx, ctx, rc, stage, 'write-off approved', w.requested_by);
        }
      }
      await this.loans.event(tx, loan.customer_id, loan.id, ctx.auth.userId, 'LOAN_WRITTEN_OFF', summary);
      await this.audit.record(tx, ctx, { action: 'loan.written_off', entityType: 'loan', entityId: loan.id, branchId: loan.branch_id, oldValues: { status: 'ACTIVE' }, newValues: { status: 'WRITTEN_OFF', amount: amount.toString(), principal: b.principal.toString(), interest: b.interest.toString(), fees: b.fees.toString(), penalty: b.penalty.toString(), advanceUsed: advanceUsed.toString(), journal: entry.entryNo } });
      return { ok: true, amount: amount.toString(), journalNo: entry.entryNo };
    });
  }

  /** Pending decisions for the approver's inbox. */
  async approvals(auth: AuthContext) {
    const branches = scope.branchFilter(auth);
    const ids = branches ? (branches.length ? branches : [NONE]) : null;
    const [stages, sales, writeOffs] = await Promise.all([
      this.db.selectFrom('recovery_cases as rc').innerJoin('loans as l', 'l.id', 'rc.loan_id').innerJoin('users as u', 'u.id', 'rc.requested_by').select(['rc.id', 'rc.case_no', 'rc.requested_stage', 'rc.request_note', 'rc.requested_at', 'u.full_name as requested_by_name', 'l.loan_no']).where('rc.requested_stage', 'is not', null).$if(ids !== null, (q) => q.where('rc.branch_id', 'in', ids!)).execute(),
      this.db.selectFrom('asset_sales as s').innerJoin('loans as l', 'l.id', 's.loan_id').innerJoin('users as u', 'u.id', 's.requested_by').select(['s.id', 's.case_id', 's.sale_no', 's.sale_price', 's.buyer_name', 's.requested_at', 'u.full_name as requested_by_name', 'l.loan_no']).where('s.status', '=', 'PENDING').$if(ids !== null, (q) => q.where('l.branch_id', 'in', ids!)).execute(),
      this.db.selectFrom('loan_write_offs as w').innerJoin('loans as l', 'l.id', 'w.loan_id').innerJoin('users as u', 'u.id', 'w.requested_by').select(['w.id', 'w.case_id', 'w.reason', 'w.requested_at', 'u.full_name as requested_by_name', 'l.loan_no', 'l.balance_payable']).where('w.status', '=', 'PENDING').$if(ids !== null, (q) => q.where('l.branch_id', 'in', ids!)).execute(),
    ]);
    return { stages, sales, writeOffs };
  }
}
