import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { Authenticated, Ctx, RequestContext } from '../auth/context';
import { ExportFormat, ReportsService } from './reports.service';

const TYPES: Record<ExportFormat, string> = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' };

function send(res: Response, fileName: string, buf: Buffer) {
  const ext = fileName.endsWith('.pdf') ? 'pdf' : 'xlsx';
  res.setHeader('Content-Type', TYPES[ext]);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'no-store');
  return new StreamableFile(buf);
}

/** Each report checks its own permission (report.loan, report.collection, …). */
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Authenticated()
  @Get('reports')
  catalogue(@Ctx() ctx: RequestContext) {
    return this.reports.catalogue(ctx.auth);
  }

  @Authenticated()
  @Get('reports/ca-pack')
  async caPack(@Ctx() ctx: RequestContext, @Query() q: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    const r = await this.reports.caPack(ctx, q);
    return send(res, r.fileName, r.file);
  }

  /** format=json (default) returns rows; xlsx / pdf return a file, or 202 {jobId} for large reports. */
  @Authenticated()
  @Get('reports/:name')
  async run(@Ctx() ctx: RequestContext, @Param('name') name: string, @Query() q: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    const { format, ...filters } = q;
    if (format === 'xlsx' || format === 'pdf') {
      const r = await this.reports.export(ctx, name, format, filters);
      if ('jobId' in r) {
        res.status(HttpStatus.ACCEPTED);
        return { jobId: r.jobId, message: 'This report is large; it is being prepared. Download it from Exports when ready.' };
      }
      return send(res, r.fileName, r.file);
    }
    return this.reports.run(ctx, name, filters);
  }

  @Authenticated()
  @Get('exports')
  jobs(@Ctx() ctx: RequestContext) {
    return this.reports.jobs(ctx.auth);
  }

  @Authenticated()
  @Get('exports/:id/download')
  async download(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.reports.download(ctx, id);
    return send(res, r.fileName, r.file);
  }
}
