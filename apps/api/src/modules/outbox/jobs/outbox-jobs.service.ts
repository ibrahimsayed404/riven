import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';

import { ownsScheduledJobs, ProcessRole, reconcileJobScheduler, SchedulerSpec } from '../../../infra/queue/scheduler-reconciler';
import {
  OUTBOX_DRAIN_JOB,
  OUTBOX_DRAIN_PATTERN,
  OUTBOX_JOB_TEMPLATE_OPTIONS,
  OUTBOX_QUEUE,
  OUTBOX_SCHEDULER_ID,
} from '../outbox.constants';
import { OutboxService } from '../outbox.service';

const OUTBOX_SCHEDULER: SchedulerSpec = {
  id: OUTBOX_SCHEDULER_ID,
  pattern: OUTBOX_DRAIN_PATTERN,
  intervalMs: 5 * 60_000,
  jobName: OUTBOX_DRAIN_JOB,
  templateOptions: OUTBOX_JOB_TEMPLATE_OPTIONS,
};

/** Owns the scheduled outbox drain (01 §7.5 path 5) in the process whose PROCESS_ROLE allows it. */
@Injectable()
export class OutboxJobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxJobsService.name);
  private timer?: NodeJS.Timeout;
  private reconciling = false;

  constructor(
    @InjectQueue(OUTBOX_QUEUE) private readonly outboxQueue: Queue,
    private readonly configService: ConfigService,
  ) {}

  onApplicationBootstrap() {
    if (!ownsScheduledJobs(this.configService.get<ProcessRole>('PROCESS_ROLE'))) return;
    this.outboxQueue.on('error', (error) => this.logger.warn(`outbox queue error: ${error.message}`));
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const result = await reconcileJobScheduler(this.outboxQueue, OUTBOX_SCHEDULER);
      if (result.outcome === 'recreated') this.logger.warn(`Outbox drain schedule recreated (${result.reason}).`);
    } catch (error) {
      this.logger.warn(`Outbox schedule reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.reconciling = false;
    }
  }
}

/** The outbox-queue worker: its own queue and concurrency, separate from reservation expiry (TD-23). */
@Processor(OUTBOX_QUEUE, { autorun: false, concurrency: 1 })
export class OutboxDrainProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxDrainProcessor.name);

  constructor(
    private readonly outboxService: OutboxService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  onApplicationBootstrap() {
    if (!ownsScheduledJobs(this.configService.get<ProcessRole>('PROCESS_ROLE'))) return;
    this.worker.run().catch((error: unknown) => {
      this.logger.error(`outbox worker stopped: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async process(job: Job<unknown, unknown, string>): Promise<unknown> {
    if (job.name !== OUTBOX_DRAIN_JOB) return undefined;
    return this.outboxService.drain({ triggeredBy: 'schedule', jobId: job.id ?? null });
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.warn(`outbox worker error: ${error.message}`);
  }
}
