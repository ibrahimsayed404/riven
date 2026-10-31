import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAction, AdminTargetType } from '@prisma/client';
import { hostname } from 'os';

import { AuditService } from '../../audit/audit.service';
import { MOVEMENT_SOURCE } from '../../products/inventory-ledger';
import { OrdersRepository } from '../orders.repository';
import {
  EXPIRE_OVERDUE_COMMAND,
  EXPIRY_BATCH_SIZE,
  MANUAL_RUN_BUDGET_MS,
  SCHEDULED_RUN_BUDGET_MS,
  STALE_RUN_AFTER_MS,
} from './expiry.constants';
import { MaintenanceRunStatus, MaintenanceRunsRepository } from '../maintenance-runs.repository';

export interface ExpiryRunOptions {
  /** 'schedule' or the admin user id (manual command). */
  triggeredBy: string;
  jobId?: string | null;
  scheduledFor?: Date | null;
  budgetMs: number;
  batchSize?: number;
}

export interface ExpiryRunResult {
  runId: string;
  status: Exclude<MaintenanceRunStatus, 'RUNNING'>;
  batches: number;
  candidates: number;
  processed: number;
  released: number;
  skipped: number;
  failed: number;
  ordersCancelled: number;
  error: string | null;
}

/**
 * Releases abandoned checkouts (specs/commerce/21 §8, 23 R0). Scheduled and
 * manual runs share this one method: same eligibility, locks and transactions;
 * only the trigger and the time budget differ.
 *
 * - Every run has a MaintenanceRun row, written before any group is touched.
 * - Each group is its own transaction (OrdersRepository.cancelPendingGroup);
 *   a failing group is counted and skipped, never aborting the run.
 * - An in-memory keyset cursor moves past every attempted group, so a run tries
 *   each group at most once; the next run starts again from the oldest.
 * - The TTL cutoff is computed once per run from the application clock, as
 *   before R0 (23 §11.7).
 */
@Injectable()
export class ReservationExpiryService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ReservationExpiryService.name);
  private stopping = false;

  constructor(
    private readonly ordersRepository: OrdersRepository,
    private readonly runsRepository: MaintenanceRunsRepository,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  /** SIGTERM: stop starting new groups; the group in progress finishes (23 R1.3). */
  beforeApplicationShutdown(): void {
    this.stopping = true;
  }

  /** Scheduled run (the BullMQ processor). */
  runScheduled(jobId: string | null, scheduledFor: Date | null): Promise<ExpiryRunResult> {
    return this.run({ triggeredBy: 'schedule', jobId, scheduledFor, budgetMs: SCHEDULED_RUN_BUDGET_MS });
  }

  /**
   * Manual run (POST /admin/maintenance/expire-overdue). Works without Redis:
   * no queue is involved. One audit write is attempted per call, even when
   * nothing is released (23 §11.4, C-c); it is best-effort, like every admin
   * audit row (C-d — TD-04 pending).
   */
  async runManual(adminId: string, reason: string): Promise<ExpiryRunResult> {
    const result = await this.run({ triggeredBy: adminId, budgetMs: MANUAL_RUN_BUDGET_MS });
    await this.auditService.record({
      actorId: adminId,
      action: AdminAction.MAINTENANCE_EXPIRE_OVERDUE,
      targetType: AdminTargetType.MAINTENANCE_RUN,
      targetId: result.runId,
      reason,
    });
    return result;
  }

  async run(options: ExpiryRunOptions): Promise<ExpiryRunResult> {
    const batchSize = options.batchSize ?? EXPIRY_BATCH_SIZE;
    const ttlMs = this.ttlMinutes() * 60_000;
    const startedAt = Date.now();
    const cutoff = new Date(startedAt - ttlMs);

    // A row left RUNNING by a process that died is closed by age only.
    await this.runsRepository.closeStale(EXPIRE_OVERDUE_COMMAND, new Date(startedAt - STALE_RUN_AFTER_MS));

    const backlog = await this.ordersRepository.staleBacklog(cutoff);
    const oldestDeadline = backlog.oldestCreatedAt ? new Date(backlog.oldestCreatedAt.getTime() + ttlMs) : null;
    const run = await this.runsRepository.start({
      command: EXPIRE_OVERDUE_COMMAND,
      triggeredBy: options.triggeredBy,
      jobId: options.jobId ?? null,
      scheduledFor: options.scheduledFor ?? null,
      workerInstance: `${hostname()}:${process.pid}`,
      backlogAtStart: backlog.count,
      oldestOverdueAtStart: oldestDeadline,
      catchUp: backlog.count > batchSize,
    });

    const counts = { batches: 0, candidates: 0, processed: 0, released: 0, skipped: 0, failed: 0, ordersCancelled: 0 };
    let lastError: string | null = null;
    let stoppedByShutdown = false;
    let runError: string | null = null;
    const deadline = startedAt + options.budgetMs;
    let cursor: { createdAt: Date; id: string } | undefined;

    try {
      batches: while (true) {
        if (this.stopping) {
          stoppedByShutdown = true;
          break;
        }
        if (Date.now() >= deadline) break;

        const batch = await this.ordersRepository.findStalePendingGroups(cutoff, batchSize, cursor);
        if (batch.length === 0) break;
        counts.batches++;
        counts.candidates += batch.length;

        for (const group of batch) {
          if (this.stopping) {
            stoppedByShutdown = true;
            break batches;
          }
          if (Date.now() >= deadline) break batches;

          cursor = { createdAt: group.createdAt, id: group.id };
          counts.processed++;
          try {
            const result = await this.ordersRepository.cancelPendingGroup(group.id, {
              lockMode: 'skipLocked',
              requireExpiryEligibility: true,
              source: MOVEMENT_SOURCE.EXPIRY,
            });
            if (result.outcome === 'released') {
              counts.released++;
              counts.ordersCancelled += result.cancelledOrderIds.length;
            } else {
              counts.skipped++;
              this.logger.debug(`Expiry skipped group ${group.id}: ${result.outcome === 'skipped' ? 'locked' : 'not_eligible'}`);
            }
          } catch (error) {
            counts.failed++;
            lastError = describe(error);
            this.logger.warn(`Expiry failed for group ${group.id}: ${lastError}`);
          }
        }
      }
    } catch (error) {
      // Run-level failure (e.g. the candidate query): recorded, never swallowed silently.
      runError = describe(error);
      this.logger.error(`Expiry run ${run.id} failed: ${runError}`);
    }

    const status: ExpiryRunResult['status'] = runError
      ? 'FAILED'
      : counts.failed > 0 || stoppedByShutdown
        ? 'PARTIAL'
        : 'SUCCEEDED';
    const error = runError ?? (stoppedByShutdown ? 'shutdown' : lastError);
    const { ordersCancelled, ...runCounts } = counts;

    const finished = await this.runsRepository.finish(run.id, { status, ...runCounts, error });
    if (!finished) {
      this.logger.warn(`Expiry run ${run.id} was already closed (stale) before it finished; its record was not overwritten.`);
    }
    if (counts.released > 0) {
      this.logger.log(`Expired ${counts.released} abandoned checkout group(s), ${ordersCancelled} order(s); stock released.`);
    }

    return { runId: run.id, status, ...counts, error };
  }

  private ttlMinutes(): number {
    return this.configService.get<number>('CHECKOUT_PENDING_TTL_MINUTES') ?? 60;
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Prisma puts a long code frame first and the database's own error last:
  // keep both ends so the stored run error still names the real cause.
  return message.length > 500 ? `${message.slice(0, 150)} … ${message.slice(-340)}` : message;
}
