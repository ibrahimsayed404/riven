import { Injectable } from '@nestjs/common';
import { OutboxDelivery, OutboxDeliveryStatus, OutboxEvent, Prisma } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { OUTBOX_CONSUMER_TIMEOUT_MS } from './outbox.constants';

export type ClaimedDelivery = OutboxDelivery & { event: OutboxEvent };

/** Thrown inside the consumer transaction when another instance took the lease over. */
export class OutboxLeaseLostError extends Error {
  constructor(deliveryId: string) {
    super(`lease lost for delivery ${deliveryId}`);
    this.name = 'OutboxLeaseLostError';
  }
}

/** Every Prisma call for the outbox tables (specs/commerce/01 §7.3 – §7.9). */
@Injectable()
export class OutboxRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claims due and stale deliveries in one statement, with database time only:
   * PENDING whose availableAt has passed, or PROCESSING whose lease expired (the
   * owner crashed or hung). SKIP LOCKED keeps two instances off the same rows.
   */
  async claim(owner: string, batch: number, leaseMs: number): Promise<ClaimedDelivery[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "outbox_deliveries" d
         SET "status" = 'PROCESSING', "leaseOwner" = ${owner},
             "leaseUntil" = now() + (${leaseMs} * interval '1 millisecond'), "attempts" = d."attempts" + 1
       WHERE d."id" IN (
         SELECT "id" FROM "outbox_deliveries"
          WHERE ("status" = 'PENDING' AND "availableAt" <= now())
             OR ("status" = 'PROCESSING' AND "leaseUntil" < now())
          ORDER BY "id"
          LIMIT ${batch}
          FOR UPDATE SKIP LOCKED)
      RETURNING d."id"`;
    if (rows.length === 0) return [];
    return this.prisma.outboxDelivery.findMany({ where: { id: { in: rows.map((r) => r.id) } }, include: { event: true }, orderBy: { id: 'asc' } });
  }

  /**
   * One consumer transaction: dedupe by processed_events, apply the consumer's
   * effect, then complete guarded by the lease. If the lease was taken over, the
   * guarded completion matches nothing and everything rolls back (01 §7.4).
   */
  async processInTransaction(
    delivery: ClaimedDelivery,
    owner: string,
    effect: (event: OutboxEvent, tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<'processed' | 'duplicate'> {
    return this.prisma.$transaction(
      async (tx) => {
        const fresh = await tx.$queryRaw<{ eventId: string }[]>`
          INSERT INTO "processed_events" ("consumer", "eventId", "processedAt")
          VALUES (${delivery.consumer}, ${delivery.eventId}, now())
          ON CONFLICT DO NOTHING
          RETURNING "eventId"`;
        if (fresh.length > 0) await effect(delivery.event, tx);

        const done = await tx.outboxDelivery.updateMany({
          where: { id: delivery.id, status: OutboxDeliveryStatus.PROCESSING, leaseOwner: owner },
          data: { status: OutboxDeliveryStatus.PROCESSED, processedAt: new Date(), lastError: null },
        });
        if (done.count !== 1) throw new OutboxLeaseLostError(delivery.id);
        return fresh.length > 0 ? 'processed' : 'duplicate';
      },
      { timeout: OUTBOX_CONSUMER_TIMEOUT_MS },
    );
  }

  /** Guarded by the lease: retry later (PENDING + backoff, database time) or give up (DEAD). */
  async fail(deliveryId: string, owner: string, error: string, dead: boolean, backoffMs: number): Promise<boolean> {
    const count = dead
      ? await this.prisma.$executeRaw`
          UPDATE "outbox_deliveries" SET "status" = 'DEAD', "lastError" = ${error}
           WHERE "id" = ${deliveryId} AND "status" = 'PROCESSING' AND "leaseOwner" = ${owner}`
      : await this.prisma.$executeRaw`
          UPDATE "outbox_deliveries"
             SET "status" = 'PENDING', "lastError" = ${error},
                 "availableAt" = now() + (${backoffMs} * interval '1 millisecond'),
                 "leaseOwner" = NULL, "leaseUntil" = NULL
           WHERE "id" = ${deliveryId} AND "status" = 'PROCESSING' AND "leaseOwner" = ${owner}`;
    return count === 1;
  }

  /** DEAD → PENDING only; attempts reset (recorded by the caller's audit row). */
  async requeue(deliveryId: string): Promise<OutboxDelivery | null> {
    const result = await this.prisma.outboxDelivery.updateMany({
      where: { id: deliveryId, status: OutboxDeliveryStatus.DEAD },
      data: { status: OutboxDeliveryStatus.PENDING, attempts: 0, availableAt: new Date(), leaseOwner: null, leaseUntil: null },
    });
    if (result.count !== 1) return null;
    return this.prisma.outboxDelivery.findUnique({ where: { id: deliveryId } });
  }

  findDelivery(id: string) {
    return this.prisma.outboxDelivery.findUnique({ where: { id }, include: { event: true } });
  }

  async listDeliveries(filter: { status?: OutboxDeliveryStatus; consumer?: string; type?: string; page: number; limit: number }) {
    const where: Prisma.OutboxDeliveryWhereInput = {};
    if (filter.status) where.status = filter.status;
    if (filter.consumer) where.consumer = filter.consumer;
    if (filter.type) where.event = { type: filter.type };
    const [total, data] = await this.prisma.$transaction([
      this.prisma.outboxDelivery.count({ where }),
      this.prisma.outboxDelivery.findMany({
        where,
        include: { event: true },
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.limit,
        take: filter.limit,
      }),
    ]);
    return { data, total };
  }

  /** Monitoring (01 §7.7). */
  async metrics() {
    const [byStatus, oldestPending, expiredLeases, retried] = await this.prisma.$transaction([
      this.prisma.outboxDelivery.groupBy({ by: ['status'], _count: { _all: true }, orderBy: { status: 'asc' } }),
      this.prisma.outboxDelivery.findFirst({ where: { status: OutboxDeliveryStatus.PENDING }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.prisma.outboxDelivery.count({ where: { status: OutboxDeliveryStatus.PROCESSING, leaseUntil: { lt: new Date() } } }),
      this.prisma.outboxDelivery.count({ where: { attempts: { gt: 1 }, status: { not: OutboxDeliveryStatus.PROCESSED } } }),
    ]);
    const counts = Object.fromEntries(byStatus.map((row) => [row.status, (row._count as { _all: number })._all])) as Partial<Record<OutboxDeliveryStatus, number>>;
    return {
      pending: counts.PENDING ?? 0,
      processing: counts.PROCESSING ?? 0,
      processed: counts.PROCESSED ?? 0,
      dead: counts.DEAD ?? 0,
      oldestPendingAt: oldestPending?.createdAt ?? null,
      expiredLeases,
      retrying: retried,
    };
  }

  /** Run record for a drain (shared maintenance_runs table, command OUTBOX_DRAIN). */
  async recordDrain(data: {
    triggeredBy: string;
    status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
    startedAt: Date;
    processed: number;
    released: number;
    skipped: number;
    failed: number;
    error: string | null;
    jobId?: string | null;
  }) {
    return this.prisma.maintenanceRun.create({
      data: {
        command: 'OUTBOX_DRAIN',
        triggeredBy: data.triggeredBy,
        status: data.status,
        startedAt: data.startedAt,
        finishedAt: new Date(),
        processed: data.processed,
        released: data.released,
        skipped: data.skipped,
        failed: data.failed,
        error: data.error,
        jobId: data.jobId ?? null,
      },
    });
  }
}
