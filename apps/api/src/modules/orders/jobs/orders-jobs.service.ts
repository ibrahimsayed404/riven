import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobSchedulerJson, Queue } from 'bullmq';

import { MaintenanceRunsRepository } from '../maintenance-runs.repository';

export const ORDERS_QUEUE = 'orders';
export const EXPIRE_PENDING_JOB = 'expire-pending-checkouts';

// specs/commerce/21 §8.1 – §8.3, 23 R1 / R2 (TD-18).
export const EXPIRY_SCHEDULER_ID = 'expire-pending-checkouts-scheduler';
export const EXPIRY_PATTERN = '*/10 * * * *';
export const EXPIRY_INTERVAL_MS = 10 * 60_000;
export const SCHEDULE_RECONCILE_COMMAND = 'SCHEDULE_RECONCILE';
/** No business state in the job: the payload is empty, eligibility is read from PostgreSQL. */
export const EXPIRY_JOB_TEMPLATE_OPTIONS = {
  attempts: 1, // the next tick is the retry
  removeOnComplete: { count: 100, age: 86_400 },
  removeOnFail: { count: 1_000, age: 604_800 },
};
const RECONCILE_EVERY_MS = 60_000;
const RECONCILE_TIMEOUT_MS = 5_000;

export type ProcessRole = 'all' | 'api' | 'worker';

/** Exactly one component type runs the expiry worker and owns its schedule (22 §5.4). */
export function ownsExpirySchedule(role: ProcessRole | undefined): boolean {
  return role !== 'api';
}

/** Healthy = present, on the expected pattern, and its next run is not more than one interval overdue (21 §8.2.1). */
export function isScheduleHealthy(scheduler: JobSchedulerJson | undefined, now: number): boolean {
  return (
    !!scheduler &&
    scheduler.pattern === EXPIRY_PATTERN &&
    typeof scheduler.next === 'number' &&
    scheduler.next >= now - EXPIRY_INTERVAL_MS
  );
}

export type ReconcileOutcome = 'healthy' | 'recreated' | 'failed' | 'busy' | 'not-owner';

/**
 * Owns the reservation-expiry schedule in the process whose PROCESS_ROLE allows
 * it. Reconciles at boot (without blocking startup) and every 60 s: a scheduler
 * that is missing, on the wrong pattern, or whose next job is lost is upserted
 * again under the same fixed id — idempotent across restarts and instances,
 * never a second schedule. Each recreation is recorded (alert A8).
 */
@Injectable()
export class OrdersJobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OrdersJobsService.name);
  private timer?: NodeJS.Timeout;
  private reconciling = false;
  /** Consecutive failed reconcile checks (health signal A14). */
  consecutiveReconcileFailures = 0;

  constructor(
    @InjectQueue(ORDERS_QUEUE) private readonly ordersQueue: Queue,
    private readonly configService: ConfigService,
    private readonly runsRepository: MaintenanceRunsRepository,
  ) {}

  onApplicationBootstrap() {
    if (!ownsExpirySchedule(this.role())) return;

    this.ordersQueue.on('error', (error) => this.logger.warn(`orders queue error: ${error.message}`));
    void this.reconcile(); // never blocks startup
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async reconcile(): Promise<ReconcileOutcome> {
    if (!ownsExpirySchedule(this.role())) return 'not-owner';
    if (this.reconciling) return 'busy'; // single-flight
    this.reconciling = true;
    try {
      const outcome = await withTimeout(this.reconcileOnce(), RECONCILE_TIMEOUT_MS);
      this.consecutiveReconcileFailures = 0;
      return outcome;
    } catch (error) {
      this.consecutiveReconcileFailures++;
      this.logger.warn(
        `Expiry schedule reconcile failed (${this.consecutiveReconcileFailures} in a row): ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'failed';
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOnce(): Promise<'healthy' | 'recreated'> {
    const scheduler = await this.ordersQueue.getJobScheduler(EXPIRY_SCHEDULER_ID);
    if (isScheduleHealthy(scheduler, Date.now())) return 'healthy';

    const reason = !scheduler
      ? 'missing'
      : scheduler.pattern !== EXPIRY_PATTERN
        ? `pattern ${scheduler.pattern ?? 'none'}`
        : 'next run overdue';
    await this.ordersQueue.upsertJobScheduler(
      EXPIRY_SCHEDULER_ID,
      { pattern: EXPIRY_PATTERN },
      { name: EXPIRE_PENDING_JOB, data: {}, opts: EXPIRY_JOB_TEMPLATE_OPTIONS },
    );
    this.logger.warn(`Expiry schedule recreated (${reason}).`);
    try {
      await this.runsRepository.recordInstant(SCHEDULE_RECONCILE_COMMAND, 'reconciler', 'SUCCEEDED', `recreated: ${reason}`);
    } catch (error) {
      // The schedule is restored either way; the record is best-effort (PostgreSQL may be down).
      this.logger.warn(`Could not record schedule recreation: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 'recreated';
  }

  /** Redis reachability for /health/dependencies (alert A11): one bounded round trip. */
  async pingRedis(timeoutMs = 2_000): Promise<boolean> {
    try {
      await withTimeout(this.ordersQueue.getJobCounts('waiting'), timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /** Queue counts for monitoring (21 §8.3, 23 R2.4). */
  queueCounts() {
    return this.ordersQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  }

  private role(): ProcessRole {
    return this.configService.get<ProcessRole>('PROCESS_ROLE') ?? 'all';
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
