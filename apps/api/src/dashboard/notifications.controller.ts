import { Controller, Get } from '@nestjs/common';
import { Authenticated, Ctx, RequestContext } from '../auth/context';
import { InboxService } from './inbox.service';

/** Notification centre v1 (doc 10 §Notifications): what is waiting for this user, computed live. */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly inbox: InboxService) {}

  @Authenticated()
  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.inbox.items(ctx.auth);
    return { items, total: items.reduce((s, i) => s + (i.tone === 'ok' ? 0 : i.count), 0) };
  }
}
