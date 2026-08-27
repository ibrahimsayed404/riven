import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class BazaarJobsService implements OnModuleInit {
  constructor(@InjectQueue('bazaars') private readonly bazaarsQueue: Queue) {}

  async onModuleInit() {
    // Note: Recurring bazaars are not auto-completed in this pass because we lack an
    // RRULE expansion library to accurately determine the end of their last occurrence.
    // We only auto-complete ONE_OFF bazaars when they pass their endDate.
    await this.bazaarsQueue.upsertJobScheduler(
      'autocomplete-one-off-scheduler',
      {
        pattern: '*/15 * * * *', // Run every 15 minutes
      },
      {
        name: 'autocomplete-one-off',
        data: {},
      }
    );
  }
}
