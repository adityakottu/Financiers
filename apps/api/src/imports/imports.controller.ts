import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { Authenticated, Ctx, RequestContext, Require, RequireRecentAuth } from '../auth/context';
import { ApiError, forbidden, parse } from '../common/errors';
import { ImportsService } from './imports.service';
import { PilotService } from './pilot.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MAX_BYTES = 10 * 1024 * 1024;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function send(res: Response, fileName: string, buf: Buffer) {
  res.setHeader('Content-Type', XLSX);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'no-store');
  return new StreamableFile(buf);
}

/** Uploaders (import.run) and confirmers (import.confirm) both see the imports. */
function assertImportAccess(ctx: RequestContext) {
  if (!ctx.auth.permissions.has('import.run') && !ctx.auth.permissions.has('import.confirm')) throw forbidden();
}

@Controller()
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly pilot: PilotService,
  ) {}

  /* ---------------- Data migration ---------------- */

  @Authenticated()
  @Get('imports/templates/:kind')
  async template(@Ctx() ctx: RequestContext, @Param('kind') kind: string, @Res({ passthrough: true }) res: Response) {
    const k = parse(z.enum(['customers', 'loans', 'parallel-run']), kind);
    if (k === 'parallel-run' ? !ctx.auth.permissions.has('pilot.compare') : !ctx.auth.permissions.has('import.run') && !ctx.auth.permissions.has('import.confirm')) throw forbidden();
    const buf = await this.imports.template(k === 'customers' ? 'CUSTOMERS' : k === 'loans' ? 'LOANS' : 'PARALLEL');
    return send(res, `template-${k}.xlsx`, buf);
  }

  @Authenticated()
  @Get('imports')
  async list(@Ctx() ctx: RequestContext) {
    assertImportAccess(ctx);
    return { data: await this.imports.list() };
  }

  @Authenticated()
  @Get('imports/:id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    assertImportAccess(ctx);
    return this.imports.get(ctx.auth, id);
  }

  @Authenticated()
  @Get('imports/:id/errors.xlsx')
  async errors(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    assertImportAccess(ctx);
    const f = await this.imports.errorsXlsx(id);
    return send(res, f.name, f.buffer);
  }

  @Require('import.run')
  @Post('imports')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1, fields: 4 } }))
  upload(@Ctx() ctx: RequestContext, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: Record<string, string>) {
    if (!file) throw new ApiError(422, 'EMPTY_FILE', 'Choose the filled template');
    const p = parse(z.object({ kind: z.enum(['CUSTOMERS', 'LOANS']), cutoverDate: isoDate.optional() }).strict(), body);
    return this.imports.upload(ctx, p.kind, file, p.cutoverDate);
  }

  /** Four eyes: a different person, with their password re-entered, creates the records for real. */
  @Require('import.confirm')
  @RequireRecentAuth()
  @Post('imports/:id/confirm')
  @HttpCode(200)
  confirm(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const p = parse(z.object({ acceptInvalid: z.boolean().default(false) }).strict(), body ?? {});
    return this.imports.confirm(ctx, id, p.acceptInvalid);
  }

  @Authenticated()
  @Post('imports/:id/cancel')
  @HttpCode(200)
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    assertImportAccess(ctx);
    return this.imports.cancel(ctx, id);
  }

  /* ---------------- Pilot parallel run ---------------- */

  @Require('pilot.compare')
  @Get('pilot/days')
  listDays(@Ctx() ctx: RequestContext, @Query('branchId', ParseUUIDPipe) branchId: string) {
    return this.pilot.list(ctx.auth, branchId);
  }

  @Require('pilot.compare')
  @Get('pilot/days/:id')
  day(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.pilot.day(ctx.auth, id);
  }

  @Require('pilot.compare')
  @Post('pilot/days')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1, fields: 4 } }))
  uploadDay(@Ctx() ctx: RequestContext, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: Record<string, string>) {
    if (!file) throw new ApiError(422, 'EMPTY_FILE', 'Choose the old process’s day sheet');
    const p = parse(z.object({ branchId: z.string().uuid(), date: isoDate }).strict(), body);
    return this.pilot.upload(ctx, p.branchId, p.date, file);
  }

  @Require('pilot.sign_off')
  @Post('pilot/days/:id/sign-off')
  @HttpCode(200)
  signOff(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const p = parse(z.object({ note: z.string().trim().max(2000).optional() }).strict(), body ?? {});
    return this.pilot.signOff(ctx, id, p.note);
  }
}
