import { Controller, DynamicModule, Get, Inject, MiddlewareConsumer, Module, NestModule, OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PgThrottlerStorage } from './common/rate-limit.storage';
import { SystemController, SystemService } from './common/system.service';
import { IntegrityController, IntegrityService } from './integrity/integrity.service';
import { sql } from 'kysely';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AccessService } from './auth/access.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { Public } from './auth/context';
import { SessionService } from './auth/session.service';
import { CryptoService } from './common/crypto.service';
import { RequestIdMiddleware } from './common/http';
import { IdempotencyService } from './common/idempotency.service';
import { AppConfig, CONFIG } from './config/config';
import { CustomersController } from './customers/customers.controller';
import { CustomersService } from './customers/customers.service';
import { SearchController } from './customers/search.controller';
import { DashboardController } from './dashboard/dashboard.controller';
import { createDb, DB_TOKEN, Db } from './db/db';
import { FilesService } from './files/files.service';
import { NumberingService } from './numbering/numbering.service';
import { BranchesController } from './org/branches.controller';
import { EmployeesController } from './org/employees.controller';
import { SettingsController } from './settings/settings.controller';
import { UsersController } from './users/users.controller';
import { AccountsController } from './ledger/accounts.controller';
import { LedgerService } from './ledger/ledger.service';
import { AssetsController, LoansController, ProductsController } from './lending/lending.controller';
import { LoansService } from './lending/loans.service';
import { JobsController } from './jobs/jobs.controller';
import { JobsService } from './jobs/jobs.service';
import { CollectionsController, LoanCollectionsController, PaymentsController, PublicReceiptsController, ReversalsController } from './collections/collections.controller';
import { CollectionsService } from './collections/collections.service';
import { PaymentsService } from './collections/payments.service';
import { MessagesController, ReminderRulesController, TemplatesController, WebhooksController } from './messaging/messaging.controller';
import { MessagingService } from './messaging/messaging.service';
import { BankingController, BooksController, ExpensesController, JournalsController } from './accounting/accounting.controller';
import { BankingService } from './accounting/banking.service';
import { BooksService } from './accounting/books.service';
import { ExpensesService } from './accounting/expenses.service';
import { JournalsService } from './accounting/journals.service';
import { ReconciliationController } from './reconciliation/reconciliation.controller';
import { SettlementsService } from './reconciliation/settlements.service';
import { StatementsService } from './reconciliation/statements.service';
import { RecoveryController } from './recovery/recovery.controller';
import { RecoveryService } from './recovery/recovery.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { DashboardService } from './dashboard/dashboard.service';
import { InboxService } from './dashboard/inbox.service';
import { NotificationsController } from './dashboard/notifications.controller';

@Controller('health')
class HealthController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  @Public()
  @Get()
  async health() {
    await sql`SELECT 1`.execute(this.db);
    return { status: 'ok' };
  }
}

const THROTTLE_DB = Symbol('THROTTLE_DB');

class DbLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(THROTTLE_DB) private readonly throttleDb: Db,
  ) {}
  async onApplicationShutdown() {
    await Promise.all([this.db.destroy(), this.throttleDb.destroy()]);
  }
}

@Module({})
export class AppModule implements NestModule {
  static forRoot(config: AppConfig): DynamicModule {
    // Rate-limit counters live in PostgreSQL so limits hold across API instances (own small pool).
    const throttleDb = createDb(config.databaseUrl, 3);
    return {
      module: AppModule,
      imports: [
        ThrottlerModule.forRoot({
          // Generous default per client IP; auth routes set tighter limits with @Throttle.
          throttlers: [{ name: 'default', ttl: 60_000, limit: config.rateLimitPerMinute }],
          storage: new PgThrottlerStorage(throttleDb),
          // Integration tests make many logins from one IP; they opt in with a header when testing limits.
          skipIf: (ctx) =>
            config.env === 'test' && !ctx.switchToHttp().getRequest<{ headers: Record<string, string> }>().headers['x-test-throttle'],
        }),
      ],
      controllers: [
        HealthController,
        SystemController,
        IntegrityController,
        AuthController,
        UsersController,
        BranchesController,
        EmployeesController,
        SettingsController,
        AuditController,
        CustomersController,
        SearchController,
        DashboardController,
        ProductsController,
        LoansController,
        AssetsController,
        AccountsController,
        JobsController,
        LoanCollectionsController,
        PaymentsController,
        ReversalsController,
        CollectionsController,
        PublicReceiptsController,
        MessagesController,
        TemplatesController,
        ReminderRulesController,
        WebhooksController,
        ExpensesController,
        BankingController,
        JournalsController,
        BooksController,
        ReconciliationController,
        RecoveryController,
        ReportsController,
        NotificationsController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DB_TOKEN, useFactory: () => createDb(config.databaseUrl) },
        { provide: THROTTLE_DB, useValue: throttleDb },
        DbLifecycle,
        CryptoService,
        SystemService,
        IntegrityService,
        AccessService,
        SessionService,
        AuthService,
        AuditService,
        NumberingService,
        IdempotencyService,
        FilesService,
        CustomersService,
        LedgerService,
        LoansService,
        JobsService,
        MessagingService,
        PaymentsService,
        CollectionsService,
        ExpensesService,
        BankingService,
        JournalsService,
        BooksService,
        SettlementsService,
        StatementsService,
        RecoveryService,
        ReportsService,
        DashboardService,
        InboxService,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
