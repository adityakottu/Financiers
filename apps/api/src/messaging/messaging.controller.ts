import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, RawBodyRequest, Req } from '@nestjs/common';
import { MESSAGE_CHANNELS, reminderRuleUpdateSchema, templateUpdateSchema } from '@fin/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { Ctx, Public, RequestContext, Require } from '../auth/context';
import { forbidden, notFound, parse } from '../common/errors';
import { AppConfig, CONFIG } from '../config/config';
import { MessagingService } from './messaging.service';
import { safeEqualText, verifyMetaSignature } from './providers';

@Controller('messages')
export class MessagesController {
  constructor(private readonly messaging: MessagingService) {}

  @Require('message.view')
  @Get()
  list(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const p = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().uuid().optional(),
        loanId: z.string().uuid().optional(),
        customerId: z.string().uuid().optional(),
        status: z.enum(['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SIMULATED', 'SKIPPED']).optional(),
        channel: z.enum(MESSAGE_CHANNELS).optional(),
      }),
      q,
    );
    return this.messaging.list(ctx.auth, p);
  }

  @Require('message.view')
  @Get('providers')
  providers() {
    return this.messaging.providers();
  }

  /** Send whatever is queued now instead of waiting for the next relay cycle. */
  @Require('message.configure')
  @Post('relay')
  @HttpCode(200)
  relay() {
    return this.messaging.relayOnce(100);
  }
}

@Controller('message-templates')
export class TemplatesController {
  constructor(private readonly messaging: MessagingService) {}

  @Require('message.view')
  @Get()
  async list() {
    return { data: await this.messaging.templates() };
  }

  @Require('message.configure')
  @Put(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.messaging.updateTemplate(ctx, id, parse(templateUpdateSchema, body));
  }
}

@Controller('reminder-rules')
export class ReminderRulesController {
  constructor(private readonly messaging: MessagingService) {}

  @Require('message.view')
  @Get()
  async list() {
    return { data: await this.messaging.reminderRules() };
  }

  @Require('message.configure')
  @Put(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.messaging.updateReminderRule(ctx, id, parse(reminderRuleUpdateSchema, body));
  }
}

/**
 * Delivery reports from the providers. Public (providers have no session) but authenticated:
 * Meta signs the raw body with the app secret; MSG91 must present the shared token.
 * Unconfigured webhooks answer 404.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly messaging: MessagingService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** One-time subscription check from Meta. */
  @Public()
  @Get('whatsapp')
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string) {
    const expected = this.config.whatsapp.verifyToken;
    if (!expected) throw notFound('Webhook');
    if (mode !== 'subscribe' || !token || !safeEqualText(token, expected)) throw forbidden('BAD_VERIFY_TOKEN', 'Verification failed');
    return /^[A-Za-z0-9_-]{1,100}$/.test(challenge ?? '') ? challenge : '';
  }

  @Public()
  @Post('whatsapp')
  @HttpCode(200)
  whatsapp(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature: string | undefined, @Body() body: unknown) {
    const secret = this.config.whatsapp.appSecret;
    if (!secret) throw notFound('Webhook');
    if (!req.rawBody || !verifyMetaSignature(req.rawBody, signature, secret)) throw forbidden('BAD_SIGNATURE', 'Invalid signature');
    return this.messaging.whatsappWebhook(body);
  }

  @Public()
  @Post('msg91')
  @HttpCode(200)
  msg91(@Query('token') token: string | undefined, @Body() body: unknown) {
    const expected = this.config.sms.webhookToken;
    if (!expected) throw notFound('Webhook');
    if (!token || !safeEqualText(token, expected)) throw forbidden('BAD_TOKEN', 'Invalid token');
    return this.messaging.msg91Webhook(body);
  }
}
