import { Injectable } from '@nestjs/common';
import { PaymentProviderEventKind, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { PAYMOB_PROVIDER } from './paymob.constants';

export interface StoredProviderEvent {
  id: string;
  /** Already processed by an earlier delivery: the caller must not apply it again. */
  alreadyProcessed: boolean;
}

/**
 * Every signed Paymob callback, stored before anything is applied
 * (specs/commerce/25 S1). The unique (provider, transaction id, kind) makes
 * repeated deliveries one row; `processedAt` separates "seen" from "done", so a
 * delivery that crashed half-way is processed again when Paymob retries it.
 */
@Injectable()
export class PaymobEventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(event: {
    providerTransactionId: string;
    kind: PaymentProviderEventKind;
    signedOrderId: string | null;
    amountCents: number | null;
    currency: string | null;
    payload: Record<string, unknown>;
  }): Promise<StoredProviderEvent> {
    const key = { provider: PAYMOB_PROVIDER, providerTransactionId: event.providerTransactionId, kind: event.kind };
    try {
      const created = await this.prisma.paymentProviderEvent.create({
        data: {
          ...key,
          signedOrderId: event.signedOrderId,
          amountCents: event.amountCents,
          currency: event.currency,
          payload: event.payload as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return { id: created.id, alreadyProcessed: false };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      const existing = await this.prisma.paymentProviderEvent.findUniqueOrThrow({
        where: { provider_providerTransactionId_kind: key },
        select: { id: true, processedAt: true },
      });
      return { id: existing.id, alreadyProcessed: existing.processedAt !== null };
    }
  }

  /** Signed PAYMENT callbacks received before `olderThan` and still not processed (a handler kept failing). */
  countStuckPayments(olderThan: Date): Promise<number> {
    return this.prisma.paymentProviderEvent.count({
      where: { kind: 'PAYMENT', processedAt: null, receivedAt: { lt: olderThan } },
    });
  }

  /** First finisher wins; a concurrent duplicate that also finishes changes nothing. */
  async markProcessed(id: string, outcome: string, handler: string | null): Promise<void> {
    await this.prisma.paymentProviderEvent.updateMany({
      where: { id, processedAt: null },
      data: { outcome, handler, processedAt: new Date() },
    });
  }
}
