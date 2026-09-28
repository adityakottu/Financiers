import { Controller, DynamicModule, Get, Inject, MiddlewareConsumer, Module, NestModule, OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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

class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}
  async onApplicationShutdown() {
    await this.db.destroy();
  }
}

@Module({})
export class AppModule implements NestModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ThrottlerModule.forRoot({
          // Generous default per client IP; auth routes set tighter limits with @Throttle.
          throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
          // Integration tests make many logins from one IP; they opt in with a header when testing limits.
          skipIf: (ctx) =>
            config.env === 'test' && !ctx.switchToHttp().getRequest<{ headers: Record<string, string> }>().headers['x-test-throttle'],
        }),
      ],
      controllers: [
        HealthController,
        AuthController,
        UsersController,
        BranchesController,
        EmployeesController,
        SettingsController,
        AuditController,
        CustomersController,
        SearchController,
        DashboardController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DB_TOKEN, useFactory: () => createDb(config.databaseUrl) },
        DbLifecycle,
        CryptoService,
        AccessService,
        SessionService,
        AuthService,
        AuditService,
        NumberingService,
        IdempotencyService,
        FilesService,
        CustomersService,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
