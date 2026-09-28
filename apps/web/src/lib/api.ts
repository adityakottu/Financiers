'use client';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path: string; message: string }[],
    readonly requestId?: string,
  ) {
    super(message);
  }

  /** Field → message map for forms. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of this.details ?? []) if (d.path && !out[d.path]) out[d.path] = d.message;
    return out;
  }
}

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)(?:__Host-)?fin_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : '';
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: number;
  signal?: AbortSignal;
  /** Don't redirect to /login on 401 (used by the login page itself). */
  noAuthRedirect?: boolean;
}

/** Where the server says the user must go before anything else works. */
const RESTRICTION_ROUTES: Record<string, string> = {
  MFA_PENDING: '/login/mfa',
  PASSWORD_CHANGE: '/setup/password',
  MFA_SETUP: '/setup/mfa',
};

export async function api<T = unknown>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken();
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.ifMatch !== undefined) headers['If-Match'] = `"v${opts.ifMatch}"`;
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body, credentials: 'same-origin', signal: opts.signal, cache: 'no-store' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
  }

  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json?.error ?? {};
    const error = new ApiError(res.status, err.code ?? 'ERROR', err.message ?? 'Request failed', err.details, err.requestId);
    if (typeof window !== 'undefined') {
      if (res.status === 401 && !opts.noAuthRedirect && !location.pathname.startsWith('/login')) {
        location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      } else if (res.status === 403 && RESTRICTION_ROUTES[error.code] && location.pathname !== RESTRICTION_ROUTES[error.code]) {
        location.href = RESTRICTION_ROUTES[error.code]!;
      }
    }
    throw error;
  }
  return json as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>('GET', path, { signal });

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function restrictionRoute(restriction: string | null | undefined): string | null {
  return restriction ? RESTRICTION_ROUTES[restriction] ?? null : null;
}
