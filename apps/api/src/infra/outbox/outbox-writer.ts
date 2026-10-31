import { Prisma } from '@prisma/client';

import { OUTBOX_CONSUMER_REGISTRY, OutboxConsumerRegistry } from './outbox.registry';

export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  type: string;
  /** No secrets, no full account numbers (01 §7.9). */
  payload: Prisma.InputJsonValue;
  correlationId?: string;
}

/**
 * Writes one outbox event and one PENDING delivery per registered consumer, using
 * the caller's transaction client — call it from inside the business
 * transaction, so the event exists iff the business change committed
 * (specs/commerce/01 §7.1, OBX-01). Nothing is published here; processing
 * happens after commit through the drain.
 *
 * `sequence` is per aggregate. The producer already holds the aggregate's row
 * lock (01 §4), so two writers for one aggregate cannot interleave; if they ever
 * did, the unique (aggregateType, aggregateId, sequence) refuses the second.
 */
export async function writeOutboxEvent(
  tx: Prisma.TransactionClient,
  input: OutboxEventInput,
  registry: OutboxConsumerRegistry = OUTBOX_CONSUMER_REGISTRY,
): Promise<string> {
  const last = await tx.outboxEvent.aggregate({
    where: { aggregateType: input.aggregateType, aggregateId: input.aggregateId },
    _max: { sequence: true },
  });
  const consumers = registry[input.type] ?? [];
  const event = await tx.outboxEvent.create({
    data: {
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      sequence: (last._max.sequence ?? 0) + 1,
      type: input.type,
      payload: input.payload,
      correlationId: input.correlationId ?? null,
      deliveries: { create: consumers.map((consumer) => ({ consumer })) },
    },
    select: { id: true },
  });
  return event.id;
}
