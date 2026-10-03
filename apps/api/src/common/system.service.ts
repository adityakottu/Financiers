import { Body, Controller, Get, HttpCode, Inject, Injectable, Put } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Authenticated, Ctx, Public, RequestContext, Require, RequireRecentAuth } from '../auth/context';
import { AppConfig, CONFIG } from '../config/config';
import { DB_TOKEN, Db } from '../db/db';
import { parse } from './errors';

export interface Maintenance {
  enabled: boolean;
  message: string | null;
  /** Forced on by the MAINTENANCE_MODE environment variable (cannot be switched off in the app). */
  forced: boolean;
}

/**
 * Maintenance mode (doc 14 §3.1): while on, every change is refused with 503 so a restore or an
 * investigation can run on a frozen database; reading stays possible. Cached for 5 seconds.
 */
@Injectable()
export class SystemService {
  private cache: { at: number; value: Maintenance } | null = null;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async maintenance(): Promise<Maintenance> {
    if (this.cache && Date.now() - this.cache.at < 5_000) return this.cache.value;
    const row = await this.db.selectFrom('system_flags').select('value').where('key', '=', 'maintenance').executeTakeFirst();
    const v = (row?.value ?? {}) as { enabled?: boolean; message?: string | null };
    const value = { enabled: this.config.maintenanceMode || !!v.enabled, message: v.message ?? null, forced: this.config.maintenanceMode };
    this.cache = { at: Date.now(), value };
    return value;
  }

  async setMaintenance(ctx: RequestContext, enabled: boolean, message: string | null) {
    await this.db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom('system_flags').select('value').where('key', '=', 'maintenance').forUpdate().executeTakeFirst();
      await tx
        .insertInto('system_flags')
        .values({ key: 'maintenance', value: JSON.stringify({ enabled, message }), updated_by: ctx.auth.userId })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify({ enabled, message }), updated_by: ctx.auth.userId, updated_at: new Date() }))
        .execute();
      await this.audit.record(tx, ctx, { action: enabled ? 'system.maintenance_on' : 'system.maintenance_off', entityType: 'system', entityId: 'maintenance', oldValues: (before?.value ?? undefined) as Record<string, unknown> | undefined, newValues: { enabled, message } });
    });
    this.cache = null;
    return this.maintenance();
  }
}

const maintenanceSchema = z.object({ enabled: z.boolean(), message: z.string().trim().max(300).optional() }).strict();

@Controller('system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  /** Public so the sign-in page can show the notice. */
  @Public()
  @Get('status')
  async status() {
    const m = await this.system.maintenance();
    return { maintenance: { enabled: m.enabled, message: m.message } };
  }

  @Authenticated()
  @Get('maintenance')
  get() {
    return this.system.maintenance();
  }

  @Require('settings.company')
  @RequireRecentAuth()
  @Put('maintenance')
  @HttpCode(200)
  set(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(maintenanceSchema, body);
    return this.system.setMaintenance(ctx, b.enabled, b.message ?? null);
  }
}
