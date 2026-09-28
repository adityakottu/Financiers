import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  assetSchema,
  freeCalculateSchema,
  loanCalculateSchema,
  loanCancelSchema,
  loanCreateSchema,
  loanDecisionSchema,
  loanDisburseSchema,
  loanListQuerySchema,
  loanRejectSchema,
  productSchema,
} from '@fin/contracts';
import { computeFees } from '@fin/loan-engine';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service';
import { Ctx, FinRequest, RequestContext, Require } from '../auth/context';
import { conflict, notFound, parse, preconditionFailed } from '../common/errors';
import { IdempotencyService } from '../common/idempotency.service';
import { DB_TOKEN, Db, isUniqueViolation } from '../db/db';
import { FilesService, MAX_UPLOAD_BYTES } from '../files/files.service';
import { LedgerService } from '../ledger/ledger.service';
import { expectedVersion } from '../org/versioning';
import { LoansService } from './loans.service';
import { buildStatement, statementPdf, statementXlsx } from './statement';

@Controller('loan-products')
export class ProductsController {
  constructor(private readonly loans: LoansService) {}

  @Require('loan.view')
  @Get()
  async list(@Query('includeRetired') includeRetired?: string) {
    return { data: await this.loans.listProducts(includeRetired === 'true') };
  }

  @Require('loan.view')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.loans.product(id);
  }

  @Require('product.manage')
  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.loans.createProduct(ctx, parse(productSchema, body));
  }

  @Require('product.manage')
  @Put(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.loans.updateProduct(ctx, id, parse(productSchema, body));
  }

  @Require('product.manage')
  @Post(':id/retire')
  @HttpCode(204)
  async retire(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.loans.setProductStatus(ctx, id, 'RETIRED');
  }

  @Require('product.manage')
  @Post(':id/reactivate')
  @HttpCode(204)
  async reactivate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.loans.setProductStatus(ctx, id, 'ACTIVE');
  }
}

@Controller('loans')
export class LoansController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly loans: LoansService,
    private readonly idempotency: IdempotencyService,
    private readonly ledger: LedgerService,
  ) {}

  /** Preview exactly what will be saved (doc 06 §11). */
  @Require('loan.view')
  @Post('calculate')
  @HttpCode(200)
  calculate(@Body() body: unknown) {
    const { productId, ...terms } = parse(loanCalculateSchema, body);
    return this.loans.preview(productId, terms);
  }

  /** Stand-alone calculator: any method and fees, no product. */
  @Require('loan.view')
  @Post('calculator')
  @HttpCode(200)
  calculator(@Body() body: unknown) {
    const i = parse(freeCalculateSchema, body);
    return this.loans.freeCalculate({
      principal: i.principal,
      annualRate: i.annualRate,
      method: i.method,
      frequency: i.frequency,
      customIntervalDays: i.customIntervalDays,
      numInstallments: i.numInstallments,
      disbursementDate: i.disbursementDate,
      firstDueDate: i.firstDueDate,
      roundingUnit: i.roundingUnit,
      skipSundays: i.skipSundays,
      fees: computeFees(i.feeRules, i.principal),
    });
  }

  @Require('loan.view')
  @Get()
  list(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return this.loans.list(ctx.auth, parse(loanListQuerySchema, q));
  }

  @Require('loan.create')
  @Post()
  async create(@Ctx() ctx: RequestContext, @Req() req: FinRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const key = this.idempotency.keyFrom(req);
    const input = parse(loanCreateSchema, body);
    const r = await this.idempotency.run(ctx.auth.userId, key, 'POST /loans', body, async (tx) => ({
      status: 201,
      body: await this.loans.create(tx, ctx, input),
    }));
    res.status(r.status);
    if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return r.body;
  }

  @Require('loan.view')
  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.loans.get(ctx.auth, id);
  }

  @Require('loan.create')
  @Post(':id/submit')
  @HttpCode(200)
  submit(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.loans.submit(ctx, id);
  }

  @Require('loan.approve')
  @Post(':id/approve')
  @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.loans.approve(ctx, id, parse(loanDecisionSchema, body ?? {}).note);
  }

  @Require('loan.approve')
  @Post(':id/reject')
  @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.loans.reject(ctx, id, parse(loanRejectSchema, body).note);
  }

  @Require('loan.cancel')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.loans.cancel(ctx, id, parse(loanCancelSchema, body).reason);
  }

  @Require('loan.disburse')
  @Get(':id/payout-accounts')
  async payoutAccounts(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const loan = await this.loans.get(ctx.auth, id);
    return { data: await this.ledger.payoutAccounts(this.db, loan.branch_id) };
  }

  /** Money leaves the company here: idempotent, row-locked, one balanced journal. */
  @Require('loan.disburse')
  @Post(':id/disburse')
  @HttpCode(200)
  async disburse(@Ctx() ctx: RequestContext, @Req() req: FinRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const key = this.idempotency.keyFrom(req);
    const input = parse(loanDisburseSchema, body);
    const r = await this.idempotency.run(ctx.auth.userId, key, `POST /loans/${id}/disburse`, body, async (tx) => ({
      status: 200,
      body: await this.loans.disburse(tx, ctx, id, input),
    }));
    res.status(r.status);
    if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return r.body;
  }

  @Require('ledger.view')
  @Get(':id/journal')
  async journal(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.loans.get(ctx.auth, id);
    return { data: await this.ledger.entriesForSource(this.db, { loanId: id }) };
  }

  @Require('statement.generate')
  @Get(':id/statement')
  async statement(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query('format') format: string | undefined, @Res({ passthrough: true }) res: Response) {
    const loan = await this.loans.get(ctx.auth, id);
    const s = await buildStatement(this.db, id);
    if (format === 'xlsx' || format === 'pdf') {
      const file = format === 'xlsx' ? await statementXlsx(s) : await statementPdf(s);
      res.setHeader('Content-Type', format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="statement-${loan.loan_no}.${format}"`);
      return new StreamableFile(file);
    }
    return s;
  }
}

const assetListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
  q: z.string().trim().max(60).optional(),
  status: z.string().max(20).optional(),
  category: z.string().max(20).optional(),
});
const assetUpdateSchema = assetSchema.partial().strict();
const assetDocSchema = z.object({ docType: z.enum(['RC', 'INSURANCE', 'INVOICE', 'PERMIT', 'FITNESS', 'NOC', 'PHOTO', 'OTHER']), expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

@Controller('assets')
export class AssetsController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly loans: LoansService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  @Require('loan.view')
  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(assetListQuery, query);
    let sel = this.loans
      .scoped(this.db, ctx.auth)
      .innerJoin('assets as a', 'a.loan_id', 'l.id')
      .select([
        'a.id',
        'a.asset_no',
        'a.category',
        'a.status',
        'a.description',
        'a.make',
        'a.model',
        'a.registration_no',
        'a.chassis_no',
        'a.serial_no',
        'a.asset_value',
        'a.insurance_expiry',
        'l.id as loan_id',
        'l.loan_no',
        'c.full_name as customer_name',
        'b.code as branch_code',
      ])
      .orderBy('a.id', 'desc')
      .limit(q.limit + 1);
    if (q.cursor) sel = sel.where('a.id', '<', q.cursor);
    if (q.status) sel = sel.where('a.status', '=', q.status);
    if (q.category) sel = sel.where('a.category', '=', q.category);
    if (q.q) {
      const t = q.q.toUpperCase().replace(/[\s%_\\-]/g, '');
      sel = sel.where((eb) => eb.or([eb('a.registration_no', 'like', `%${t}%`), eb('a.chassis_no', 'like', `%${t}%`), eb('a.engine_no', 'like', `%${t}%`), eb('a.serial_no', 'like', `%${t}%`), eb('a.asset_no', 'like', `%${t}%`)]));
    }
    const rows = await sel.execute();
    const hasMore = rows.length > q.limit;
    const data = rows.slice(0, q.limit);
    return { data, nextCursor: hasMore ? data[data.length - 1]!.id : null };
  }

  @Require('loan.view')
  @Get(':id')
  async get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const a = await this.loans.assetById(ctx.auth, id);
    const [docs, events] = await Promise.all([
      this.db
        .selectFrom('asset_documents as d')
        .innerJoin('files as f', 'f.id', 'd.file_id')
        .select(['d.id', 'd.doc_type', 'd.expiry_date', 'd.created_at', 'f.original_name', 'f.size_bytes', 'f.scan_status'])
        .where('d.asset_id', '=', id)
        .orderBy('d.created_at', 'desc')
        .execute(),
      this.db.selectFrom('asset_events').selectAll().where('asset_id', '=', id).orderBy('at', 'desc').execute(),
    ]);
    return { ...a, documents: docs, events };
  }

  /** Insurance, permit and similar details change during a loan; identifiers change only before disbursement. */
  @Require('asset.edit')
  @Patch(':id')
  async update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Headers('if-match') ifMatch?: string) {
    const input = parse(assetUpdateSchema, body);
    const version = expectedVersion(ifMatch);
    await this.loans.assetById(ctx.auth, id);
    try {
      return await this.db.transaction().execute(async (tx) => {
        const before = await tx.selectFrom('assets').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
        if (before.version !== version) throw preconditionFailed();
        const identifiers = ['registrationNo', 'chassisNo', 'engineNo', 'serialNo'] as const;
        if (before.status !== 'PENDING' && identifiers.some((k) => input[k] !== undefined)) {
          throw conflict('ASSET_LOCKED', 'Registration, chassis, engine and serial numbers cannot change after disbursement');
        }
        const map: Record<string, string> = {
          description: 'description', make: 'make', model: 'model', variant: 'variant', manufactureYear: 'manufacture_year', colour: 'colour',
          serialNo: 'serial_no', registrationNo: 'registration_no', chassisNo: 'chassis_no', engineNo: 'engine_no', vehicleType: 'vehicle_type',
          assetValue: 'asset_value', purchasePrice: 'purchase_price', purchaseDate: 'purchase_date', dealerName: 'dealer_name', invoiceNo: 'invoice_no',
          hypothecationMarked: 'hypothecation_marked', insurer: 'insurer', insurancePolicyNo: 'insurance_policy_no', insuranceExpiry: 'insurance_expiry',
          permitNo: 'permit_no', permitExpiry: 'permit_expiry', fitnessExpiry: 'fitness_expiry', taxValidTill: 'tax_valid_till',
        };
        const next: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input)) if (v !== undefined) next[map[k]!] = v;
        const d = diff(before as unknown as Record<string, unknown>, next);
        if (!d.changed) return { id, version: before.version };
        const row = await tx
          .updateTable('assets')
          .set({ ...(next as object), version: before.version + 1, updated_at: new Date(), updated_by: ctx.auth.userId })
          .where('id', '=', id)
          .returning('version')
          .executeTakeFirstOrThrow();
        await this.audit.record(tx, ctx, { action: 'asset.updated', entityType: 'asset', entityId: id, branchId: before.branch_id, oldValues: d.oldValues, newValues: d.newValues });
        return { id, version: row.version };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('ASSET_ALREADY_FINANCED', 'Another live loan already uses this registration or chassis number');
      throw e;
    }
  }

  @Require('asset.edit')
  @Post(':id/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } }))
  async upload(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: unknown) {
    const input = parse(assetDocSchema, body);
    const a = await this.loans.assetById(ctx.auth, id);
    if (!file) throw notFound('File');
    return this.db.transaction().execute(async (tx) => {
      const f = await this.files.store(tx, file, 'ASSET', ctx.auth.userId);
      const doc = await tx
        .insertInto('asset_documents')
        .values({ asset_id: id, file_id: f.id, doc_type: input.docType, expiry_date: input.expiryDate ?? null, created_by: ctx.auth.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(tx, ctx, { action: 'asset.document_uploaded', entityType: 'asset', entityId: id, branchId: a.branch_id, newValues: { documentId: doc.id, docType: input.docType, fileName: f.original_name } });
      return { id: doc.id, file: f };
    });
  }

  @Require('loan.view')
  @Get(':id/documents/:docId/download')
  async download(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string, @Res() res: Response) {
    const a = await this.loans.assetById(ctx.auth, id);
    const doc = await this.db
      .selectFrom('asset_documents as d')
      .innerJoin('files as f', 'f.id', 'd.file_id')
      .select(['f.storage_key', 'f.mime_type', 'f.original_name', 'f.scan_status'])
      .where('d.id', '=', docId)
      .where('d.asset_id', '=', id)
      .executeTakeFirst();
    if (!doc) throw notFound('Document');
    if (doc.scan_status !== 'CLEAN') throw conflict('FILE_NOT_SCANNED', 'This file is still being checked for viruses');
    const data = await this.files.read(doc.storage_key);
    await this.audit.record(this.db, ctx, { action: 'asset.document_viewed', entityType: 'asset', entityId: id, branchId: a.branch_id, newValues: { documentId: docId } });
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${doc.mime_type === 'application/pdf' ? 'attachment' : 'inline'}; filename="${doc.original_name}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(data);
  }
}
