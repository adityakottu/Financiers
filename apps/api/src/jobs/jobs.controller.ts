import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { isoDateSchema } from '@fin/contracts';
import { z } from 'zod';
import { Ctx, RequestContext, Require } from '../auth/context';
import { istToday } from '../common/dates';
import { parse } from '../common/errors';
import { JobsService } from './jobs.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Require('jobs.run')
  @Get('daily')
  async history() {
    return { data: await this.jobs.history() };
  }

  /** Run (or catch up) end-of-day for a date. Safe to repeat: a finished date is skipped. */
  @Require('jobs.run')
  @Post('daily')
  @HttpCode(200)
  run(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const { date } = parse(z.object({ date: isoDateSchema.optional() }).strict(), body ?? {});
    return this.jobs.runDaily(date ?? istToday(), {
      userId: ctx.auth.userId,
      roles: ctx.auth.roles,
      sessionId: ctx.auth.sessionId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
  }
}
