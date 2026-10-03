import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AppConfig, CONFIG } from '../config/config';
import { DB_TOKEN, Db, Executor } from '../db/db';
import { CryptoService } from '../common/crypto.service';

export interface IssuedSession {
  sessionId: string;
  token: string;
  csrf: string;
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    db: Executor,
    userId: string,
    meta: { ip: string | null; userAgent: string | null },
    mfaPending: boolean,
  ): Promise<IssuedSession> {
    const token = CryptoService.token();
    const csrf = CryptoService.token();
    const row = await db
      .insertInto('sessions')
      .values({
        user_id: userId,
        token_hash: CryptoService.sha256(token),
        csrf_hash: CryptoService.sha256(csrf),
        expires_at: new Date(Date.now() + this.config.sessionAbsoluteMs),
        ip: meta.ip,
        user_agent: meta.userAgent,
        mfa_pending: mfaPending,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { sessionId: row.id, token, csrf };
  }

  /** New secret for the same session after a privilege change (MFA completed, password changed). */
  async rotate(db: Executor, sessionId: string): Promise<IssuedSession> {
    const token = CryptoService.token();
    const csrf = CryptoService.token();
    await db
      .updateTable('sessions')
      .set({ token_hash: CryptoService.sha256(token), csrf_hash: CryptoService.sha256(csrf) })
      .where('id', '=', sessionId)
      .execute();
    return { sessionId, token, csrf };
  }

  findByToken(token: string) {
    return this.db
      .selectFrom('sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .select([
        's.id',
        's.user_id',
        's.csrf_hash',
        's.created_at',
        's.last_seen_at',
        's.expires_at',
        's.mfa_pending',
        's.reauth_at',
        's.revoked_at',
        'u.username',
        'u.full_name',
        'u.status',
        'u.must_change_password',
        'u.mfa_enabled',
      ])
      .where('s.token_hash', '=', CryptoService.sha256(token))
      .executeTakeFirst();
  }

  async touch(sessionId: string) {
    await this.db.updateTable('sessions').set({ last_seen_at: new Date() }).where('id', '=', sessionId).execute();
  }

  async revoke(db: Executor, sessionId: string, reason: string) {
    await db
      .updateTable('sessions')
      .set({ revoked_at: new Date(), revoke_reason: reason })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /** Revoke every active session of a user, optionally keeping one (the caller's). */
  async revokeAllForUser(db: Executor, userId: string, reason: string, exceptSessionId?: string) {
    let q = db
      .updateTable('sessions')
      .set({ revoked_at: new Date(), revoke_reason: reason })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null);
    if (exceptSessionId) q = q.where('id', '<>', exceptSessionId);
    const r = await q.executeTakeFirst();
    return Number(r.numUpdatedRows);
  }

  setCookies(res: Response, s: IssuedSession) {
    const common = {
      secure: this.config.cookieSecure,
      sameSite: 'strict' as const,
      path: '/',
      maxAge: this.config.sessionAbsoluteMs,
    };
    res.cookie(this.config.sessionCookie, s.token, { ...common, httpOnly: true });
    // Readable by the web app, which echoes it in X-CSRF-Token; the server compares it to the session's hash.
    res.cookie(this.config.csrfCookie, s.csrf, { ...common, httpOnly: false });
  }

  clearCookies(res: Response) {
    const opts = { secure: this.config.cookieSecure, sameSite: 'strict' as const, path: '/' };
    res.clearCookie(this.config.sessionCookie, { ...opts, httpOnly: true });
    res.clearCookie(this.config.csrfCookie, opts);
  }
}
