import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { penaltyForDay, PenaltyRule } from '@fin/loan-engine';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { AuditActor, AuditService } from '../audit/audit.service';
import { istMinutesSinceMidnight, istToday } from '../common/dates';
import { unprocessable } from '../common/errors';
import { AppConfig, CONFIG } from '../config/config';
import { DB_TOKEN, Db, Tx } from '../db/db';
import { GL, LedgerService } from '../ledger/ledger.service';
import { LoansService } from '../lending/loans.service';

const JOB = 'daily.close';
const LOCK_KEY = 7314100;

export interface DailyResult {
  date: string;
  skipped?: boolean;
  statusesUpdated: number;
  interestAccrued: number;
  accrualEntries: number;
  penaltiesAssessed: number;
  penaltyAmount: string;
}

/**
 * End-of-day processing for one business date (doc 02 §10):
 *   1. installment status roll (upcoming / due today / overdue, days overdue)
 *   2. interest accrual on installments falling due (E2: Dr Interest Receivable / Cr Interest Income)
 *   3. penal charges past grace (E3: Dr Penal Receivable / Cr Penal Income)
 *   4. loan balance refresh
 * One transaction per date, guarded by an advisory lock, and recorded in job_runs, so running it
 * twice (two API instances, a retry, a manual run) never double-posts.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Jobs');
  private timer?: NodeJS.Timeout;
  private startup?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly ledger: LedgerService,
    private readonly loans: LoansService,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap() {
    if (this.config.env === 'test') return;
    // Check every 10 minutes; after 00:05 IST, run any business dates not yet processed.
    const tick = () => {
      if (!this.stopped) void this.catchUp().catch((e) => this.log.error(e));
    };
    this.timer = setInterval(tick, 10 * 60_000);
    this.startup = setTimeout(tick, 5_000);
  }

  onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.startup) clearTimeout(this.startup);
  }

  async catchUp(actor: AuditActor = { userId: null }) {
    if (istMinutesSinceMidnight() < 5) return;
    const today = istToday();
    const last = await this.db
      .selectFrom('job_runs')
      .select(sql<string>`max(business_date)::text`.as('d'))
      .where('job', '=', JOB)
      .where('status', '=', 'DONE')
      .executeTakeFirst();
    let d = last?.d ? addDay(last.d) : today;
    while (d <= today) {
      await this.runDaily(d, actor);
      d = addDay(d);
    }
  }

  async runDaily(date: string, actor: AuditActor): Promise<DailyResult> {
    if (date > istToday()) throw unprocessable('FUTURE_DATE', 'End-of-day cannot run for a future date');
    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`.execute(tx);
      const done = await tx.selectFrom('job_runs').select('status').where('job', '=', JOB).where('business_date', '=', date).executeTakeFirst();
      if (done?.status === 'DONE') {
        return { date, skipped: true, statusesUpdated: 0, interestAccrued: 0, accrualEntries: 0, penaltiesAssessed: 0, penaltyAmount: '0.00' };
      }
      const statusesUpdated = await this.rollStatuses(tx, date);
      const accrual = await this.accrueInterest(tx, date);
      const penalty = await this.assessPenalties(tx, date);
      await this.rollStatuses(tx, date); // penalties change balances
      await this.loans.refreshBalances(tx, 'ALL_ACTIVE', date);
      const result: DailyResult = {
        date,
        statusesUpdated,
        interestAccrued: accrual.installments,
        accrualEntries: accrual.entries,
        penaltiesAssessed: penalty.count,
        penaltyAmount: penalty.amount.toString(),
      };
      await tx
        .insertInto('job_runs')
        .values({ job: JOB, business_date: date, status: 'DONE', finished_at: new Date(), details: JSON.stringify(result) })
        .onConflict((oc) => oc.columns(['job', 'business_date']).doUpdateSet({ status: 'DONE', finished_at: new Date(), details: JSON.stringify(result) }))
        .execute();
      await this.audit.recordAs(tx, actor, { action: 'jobs.daily_close', entityType: 'job', entityId: date, newValues: result as unknown as Record<string, unknown> });
      return result;
    });
  }

  /** Status of every open installment of active loans as of `date`. */
  private async rollStatuses(tx: Tx, date: string): Promise<number> {
    const r = await sql`
      UPDATE loan_installments i SET
        status = CASE
          WHEN i.total_paid >= i.total_due THEN 'PAID'
          WHEN i.due_date < ${date}::date THEN 'OVERDUE'
          WHEN i.total_paid > 0 THEN 'PARTIALLY_PAID'
          WHEN i.due_date = ${date}::date THEN 'DUE_TODAY'
          ELSE 'UPCOMING' END,
        days_overdue = CASE WHEN i.due_date < ${date}::date AND i.total_paid < i.total_due THEN ${date}::date - i.due_date ELSE 0 END
      FROM loans l
      WHERE l.id = i.loan_id AND l.status = 'ACTIVE' AND i.status NOT IN ('PAID', 'WAIVED', 'RESCHEDULED')`.execute(tx);
    return Number(r.numAffectedRows ?? 0);
  }

  /** E2 — accrual on due date (decision D1). One entry per loan per run, a line pair per installment. */
  private async accrueInterest(tx: Tx, date: string) {
    const due = await tx
      .selectFrom('loan_installments as i')
      .innerJoin('loans as l', 'l.id', 'i.loan_id')
      .select(['i.id', 'i.loan_id', 'i.installment_no', 'i.interest_due', 'i.due_date', 'l.loan_no', 'l.branch_id', 'l.customer_id'])
      .where('l.status', '=', 'ACTIVE')
      .where('i.status', '<>', 'RESCHEDULED')
      .where('i.interest_accrued_at', 'is', null)
      .where('i.due_date', '<=', date)
      .orderBy('i.loan_id')
      .orderBy('i.installment_no')
      .execute();
    const byLoan = new Map<string, typeof due>();
    for (const i of due) byLoan.set(i.loan_id, [...(byLoan.get(i.loan_id) ?? []), i]);
    let entries = 0;
    for (const [loanId, items] of byLoan) {
      const withInterest = items.filter((i) => Money.of(i.interest_due).isPositive());
      if (withInterest.length) {
        const first = items[0]!;
        await this.ledger.post(tx, {
          entryType: 'ACCRUAL',
          valueDate: date,
          branchId: first.branch_id,
          sourceType: 'loan',
          sourceId: loanId,
          narration: `Interest due on loan ${first.loan_no} (installment ${withInterest.map((i) => i.installment_no).join(', ')})`,
          lines: withInterest.flatMap((i) => [
            { account: GL.INTEREST_RECEIVABLE, debit: Money.of(i.interest_due), loanId, customerId: first.customer_id, memo: `Installment ${i.installment_no} due ${i.due_date}` },
            { account: GL.INTEREST_INCOME, credit: Money.of(i.interest_due), loanId, memo: `Installment ${i.installment_no}` },
          ]),
          createdBy: null,
        });
        entries++;
      }
      await tx.updateTable('loan_installments').set({ interest_accrued_at: new Date() }).where('id', 'in', items.map((i) => i.id)).execute();
    }
    return { installments: due.length, entries };
  }

  /** E3 — penal charges per the loan's frozen penalty rule. At most one assessment per installment per day. */
  private async assessPenalties(tx: Tx, date: string) {
    const overdue = await tx
      .selectFrom('loan_installments as i')
      .innerJoin('loans as l', 'l.id', 'i.loan_id')
      .select([
        'i.id',
        'i.loan_id',
        'i.installment_no',
        'i.due_date',
        'i.penalty_due',
        sql<string>`(i.principal_due + i.interest_due + i.fees_due) - (i.principal_paid + i.interest_paid + i.fees_paid)`.as('overdue_amount'),
        sql<number>`${date}::date - i.due_date`.as('days_overdue'),
        'l.penalty_rule',
        'l.loan_no',
        'l.branch_id',
        'l.customer_id',
      ])
      .where('l.status', '=', 'ACTIVE')
      .where('i.status', 'not in', ['PAID', 'WAIVED', 'RESCHEDULED'])
      .where('i.due_date', '<', date)
      .execute();
    let count = 0;
    let total = Money.zero();
    for (const i of overdue) {
      const rule = i.penalty_rule as unknown as PenaltyRule;
      const amount = penaltyForDay(rule, { daysOverdue: Number(i.days_overdue), overdueAmount: i.overdue_amount, alreadyCharged: i.penalty_due });
      if (!amount.isPositive()) continue;
      const charge = await tx
        .insertInto('loan_charges')
        .values({
          loan_id: i.loan_id,
          installment_id: i.id,
          charge_type: 'PENALTY',
          code: rule.type,
          description: `Penal charge — installment ${i.installment_no} (${i.days_overdue} days overdue)`,
          amount: amount.toString(),
          assessed_on: date,
        })
        .onConflict((oc) => oc.columns(['installment_id', 'assessed_on']).where('charge_type', '=', 'PENALTY').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!charge) continue; // already assessed for this day
      const entry = await this.ledger.post(tx, {
        entryType: 'PENALTY',
        valueDate: date,
        branchId: i.branch_id,
        sourceType: 'loan_charge',
        sourceId: charge.id,
        narration: `Penal charge on loan ${i.loan_no}, installment ${i.installment_no}`,
        lines: [
          { account: GL.PENAL_RECEIVABLE, debit: amount, loanId: i.loan_id, customerId: i.customer_id, memo: `Installment ${i.installment_no}` },
          { account: GL.PENAL_INCOME, credit: amount, loanId: i.loan_id, memo: `Installment ${i.installment_no}` },
        ],
        createdBy: null,
      });
      await tx.updateTable('loan_charges').set({ journal_entry_id: entry.id }).where('id', '=', charge.id).execute();
      await tx
        .updateTable('loan_installments')
        .set((eb) => ({ penalty_due: eb('penalty_due', '+', amount.toString()) }))
        .where('id', '=', i.id)
        .execute();
      count++;
      total = total.plus(amount);
    }
    return { count, amount: total };
  }

  async history(limit = 30) {
    return this.db.selectFrom('job_runs').selectAll().where('job', '=', JOB).orderBy('business_date', 'desc').limit(limit).execute();
  }
}

function addDay(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}
