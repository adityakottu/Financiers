import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  asOfQuerySchema,
  chequeBounceSchema,
  chequeClearSchema,
  chequeDepositSchema,
  depositCreateSchema,
  expenseCreateSchema,
  expenseRejectSchema,
  journalListQuerySchema,
  manualJournalSchema,
  periodQuerySchema,
  reversalDecisionSchema,
  reverseReasonSchema,
  unlockSchema,
} from '@fin/contracts';
import type { Permission } from '@fin/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Authenticated, Ctx, RequestContext, Require, RequireRecentAuth } from '../auth/context';
import { istToday } from '../common/dates';
import { ApiError, forbidden, notFound, parse } from '../common/errors';
import { DB_TOKEN, Db } from '../db/db';
import { FilesService, MAX_UPLOAD_BYTES } from '../files/files.service';
import { PaymentsService } from '../collections/payments.service';
import { BankingService } from './banking.service';
import { BooksService } from './books.service';
import { ExpensesService } from './expenses.service';
import { JournalsService } from './journals.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
function anyOf(ctx: RequestContext, ...p: Permission[]) {
  if (!p.some((x) => ctx.auth.permissions.has(x))) throw forbidden();
}
function xlsx(res: Response, name: string, buf: Buffer) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
  return new StreamableFile(buf);
}

@Controller('expenses')
export class ExpensesController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly expenses: ExpensesService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  @Authenticated()
  @Get('categories')
  async categories() {
    return { data: await this.expenses.categories() };
  }

  @Authenticated()
  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    anyOf(ctx, 'expense.submit', 'expense.view');
    const p = parse(
      z.object({
        status: z.enum(['SUBMITTED', 'APPROVED', 'POSTED', 'REJECTED', 'REVERSED']).optional(),
        branchId: z.string().uuid().optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        mine: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      q,
    );
    return { data: await this.expenses.list(ctx.auth, { ...p, mine: p.mine === 'true' }) };
  }

  @Authenticated()
  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    anyOf(ctx, 'expense.submit', 'expense.view');
    return this.expenses.get(ctx.auth, id);
  }

  @Require('expense.submit')
  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.expenses.create(ctx, parse(expenseCreateSchema, body));
  }

  @Require('expense.approve')
  @Post(':id/approve')
  @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.approve(ctx, id);
  }

  @Require('expense.post')
  @Post(':id/post')
  @HttpCode(200)
  post(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.post(ctx, id);
  }

  @Authenticated()
  @Post(':id/reject')
  @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    anyOf(ctx, 'expense.approve', 'expense.post');
    return this.expenses.reject(ctx, id, parse(expenseRejectSchema, body).reason);
  }

  @Require('expense.post')
  @RequireRecentAuth()
  @Post(':id/reverse')
  @HttpCode(200)
  reverse(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.expenses.reverse(ctx, id, parse(reverseReasonSchema, body).reason);
  }

  @Authenticated()
  @Post(':id/bill')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2 } }))
  async bill(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File | undefined) {
    anyOf(ctx, 'expense.submit', 'expense.view');
    if (!file) throw new ApiError(422, 'EMPTY_FILE', 'Choose a file to upload');
    await this.expenses.get(ctx.auth, id); // scope
    const f = await this.db.transaction().execute((tx) => this.files.store(tx, file, 'EXPENSE', ctx.auth.userId));
    await this.expenses.attachBill(ctx, id, f.id);
    return { fileId: f.id, name: f.original_name };
  }

  @Authenticated()
  @Get(':id/bill')
  async download(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    anyOf(ctx, 'expense.submit', 'expense.view');
    const e = await this.expenses.get(ctx.auth, id);
    if (!e.file_id) throw notFound('Bill');
    const f = await this.db.selectFrom('files').select(['storage_key', 'mime_type', 'original_name', 'scan_status']).where('id', '=', e.file_id).executeTakeFirstOrThrow();
    if (f.scan_status !== 'CLEAN') throw new ApiError(409, 'FILE_NOT_SCANNED', 'This file is still being checked for viruses. Try again shortly.');
    const data = await this.files.read(f.storage_key);
    await this.audit.record(this.db, ctx, { action: 'expense.bill_viewed', entityType: 'expense', entityId: id });
    res.setHeader('Content-Type', f.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${f.mime_type === 'application/pdf' ? 'attachment' : 'inline'}; filename="${f.original_name}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(data);
  }
}

@Controller('banking')
export class BankingController {
  constructor(
    private readonly banking: BankingService,
    private readonly payments: PaymentsService,
  ) {}

  @Authenticated()
  @Get('accounts')
  async accounts(@Ctx() ctx: RequestContext) {
    anyOf(ctx, 'deposit.record', 'ledger.view', 'cheque.manage');
    return { data: await this.banking.accounts(ctx.auth) };
  }

  @Authenticated()
  @Get('deposits')
  async deposits(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    anyOf(ctx, 'deposit.record', 'ledger.view');
    const p = parse(z.object({ from: isoDate.optional(), to: isoDate.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), q);
    return { data: await this.banking.deposits(ctx.auth, p) };
  }

  @Require('deposit.record')
  @Post('deposits')
  record(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.banking.recordDeposit(ctx, parse(depositCreateSchema, body));
  }

  @Require('deposit.record')
  @Post('deposits/:id/reverse')
  @HttpCode(200)
  reverse(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.banking.reverseDeposit(ctx, id, parse(reverseReasonSchema, body).reason);
  }

  @Require('cheque.manage')
  @Get('cheques')
  async cheques(@Ctx() ctx: RequestContext, @Query('status') status?: string) {
    return { data: await this.payments.cheques(ctx.auth, status ? parse(z.enum(['RECEIVED', 'DEPOSITED', 'CLEARED', 'BOUNCED']), status) : undefined) };
  }

  @Require('cheque.manage')
  @Post('cheques/:id/deposit')
  @HttpCode(200)
  depositCheque(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.payments.depositCheque(ctx, id, parse(chequeDepositSchema, body));
  }

  @Require('cheque.manage')
  @Post('cheques/:id/clear')
  @HttpCode(200)
  clearCheque(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.payments.clearCheque(ctx, id, parse(chequeClearSchema, body).clearedOn);
  }

  @Require('cheque.manage')
  @RequireRecentAuth()
  @Post('cheques/:id/bounce')
  @HttpCode(200)
  bounceCheque(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.payments.bounceCheque(ctx, id, parse(chequeBounceSchema, body));
  }
}

@Controller()
export class JournalsController {
  constructor(private readonly journals: JournalsService) {}

  @Require('ledger.view')
  @Get('journals')
  list(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return this.journals.list(ctx.auth, parse(journalListQuerySchema, q));
  }

  @Require('ledger.view')
  @Get('journals/:id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.journals.get(ctx.auth, id);
  }

  @Require('ledger.view')
  @Get('manual-journals')
  async manual(@Ctx() ctx: RequestContext, @Query('status') status?: string) {
    return { data: await this.journals.listManual(ctx.auth, status ? parse(z.enum(['PENDING', 'APPROVED', 'REJECTED']), status) : undefined) };
  }

  @Require('journal.create')
  @Post('manual-journals')
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.journals.create(ctx, parse(manualJournalSchema, body));
  }

  @Require('journal.approve')
  @RequireRecentAuth()
  @Post('manual-journals/:id/approve')
  @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.journals.approve(ctx, id, parse(reversalDecisionSchema, body ?? {}).note);
  }

  @Require('journal.approve')
  @Post('manual-journals/:id/reject')
  @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.journals.reject(ctx, id, parse(expenseRejectSchema, body).reason);
  }

  @Require('ledger.view')
  @Get('periods')
  async periods() {
    return { data: await this.journals.periods() };
  }

  @Require('period.soft_lock')
  @Post('periods/:month/soft-lock')
  @HttpCode(200)
  softLock(@Ctx() ctx: RequestContext, @Param('month') month: string) {
    return this.journals.setPeriod(ctx, month, 'SOFT_LOCKED');
  }

  @Require('period.lock')
  @Post('periods/:month/lock')
  @HttpCode(200)
  lock(@Ctx() ctx: RequestContext, @Param('month') month: string) {
    return this.journals.setPeriod(ctx, month, 'LOCKED');
  }

  @Require('period.unlock')
  @RequireRecentAuth()
  @Post('periods/:month/reopen')
  @HttpCode(200)
  reopen(@Ctx() ctx: RequestContext, @Param('month') month: string, @Body() body: unknown) {
    return this.journals.setPeriod(ctx, month, 'OPEN', parse(unlockSchema, body).reason);
  }
}

@Controller('books')
export class BooksController {
  constructor(private readonly books: BooksService) {}

  @Require('ledger.view')
  @Get('summary')
  async summary(@Ctx() ctx: RequestContext, @Query() q: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    const p = parse(periodQuerySchema, q);
    const r = await this.books.accountSummaries(ctx.auth, p.from, p.to, p.branchId);
    if (q.format !== 'xlsx') return r;
    return xlsx(
      res,
      `cash-bank-${p.from}-${p.to}`,
      await this.books.xlsx('Cash & bank summary', `${p.from} to ${p.to}`, [
        { header: 'Code', key: 'code', width: 14 },
        { header: 'Account', key: 'name', width: 36 },
        { header: 'Opening', key: 'opening', width: 16, money: true },
        { header: 'Receipts', key: 'receipts', width: 16, money: true },
        { header: 'Payments', key: 'payments', width: 16, money: true },
        { header: 'Closing', key: 'closing', width: 16, money: true },
      ], r.data, { code: '', name: 'Total', ...r.totals }),
    );
  }

  @Require('ledger.view')
  @Get('day')
  async day(@Ctx() ctx: RequestContext, @Query() q: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    const p = parse(z.object({ date: isoDate.default(istToday()), branchId: z.string().uuid().optional() }), q);
    const r = await this.books.dayBook(ctx.auth, p.date, p.branchId);
    if (q.format !== 'xlsx') return r;
    const rows = r.entries.flatMap((e) => e.lines.map((l, i) => ({ entry: i ? '' : e.entry_no, type: i ? '' : e.entry_type, narration: i ? '' : e.narration, account: `${l.code} ${l.name}`, debit: Number(l.debit) ? l.debit : null, credit: Number(l.credit) ? l.credit : null })));
    return xlsx(res, `day-book-${p.date}`, await this.books.xlsx('Day book', p.date, [
      { header: 'Entry', key: 'entry', width: 16 },
      { header: 'Type', key: 'type', width: 14 },
      { header: 'Narration', key: 'narration', width: 50 },
      { header: 'Account', key: 'account', width: 36 },
      { header: 'Debit', key: 'debit', width: 16, money: true },
      { header: 'Credit', key: 'credit', width: 16, money: true },
    ], rows, { entry: '', type: '', narration: '', account: 'Total', debit: r.total, credit: r.total }));
  }

  @Require('ledger.view')
  @Get('trial-balance')
  async tb(@Ctx() ctx: RequestContext, @Query() q: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    const p = parse(asOfQuerySchema, q);
    const r = await this.books.trialBalance(ctx.auth, p.asOf, p.branchId);
    if (q.format !== 'xlsx') return r;
    return xlsx(res, `trial-balance-${p.asOf}`, await this.books.xlsx('Trial balance', `As of ${p.asOf}`, [
      { header: 'Code', key: 'code', width: 14 },
      { header: 'Account', key: 'name', width: 40 },
      { header: 'Debit', key: 'debit', width: 18, money: true },
      { header: 'Credit', key: 'credit', width: 18, money: true },
    ], r.data, { code: '', name: 'Total', debit: r.totals.debit, credit: r.totals.credit }));
  }

  @Require('ledger.view')
  @Get('profit-loss')
  async pl(@Ctx() ctx: RequestContext, @Query() q: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    const p = parse(periodQuerySchema, q);
    const r = await this.books.profitAndLoss(ctx.auth, p.from, p.to, p.branchId);
    if (q.format !== 'xlsx') return r;
    const rows = [{ code: '', name: 'Income', amount: null }, ...r.income, { code: '', name: 'Total income', amount: r.totals.income }, { code: '', name: 'Expenses', amount: null }, ...r.expenses, { code: '', name: 'Total expenses', amount: r.totals.expenses }];
    return xlsx(res, `profit-loss-${p.from}-${p.to}`, await this.books.xlsx('Profit & loss', `${p.from} to ${p.to}`, [
      { header: 'Code', key: 'code', width: 14 },
      { header: 'Account', key: 'name', width: 40 },
      { header: 'Amount', key: 'amount', width: 18, money: true },
    ], rows, { code: '', name: 'Net profit', amount: r.totals.net }));
  }

  @Require('ledger.view')
  @Get('balance-sheet')
  async bs(@Ctx() ctx: RequestContext, @Query() q: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    const p = parse(asOfQuerySchema, q);
    const r = await this.books.balanceSheet(ctx.auth, p.asOf, p.branchId);
    if (q.format !== 'xlsx') return r;
    const rows = [
      { code: '', name: 'Assets', amount: null }, ...r.assets, { code: '', name: 'Total assets', amount: r.totals.assets },
      { code: '', name: 'Liabilities', amount: null }, ...r.liabilities, { code: '', name: 'Total liabilities', amount: r.totals.liabilities },
      { code: '', name: 'Equity', amount: null }, ...r.equity, { code: '', name: 'Profit not yet closed to reserves', amount: r.profit },
    ];
    return xlsx(res, `balance-sheet-${p.asOf}`, await this.books.xlsx('Balance sheet', `As of ${p.asOf}`, [
      { header: 'Code', key: 'code', width: 14 },
      { header: 'Account', key: 'name', width: 40 },
      { header: 'Amount', key: 'amount', width: 18, money: true },
    ], rows, { code: '', name: 'Liabilities + equity + profit', amount: r.totals.liabilitiesAndEquity }));
  }
}
