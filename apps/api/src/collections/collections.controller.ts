import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  assignSchema,
  messageSendSchema,
  paymentCreateSchema,
  paymentListQuerySchema,
  paymentPreviewSchema,
  reversalDecisionSchema,
  reversalRejectSchema,
  reversalRequestSchema,
  visitSchema,
} from '@fin/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { Ctx, FinRequest, Public, RequestContext, Require, RequireRecentAuth } from '../auth/context';
import { istToday } from '../common/dates';
import { notFound, parse } from '../common/errors';
import { IdempotencyService } from '../common/idempotency.service';
import { DB_TOKEN, Db } from '../db/db';
import { LoansService } from '../lending/loans.service';
import { MessagingService } from '../messaging/messaging.service';
import { CollectionsService } from './collections.service';
import { PaymentsService } from './payments.service';

@Controller('loans')
export class LoanCollectionsController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly payments: PaymentsService,
    private readonly collections: CollectionsService,
    private readonly idempotency: IdempotencyService,
    private readonly loans: LoansService,
    private readonly messaging: MessagingService,
  ) {}

  /** What a payment of this amount would settle — shown before the collector confirms. */
  @Require('payment.collect')
  @Post(':id/payments/preview')
  @HttpCode(200)
  preview(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.payments.preview(ctx.auth, id, parse(paymentPreviewSchema, body).amount);
  }

  /** Record a payment. Exactly-once: the Idempotency-Key makes retries and double taps safe. */
  @Require('payment.collect')
  @Post(':id/payments')
  async record(@Ctx() ctx: RequestContext, @Req() req: FinRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const key = this.idempotency.keyFrom(req);
    const input = parse(paymentCreateSchema, body);
    const r = await this.idempotency.run(ctx.auth.userId, key, `POST /loans/${id}/payments`, body, async (tx) => ({
      status: 201,
      body: await this.payments.record(tx, ctx, id, input),
    }));
    res.status(r.status);
    if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return r.body;
  }

  @Require('loan.view')
  @Get(':id/collections')
  activity(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.collections.loanActivity(ctx.auth, id);
  }

  @Require('payment.collect')
  @Post(':id/visits')
  visit(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.collections.recordVisit(ctx, id, parse(visitSchema, body));
  }

  @Require('message.send')
  @Post(':id/messages')
  async send(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(messageSendSchema.omit({ loanId: true }), body);
    return this.db.transaction().execute(async (tx) => {
      const loan = await this.loans
        .scoped(tx, ctx.auth)
        .select(['l.id', 'l.loan_no', 'l.customer_id', 'c.full_name as customer_name', 'l.status', 'l.next_due_date', 'l.next_due_amount', 'l.overdue_amount'])
        .where('l.id', '=', id)
        .executeTakeFirst();
      if (!loan) throw notFound('Loan');
      return this.messaging.sendManual(tx, ctx, loan, input);
    });
  }
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Require('payment.view')
  @Get()
  list(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return this.payments.list(ctx.auth, parse(paymentListQuerySchema, q));
  }

  @Require('payment.view')
  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(ctx.auth, id);
  }

  @Require('payment.view')
  @Get(':id/receipt.pdf')
  async receipt(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.payments.receiptPdf(ctx.auth, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${r.filename}"`);
    return new StreamableFile(r.pdf);
  }

  @Require('payment.reverse_request')
  @Post(':id/reversal')
  requestReversal(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.payments.requestReversal(ctx, id, parse(reversalRequestSchema, body));
  }
}

@Controller('reversals')
export class ReversalsController {
  constructor(private readonly payments: PaymentsService) {}

  @Require('payment.view')
  @Get()
  async pending(@Ctx() ctx: RequestContext) {
    return { data: await this.payments.pendingReversals(ctx.auth) };
  }

  @Require('payment.reverse_approve')
  @RequireRecentAuth()
  @Post(':id/approve')
  @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.payments.approveReversal(ctx, id, parse(reversalDecisionSchema, body ?? {}).note);
  }

  @Require('payment.reverse_approve')
  @Post(':id/reject')
  @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.payments.rejectReversal(ctx, id, parse(reversalRejectSchema, body).note);
  }
}

@Controller('collections')
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Require('payment.collect')
  @Get('my-day')
  myDay(@Ctx() ctx: RequestContext) {
    return this.collections.myDay(ctx.auth);
  }

  @Require('collection.view_team')
  @Get('collectors')
  async collectors(@Ctx() ctx: RequestContext, @Query('branchId') branchId?: string) {
    return { data: await this.collections.collectors(ctx.auth, branchId ? parse(z.string().uuid(), branchId) : undefined) };
  }

  @Require('collection.view_team')
  @Get('summary')
  summary(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const p = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), branchId: z.string().uuid().optional() }), q);
    return this.collections.summary(ctx.auth, p.date ?? istToday(), p.branchId);
  }

  @Require('collection.assign')
  @Post('assign')
  @HttpCode(200)
  assign(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.collections.assign(ctx, parse(assignSchema, body));
  }
}

/** Receipt verification from the QR code. Public, rate-limited, minimal data. */
@Controller('public/receipts')
export class PublicReceiptsController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':token')
  verify(@Param('token') token: string) {
    return this.payments.verifyReceipt(token);
  }
}
