import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  KYC_DOC_TYPES,
  customerCreateSchema,
  customerListQuerySchema,
  customerUpdateSchema,
  kycInputSchema,
  kycVerifySchema,
} from '@fin/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { Ctx, FinRequest, RequestContext, Require, RequireRecentAuth } from '../auth/context';
import { IdempotencyService } from '../common/idempotency.service';
import { ApiError, notFound, parse } from '../common/errors';
import { DB_TOKEN, Db } from '../db/db';
import { FilesService, MAX_UPLOAD_BYTES } from '../files/files.service';
import { expectedVersion } from '../org/versioning';
import { CustomersService } from './customers.service';

const docTypeSchema = z.enum(KYC_DOC_TYPES);
const uploadSchema = z.object({
  category: z.enum(['KYC', 'ADDRESS_PROOF', 'PHOTO', 'AGREEMENT', 'OTHER']),
  notes: z.string().trim().max(300).optional(),
});

@Controller('customers')
export class CustomersController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly customers: CustomersService,
    private readonly idempotency: IdempotencyService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  @Require('customer.view')
  @Get()
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.customers.list(ctx.auth, parse(customerListQuerySchema, query));
  }

  /** Idempotent: a double-tap or retry with the same Idempotency-Key creates one customer. */
  @Require('customer.create')
  @Post()
  async create(
    @Ctx() ctx: RequestContext,
    @Req() req: FinRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = this.idempotency.keyFrom(req);
    const input = parse(customerCreateSchema, body);
    const r = await this.idempotency.run(ctx.auth.userId, key, 'POST /customers', body, async (tx) => ({
      status: 201,
      body: await this.customers.create(tx, ctx, input),
    }));
    res.status(r.status);
    if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return r.body;
  }

  @Require('customer.view')
  @Get(':id')
  async get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const c = await this.customers.get(ctx.auth, id);
    res.setHeader('ETag', `"v${c.version}"`);
    return c;
  }

  @Require('customer.edit')
  @Patch(':id')
  update(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.customers.update(ctx, id, parse(customerUpdateSchema, body), expectedVersion(ifMatch));
  }

  @Require('customer.view')
  @Get(':id/timeline')
  async timeline(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.customers.timeline(ctx.auth, id) };
  }

  @Require('customer.edit')
  @Put(':id/kyc')
  kyc(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.customers.upsertKyc(ctx, id, parse(kycInputSchema, body));
  }

  @Require('customer.edit', 'kyc.view_masked')
  @Post(':id/kyc/verify')
  @HttpCode(200)
  verify(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(kycVerifySchema, body);
    return this.customers.verifyKyc(ctx, id, input.docType, input.method);
  }

  @Require('kyc.reveal')
  @RequireRecentAuth()
  @Post(':id/kyc/:docType/reveal')
  @HttpCode(200)
  reveal(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('docType') docType: string) {
    return this.customers.revealKyc(ctx, id, parse(docTypeSchema, docType));
  }

  @Require('document.upload')
  @Post(':id/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } }))
  async upload(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ) {
    const input = parse(uploadSchema, body);
    if (input.category === 'KYC' && !ctx.auth.permissions.has('document.view_kyc')) {
      throw new ApiError(403, 'FORBIDDEN', 'You cannot upload KYC documents');
    }
    const customer = await this.customers.get(ctx.auth, id); // scope check
    if (!file) throw new ApiError(422, 'EMPTY_FILE', 'Choose a file to upload');
    return this.db.transaction().execute(async (tx) => {
      const f = await this.files.store(tx, file, input.category === 'KYC' ? 'KYC' : 'CUSTOMER', ctx.auth.userId);
      const doc = await tx
        .insertInto('customer_documents')
        .values({ customer_id: id, file_id: f.id, category: input.category, notes: input.notes ?? null, created_by: ctx.auth.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.customers.event(tx, id, ctx.auth.userId, 'DOCUMENT_UPLOADED', `${input.category} document uploaded: ${f.original_name}`, {
        type: 'document',
        id: doc.id,
      });
      await this.audit.record(tx, ctx, {
        action: 'customer.document_uploaded',
        entityType: 'customer',
        entityId: id,
        branchId: customer.branchId,
        newValues: { documentId: doc.id, category: input.category, fileName: f.original_name, size: f.size_bytes },
      });
      return { id: doc.id, file: f };
    });
  }

  @Require('customer.view')
  @Get(':id/documents/:docId/download')
  async download(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Res() res: Response,
  ) {
    const customer = await this.customers.get(ctx.auth, id);
    const doc = await this.db
      .selectFrom('customer_documents as d')
      .innerJoin('files as f', 'f.id', 'd.file_id')
      .select(['d.category', 'f.storage_key', 'f.mime_type', 'f.original_name', 'f.scan_status'])
      .where('d.id', '=', docId)
      .where('d.customer_id', '=', id)
      .executeTakeFirst();
    if (!doc) throw notFound('Document');
    if (doc.category === 'KYC' && !ctx.auth.permissions.has('document.view_kyc')) throw notFound('Document');
    if (doc.scan_status !== 'CLEAN') {
      throw new ApiError(409, 'FILE_NOT_SCANNED', 'This file is still being checked for viruses. Try again shortly.');
    }
    const data = await this.files.read(doc.storage_key);
    await this.audit.record(this.db, ctx, {
      action: 'customer.document_viewed',
      entityType: 'customer',
      entityId: id,
      branchId: customer.branchId,
      newValues: { documentId: docId, category: doc.category },
    });
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${doc.mime_type === 'application/pdf' ? 'attachment' : 'inline'}; filename="${doc.original_name}"`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(data);
  }
}
