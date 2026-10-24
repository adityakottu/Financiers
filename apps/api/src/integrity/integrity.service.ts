import { Controller, Get, HttpCode, Inject, Injectable, Logger, Post } from '@nestjs/common';
import { Ctx, RequestContext, Require } from '../auth/context';
import { DB_TOKEN, Db } from '../db/db';
import { runIntegrityChecks } from './checks';

export type IntegrityTrigger = 'NIGHTLY' | 'MANUAL' | 'CLI';

/** Runs the integrity checks and keeps the result (nightly, on demand, and after restores). */
@Injectable()
export class IntegrityService {
  private readonly log = new Logger('Integrity');

  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  async run(trigger: IntegrityTrigger, userId: string | null = null) {
    // Recorded once, complete: integrity_runs is append-only (no UPDATE grant for the app).
    const started = new Date();
    const checks = await runIntegrityChecks(this.db);
    const ok = checks.every((c) => c.ok);
    const run = await this.db.insertInto('integrity_runs').values({ trigger, run_by: userId, started_at: started, finished_at: new Date(), ok, checks: JSON.stringify(checks) }).returning('id').executeTakeFirstOrThrow();
    if (!ok) this.log.error(`INTEGRITY CHECK FAILED: ${checks.filter((c) => !c.ok).map((c) => `${c.code} — ${c.detail}`).join('; ')}`);
    return { id: run.id, ok, checks };
  }

  /** Nightly: once per IST day, after end-of-day processing. */
  async nightly() {
    const done = await this.db.selectFrom('integrity_runs').select('id').where('trigger', '=', 'NIGHTLY').where('started_at', '>', new Date(Date.now() - 20 * 3600_000)).executeTakeFirst();
    if (!done) await this.run('NIGHTLY');
  }

  async latest() {
    return this.db.selectFrom('integrity_runs as r').leftJoin('users as u', 'u.id', 'r.run_by').select(['r.id', 'r.trigger', 'r.started_at', 'r.finished_at', 'r.ok', 'r.checks', 'u.full_name as run_by_name']).orderBy('r.started_at', 'desc').limit(30).execute();
  }
}

@Controller('integrity')
export class IntegrityController {
  constructor(private readonly integrity: IntegrityService) {}

  @Require('audit.view')
  @Get('runs')
  runs() {
    return this.integrity.latest();
  }

  @Require('jobs.run')
  @Post('run')
  @HttpCode(200)
  run(@Ctx() ctx: RequestContext) {
    return this.integrity.run('MANUAL', ctx.auth.userId);
  }
}
