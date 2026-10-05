import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './config/config';
import { ErrorFilter } from './common/http';
import { accessLog, JsonLogger } from './common/logging';

/** Shared by main.ts and the integration tests so both run the exact same pipeline. */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    logger: config.env === 'test' ? ['error'] : config.logFormat === 'json' ? new JsonLogger() : ['log', 'warn', 'error'],
    bodyParser: false,
    // Webhook signatures are computed over the exact bytes received.
    rawBody: true,
  });
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '256kb' });
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: config.production ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    }),
  );
  app.use(cookieParser());
  if (config.logFormat === 'json' && config.env !== 'test') app.use(accessLog);
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ErrorFilter());
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  return app;
}
