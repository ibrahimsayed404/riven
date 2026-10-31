import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'node:path';

import { validateEnv } from './infra/config/env.validation';
import { PrismaModule } from './infra/prisma/prisma.module';
import { QueueModule } from './infra/queue/queue.module';
import { OrdersJobsModule } from './modules/orders/jobs/orders-jobs.module';
import { OutboxModule } from './modules/outbox/outbox.module';

/**
 * The dedicated background worker: reservation expiry and its schedule
 * reconciler (TD-22, specs/commerce/21 §8.4), plus the outbox drain on its own
 * queue in the same process (TD-23, 21 §8.5). No HTTP server, no other
 * queue processors.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [join(process.cwd(), '.env'), join(process.cwd(), '../../.env')],
      validate: validateEnv,
    }),
    PrismaModule,
    QueueModule,
    OrdersJobsModule,
    OutboxModule,
  ],
})
export class WorkerModule {}
