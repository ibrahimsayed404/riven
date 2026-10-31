import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PaymentProviderEventKind } from '@prisma/client';

import { PaymobEventsRepository } from './paymob-events.repository';
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
  /** Signed `amount_cents`; null when missing or not a number (never applied then). */
  amountCents: number | null;
  /** Signed `currency`; null when missing (never applied then). */
  currency: string | null;
  unsignedReference: string | null;
  raw: Record<string, unknown>;
}

export type PaymobHandlerOutcome =
  | 'unmatched'
  | 'duplicate'
  | 'paid'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'orphan'
  | 'double_payment';

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

/** Records a signed, successful charge that no handler claimed, so a human sees it (commerce/25 §10). */
export type UnmatchedPaymentRecorder = (event: PaymobPaymentEvent) => Promise<void>;

export type WebhookOutcome = PaymobHandlerOutcome | 'ignored';

const isTrue = (value: unknown) => value === true;

/** Postgres INTEGER bound: a signed amount beyond it could not be stored and would fail every delivery. */
const INT32_MAX = 2_147_483_647;
const isId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const SIGNED_BOOLEANS = ['success', 'pending', 'error_occured', 'is_refunded', 'is_voided', 'is_capture', 'is_auth', 'has_parent_transaction', 'is_3d_secure', 'is_standalone_payment'] as const;

/**
 * Paymob's HMAC concatenates the signed values with no delimiter, so a holder
 * of one valid signature could shift characters between neighbouring fields
 * and keep it valid (commerce/25 §10 – §11). A callback is only trusted when
 * EVERY signed field that takes part in a decision is present with its exact
 * type and format — a missing field adds nothing to the signed string, which
 * is exactly what lets digits move across a boundary: JSON booleans, positive
 * safe integers for ids, a whole ISO timestamp, a 3-letter currency. The two
 * integer pairs that touch (id ↔ integration_id, order.id ↔ owner) are pinned
 * by the dispatcher to the configured integration and merchant. Returns why not.
 */
export function signedFieldProblem(obj: Record<string, any>): string | null {
  if (!isId(obj.id)) return 'id is not a positive integer';
  if (!isId(obj.order?.id)) return 'order.id is not a positive integer';
  if (!isId(obj.integration_id)) return 'integration_id is missing or not a positive integer';
  if (!isId(obj.owner)) return 'owner is missing or not a positive integer';
  if (!(typeof obj.amount_cents === 'number' && Number.isSafeInteger(obj.amount_cents))) return 'amount_cents is missing or not an integer';
  if (!(typeof obj.created_at === 'string' && ISO_INSTANT.test(obj.created_at))) return 'created_at is missing or not an ISO timestamp';
  if (!(typeof obj.currency === 'string' && CURRENCY_CODE.test(obj.currency))) return 'currency is missing or not a 3-letter code';
  for (const flag of SIGNED_BOOLEANS) {
    if (typeof obj[flag] !== 'boolean') return `${flag} is missing or not a JSON boolean`;
  }
  return null;
}

/** What is kept of a callback: the signed fields and a few unsigned diagnostics — no billing / shipping personal data. */
function evidenceOf(obj: Record<string, any>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of ['id', 'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction', 'integration_id', 'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded', 'is_standalone_payment', 'is_voided', 'owner', 'pending', 'success', 'special_reference', 'is_refund', 'is_void']) {
    if (obj[key] !== undefined) kept[key] = obj[key];
  }
  if (obj.order?.id !== undefined) kept.order = { id: obj.order.id, merchant_order_id: obj.order?.merchant_order_id };
  if (obj.source_data) kept.source_data = { pan: obj.source_data.pan, sub_type: obj.source_data.sub_type, type: obj.source_data.type };
  if (obj.data?.message !== undefined) kept.data = { message: obj.data.message };
  return kept;
}

/**
 * What a signed Paymob transaction callback is, from SIGNED fields only
 * (PAYMOB_HMAC_KEYS; specs/commerce/25 G3). Only PAYMENT is ever offered to a
 * handler: a refund, void, decline, pending or authorization-only callback is
 * stored as evidence and never mistaken for a (second) charge. The unsigned
 * `is_void` flag only labels a child transaction as VOID vs REFUND; it never
 * decides whether money is applied.
 */
export function classifyPaymobTransaction(obj: Record<string, unknown>): PaymentProviderEventKind {
  if (isTrue(obj.pending)) return PaymentProviderEventKind.PENDING;
  if (isTrue(obj.is_voided)) return PaymentProviderEventKind.VOID;
  if (isTrue(obj.is_refunded)) return PaymentProviderEventKind.REFUND;
  if (isTrue(obj.has_parent_transaction)) return isTrue(obj.is_void) ? PaymentProviderEventKind.VOID : PaymentProviderEventKind.REFUND;
  if (isTrue(obj.is_auth) && !isTrue(obj.is_capture)) return PaymentProviderEventKind.OTHER;
  if (isTrue(obj.success) && !isTrue(obj.error_occured)) return PaymentProviderEventKind.PAYMENT;
  return PaymentProviderEventKind.DECLINED;
}

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
  private unmatchedRecorder: UnmatchedPaymentRecorder | null = null;

  constructor(
    private readonly paymobService: PaymobService,
    private readonly events: PaymobEventsRepository,
  ) {}

  registerUnmatchedRecorder(recorder: UnmatchedPaymentRecorder): void {
    if (this.unmatchedRecorder) throw new Error('Paymob unmatched-payment recorder registered twice');
    this.unmatchedRecorder = recorder;
  }

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

    const parsed = this.parse(payload);
    if (!parsed) {
      return { received: true, outcome: 'ignored' };
    }
    const { kind, event } = parsed;

    // Stored before anything is applied (evidence + database-level idempotency).
    const stored = await this.events.record({
      providerTransactionId: event.transactionId,
      kind,
      signedOrderId: event.signedOrderId,
      amountCents: event.amountCents,
      currency: event.currency,
      payload: event.raw,
    });
    if (stored.alreadyProcessed) {
      return { received: true, outcome: 'duplicate' };
    }

    if (kind !== PaymentProviderEventKind.PAYMENT) {
      await this.events.markProcessed(stored.id, 'ignored', null);
      return { received: true, outcome: 'ignored' };
    }

    // A handler that throws leaves the event unprocessed: Paymob's retry of
    // this callback runs it again, and the handlers are idempotent.
    for (const handler of this.handlers) {
      const outcome = await handler.handle(event);
      if (outcome !== 'unmatched') {
        await this.events.markProcessed(stored.id, outcome, handler.name);
        return { received: true, outcome, handler: handler.name };
      }
    }
    this.logger.warn(
      `Paymob webhook: no handler claimed transaction ${event.transactionId} (order.id=${event.signedOrderId}, ` +
        `reference=${event.unsignedReference}) across ${this.handlers.length} handler(s); recorded as UNMATCHED_PAYMENT`,
    );
    // Money was taken for nothing we know: an exception a human must resolve,
    // recorded before the event counts as processed (a crash here is retried).
    if (this.unmatchedRecorder) await this.unmatchedRecorder(event);
    await this.events.markProcessed(stored.id, 'unmatched', null);
    return { received: true, outcome: 'unmatched' };
  }

  /**
   * Null when the payload cannot be trusted as a Paymob transaction (nothing is
   * stored or matched — storing it would let a forgery occupy a transaction id).
   * Logged at ERROR: a correctly signed callback refused here may be a genuine
   * charge in an unexpected format, which needs a human before the order expires.
   */
  private parse(payload: unknown): { kind: PaymentProviderEventKind; event: PaymobPaymentEvent } | null {
    const body = (payload ?? {}) as Record<string, any>;
    const obj = (body.obj ?? body) as Record<string, any>;
    const problem = signedFieldProblem(obj);
    if (problem) {
      this.logger.error(`Paymob webhook refused: ${problem}; nothing stored`);
      return null;
    }
    const integration = this.paymobService.expectedIntegrationId();
    const merchant = this.paymobService.expectedMerchantId();
    if (integration === null || merchant === null) {
      this.logger.error('Paymob webhook refused: PAYMOB_INTEGRATION_ID / PAYMOB_MERCHANT_ID not configured; nothing stored');
      return null;
    }
    if (String(obj.integration_id) !== integration || String(obj.owner) !== merchant) {
      this.logger.error(`Paymob webhook refused: integration ${obj.integration_id} / owner ${obj.owner} is not ours; nothing stored`);
      return null;
    }
    const amount = obj.amount_cents;
    const reference = obj.special_reference ?? obj.order?.merchant_order_id;
    return {
      kind: classifyPaymobTransaction(obj),
      event: {
        transactionId: String(obj.id),
        signedOrderId: String(obj.order.id),
        // Outside 0..INT32 it could not be stored: treat as unknown → AMOUNT_MISMATCH, never a crash loop.
        amountCents: typeof amount === 'number' && amount >= 0 && amount <= INT32_MAX ? amount : null,
        currency: typeof obj.currency === 'string' ? obj.currency : null,
        unsignedReference: reference != null ? String(reference) : null,
        raw: evidenceOf(obj),
      },
    };
  }
}
