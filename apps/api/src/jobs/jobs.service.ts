import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { penaltyForDay, PenaltyRule } from '@fin/loan-engine';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { AuditActor, AuditService } from '../audit/audit.service';
import { istMinutesSinceMidnight, istToday } from '../common/dates';
import { unprocessable } from '../common/errors';
import { AppConfig, CONFIG } from '../config/config';
import { DB_TOKEN, Db, Tx } from '../db/db';
import { CollectionsService } from '../collections/collections.service';
import { PaymentsService } from '../collections/payments.service';
import { GL, LedgerService } from '../ledger/ledger.service';
import { accrueInterest, rollStatuses } from '../lending/dues';
import { LoansService } from '../lending/loans.service';
import { MessagingService } from '../messaging/messaging.service';

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
  advancesApplied?: number;
  promisesResolved?: number;
  remindersQueued?: number;
}

/**
 * End-of-day processing for one business date (doc 02 §10):
 *   1. installment status roll (upcoming / due today / overdue, days overdue)
 *   2. interest accrual on installments falling due (E2: Dr Interest Receivable / Cr Interest Income)
 *   3. penal charges past grace (E3: Dr Penal Receivable / Cr Penal Income)
 *   4. customer advances applied to installments that fell due
 *   5. loan balance refresh
 *   6. promises to pay resolved (kept / partial / broken)
 *   7. due and overdue reminders queued (sent from 09:00 IST)
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
    private readonly payments: PaymentsService,
    private readonly collections: CollectionsService,
    private readonly messaging: MessagingService,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.workers) return;
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
      const statusesUpdated = await rollStatuses(tx, date);
      const accrual = await accrueInterest(tx, this.ledger, date);
      const penalty = await this.assessPenalties(tx, date);
      const advancesApplied = await this.payments.applyAdvancesDue(tx, date);
      await rollStatuses(tx, date); // penalties and advances change balances
      await this.loans.refreshBalances(tx, 'ALL_ACTIVE', date);
      const promisesResolved = await this.collections.resolvePromises(tx, date);
      const remindersQueued = await this.messaging.queueReminders(tx, date);
      const result: DailyResult = {
        date,
        statusesUpdated,
        interestAccrued: accrual.installments,
        accrualEntries: accrual.entries,
        penaltiesAssessed: penalty.count,
        penaltyAmount: penalty.amount.toString(),
        advancesApplied,
        promisesResolved,
        remindersQueued,
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
