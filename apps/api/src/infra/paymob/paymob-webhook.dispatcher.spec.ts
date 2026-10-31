import { Logger, UnauthorizedException } from '@nestjs/common';
import { PaymentProviderEventKind } from '@prisma/client';

import { PaymobEventsRepository } from './paymob-events.repository';
import { PaymobWebhookController } from './paymob-webhook.controller';
import {
  classifyPaymobTransaction,
  PaymobPaymentEvent,
  PaymobWebhookDispatcher,
  PaymobWebhookHandler,
  signedFieldProblem,
} from './paymob-webhook.dispatcher';
import { PaymobService } from './paymob.service';

/** A complete signed Paymob transaction: every field of PAYMOB_HMAC_KEYS that takes part in a decision. */
const signedObj = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 555,
  amount_cents: 3040,
  created_at: '2026-10-31T10:00:00.123456',
  currency: 'EGP',
  integration_id: 12,
  owner: 7,
  order: { id: 900 },
  success: true,
  pending: false,
  error_occured: false,
  has_parent_transaction: false,
  is_3d_secure: true,
  is_auth: false,
  is_capture: false,
  is_refunded: false,
  is_standalone_payment: true,
  is_voided: false,
  ...over,
});
const success = (over: Record<string, unknown> = {}) => ({ obj: signedObj(over) });
const without = (field: string) => {
  const obj = signedObj();
  delete obj[field];
  return { obj };
};

function handler(name: string, outcome: 'unmatched' | 'paid' | 'duplicate'): PaymobWebhookHandler & { handle: jest.Mock } {
  return { name, handle: jest.fn().mockResolvedValue(outcome) };
}

describe('PaymobWebhookDispatcher (PLAN-02, commerce/25 S1)', () => {
  let paymob: jest.Mocked<PaymobService>;
  let events: { record: jest.Mock; markProcessed: jest.Mock };
  let dispatcher: PaymobWebhookDispatcher;

  beforeEach(() => {
    paymob = {
      verifyWebhookHmac: jest.fn().mockReturnValue(true),
      expectedIntegrationId: jest.fn().mockReturnValue('12'),
      expectedMerchantId: jest.fn().mockReturnValue('7'),
    } as unknown as jest.Mocked<PaymobService>;
    events = { record: jest.fn().mockResolvedValue({ id: 'ev-1', alreadyProcessed: false }), markProcessed: jest.fn().mockResolvedValue(undefined) };
    dispatcher = new PaymobWebhookDispatcher(paymob, events as unknown as PaymobEventsRepository);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('signature gate', () => {
    it('401 WEBHOOK_SIGNATURE_MISSING without an hmac; nothing stored, handlers never run', async () => {
      const h = handler('a', 'paid');
      dispatcher.register(h);
      await expect(dispatcher.dispatch(success(), undefined)).rejects.toMatchObject({ response: { code: 'WEBHOOK_SIGNATURE_MISSING' } });
      expect(h.handle).not.toHaveBeenCalled();
      expect(events.record).not.toHaveBeenCalled();
    });

    it('401 WEBHOOK_SIGNATURE_INVALID when verification fails; nothing stored', async () => {
      paymob.verifyWebhookHmac.mockReturnValue(false);
      await expect(dispatcher.dispatch(success(), 'bad')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(events.record).not.toHaveBeenCalled();
    });

    it('the controller accepts the hmac from the query string as well as the header', async () => {
      const controller = new PaymobWebhookController(dispatcher);
      await controller.handleWebhook(success(), undefined, 'sig');
      expect(paymob.verifyWebhookHmac).toHaveBeenCalledWith(success(), 'sig');
    });
  });

  describe('classification from SIGNED fields only (G3)', () => {
    it.each([
      ['a completed successful charge', {}, PaymentProviderEventKind.PAYMENT],
      ['a capture of an authorization', { is_auth: true, is_capture: true }, PaymentProviderEventKind.PAYMENT],
      ['a pending transaction', { pending: true }, PaymentProviderEventKind.PENDING],
      ['a failed transaction', { success: false }, PaymentProviderEventKind.DECLINED],
      ['an error flag', { error_occured: true }, PaymentProviderEventKind.DECLINED],
      ['a refunded transaction', { is_refunded: true }, PaymentProviderEventKind.REFUND],
      ['a voided transaction', { is_voided: true }, PaymentProviderEventKind.VOID],
      ['a refund child transaction (success: true)', { has_parent_transaction: true }, PaymentProviderEventKind.REFUND],
      ['a void child transaction (success: true)', { has_parent_transaction: true, is_void: true }, PaymentProviderEventKind.VOID],
      ['an authorization only', { is_auth: true, is_capture: false }, PaymentProviderEventKind.OTHER],
      ['string "true" is not a JSON boolean: never a payment', { success: 'true' }, PaymentProviderEventKind.DECLINED],
    ])('%s → %s', (_label, over, kind) => {
      expect(classifyPaymobTransaction(success(over).obj)).toBe(kind);
    });

    it('the UNSIGNED is_refund / is_void flags never turn a signed success into a non-payment or vice versa', () => {
      expect(classifyPaymobTransaction(success({ is_refund: true }).obj)).toBe(PaymentProviderEventKind.PAYMENT);
      expect(classifyPaymobTransaction(success({ is_void: true }).obj)).toBe(PaymentProviderEventKind.PAYMENT);
    });
  });

  describe('signed fields must have their exact types (delimiter-less HMAC, commerce/25 §10)', () => {
    it.each([
      ['a string transaction id', { id: '555' }],
      ['a non-numeric order id', { order: { id: 'po-1' } }],
      ['a decimal amount', { amount_cents: 30.4 }],
      ['a lower-case currency', { currency: 'egp' }],
      ['a non-ISO created_at', { created_at: 'yesterday' }],
      ['a string boolean', { success: 'true' }],
      ['a string integration id', { integration_id: '12' }],
      ['a null currency', { currency: null }],
      ['a created_at with trailing characters (EGP shifted into it)', { created_at: '2026-10-31T10:00:00.123456EGP' }],
      ['a null owner', { owner: null }],
    ])('%s: refused, nothing stored, no handler', async (_label, over) => {
      const h = handler('orders', 'paid');
      dispatcher.register(h);
      await expect(dispatcher.dispatch(success(over), 'sig')).resolves.toEqual({ received: true, outcome: 'ignored' });
      expect(events.record).not.toHaveBeenCalled();
      expect(h.handle).not.toHaveBeenCalled();
    });

    it.each([['integration_id'], ['owner'], ['amount_cents'], ['created_at'], ['currency'], ['success'], ['is_voided'], ['has_parent_transaction']])(
      'a callback without %s is refused: a missing signed field adds nothing to the HMAC string, which is what lets digits move',
      async (field) => {
        const h = handler('orders', 'paid');
        dispatcher.register(h);
        await expect(dispatcher.dispatch(without(field), 'sig')).resolves.toEqual({ received: true, outcome: 'ignored' });
        expect(events.record).not.toHaveBeenCalled();
      },
    );

    it('forged by shifting digits (judge round 2): id+integration_id merged, or order.id+owner merged — refused, nothing stored', async () => {
      const h = handler('orders', 'paid');
      dispatcher.register(h);
      const idShift = signedObj({ id: Number('555' + '12') });
      delete idShift.integration_id;
      const ownerShift = signedObj({ order: { id: Number('900' + '7') } });
      delete ownerShift.owner;
      await expect(dispatcher.dispatch({ obj: idShift }, 'sig')).resolves.toMatchObject({ outcome: 'ignored' });
      await expect(dispatcher.dispatch({ obj: ownerShift }, 'sig')).resolves.toMatchObject({ outcome: 'ignored' });
      // with both fields present, moving digits changes integration_id or owner away from the pinned values
      await expect(dispatcher.dispatch(success({ id: 5551, integration_id: 2 }), 'sig')).resolves.toMatchObject({ outcome: 'ignored' });
      await expect(dispatcher.dispatch(success({ order: { id: 9007 }, owner: 0 }), 'sig')).resolves.toMatchObject({ outcome: 'ignored' });
      await expect(dispatcher.dispatch(success({ owner: 70 }), 'sig')).resolves.toMatchObject({ outcome: 'ignored' });
      expect(h.handle).not.toHaveBeenCalled();
      expect(events.record).not.toHaveBeenCalled();
    });

    it('when the integration or merchant pin is not configured, every callback is refused (never trusted unpinned)', async () => {
      const h = handler('orders', 'paid');
      dispatcher.register(h);
      paymob.expectedMerchantId.mockReturnValue(null);
      await expect(dispatcher.dispatch(success(), 'sig')).resolves.toEqual({ received: true, outcome: 'ignored' });
      paymob.expectedMerchantId.mockReturnValue('7');
      paymob.expectedIntegrationId.mockReturnValue(null);
      await expect(dispatcher.dispatch(success(), 'sig')).resolves.toEqual({ received: true, outcome: 'ignored' });
      expect(events.record).not.toHaveBeenCalled();
    });

    it('a refused signed callback is logged at ERROR (it may be a genuine charge in an unexpected format)', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      await dispatcher.dispatch(success({ created_at: '2026-10-31 10:00:00' }), 'sig');
      expect(errorSpy.mock.calls.some(([message]) => String(message).includes('Paymob webhook refused'))).toBe(true);
    });

    it('a well-formed callback has no problem', () => {
      expect(signedFieldProblem(success({ created_at: '2026-10-31T10:00:00.000Z', integration_id: 12, owner: 7 }).obj)).toBeNull();
    });

    it('a callback for another Paymob integration is not ours (pins the id/integration_id boundary)', async () => {
      paymob.expectedIntegrationId.mockReturnValue('12');
      const h = handler('orders', 'paid');
      dispatcher.register(h);
      await expect(dispatcher.dispatch(success({ integration_id: 13 }), 'sig')).resolves.toEqual({ received: true, outcome: 'ignored' });
      expect(events.record).not.toHaveBeenCalled();
      await expect(dispatcher.dispatch(success({ integration_id: 12 }), 'sig')).resolves.toMatchObject({ outcome: 'paid' });
    });

    it('an amount beyond the INTEGER range becomes null (→ AMOUNT_MISMATCH), never a crash loop', async () => {
      const h = handler('orders', 'paid');
      dispatcher.register(h);
      await dispatcher.dispatch(success({ amount_cents: 2_147_483_648 }), 'sig');
      expect(h.handle.mock.calls[0][0].amountCents).toBeNull();
    });

    it('stores only the signed fields and unsigned diagnostics — no billing or shipping personal data', async () => {
      dispatcher.register(handler('orders', 'paid'));
      await dispatcher.dispatch(success({ billing_data: { email: 'shopper@x.com', phone_number: '+20100' }, order: { id: 900, shipping_data: { street: 'x' } } }), 'sig');
      const stored = JSON.stringify(events.record.mock.calls[0][0].payload);
      expect(stored).not.toContain('shopper@x.com');
      expect(stored).not.toContain('street');
      expect(events.record.mock.calls[0][0].payload).toMatchObject({ id: 555, amount_cents: 3040, currency: 'EGP', order: { id: 900 } });
    });
  });

  describe('every signed callback is stored before anything is applied', () => {
    it.each([
      ['pending transaction', { pending: true }, PaymentProviderEventKind.PENDING],
      ['failed transaction', { success: false }, PaymentProviderEventKind.DECLINED],
      ['refund', { has_parent_transaction: true }, PaymentProviderEventKind.REFUND],
      ['void', { is_voided: true }, PaymentProviderEventKind.VOID],
    ])('a %s is stored, marked processed as ignored, and never offered to a handler', async (_label, over, kind) => {
      const h = handler('a', 'paid');
      dispatcher.register(h);
      await expect(dispatcher.dispatch(success(over), 'sig')).resolves.toEqual({ received: true, outcome: 'ignored' });
      expect(events.record).toHaveBeenCalledWith(expect.objectContaining({ providerTransactionId: '555', kind }));
      expect(events.markProcessed).toHaveBeenCalledWith('ev-1', 'ignored', null);
      expect(h.handle).not.toHaveBeenCalled();
    });

    it('a callback without a transaction id cannot be stored or matched: ignored', async () => {
      const h = handler('a', 'paid');
      dispatcher.register(h);
      await expect(dispatcher.dispatch(success({ id: undefined }), 'sig')).resolves.toEqual({ received: true, outcome: 'ignored' });
      expect(events.record).not.toHaveBeenCalled();
      expect(h.handle).not.toHaveBeenCalled();
    });

    it('a callback already processed by an earlier delivery is a duplicate: no handler runs', async () => {
      events.record.mockResolvedValue({ id: 'ev-1', alreadyProcessed: true });
      const h = handler('orders', 'paid');
      dispatcher.register(h);
      await expect(dispatcher.dispatch(success(), 'sig')).resolves.toEqual({ received: true, outcome: 'duplicate' });
      expect(h.handle).not.toHaveBeenCalled();
      expect(events.markProcessed).not.toHaveBeenCalled();
    });

    it('a stored but unprocessed callback (earlier delivery crashed) is processed again', async () => {
      events.record.mockResolvedValue({ id: 'ev-1', alreadyProcessed: false });
      const h = handler('orders', 'paid');
      dispatcher.register(h);
      await expect(dispatcher.dispatch(success(), 'sig')).resolves.toMatchObject({ outcome: 'paid' });
      expect(h.handle).toHaveBeenCalledTimes(1);
    });

    it('a handler that throws leaves the event unprocessed (the provider retry runs it again)', async () => {
      const h = { name: 'orders', handle: jest.fn().mockRejectedValue(new Error('db down')) };
      dispatcher.register(h);
      await expect(dispatcher.dispatch(success(), 'sig')).rejects.toThrow('db down');
      expect(events.markProcessed).not.toHaveBeenCalled();
    });
  });

  describe('handler chaining', () => {
    it('normalises the event: signed ids as strings, signed amount and currency, unsigned reference separated', async () => {
      const h = handler('orders', 'paid');
      dispatcher.register(h);

      await dispatcher.dispatch(success({ special_reference: 'og:group-1' }), 'sig');

      const event: PaymobPaymentEvent = h.handle.mock.calls[0][0];
      expect(event).toMatchObject({ transactionId: '555', signedOrderId: '900', amountCents: 3040, currency: 'EGP', unsignedReference: 'og:group-1' });
    });

    it('never falls back to the UNSIGNED order.amount_cents: a callback without the signed amount or currency is refused', async () => {
      const h = handler('orders', 'paid');
      dispatcher.register(h);
      const outcome = await dispatcher.dispatch(success({ amount_cents: undefined, currency: undefined, order: { id: 900, amount_cents: 3040 } }), 'sig');
      expect(outcome).toEqual({ received: true, outcome: 'ignored' });
      expect(h.handle).not.toHaveBeenCalled();
    });

    it('offers the event to handlers in order until one claims it, names the claimant, and marks the event processed', async () => {
      const first = handler('subscriptions', 'unmatched');
      const second = handler('orders', 'paid');
      const third = handler('fees', 'paid');
      dispatcher.register(first);
      dispatcher.register(second);
      dispatcher.register(third);

      const result = await dispatcher.dispatch(success(), 'sig');

      expect(result).toEqual({ received: true, outcome: 'paid', handler: 'orders' });
      expect(third.handle).not.toHaveBeenCalled();
      expect(events.markProcessed).toHaveBeenCalledWith('ev-1', 'paid', 'orders');
    });

    it('200 unmatched when no handler claims the event: recorded as an exception BEFORE the event counts as processed', async () => {
      const order: string[] = [];
      dispatcher.register(handler('orders', 'unmatched'));
      dispatcher.registerUnmatchedRecorder(async (event) => {
        order.push(`recorded ${event.transactionId}`);
      });
      events.markProcessed.mockImplementation(async () => {
        order.push('processed');
      });
      await expect(dispatcher.dispatch(success(), 'sig')).resolves.toEqual({ received: true, outcome: 'unmatched' });
      expect(order).toEqual(['recorded 555', 'processed']);
      expect(events.markProcessed).toHaveBeenCalledWith('ev-1', 'unmatched', null);
    });

    it('if recording the unmatched charge fails, the event stays unprocessed (the provider retry records it)', async () => {
      dispatcher.register(handler('orders', 'unmatched'));
      dispatcher.registerUnmatchedRecorder(async () => {
        throw new Error('db down');
      });
      await expect(dispatcher.dispatch(success(), 'sig')).rejects.toThrow('db down');
      expect(events.markProcessed).not.toHaveBeenCalled();
    });

    it('refuses a second unmatched-payment recorder', () => {
      dispatcher.registerUnmatchedRecorder(async () => undefined);
      expect(() => dispatcher.registerUnmatchedRecorder(async () => undefined)).toThrow(/registered twice/);
    });

    it('refuses to register the same handler name twice', () => {
      dispatcher.register(handler('orders', 'paid'));
      expect(() => dispatcher.register(handler('orders', 'paid'))).toThrow(/registered twice/);
    });
  });
});
