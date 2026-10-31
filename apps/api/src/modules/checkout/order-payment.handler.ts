import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
  PaymobHandlerOutcome,
  PaymobPaymentEvent,
  PaymobWebhookDispatcher,
  PaymobWebhookHandler,
} from '../../infra/paymob/paymob-webhook.dispatcher';
import { PAYMOB_PROVIDER } from '../../infra/paymob/paymob.constants';
import { CheckoutRepository } from './checkout.repository';

/** Prefix of the special_reference we send Paymob for a checkout; see orderGroupReference(). */
export const ORDER_GROUP_REFERENCE_PREFIX = 'og:';

export function orderGroupReference(groupId: string): string {
  return `${ORDER_GROUP_REFERENCE_PREFIX}${groupId}`;
}

/**
 * Turns a Paymob payment callback into PAID orders — once, for the right
 * amount and currency, on the right group (fix.js PAY-01, PAY-02;
 * specs/commerce/25 S1). Registered with the single PaymobWebhookDispatcher,
 * which has already verified the signature, stored the callback, and decided
 * from signed fields that it is a payment.
 *
 * Rules:
 *  - The group is found by the id Paymob signs as order.id — never by
 *    special_reference, which any replayer can rewrite, and never by the
 *    transaction id (a different id space). The unsigned reference may only
 *    corroborate.
 *  - Everything else is decided and written under the group's row lock in one
 *    transaction (CheckoutRepository.applyPayment / decidePayment): a second
 *    charge, a late charge, a wrong amount or a wrong currency is recorded as a
 *    PaymentException in that same transaction — never only logged.
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
    // A signed charge that no handler claims is money taken for nothing known:
    // recorded as an UNMATCHED_PAYMENT exception for a human (commerce/25 §10).
    this.dispatcher.registerUnmatchedRecorder((event) =>
      this.checkoutRepository.recordUnmatchedPayment({
        provider: PAYMOB_PROVIDER,
        transactionId: event.transactionId,
        amountCents: event.amountCents,
        currency: event.currency,
      }),
    );
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

    const applied = await this.checkoutRepository.applyPayment({
      groupId: group.id,
      provider: PAYMOB_PROVIDER,
      transactionId: event.transactionId,
      amountCents: event.amountCents,
      currency: event.currency,
    });

    const charge = `transaction ${event.transactionId} (${event.amountCents ?? '?'} ${event.currency ?? '?'})`;
    if (applied.outcome === 'paid') {
      this.logger.log(`Paymob webhook: group ${group.id} paid by ${charge}; ${applied.paidOrders} order(s) PAID`);
    } else if (applied.exception) {
      this.logger.error(
        `Paymob webhook: ${applied.exception} for group ${group.id}, ${charge}, expected ${applied.expectedCents} piastres. ` +
          'Recorded as a payment exception (GET /admin/payment-exceptions); nothing applied.',
      );
    }
    return applied.outcome;
  }
}
