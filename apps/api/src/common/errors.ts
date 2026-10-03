import { HttpException } from '@nestjs/common';
import type { ZodError, ZodTypeAny, z } from 'zod';

/** Every API error carries a stable machine-readable code. */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);
export const unauthorized = (code = 'UNAUTHENTICATED', message = 'Please sign in') =>
  new ApiError(401, code, message);
export const forbidden = (code = 'FORBIDDEN', message = 'You do not have permission to do this') =>
  new ApiError(403, code, message);
export const notFound = (what = 'Record') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new ApiError(409, code, message, details);
export const preconditionFailed = (message = 'This record was changed by someone else. Reload and try again.') =>
  new ApiError(412, 'VERSION_CONFLICT', message);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new ApiError(422, code, message, details);

export function zodDetails(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Validate untrusted input; throws 400 VALIDATION_FAILED with field-level details. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw badRequest('VALIDATION_FAILED', 'Some fields are invalid', zodDetails(r.error));
  return r.data;
}
