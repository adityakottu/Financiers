import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './app';
import { loadConfig } from './config/config';

async function bootstrap() {
  const config = loadConfig();
  const app = await createApp(config);
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  new Logger('Bootstrap').log(`API listening on :${config.port} (${config.env})`);
}

void bootstrap();
