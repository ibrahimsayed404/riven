import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';

import { PaymobService } from './paymob.service';

/**
 * A Paymob transaction that passed the HMAC gate and represents money actually
 * taken. Only signed fields are surfaced as first-class properties; anything a
 * replayer could rewrite (special_reference, merchant_order_id) is exposed as
 * `unsignedReference` and must only ever corroborate, never select.
 */
export interface PaymobPaymentEvent {
  transactionId: string;
  /** Paymob's order id — signed as `order.id`. */
  signedOrderId: string | null;
  amountCents: number;
  unsignedReference: string | null;
  raw: Record<string, unknown>;
}

export type PaymobHandlerOutcome = 'unmatched' | 'duplicate' | 'paid' | 'amount_mismatch' | 'orphan' | 'double_payment';

/**
 * Implemented by each module that sells something through Paymob (order
 * groups today; subscriptions and bazaar fees later — payments-module-spec).
 * Return 'unmatched' when the event is not yours so the dispatcher can try the
 * next handler.
 */
export interface PaymobWebhookHandler {
  readonly name: string;
  handle(event: PaymobPaymentEvent): Promise<PaymobHandlerOutcome>;
}

export type WebhookOutcome = PaymobHandlerOutcome | 'ignored';

/**
 * Paymob posts every transaction of a merchant account to ONE callback URL.
 * This is that URL's brain (fix.js PLAN-02): verify the signature once, decide
 * once whether the event is a payment, then offer it to each registered handler
 * until one claims it. Modules register themselves on init; nobody adds a
 * second route.
 */
@Injectable()
export class PaymobWebhookDispatcher {
  private readonly logger = new Logger(PaymobWebhookDispatcher.name);
  private readonly handlers: PaymobWebhookHandler[] = [];

  constructor(private readonly paymobService: PaymobService) {}

  register(handler: PaymobWebhookHandler): void {
    if (this.handlers.some((h) => h.name === handler.name)) {
      throw new Error(`Paymob webhook handler "${handler.name}" registered twice`);
    }
    this.handlers.push(handler);
  }

  async dispatch(payload: unknown, hmacValue: string | undefined): Promise<{ received: true; outcome: WebhookOutcome; handler?: string }> {
    if (!hmacValue) {
      throw new UnauthorizedException({ code: 'WEBHOOK_SIGNATURE_MISSING', message: 'Missing HMAC signature.' });
    }
    if (!this.paymobService.verifyWebhookHmac(payload, hmacValue)) {
      throw new UnauthorizedException({ code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Invalid HMAC signature.' });
    }

    const event = this.toPaymentEvent(payload);
    if (!event) {
      return { received: true, outcome: 'ignored' };
    }

    for (const handler of this.handlers) {
      const outcome = await handler.handle(event);
      if (outcome !== 'unmatched') {
        return { received: true, outcome, handler: handler.name };
      }
    }

    this.logger.warn(
      `Paymob webhook: no handler claimed transaction ${event.transactionId} (order.id=${event.signedOrderId}, ` +
        `reference=${event.unsignedReference}) across ${this.handlers.length} handler(s)`,
    );
    return { received: true, outcome: 'unmatched' };
  }

  /** Null when the payload is not a completed successful payment. */
  private toPaymentEvent(payload: unknown): PaymobPaymentEvent | null {
    const body = (payload ?? {}) as Record<string, any>;
    const obj = (body.obj ?? body) as Record<string, any>;

    const isPayment = obj.success === true && obj.pending !== true && obj.error_occured !== true;
    if (!isPayment) return null;

    if (obj.id == null) {
      this.logger.warn('Paymob webhook without a transaction id; ignoring');
      return null;
    }

    const reference = obj.special_reference ?? obj.order?.merchant_order_id;
    return {
      transactionId: String(obj.id),
      signedOrderId: obj.order?.id != null ? String(obj.order.id) : null,
      amountCents: Number(obj.amount_cents ?? obj.order?.amount_cents ?? NaN),
      unsignedReference: reference != null ? String(reference) : null,
      raw: obj,
    };
  }
}
