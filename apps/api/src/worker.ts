import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './worker.module';

const logger = new Logger('Worker');

// A worker must stay up through transient failures: an unhandled rejection is
// logged, never fatal (specs/commerce/23 R1.6). Real crashes are restarted by the host.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

async function bootstrap() {
  // This entry point is always the owner of reservation expiry (22 §5.4).
  process.env.PROCESS_ROLE = 'worker';

  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM: the expiry run stops between groups, then BullMQ closes the worker
  // after the active job (beforeApplicationShutdown → onApplicationShutdown).
  app.enableShutdownHooks();
  logger.log('Reservation-expiration worker started.');
}

void bootstrap();
