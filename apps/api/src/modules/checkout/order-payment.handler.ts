import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { toCents } from '../../common/money';
import {
  PaymobHandlerOutcome,
  PaymobPaymentEvent,
  PaymobWebhookDispatcher,
  PaymobWebhookHandler,
} from '../../infra/paymob/paymob-webhook.dispatcher';
import { CheckoutRepository, OrderGroupWithOrders } from './checkout.repository';

/** Prefix of the special_reference we send Paymob for a checkout; see referenceFor(). */
export const ORDER_GROUP_REFERENCE_PREFIX = 'og:';

export function orderGroupReference(groupId: string): string {
  return `${ORDER_GROUP_REFERENCE_PREFIX}${groupId}`;
}

/**
 * Turns a Paymob success webhook into PAID orders — once, for the right
 * amount, on the right group (fix.js PAY-01, PAY-02). Registered with the
 * single PaymobWebhookDispatcher (fix.js PLAN-02), which has already verified
 * the signature and decided the event is a completed payment.
 *
 * Rules:
 *  - The group is found by the id Paymob signs as order.id — never by
 *    special_reference, which any replayer can rewrite, and never by the
 *    transaction id (a different id space).
 *  - A group records at most one transaction. A replay (same id) is a
 *    duplicate; a different id on an already-recorded group is a double
 *    charge, logged for a manual refund and never applied.
 *  - The expected amount is the sum of the group's non-cancelled orders; only
 *    PENDING orders move to PAID. A payment for a fully cancelled group is
 *    recorded and logged for a manual refund, never applied.
 */
@Injectable()
export class OrderPaymentHandler implements PaymobWebhookHandler, OnModuleInit {
  readonly name = 'order-groups';
  private readonly logger = new Logger(OrderPaymentHandler.name);

  constructor(
    private readonly dispatcher: PaymobWebhookDispatcher,
    private readonly checkoutRepository: CheckoutRepository,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register(this);
  }

  async handle(event: PaymobPaymentEvent): Promise<PaymobHandlerOutcome> {
    if (!event.signedOrderId) {
      return 'unmatched'; // nothing signed to match on; another handler may know this shape
    }
    const group = await this.checkoutRepository.findGroupByPaymobOrderId(event.signedOrderId);
    if (!group) {
      return 'unmatched';
    }

    // The unsigned reference may only corroborate the group the signed ids found.
    if (event.unsignedReference !== null && event.unsignedReference !== orderGroupReference(group.id)) {
      this.logger.error(
        `Paymob webhook: reference ${event.unsignedReference} does not match group ${group.id} found by signed ids; refusing`,
      );
      return 'unmatched';
    }

    // Already carries a transaction: replay of the same one, or a second charge.
    if (group.paymobTransactionId !== null) {
      if (group.paymobTransactionId === event.transactionId) {
        return 'duplicate';
      }
      this.logger.error(
        `Paymob webhook: SECOND transaction ${event.transactionId} (${event.amountCents} piastres) for group ${group.id}, ` +
          `which already recorded ${group.paymobTransactionId}. Customer likely charged twice — refund manually.`,
      );
      return 'double_payment';
    }

    const expectedCents = this.expectedCents(group);
    const hasPendingOrders = group.orders.some((order) => order.status === 'PENDING');

    let outcome: PaymobHandlerOutcome;
    let markPaid = false;

    if (expectedCents === 0 || !hasPendingOrders) {
      outcome = 'orphan';
    } else if (event.amountCents !== expectedCents) {
      outcome = 'amount_mismatch';
    } else {
      outcome = 'paid';
      markPaid = true;
    }

    const { recorded, paidOrders } = await this.checkoutRepository.recordPayment({
      groupId: group.id,
      transactionId: event.transactionId,
      amountCents: Number.isFinite(event.amountCents) ? event.amountCents : 0,
      markPaid,
    });
    if (!recorded) {
      // Lost a race with a concurrent delivery of a webhook for this group.
      return 'duplicate';
    }
    if (outcome === 'paid' && paidOrders === 0) {
      // Raced with a cancel between our read and the write; money is recorded.
      outcome = 'orphan';
    }

    if (outcome === 'amount_mismatch') {
      this.logger.error(
        `Paymob webhook: amount mismatch for group ${group.id} — expected ${expectedCents} piastres, received ${event.amountCents}. ` +
          `Transaction ${event.transactionId} recorded, orders NOT marked paid. Needs a human.`,
      );
    } else if (outcome === 'orphan') {
      this.logger.error(
        `Paymob webhook: payment ${event.transactionId} (${event.amountCents} piastres) for group ${group.id} whose orders are all ` +
          `cancelled or already paid. Recorded for manual refund; nothing marked paid.`,
      );
    } else if (outcome === 'paid') {
      this.logger.log(`Paymob webhook: group ${group.id} paid by transaction ${event.transactionId} (${event.amountCents} piastres)`);
    }

    return outcome;
  }

  /** What the shopper still owes: every order not cancelled, in integer piastres. */
  private expectedCents(group: OrderGroupWithOrders): number {
    return group.orders
      .filter((order) => order.status !== 'CANCELLED')
      .reduce((sum, order) => sum + toCents(order.subtotal), 0);
  }
}
