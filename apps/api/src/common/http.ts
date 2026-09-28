import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  NestMiddleware,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { NextFunction, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { FinRequest } from '../auth/context';
import { ApiError } from './errors';

export class RequestIdMiddleware implements NestMiddleware {
  use(req: FinRequest, res: Response, next: NextFunction) {
    const incoming = req.get('x-request-id');
    req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  }
}

/** Uniform error body; never leaks stack traces or SQL. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<FinRequest>();
    const requestId = req.requestId;

    let status = 500;
    let body: { code: string; message: string; details?: unknown };

    if (exception instanceof ApiError) {
      status = exception.getStatus();
      body = { code: exception.code, message: exception.message, details: exception.details };
    } else if (exception instanceof ThrottlerException) {
      status = 429;
      body = { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again.' };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      const message =
        typeof r === 'object' && r && 'message' in r
          ? String(Array.isArray((r as { message: unknown }).message) ? (r as { message: string[] }).message[0] : (r as { message: string }).message)
          : exception.message;
      body = { code: status === 404 ? 'NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', message };
    } else {
      this.log.error(`[${requestId}] ${req.method} ${req.path}`, exception instanceof Error ? exception.stack : String(exception));
      body = { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };
    }
    res.status(status).json({ error: { ...body, requestId } });
  }
}
