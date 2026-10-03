import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { mask, templateVariables } from '@fin/contracts';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { istMinutesSinceMidnight, istToday } from '../common/dates';
import { badRequest, notFound, unprocessable } from '../common/errors';
import { AppConfig, CONFIG } from '../config/config';
import { DB_TOKEN, Db, Executor } from '../db/db';
import { isForward, MessageProvider, ProviderError, smsProvider, whatsappProvider } from './providers';

export type Channel = 'SMS' | 'WHATSAPP';
export type EventCode = 'PAYMENT_RECEIVED' | 'DUE_REMINDER' | 'OVERDUE' | 'LOAN_DISBURSED' | 'LOAN_CLOSED' | 'PAYMENT_REVERSED';

/** Placeholders each event can fill. Template edits may only use these. */
export const EVENT_VARIABLES: Record<EventCode, string[]> = {
  PAYMENT_RECEIVED: ['name', 'amount', 'loan_no', 'date', 'receipt_no', 'balance', 'company'],
  DUE_REMINDER: ['name', 'amount', 'loan_no', 'due_date', 'company'],
  OVERDUE: ['name', 'amount', 'loan_no', 'due_date', 'company'],
  LOAN_DISBURSED: ['name', 'loan_no', 'amount', 'installment', 'due_date', 'company'],
  LOAN_CLOSED: ['name', 'loan_no', 'company'],
  PAYMENT_REVERSED: ['name', 'receipt_no', 'amount', 'loan_no', 'company'],
};

const MAX_ATTEMPTS = 5;
const MANUAL_PER_LOAN_PER_DAY = 3;

export const fmtAmount = (v: string | Money) => (typeof v === 'string' ? Money.of(v) : v).format({ symbol: false });
export const fmtDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/**
 * Reminders respect quiet hours (09:00–20:00 IST) so customers are not messaged at night ⚖.
 * Returns when a reminder created now may go out.
 */
export function quietHoursAvailableAt(now = new Date()): Date {
  const m = istMinutesSinceMidnight(now);
  if (m >= 9 * 60 && m < 20 * 60) return now;
  const today = istToday(now);
  const nineToday = new Date(`${today}T09:00:00+05:30`);
  return m < 9 * 60 ? nineToday : new Date(nineToday.getTime() + 86_400_000);
}

export interface QueueRequest {
  channel: Channel;
  eventCode: EventCode;
  customerId: string;
  loanId: string;
  paymentId?: string | null;
  installmentId?: string | null;
  vars: Record<string, string>;
  /** 'AUTO' or the user id who asked for it. */
  triggeredBy: string;
  createdBy?: string | null;
  dedupeKey?: string;
  availableAt?: Date;
}

@Injectable()
export class MessagingService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Messaging');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private companyName?: string;
  readonly sms: MessageProvider;
  readonly whatsapp: MessageProvider;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {
    this.sms = smsProvider(config);
    this.whatsapp = whatsappProvider(config);
  }

  onApplicationBootstrap() {
    if (!this.config.workers) return;
    this.timer = setInterval(() => {
      if (!this.stopped && !this.running) void this.relayOnce().catch((e) => this.log.error(e));
    }, 15_000);
  }

  onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  providers() {
    return {
      sms: { provider: this.sms.key, live: this.sms.key !== 'log' },
      whatsapp: { provider: this.whatsapp.key, live: this.whatsapp.key !== 'log' },
      webhooks: { msg91: !!this.config.sms.webhookToken, whatsapp: !!(this.config.whatsapp.appSecret && this.config.whatsapp.verifyToken) },
    };
  }

  async company(db: Executor = this.db): Promise<string> {
    if (!this.companyName) {
      const c = await db.selectFrom('companies').select(['legal_name', 'trade_name']).executeTakeFirst();
      this.companyName = c?.trade_name ?? c?.legal_name ?? 'Finance';
    }
    return this.companyName;
  }

  render(body: string, vars: Record<string, string>): { text: string; params: string[]; missing: string[] } {
    const names = templateVariables(body);
    const missing = names.filter((n) => vars[n] === undefined || vars[n] === '');
    return { text: body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => vars[k] ?? ''), params: names.map((n) => vars[n] ?? ''), missing };
  }

  /**
   * Put a message in the queue (inside the caller's transaction, so it only exists if the business
   * change commits). Consent, template and number problems are recorded as SKIPPED with the reason —
   * never silently dropped.
   */
  async queue(db: Executor, q: QueueRequest): Promise<{ id: string | null; status: string; reason?: string }> {
    const [customer, template] = await Promise.all([
      db.selectFrom('customers').select(['mobile', 'whatsapp_opt_in']).where('id', '=', q.customerId).executeTakeFirstOrThrow(),
      db.selectFrom('message_templates').selectAll().where('event_code', '=', q.eventCode).where('channel', '=', q.channel).where('language', '=', 'en').executeTakeFirst(),
    ]);
    const vars = { company: await this.company(db), ...q.vars };
    let skip: string | null = null;
    if (!customer.mobile) skip = 'Customer has no mobile number';
    else if (q.channel === 'WHATSAPP' && !customer.whatsapp_opt_in) skip = 'Customer has not agreed to WhatsApp messages';
    else if (!template) skip = 'No template for this message';
    else if (!template.is_active) skip = 'Template is switched off';
    const r = template ? this.render(template.body, vars) : { text: '', params: [], missing: [] };
    if (!skip && r.missing.length) skip = `Missing values: ${r.missing.join(', ')}`;
    const row = await db
      .insertInto('messages')
      .values({
        channel: q.channel,
        event_code: q.eventCode,
        template_id: template?.id ?? null,
        customer_id: q.customerId,
        loan_id: q.loanId,
        payment_id: q.paymentId ?? null,
        installment_id: q.installmentId ?? null,
        to_number: customer.mobile ?? '',
        body: r.text || `(${q.eventCode})`,
        params: JSON.stringify(r.params),
        status: skip ? 'SKIPPED' : 'QUEUED',
        skip_reason: skip,
        triggered_by: q.triggeredBy,
        created_by: q.createdBy ?? null,
        available_at: q.availableAt ?? new Date(),
        dedupe_key: q.dedupeKey ?? null,
      })
      .onConflict((oc) => oc.column('dedupe_key').doNothing())
      .returning(['id', 'status'])
      .executeTakeFirst();
    if (!row) return { id: null, status: 'DUPLICATE' };
    return { id: row.id, status: row.status, ...(skip ? { reason: skip } : {}) };
  }

  /** Queue on SMS, and on WhatsApp too when the customer has agreed to it. */
  async notify(db: Executor, q: Omit<QueueRequest, 'channel'>) {
    const consent = await db.selectFrom('customers').select('whatsapp_opt_in').where('id', '=', q.customerId).executeTakeFirstOrThrow();
    const out = [await this.queue(db, { ...q, channel: 'SMS', dedupeKey: q.dedupeKey ? `${q.dedupeKey}:SMS` : undefined })];
    if (consent.whatsapp_opt_in) out.push(await this.queue(db, { ...q, channel: 'WHATSAPP', dedupeKey: q.dedupeKey ? `${q.dedupeKey}:WA` : undefined }));
    return out;
  }

  /* ----------------------------- Relay ----------------------------- */

  /** Send up to `limit` due messages. Safe to run on several API instances (SKIP LOCKED). */
  async relayOnce(limit = 20): Promise<{ sent: number; simulated: number; failed: number; retried: number }> {
    this.running = true;
    const stats = { sent: 0, simulated: 0, failed: 0, retried: 0 };
    try {
      // A message stuck in SENDING (process crashed mid-call) may or may not have reached the
      // customer. Don't guess and don't resend: mark it failed with an explanation.
      await sql`UPDATE messages SET status = 'FAILED', failed_at = now(),
                  error_text = 'Interrupted while sending; check the provider dashboard before resending'
                WHERE status = 'SENDING' AND available_at < now() - interval '10 minutes'`.execute(this.db);
      const batch = await this.db.transaction().execute(async (tx) => {
        const ids = await sql<{ id: string }>`
          SELECT id FROM messages WHERE status = 'QUEUED' AND available_at <= now()
          ORDER BY available_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`.execute(tx);
        if (!ids.rows.length) return [];
        return tx
          .updateTable('messages')
          .set((eb) => ({ status: 'SENDING', attempts: eb('attempts', '+', 1), available_at: new Date() }))
          .where('id', 'in', ids.rows.map((r) => r.id))
          .returningAll()
          .execute();
      });
      for (const m of batch) {
        const t = m.template_id ? await this.db.selectFrom('message_templates').selectAll().where('id', '=', m.template_id).executeTakeFirst() : undefined;
        const provider = m.channel === 'SMS' ? this.sms : this.whatsapp;
        try {
          const r = await provider.send({
            to: m.to_number,
            body: m.body,
            params: m.params as unknown as string[],
            dltTemplateId: t?.dlt_template_id ?? null,
            waTemplateName: t?.wa_template_name ?? null,
            waLanguage: t?.wa_language ?? 'en',
          });
          await this.db
            .updateTable('messages')
            .set({ status: r.status, provider: provider.key, provider_message_id: r.providerMessageId, sent_at: new Date(), error_text: null })
            .where('id', '=', m.id)
            .execute();
          await this.db.insertInto('message_events').values({ message_id: m.id, source: provider.key, status: r.status }).execute();
          if (r.status === 'SENT') stats.sent++;
          else stats.simulated++;
        } catch (e) {
          const retryable = e instanceof ProviderError ? e.retryable : true;
          const giveUp = !retryable || m.attempts >= MAX_ATTEMPTS;
          await this.db
            .updateTable('messages')
            .set({
              status: giveUp ? 'FAILED' : 'QUEUED',
              provider: provider.key,
              error_text: (e as Error).message.slice(0, 500),
              failed_at: giveUp ? new Date() : null,
              available_at: new Date(Date.now() + 2 ** m.attempts * 60_000),
            })
            .where('id', '=', m.id)
            .execute();
          await this.db
            .insertInto('message_events')
            .values({ message_id: m.id, source: provider.key, status: giveUp ? 'FAILED' : 'RETRY', detail: JSON.stringify({ error: (e as Error).message.slice(0, 300) }) })
            .execute();
          if (giveUp) stats.failed++;
          else stats.retried++;
        }
      }
      return stats;
    } finally {
      this.running = false;
    }
  }

  /* ----------------------------- Webhooks ----------------------------- */

  private async applyStatus(provider: string, providerMessageId: string, status: string, detail: Record<string, unknown>) {
    const m = await this.db.selectFrom('messages').select(['id', 'status']).where('provider', '=', provider).where('provider_message_id', '=', providerMessageId).executeTakeFirst();
    await this.db.insertInto('message_events').values({ message_id: m?.id ?? null, source: `${provider}-webhook`, status, detail: JSON.stringify(detail) }).execute();
    if (!m || !isForward(m.status, status)) return false;
    const at = new Date();
    await this.db
      .updateTable('messages')
      .set({
        status,
        ...(status === 'DELIVERED' ? { delivered_at: at } : {}),
        ...(status === 'READ' ? { read_at: at } : {}),
        ...(status === 'FAILED' ? { failed_at: at, error_text: String(detail.error ?? 'Delivery failed').slice(0, 500) } : {}),
      })
      .where('id', '=', m.id)
      .execute();
    return true;
  }

  /** WhatsApp Cloud API status callbacks (sent / delivered / read / failed). Signature verified by the controller. */
  async whatsappWebhook(body: unknown) {
    const MAP: Record<string, string> = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };
    let updated = 0;
    const entries = (body as { entry?: { changes?: { value?: { statuses?: unknown[] } }[] }[] })?.entry ?? [];
    for (const e of entries) {
      for (const c of e.changes ?? []) {
        for (const s of (c.value?.statuses ?? []) as { id?: string; status?: string; errors?: { code?: number; title?: string }[] }[]) {
          const status = MAP[String(s.status)];
          if (!s.id || !status) continue;
          const err = s.errors?.[0];
          if (await this.applyStatus('meta', String(s.id), status, { status: s.status, ...(err ? { error: `${err.code ?? ''} ${err.title ?? ''}`.trim() } : {}) })) updated++;
        }
      }
    }
    return { updated };
  }

  /** MSG91 delivery reports. Accepts the JSON array form or a `data` field containing it. */
  async msg91Webhook(body: unknown) {
    let items: unknown = body;
    if (items && typeof items === 'object' && !Array.isArray(items) && 'data' in items) {
      const d = (items as { data: unknown }).data;
      try {
        items = typeof d === 'string' ? JSON.parse(d) : d;
      } catch {
        throw badRequest('INVALID_PAYLOAD', 'data is not valid JSON');
      }
    }
    if (!Array.isArray(items)) throw badRequest('INVALID_PAYLOAD', 'Expected a list of delivery reports');
    let updated = 0;
    for (const it of items as { requestId?: string; report?: { desc?: string; status?: string }[] }[]) {
      if (!it.requestId) continue;
      for (const r of it.report ?? []) {
        const desc = String(r.desc ?? '').toUpperCase();
        const status = desc.includes('DELIVERED') ? 'DELIVERED' : /FAIL|REJECT|NDNC|BLOCK|EXPIRED/.test(desc) ? 'FAILED' : null;
        if (status && (await this.applyStatus('msg91', String(it.requestId), status, { desc, ...(status === 'FAILED' ? { error: desc } : {}) }))) updated++;
      }
    }
    return { updated };
  }

  /* ----------------------------- Reminders ----------------------------- */

  /** Due / overdue reminders for `date` by the configured rules. Each rule fires once per installment. */
  async queueReminders(db: Executor, date: string): Promise<number> {
    const rows = await sql<{
      rule_id: string; channel: Channel; event_code: EventCode; inst_id: string; due_date: string; os: string;
      loan_id: string; loan_no: string; overdue_amount: string; customer_id: string; full_name: string;
    }>`
      SELECT r.id rule_id, r.channel, r.event_code, i.id inst_id, i.due_date::text, (i.total_due - i.total_paid)::text os,
             l.id loan_id, l.loan_no, l.overdue_amount::text, l.customer_id, c.full_name
      FROM reminder_rules r
      JOIN loan_installments i ON i.due_date = ${date}::date - r.offset_days
      JOIN loans l ON l.id = i.loan_id AND l.status = 'ACTIVE'
      JOIN customers c ON c.id = l.customer_id
      WHERE r.is_active AND i.status NOT IN ('PAID', 'WAIVED', 'RESCHEDULED')
        AND i.total_due - i.total_paid >= r.min_amount`.execute(db);
    const availableAt = quietHoursAvailableAt();
    let n = 0;
    for (const r of rows.rows) {
      const amount = r.event_code === 'OVERDUE' && Money.of(r.overdue_amount).isPositive() ? r.overdue_amount : r.os;
      const res = await this.queue(db, {
        channel: r.channel,
        eventCode: r.event_code,
        customerId: r.customer_id,
        loanId: r.loan_id,
        installmentId: r.inst_id,
        vars: { name: r.full_name, amount: fmtAmount(amount), loan_no: r.loan_no, due_date: fmtDate(r.due_date) },
        triggeredBy: 'AUTO',
        dedupeKey: `REM:${r.rule_id}:${r.inst_id}`,
        availableAt,
      });
      if (res.id) n++;
    }
    return n;
  }

  /* ----------------------------- Manual send ----------------------------- */

  async sendManual(
    db: Executor,
    ctx: RequestContext,
    loan: { id: string; loan_no: string; customer_id: string; customer_name: string; status: string; next_due_date: string | null; next_due_amount: string | null; overdue_amount: string },
    input: { channel: Channel; eventCode: 'DUE_REMINDER' | 'OVERDUE' | 'PAYMENT_RECEIVED'; paymentId?: string },
  ) {
    const sentToday = await db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('loan_id', '=', loan.id)
      .where('triggered_by', '<>', 'AUTO')
      .where('status', '<>', 'SKIPPED')
      .where('queued_at', '>=', new Date(`${istToday()}T00:00:00+05:30`))
      .executeTakeFirstOrThrow();
    if (Number(sentToday.n) >= MANUAL_PER_LOAN_PER_DAY) {
      throw unprocessable('MESSAGE_LIMIT', `At most ${MANUAL_PER_LOAN_PER_DAY} manual messages per loan per day`);
    }
    let vars: Record<string, string>;
    let paymentId: string | null = null;
    if (input.eventCode === 'DUE_REMINDER') {
      if (!loan.next_due_date || !loan.next_due_amount) throw unprocessable('NOTHING_DUE', 'No upcoming installment on this loan');
      vars = { name: loan.customer_name, amount: fmtAmount(loan.next_due_amount), loan_no: loan.loan_no, due_date: fmtDate(loan.next_due_date) };
    } else if (input.eventCode === 'OVERDUE') {
      if (!Money.of(loan.overdue_amount).isPositive()) throw unprocessable('NOTHING_OVERDUE', 'Nothing is overdue on this loan');
      const oldest = await db
        .selectFrom('loan_installments')
        .select(sql<string>`min(due_date)::text`.as('d'))
        .where('loan_id', '=', loan.id)
        .where('status', '=', 'OVERDUE')
        .executeTakeFirst();
      vars = { name: loan.customer_name, amount: fmtAmount(loan.overdue_amount), loan_no: loan.loan_no, due_date: fmtDate(oldest?.d ?? istToday()) };
    } else {
      if (!input.paymentId) throw badRequest('VALIDATION_FAILED', 'Choose the payment to confirm', [{ path: 'paymentId', message: 'Required' }]);
      const p = await db
        .selectFrom('payments as p')
        .innerJoin('receipts as r', 'r.payment_id', 'p.id')
        .select(['p.id', 'p.amount', 'p.value_date', 'p.status', 'r.receipt_no', 'r.snapshot'])
        .where('p.id', '=', input.paymentId)
        .where('p.loan_id', '=', loan.id)
        .executeTakeFirst();
      if (!p) throw notFound('Payment');
      if (p.status === 'REVERSED') throw unprocessable('PAYMENT_REVERSED', 'This payment was reversed');
      paymentId = p.id;
      const snap = p.snapshot as { balanceAfter?: string };
      vars = { name: loan.customer_name, amount: fmtAmount(p.amount), loan_no: loan.loan_no, date: fmtDate(p.value_date), receipt_no: p.receipt_no, balance: fmtAmount(snap.balanceAfter ?? '0') };
    }
    const r = await this.queue(db, {
      channel: input.channel,
      eventCode: input.eventCode,
      customerId: loan.customer_id,
      loanId: loan.id,
      paymentId,
      vars,
      triggeredBy: ctx.auth.userId,
      createdBy: ctx.auth.userId,
    });
    await this.audit.record(db, ctx, { action: 'message.sent_manually', entityType: 'loan', entityId: loan.id, newValues: { channel: input.channel, event: input.eventCode, status: r.status, reason: r.reason ?? null } });
    return r;
  }

  /* ----------------------------- Reads & settings ----------------------------- */

  async list(auth: AuthContext, q: { loanId?: string; customerId?: string; status?: string; channel?: string; limit: number; cursor?: string }) {
    let sel = this.db
      .selectFrom('messages as m')
      .innerJoin('customers as c', 'c.id', 'm.customer_id')
      .leftJoin('loans as l', 'l.id', 'm.loan_id')
      .leftJoin('users as u', 'u.id', 'm.created_by')
      .select([
        'm.id', 'm.channel', 'm.event_code', 'm.to_number', 'm.body', 'm.status', 'm.skip_reason', 'm.error_text', 'm.provider',
        'm.attempts', 'm.queued_at', 'm.sent_at', 'm.delivered_at', 'm.read_at', 'm.failed_at', 'm.available_at', 'm.triggered_by',
        'c.id as customer_id', 'c.full_name as customer_name', 'l.id as loan_id', 'l.loan_no', 'u.full_name as sent_by',
      ])
      .orderBy('m.id', 'desc')
      .limit(q.limit + 1);
    if (auth.scope === 'ASSIGNED') sel = sel.where('l.assigned_collector_id', '=', auth.employeeId ?? '00000000-0000-0000-0000-000000000000');
    else if (auth.scope === 'BRANCH') sel = sel.where('c.branch_id', 'in', auth.branchIds.length ? auth.branchIds : ['00000000-0000-0000-0000-000000000000']);
    if (q.loanId) sel = sel.where('m.loan_id', '=', q.loanId);
    if (q.customerId) sel = sel.where('m.customer_id', '=', q.customerId);
    if (q.status) sel = sel.where('m.status', '=', q.status);
    if (q.channel) sel = sel.where('m.channel', '=', q.channel);
    if (q.cursor) sel = sel.where('m.id', '<', q.cursor);
    const rows = await sel.execute();
    const showNumber = auth.permissions.has('customer.view_contact');
    const data = rows.slice(0, q.limit).map((r) => ({ ...r, to_number: showNumber ? r.to_number : mask.mobile(r.to_number) }));
    return { data, nextCursor: rows.length > q.limit ? data[data.length - 1]!.id : null };
  }

  templates() {
    return this.db.selectFrom('message_templates').selectAll().orderBy('event_code').orderBy('channel').execute();
  }

  async updateTemplate(ctx: RequestContext, id: string, input: { body: string; dltTemplateId?: string | null; waTemplateName?: string | null; waLanguage: string; isActive: boolean }) {
    return this.db.transaction().execute(async (tx) => {
      const t = await tx.selectFrom('message_templates').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!t) throw notFound('Template');
      const vars = templateVariables(input.body);
      const allowed = EVENT_VARIABLES[t.event_code as EventCode];
      const unknown = vars.filter((v) => !allowed.includes(v));
      if (unknown.length) {
        throw badRequest('VALIDATION_FAILED', `Unknown placeholder ${unknown.map((u) => `{{${u}}}`).join(', ')}`, [
          { path: 'body', message: `Allowed: ${allowed.map((a) => `{{${a}}}`).join(' ')}` },
        ]);
      }
      const next = {
        body: input.body,
        variables: vars,
        dlt_template_id: input.dltTemplateId ?? null,
        wa_template_name: input.waTemplateName ?? null,
        wa_language: input.waLanguage,
        is_active: input.isActive,
        updated_at: new Date(),
        updated_by: ctx.auth.userId,
      };
      await tx.updateTable('message_templates').set(next).where('id', '=', id).execute();
      await this.audit.record(tx, ctx, {
        action: 'message.template_updated',
        entityType: 'message_template',
        entityId: id,
        oldValues: { body: t.body, dltTemplateId: t.dlt_template_id, waTemplateName: t.wa_template_name, isActive: t.is_active },
        newValues: { body: next.body, dltTemplateId: next.dlt_template_id, waTemplateName: next.wa_template_name, isActive: next.is_active },
      });
      return { ...t, ...next };
    });
  }

  reminderRules() {
    return this.db.selectFrom('reminder_rules').selectAll().orderBy('channel').orderBy('offset_days').execute();
  }

  async updateReminderRule(ctx: RequestContext, id: string, input: { isActive: boolean; minAmount: string }) {
    return this.db.transaction().execute(async (tx) => {
      const r = await tx.selectFrom('reminder_rules').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!r) throw notFound('Reminder rule');
      await tx.updateTable('reminder_rules').set({ is_active: input.isActive, min_amount: input.minAmount, updated_at: new Date(), updated_by: ctx.auth.userId }).where('id', '=', id).execute();
      await this.audit.record(tx, ctx, {
        action: 'message.reminder_rule_updated',
        entityType: 'reminder_rule',
        entityId: id,
        oldValues: { isActive: r.is_active, minAmount: r.min_amount },
        newValues: { isActive: input.isActive, minAmount: input.minAmount },
      });
      return { ...r, is_active: input.isActive, min_amount: input.minAmount };
    });
  }
}
