import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { differenceSchema, expenseRejectSchema, reversalDecisionSchema, settlementCountSchema, settlementDeclareSchema, statementMappingSchema, unlockSchema } from '@fin/contracts';
import { z } from 'zod';
import { Authenticated, Ctx, RequestContext, Require, RequireRecentAuth } from '../auth/context';
import { istToday } from '../common/dates';
import { ApiError, forbidden, parse } from '../common/errors';
import { SettlementsService } from './settlements.service';
import { StatementsService } from './statements.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;

@Controller('reconciliation')
export class ReconciliationController {
  constructor(
    private readonly settlements: SettlementsService,
    private readonly statements: StatementsService,
  ) {}

  /* ---------------- Settlements ---------------- */

  /** An employee's day: own (settlement.submit) or anyone in scope (recon.view). */
  @Authenticated()
  @Get('settlements/:employeeId/:date')
  settlement(@Ctx() ctx: RequestContext, @Param('employeeId', ParseUUIDPipe) employeeId: string, @Param('date') date: string) {
    if (!ctx.auth.permissions.has('recon.view') && !(ctx.auth.permissions.has('settlement.submit') && ctx.auth.employeeId === employeeId)) throw forbidden();
    return this.settlements.get(ctx.auth, employeeId, parse(isoDate, date));
  }

  @Authenticated()
  @Post('settlements/:employeeId/:date/declare')
  @HttpCode(200)
  declare(@Ctx() ctx: RequestContext, @Param('employeeId', ParseUUIDPipe) employeeId: string, @Param('date') date: string, @Body() body: unknown) {
    if (!ctx.auth.permissions.has('settlement.submit') && !ctx.auth.permissions.has('settlement.verify')) throw forbidden();
    const b = parse(settlementDeclareSchema, body);
    return this.settlements.declare(ctx, employeeId, parse(isoDate, date), b.declaredCash, b.note);
  }

  @Require('settlement.verify')
  @Post('settlements/:employeeId/:date/count')
  @HttpCode(200)
  count(@Ctx() ctx: RequestContext, @Param('employeeId', ParseUUIDPipe) employeeId: string, @Param('date') date: string, @Body() body: unknown) {
    return this.settlements.count(ctx, employeeId, parse(isoDate, date), parse(settlementCountSchema, body).countedCash);
  }

  @Require('settlement.verify')
  @Post('settlements/:id/differences')
  difference(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.settlements.addDifference(ctx, id, parse(differenceSchema, body));
  }

  @Require('difference.approve')
  @RequireRecentAuth()
  @Post('differences/:id/approve')
  @HttpCode(200)
  approveDifference(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.settlements.decideDifference(ctx, id, true, parse(reversalDecisionSchema, body ?? {}).note);
  }

  @Require('difference.approve')
  @Post('differences/:id/reject')
  @HttpCode(200)
  rejectDifference(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.settlements.decideDifference(ctx, id, false, parse(expenseRejectSchema, body).reason);
  }

  /* ---------------- Branch day ---------------- */

  @Require('recon.view')
  @Get('days/:branchId/:date')
  day(@Ctx() ctx: RequestContext, @Param('branchId', ParseUUIDPipe) branchId: string, @Param('date') date: string) {
    return this.settlements.day(ctx.auth, branchId, parse(isoDate, date));
  }

  @Require('day.close')
  @Post('days/:branchId/:date/close')
  @HttpCode(200)
  close(@Ctx() ctx: RequestContext, @Param('branchId', ParseUUIDPipe) branchId: string, @Param('date') date: string) {
    return this.settlements.closeDay(ctx, branchId, parse(isoDate, date));
  }

  @Require('day.close')
  @Post('days/:branchId/:date/reopen-request')
  @HttpCode(200)
  reopenRequest(@Ctx() ctx: RequestContext, @Param('branchId', ParseUUIDPipe) branchId: string, @Param('date') date: string, @Body() body: unknown) {
    return this.settlements.requestReopen(ctx, branchId, parse(isoDate, date), parse(unlockSchema, body).reason);
  }

  @Require('day.reopen')
  @RequireRecentAuth()
  @Post('days/:branchId/:date/reopen')
  @HttpCode(200)
  reopen(@Ctx() ctx: RequestContext, @Param('branchId', ParseUUIDPipe) branchId: string, @Param('date') date: string) {
    return this.settlements.approveReopen(ctx, branchId, parse(isoDate, date));
  }

  @Require('recon.view')
  @Get('board')
  board(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const today = istToday();
    const p = parse(z.object({ from: isoDate.optional(), to: isoDate.default(today), branchId: z.string().uuid().optional() }), q);
    const from = p.from ?? new Date(new Date(`${p.to}T00:00:00Z`).getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
    return this.settlements.board(ctx.auth, from, p.to, p.branchId);
  }

  @Require('recon.view')
  @Get('unconfirmed-receipts')
  async unconfirmed(@Ctx() ctx: RequestContext, @Query('days') days?: string) {
    return { data: await this.statements.unconfirmedReceipts(ctx.auth, days ? parse(z.coerce.number().int().min(0).max(60), days) : 3) };
  }

  /* ---------------- Statements ---------------- */

  @Require('statement.import')
  @Post('statements/preview')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_STATEMENT_BYTES, files: 1, fields: 12 } }))
  preview(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: Record<string, string>) {
    if (!file) throw new ApiError(422, 'EMPTY_FILE', 'Choose a statement file');
    const { accountId, ...m } = body;
    return this.statements.preview(parse(z.string().uuid(), accountId), file, parse(statementMappingSchema, m));
  }

  @Require('statement.import')
  @Post('statements')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_STATEMENT_BYTES, files: 1, fields: 12 } }))
  import(@Ctx() ctx: RequestContext, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: Record<string, string>) {
    if (!file) throw new ApiError(422, 'EMPTY_FILE', 'Choose a statement file');
    const { accountId, acceptInvalid, ...m } = body;
    return this.statements.import(ctx, parse(z.string().uuid(), accountId), file, parse(statementMappingSchema, m), acceptInvalid === 'true');
  }

  @Require('recon.view')
  @Get('statements/imports')
  async imports(@Query('accountId') accountId?: string) {
    return { data: await this.statements.imports(accountId ? parse(z.string().uuid(), accountId) : undefined) };
  }

  @Require('recon.view')
  @Get('statements/lines')
  async lines(@Query() q: unknown) {
    const p = parse(
      z.object({
        accountId: z.string().uuid().optional(),
        status: z.enum(['UNMATCHED', 'SUGGESTED', 'MATCHED', 'IGNORED']).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      q,
    );
    return { data: await this.statements.lines(p) };
  }

  @Require('recon.match')
  @Get('statements/lines/:id/candidates')
  candidates(@Param('id', ParseUUIDPipe) id: string) {
    return this.statements.lineCandidates(id);
  }

  @Require('recon.match')
  @Post('statements/match')
  @HttpCode(200)
  run(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.statements.runMatching(ctx, parse(z.object({ accountId: z.string().uuid().optional() }).strict(), body ?? {}).accountId);
  }

  @Require('recon.match')
  @Post('matches/:id/confirm')
  @HttpCode(200)
  async confirm(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.statements.confirm(ctx, id);
    return { status: 'CONFIRMED' };
  }

  @Require('recon.match')
  @Post('matches/:id/reject')
  @HttpCode(200)
  async reject(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.statements.reject(ctx, id);
    return { status: 'REJECTED' };
  }

  @Require('recon.match')
  @Post('matches/:id/undo')
  @HttpCode(200)
  async undo(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.statements.undo(ctx, id, parse(expenseRejectSchema, body).reason);
    return { status: 'UNDONE' };
  }

  @Require('recon.match')
  @Post('statements/lines/:id/match')
  manual(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(z.object({ type: z.enum(['PAYMENT', 'DEPOSIT', 'DISBURSEMENT', 'EXPENSE']), targetId: z.string().uuid() }).strict(), body);
    return this.statements.manualMatch(ctx, id, b.type, b.targetId);
  }

  @Require('recon.match')
  @Post('statements/lines/:id/ignore')
  @HttpCode(200)
  async ignore(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.statements.ignore(ctx, id, parse(expenseRejectSchema, body).reason);
    return { status: 'IGNORED' };
  }

  @Require('recon.match')
  @Post('statements/lines/:id/suspense')
  @HttpCode(200)
  suspense(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.statements.toSuspense(ctx, id, parse(expenseRejectSchema, body).reason);
  }

  @Require('recon.view')
  @Get('bank/:accountId')
  bank(@Param('accountId', ParseUUIDPipe) accountId: string, @Query('asOf') asOf?: string) {
    return this.statements.bankReconciliation(accountId, asOf ? parse(isoDate, asOf) : istToday());
  }
}
