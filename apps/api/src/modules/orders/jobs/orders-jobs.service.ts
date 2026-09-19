import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';

export const ORDERS_QUEUE = 'orders';
export const EXPIRE_PENDING_JOB = 'expire-pending-checkouts';

/**
 * Schedules the abandoned-checkout sweep (fix.js PAY-03). Same pattern as
 * BazaarJobsService: an upserted repeatable job, idempotent across restarts.
 */
@Injectable()
export class OrdersJobsService implements OnModuleInit {
  constructor(@InjectQueue(ORDERS_QUEUE) private readonly ordersQueue: Queue) {}

  async onModuleInit() {
    await this.ordersQueue.upsertJobScheduler(
      'expire-pending-checkouts-scheduler',
      { pattern: '*/5 * * * *' }, // every 5 minutes
      { name: EXPIRE_PENDING_JOB, data: {} },
    );
  }
}
