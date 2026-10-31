import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { AdminOutboxController } from './admin-outbox.controller';
import { OutboxDrainProcessor, OutboxJobsService } from './jobs/outbox-jobs.service';
import { OUTBOX_HANDLERS, OUTBOX_QUEUE } from './outbox.constants';
import { OutboxRepository } from './outbox.repository';
import { OutboxHandler, OutboxService } from './outbox.service';

/**
 * Transactional outbox drain (specs/commerce/01 §7, TD-06) on its own queue
 * (TD-23). Consumer handlers are registered under OUTBOX_HANDLERS by their
 * modules; none exist yet (the notifications module is not built).
 */
@Module({
  imports: [AuditModule, BullModule.registerQueue({ name: OUTBOX_QUEUE })],
  controllers: [AdminOutboxController],
  providers: [
    OutboxRepository,
    OutboxService,
    OutboxJobsService,
    OutboxDrainProcessor,
    { provide: OUTBOX_HANDLERS, useValue: [] as OutboxHandler[] },
  ],
  exports: [OutboxService],
})
export class OutboxModule {}
