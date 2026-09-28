import { Controller, Get, Query } from '@nestjs/common';
import { searchQuerySchema } from '@fin/contracts';
import { Ctx, RequestContext, Require } from '../auth/context';
import { parse } from '../common/errors';
import { CustomersService } from './customers.service';

@Controller('search')
export class SearchController {
  constructor(private readonly customers: CustomersService) {}

  @Require('search.global')
  @Get()
  search(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(searchQuerySchema, query);
    return this.customers.search(ctx.auth, q.q, q.limit);
  }
}
