import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { companySettingsSchema, numberingFormatSchema } from '@fin/contracts';
import { AuditService, diff } from '../audit/audit.service';
import { Authenticated, Ctx, RequestContext, Require } from '../auth/context';
import { parse } from '../common/errors';
import { DB_TOKEN, Db } from '../db/db';
import { NumberingService, SeqType } from '../numbering/numbering.service';

@Controller('settings')
export class SettingsController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
  ) {}

  @Authenticated()
  @Get('company')
  async company() {
    const c = await this.db
      .selectFrom('companies')
      .select(['legal_name', 'trade_name', 'address', 'phone', 'email', 'gstin', 'receipt_footer', 'timezone', 'currency', 'fy_start_month'])
      .executeTakeFirstOrThrow();
    return {
      legalName: c.legal_name,
      tradeName: c.trade_name,
      address: c.address,
      phone: c.phone,
      email: c.email,
      gstin: c.gstin,
      receiptFooter: c.receipt_footer,
      timezone: c.timezone,
      currency: c.currency,
      fyStartMonth: c.fy_start_month,
    };
  }

  @Require('settings.company')
  @Put('company')
  async updateCompany(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const input = parse(companySettingsSchema, body);
    await this.db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom('companies').selectAll().forUpdate().executeTakeFirstOrThrow();
      const next = {
        legal_name: input.legalName,
        trade_name: input.tradeName ?? null,
        address: input.address ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        gstin: input.gstin ?? null,
        receipt_footer: input.receiptFooter ?? null,
      };
      const d = diff(before, next);
      if (!d.changed) return;
      await tx
        .updateTable('companies')
        .set({ ...next, updated_at: new Date(), updated_by: ctx.auth.userId })
        .where('id', '=', before.id)
        .execute();
      await this.audit.record(tx, ctx, {
        action: 'settings.company_updated',
        entityType: 'company',
        entityId: before.id,
        oldValues: d.oldValues,
        newValues: d.newValues,
      });
    });
    return this.company();
  }

  @Require('settings.numbering')
  @Get('numbering')
  async numberingFormats() {
    const rows = await this.db.selectFrom('numbering_formats').select(['seq_type', 'format']).orderBy('seq_type').execute();
    return {
      data: await Promise.all(
        rows.map(async (r) => ({
          seqType: r.seq_type,
          format: r.format,
          perBranch: r.format.includes('{BR}'),
          nextExample: await this.numbering.preview(this.db, r.seq_type as SeqType, r.format),
        })),
      ),
    };
  }

  @Require('settings.numbering')
  @Put('numbering')
  async updateNumbering(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const input = parse(numberingFormatSchema, body);
    await this.db.transaction().execute(async (tx) => {
      const before = await tx
        .selectFrom('numbering_formats')
        .select('format')
        .where('seq_type', '=', input.seqType)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (before.format === input.format) return;
      await tx
        .updateTable('numbering_formats')
        .set({ format: input.format, updated_at: new Date(), updated_by: ctx.auth.userId })
        .where('seq_type', '=', input.seqType)
        .execute();
      await this.audit.record(tx, ctx, {
        action: 'settings.numbering_updated',
        entityType: 'numbering_format',
        entityId: input.seqType,
        oldValues: { format: before.format },
        newValues: { format: input.format },
      });
    });
    return this.numberingFormats();
  }
}
