import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';

import { ExpiryRunResult, ReservationExpiryService } from '../expiry/reservation-expiry.service';
import { EXPIRE_PENDING_JOB, ORDERS_QUEUE, ownsExpirySchedule, ProcessRole } from './orders-jobs.service';

/**
 * The orders-queue worker. Created with autorun off and started only in the
 * process that owns reservation expiry (PROCESS_ROLE), so an API running next to
 * a dedicated worker never processes the job too (specs/commerce/23 R1).
 */
@Processor(ORDERS_QUEUE, { autorun: false, concurrency: 1 })
export class OrdersExpiryProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrdersExpiryProcessor.name);

  constructor(
    private readonly expiryService: ReservationExpiryService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  onApplicationBootstrap() {
    if (!ownsExpirySchedule(this.configService.get<ProcessRole>('PROCESS_ROLE'))) return;
    this.worker.run().catch((error: unknown) => {
      this.logger.error(`orders worker stopped: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * The job payload is ignored: eligibility comes only from PostgreSQL
   * (specs/commerce/21 §8, MNT-02). A run that FAILED as a whole fails the job,
   * so BullMQ records it; per-group failures leave the run PARTIAL instead.
   */
  async process(job: Job<unknown, unknown, string>): Promise<unknown> {
    if (job.name !== EXPIRE_PENDING_JOB) return undefined;

    const result = await this.expiryService.runScheduled(job.id ?? null, job.timestamp ? new Date(job.timestamp) : null);
    await this.heartbeat(result);
    if (result.status === 'FAILED') {
      throw new Error(`Expiry run ${result.runId} failed: ${result.error ?? 'unknown error'}`);
    }
    return result;
  }

  /** A Redis error must never become an unhandled 'error' event (BullMQ guidance). */
  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.warn(`orders worker error: ${error.message}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error) {
    this.logger.error(`orders job ${job?.id ?? '?'} failed: ${error.message}`);
  }

  /** External heartbeat (22 §4.3, M1): independent of PostgreSQL and Redis for alerting. Best-effort. */
  private async heartbeat(result: ExpiryRunResult): Promise<void> {
    const url = this.configService.get<string>('EXPIRY_HEARTBEAT_URL');
    if (!url) return;
    const target = result.status === 'FAILED' ? `${url.replace(/\/$/, '')}/fail` : url;
    try {
      await fetch(target, { method: 'GET', signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      this.logger.warn(`expiry heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
