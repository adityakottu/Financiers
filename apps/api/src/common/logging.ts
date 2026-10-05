import type { LoggerService } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { FinRequest } from '../auth/context';

/**
 * One JSON object per line on stdout, for CloudWatch (doc 13 §7). Messages never include request
 * bodies or query strings; the access log records the path only (search terms and filters can
 * contain names and mobile numbers).
 */
export class JsonLogger implements LoggerService {
  private write(level: string, message: unknown, rest: unknown[]) {
    const context = typeof rest[rest.length - 1] === 'string' ? (rest.pop() as string) : undefined;
    const stack = rest.find((r) => typeof r === 'string' && r.includes('\n    at '));
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, context, msg: typeof message === 'string' ? message : JSON.stringify(message), ...(stack ? { stack } : {}) })}\n`);
  }
  log(message: unknown, ...rest: unknown[]) {
    this.write('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.write('verbose', message, rest);
  }
}

/** Access log: method, path without query, status, duration, request id and user id. */
export function accessLog(req: FinRequest, res: Response, next: NextFunction) {
  const t = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path.endsWith('/health') || req.path.endsWith('/health/ready')) return;
    process.stdout.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level: 'info', context: 'http', method: req.method, path: req.path, status: res.statusCode, ms: Number((process.hrtime.bigint() - t) / 1_000_000n), requestId: req.requestId, userId: req.auth?.userId })}\n`,
    );
  });
  next();
}
