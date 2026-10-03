import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { bankAccountCreateSchema, isoDateSchema } from '@fin/contracts';
import { Money } from '@fin/money';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import { Ctx, RequestContext, Require } from '../auth/context';
import { istToday } from '../common/dates';
import { parse } from '../common/errors';
import { DB_TOKEN, Db } from '../db/db';
import { LedgerService } from './ledger.service';

const ledgerQuery = z.object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() });

@Controller('accounts')
export class AccountsController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  /** Chart of accounts with balances as of a date (defaults to today). */
  @Require('ledger.view')
  @Get()
  async list(@Ctx() ctx: RequestContext, @Query('asOf') asOf?: string) {
    const date = asOf ? parse(isoDateSchema, asOf) : istToday();
    const rows = await this.ledger.trialBalance(date, scope.branchFilter(ctx.auth));
    // Roll leaf balances up to their parents so headers show group totals.
    const byId = new Map(rows.map((r) => [r.id, { ...r, net: Money.of(r.debit).minus(Money.of(r.credit)) }]));
    for (const r of rows) {
      if (!r.is_postable) continue;
      let p = r.parent_id ? byId.get(r.parent_id) : undefined;
      while (p) {
        p.net = p.net.plus(Money.of(r.debit).minus(Money.of(r.credit)));
        p = p.parent_id ? byId.get(p.parent_id) : undefined;
      }
    }
    const data = [...byId.values()].map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      isPostable: r.is_postable,
      parentId: r.parent_id,
      debit: r.debit,
      credit: r.credit,
      // Presented in the account's natural direction (assets/expenses debit-positive, others credit-positive).
      balance: (r.normal_balance === 'DEBIT' ? r.net : Money.zero().minus(r.net)).toString(),
    }));
    const leaves = rows.filter((r) => r.is_postable);
    const totalDr = Money.sum(leaves.map((r) => Money.of(r.debit)));
    const totalCr = Money.sum(leaves.map((r) => Money.of(r.credit)));
    return { asOf: date, data, totals: { debit: totalDr.toString(), credit: totalCr.toString(), balanced: totalDr.eq(totalCr) } };
  }

  @Require('ledger.view')
  @Get(':id/ledger')
  async accountLedger(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown) {
    const { from, to } = parse(ledgerQuery, q);
    const today = istToday();
    return this.ledger.accountLedger(id, from ?? `${today.slice(0, 7)}-01`, to ?? today, scope.branchFilter(ctx.auth));
  }

  @Require('coa.manage')
  @Post('bank')
  async createBank(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const input = parse(bankAccountCreateSchema, body);
    return this.db.transaction().execute(async (tx) => {
      const acc = await this.ledger.createBankAccount(tx, input, ctx.auth.userId);
      await this.audit.record(tx, ctx, {
        action: 'account.bank_created',
        entityType: 'account',
        entityId: acc.id,
        newValues: { code: acc.code, name: acc.name, bankName: input.bankName, accountLast4: input.accountNumber?.slice(-4) ?? null, ifsc: input.ifsc ?? null, kind: input.kind },
      });
      return acc;
    });
  }

  @Require('ledger.view')
  @Get('bank/list')
  async banks() {
    return {
      data: await this.db
        .selectFrom('bank_accounts as b')
        .innerJoin('accounts as a', 'a.id', 'b.account_id')
        .select(['a.id', 'a.code', 'a.name', 'b.bank_name', 'b.branch_name', 'b.account_no_last4', 'b.ifsc', 'b.upi_vpa', 'b.kind'])
        .orderBy('a.code')
        .execute(),
    };
  }
}
