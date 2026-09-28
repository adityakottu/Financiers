import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaCodeSchema,
  reauthSchema,
  resetPasswordSchema,
} from '@fin/contracts';
import type { Response } from 'express';
import { parse } from '../common/errors';
import { AuthService } from './auth.service';
import {
  AllowRestricted,
  Authenticated,
  Ctx,
  FinRequest,
  Public,
  RequestContext,
  RequireRecentAuth,
  requestMeta,
} from './context';
import { SessionService } from './session.service';

const ANY_RESTRICTION = ['MFA_PENDING', 'PASSWORD_CHANGE', 'MFA_SETUP'] as const;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: FinRequest, @Res({ passthrough: true }) res: Response) {
    const input = parse(loginSchema, body);
    const { session, mfaRequired } = await this.auth.login(input.identifier, input.password, requestMeta(req));
    this.sessions.setCookies(res, session);
    return { mfaRequired };
  }

  @AllowRestricted('MFA_PENDING')
  @Authenticated()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(@Ctx() ctx: RequestContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    if (ctx.auth.restriction !== 'MFA_PENDING') return { ok: true };
    const { code } = parse(mfaCodeSchema, body);
    this.sessions.setCookies(res, await this.auth.verifyMfaLogin(ctx, code));
    return { ok: true };
  }

  @AllowRestricted(...ANY_RESTRICTION)
  @Authenticated()
  @Get('me')
  me(@Ctx() ctx: RequestContext) {
    return this.auth.me(ctx);
  }

  @AllowRestricted(...ANY_RESTRICTION)
  @Authenticated()
  @Post('logout')
  @HttpCode(204)
  async logout(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(ctx);
    this.sessions.clearCookies(res);
  }

  @Authenticated()
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAll(ctx);
    this.sessions.clearCookies(res);
  }

  @AllowRestricted('PASSWORD_CHANGE')
  @Authenticated()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('password/change')
  @HttpCode(200)
  async changePassword(@Ctx() ctx: RequestContext, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(changePasswordSchema, body);
    this.sessions.setCookies(res, await this.auth.changePassword(ctx, input.currentPassword, input.newPassword));
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('password/forgot')
  @HttpCode(202)
  async forgot(@Body() body: unknown, @Req() req: FinRequest) {
    const { identifier } = parse(forgotPasswordSchema, body);
    await this.auth.requestPasswordReset(identifier, requestMeta(req));
    return { message: 'If the account exists, reset instructions have been sent.' };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @Post('password/reset')
  @HttpCode(200)
  async reset(@Body() body: unknown, @Req() req: FinRequest) {
    const input = parse(resetPasswordSchema, body);
    await this.auth.resetPassword(input.token, input.newPassword, requestMeta(req));
    return { ok: true };
  }

  @Authenticated()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reauth')
  @HttpCode(200)
  async reauth(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const input = parse(reauthSchema, body);
    await this.auth.reauthenticate(ctx, input.password, input.code);
    return { ok: true };
  }

  @AllowRestricted('MFA_SETUP')
  @Authenticated()
  @Post('mfa/setup')
  @HttpCode(200)
  mfaSetup(@Ctx() ctx: RequestContext) {
    return this.auth.startMfaSetup(ctx);
  }

  @AllowRestricted('MFA_SETUP')
  @Authenticated()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mfa/enable')
  @HttpCode(200)
  mfaEnable(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const { code } = parse(mfaCodeSchema, body);
    return this.auth.enableMfa(ctx, code);
  }

  @Authenticated()
  @RequireRecentAuth()
  @Post('mfa/disable')
  @HttpCode(204)
  async mfaDisable(@Ctx() ctx: RequestContext) {
    await this.auth.disableMfa(ctx);
  }

  @Authenticated()
  @RequireRecentAuth()
  @Post('mfa/recovery-codes')
  @HttpCode(200)
  recoveryCodes(@Ctx() ctx: RequestContext) {
    return this.auth.regenerateRecoveryCodes(ctx);
  }

  @Authenticated()
  @Get('sessions')
  async listSessions(@Ctx() ctx: RequestContext) {
    const rows = await this.auth.listSessions(ctx.auth.userId);
    return { data: rows.map((s) => ({ ...s, current: s.id === ctx.auth.sessionId })) };
  }

  @Authenticated()
  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.auth.revokeOwnSession(ctx, id);
  }

  @Authenticated()
  @Get('login-history')
  async history(@Ctx() ctx: RequestContext) {
    return { data: await this.auth.loginHistory(ctx.auth.userId) };
  }
}
