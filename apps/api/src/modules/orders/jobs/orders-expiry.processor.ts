import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';

import { OrdersService } from '../orders.service';
import { EXPIRE_PENDING_JOB, ORDERS_QUEUE } from './orders-jobs.service';

@Processor(ORDERS_QUEUE)
export class OrdersExpiryProcessor extends WorkerHost {
  private readonly logger = new Logger(OrdersExpiryProcessor.name);

  constructor(
    private readonly ordersService: OrdersService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<unknown, unknown, string>): Promise<unknown> {
    if (job.name !== EXPIRE_PENDING_JOB) return undefined;

    const ttlMinutes = this.configService.get<number>('CHECKOUT_PENDING_TTL_MINUTES') ?? 60;
    try {
      return await this.ordersService.expireStalePendingGroups(ttlMinutes);
    } catch (error) {
      this.logger.error('Failed to expire abandoned checkouts', error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }
}
