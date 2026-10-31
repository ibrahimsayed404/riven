import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { AdminAction, AdminTargetType, OutboxDeliveryStatus, OutboxEvent, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { pageMeta } from '../../common/dto/pagination-query.dto';
import { AuditService } from '../audit/audit.service';
import {
  OUTBOX_CLAIM_BATCH,
  OUTBOX_DRAIN_BUDGET_MS,
  OUTBOX_DRAIN_MAX,
  OUTBOX_HANDLERS,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  outboxBackoffMs,
} from './outbox.constants';
import { OutboxLeaseLostError, OutboxRepository } from './outbox.repository';

/** A consumer: notifies, indexes or alerts — never money or stock (specs/commerce/01 §7.8). */
export interface OutboxHandler {
  consumer: string;
  handle(event: OutboxEvent, tx: Prisma.TransactionClient): Promise<void>;
}

/** Throw from a handler for poison input (schema / validation): the delivery goes DEAD at once. */
export class NonRetryableOutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableOutboxError';
  }
}

export interface DrainResult {
  runId: string | null;
  status: 'SUCCEEDED' | 'PARTIAL' | 'SKIPPED_BUSY';
  claimed: number;
  processed: number;
  duplicates: number;
  retried: number;
  dead: number;
  leaseLost: number;
}

/**
 * Drains the transactional outbox (01 §7.3 – §7.5): claim → consume → complete,
 * the same path for the boot sweep, the scheduled drain and the admin drain.
 * At-least-once delivery; exactly-once effects per consumer via processed_events.
 */
@Injectable()
export class OutboxService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxService.name);
  private readonly handlers: Map<string, OutboxHandler>;
  private draining = false;

  constructor(
    private readonly outboxRepository: OutboxRepository,
    private readonly auditService: AuditService,
    @Inject(OUTBOX_HANDLERS) handlers: OutboxHandler[],
  ) {
    this.handlers = new Map(handlers.map((h) => [h.consumer, h]));
  }

  /** Boot sweep on every instance (01 §7.5 path 3): crashes, restarts and deploys. Never blocks startup. */
  onApplicationBootstrap() {
    void this.drain({ triggeredBy: 'boot' }).catch((error: unknown) =>
      this.logger.warn(`outbox boot sweep failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  async drain(options: { triggeredBy: string; max?: number; budgetMs?: number; jobId?: string | null }): Promise<DrainResult> {
    const empty = { claimed: 0, processed: 0, duplicates: 0, retried: 0, dead: 0, leaseLost: 0 };
    if (this.draining) return { runId: null, status: 'SKIPPED_BUSY', ...empty }; // one drain per instance at a time
    this.draining = true;

    const startedAt = new Date();
    const max = options.max ?? OUTBOX_DRAIN_MAX;
    const deadline = startedAt.getTime() + (options.budgetMs ?? OUTBOX_DRAIN_BUDGET_MS);
    const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    const counts = { ...empty };
    let lastError: string | null = null;

    try {
      while (counts.claimed < max && Date.now() < deadline) {
        const batch = await this.outboxRepository.claim(owner, Math.min(OUTBOX_CLAIM_BATCH, max - counts.claimed), OUTBOX_LEASE_MS);
        if (batch.length === 0) break;
        counts.claimed += batch.length;

        for (const delivery of batch) {
          const handler = this.handlers.get(delivery.consumer);
          if (!handler) {
            await this.outboxRepository.fail(delivery.id, owner, `no handler registered for consumer "${delivery.consumer}"`, true, 0);
            counts.dead++;
            continue;
          }
          try {
            const outcome = await this.outboxRepository.processInTransaction(delivery, owner, (event, tx) => handler.handle(event, tx));
            if (outcome === 'processed') counts.processed++;
            else counts.duplicates++;
          } catch (error) {
            if (error instanceof OutboxLeaseLostError) {
              counts.leaseLost++; // another instance took it over; its result stands
              continue;
            }
            lastError = error instanceof Error ? error.message : String(error);
            const dead = error instanceof NonRetryableOutboxError || delivery.attempts >= OUTBOX_MAX_ATTEMPTS;
            await this.outboxRepository.fail(delivery.id, owner, lastError.slice(0, 1000), dead, outboxBackoffMs(delivery.attempts));
            if (dead) counts.dead++;
            else counts.retried++;
          }
        }
      }
    } finally {
      this.draining = false;
    }

    const status = counts.retried + counts.dead > 0 ? 'PARTIAL' : 'SUCCEEDED';
    let runId: string | null = null;
    if (counts.claimed > 0 || options.triggeredBy !== 'boot') {
      const run = await this.outboxRepository.recordDrain({
        triggeredBy: options.triggeredBy,
        status,
        startedAt,
        processed: counts.claimed,
        released: counts.processed + counts.duplicates,
        skipped: counts.leaseLost,
        failed: counts.retried + counts.dead,
        error: lastError,
        jobId: options.jobId,
      });
      runId = run.id;
    }
    return { runId, status, ...counts };
  }

  /** POST /admin/outbox/drain — bounded, audited, same claim path. */
  async drainForAdmin(adminId: string, max?: number): Promise<DrainResult> {
    const result = await this.drain({ triggeredBy: adminId, max: Math.min(max ?? OUTBOX_DRAIN_MAX, OUTBOX_DRAIN_MAX) });
    if (result.status === 'SKIPPED_BUSY') {
      throw new ConflictException({ code: 'OUTBOX_DRAIN_IN_PROGRESS', message: 'A drain is already running on this instance.' });
    }
    await this.auditService.record({
      actorId: adminId,
      action: AdminAction.OUTBOX_DRAIN_REQUESTED,
      targetType: AdminTargetType.OUTBOX,
      targetId: result.runId ?? 'none',
      reason: `claimed ${result.claimed}, processed ${result.processed}, retried ${result.retried}, dead ${result.dead}`,
    });
    return result;
  }

  /** PATCH /admin/outbox/deliveries/:id/requeue — DEAD → PENDING only, audited with the reason. */
  async requeueForAdmin(adminId: string, deliveryId: string, reason: string) {
    const existing = await this.outboxRepository.findDelivery(deliveryId);
    if (!existing) throw new NotFoundException({ code: 'OUTBOX_DELIVERY_NOT_FOUND', message: 'Delivery not found.' });
    const requeued = await this.outboxRepository.requeue(deliveryId);
    if (!requeued) {
      throw new ConflictException({ code: 'OUTBOX_DELIVERY_NOT_DEAD', message: `Only DEAD deliveries can be requeued (current: ${existing.status}).` });
    }
    await this.auditService.record({
      actorId: adminId,
      action: AdminAction.OUTBOX_DELIVERY_REQUEUED,
      targetType: AdminTargetType.OUTBOX,
      targetId: deliveryId,
      reason: `${reason} (attempts reset from ${existing.attempts})`,
    });
    return requeued;
  }

  async listForAdmin(filter: { status?: OutboxDeliveryStatus; consumer?: string; type?: string; page: number; limit: number }) {
    const { data, total } = await this.outboxRepository.listDeliveries(filter);
    return { data, meta: pageMeta(total, filter.page, filter.limit) };
  }

  async getForAdmin(deliveryId: string) {
    const delivery = await this.outboxRepository.findDelivery(deliveryId);
    if (!delivery) throw new NotFoundException({ code: 'OUTBOX_DELIVERY_NOT_FOUND', message: 'Delivery not found.' });
    return delivery;
  }

  metrics() {
    return this.outboxRepository.metrics();
  }
}
