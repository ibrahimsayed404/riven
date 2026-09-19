import { Logger, UnauthorizedException } from '@nestjs/common';

import { PaymobWebhookController } from './paymob-webhook.controller';
import { PaymobPaymentEvent, PaymobWebhookDispatcher, PaymobWebhookHandler } from './paymob-webhook.dispatcher';
import { PaymobService } from './paymob.service';

const success = (over: Record<string, unknown> = {}) => ({
  obj: { id: 555, success: true, pending: false, error_occured: false, amount_cents: 3040, order: { id: 900 }, ...over },
});

function handler(name: string, outcome: 'unmatched' | 'paid' | 'duplicate'): PaymobWebhookHandler & { handle: jest.Mock } {
  return { name, handle: jest.fn().mockResolvedValue(outcome) };
}

describe('PaymobWebhookDispatcher (PLAN-02)', () => {
  let paymob: jest.Mocked<PaymobService>;
  let dispatcher: PaymobWebhookDispatcher;

  beforeEach(() => {
    paymob = { verifyWebhookHmac: jest.fn().mockReturnValue(true) } as unknown as jest.Mocked<PaymobService>;
    dispatcher = new PaymobWebhookDispatcher(paymob);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('signature gate', () => {
    it('401 WEBHOOK_SIGNATURE_MISSING without an hmac; handlers never run', async () => {
      const h = handler('a', 'paid');
      dispatcher.register(h);
      await expect(dispatcher.dispatch(success(), undefined)).rejects.toMatchObject({ response: { code: 'WEBHOOK_SIGNATURE_MISSING' } });
      expect(h.handle).not.toHaveBeenCalled();
    });

    it('401 WEBHOOK_SIGNATURE_INVALID when verification fails', async () => {
      paymob.verifyWebhookHmac.mockReturnValue(false);
      await expect(dispatcher.dispatch(success(), 'bad')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('the controller accepts the hmac from the query string as well as the header', async () => {
      const controller = new PaymobWebhookController(dispatcher);
      await controller.handleWebhook(success(), undefined, 'sig');
      expect(paymob.verifyWebhookHmac).toHaveBeenCalledWith(success(), 'sig');
    });
  });

  describe('what counts as a payment', () => {
    it.each([
      ['pending transaction', { pending: true }],
      ['failed transaction', { success: false }],
      ['error flag set', { error_occured: true }],
      ['no transaction id', { id: undefined }],
    ])('ignores a %s without consulting handlers', async (_label, over) => {
      const h = handler('a', 'paid');
      dispatcher.register(h);
      await expect(dispatcher.dispatch(success(over), 'sig')).resolves.toEqual({ received: true, outcome: 'ignored' });
      expect(h.handle).not.toHaveBeenCalled();
    });
  });

  describe('handler chaining', () => {
    it('normalises the event: signed ids as strings, amount as a number, unsigned reference separated', async () => {
      const h = handler('orders', 'paid');
      dispatcher.register(h);

      await dispatcher.dispatch(success({ special_reference: 'og:group-1' }), 'sig');

      const event: PaymobPaymentEvent = h.handle.mock.calls[0][0];
      expect(event).toMatchObject({ transactionId: '555', signedOrderId: '900', amountCents: 3040, unsignedReference: 'og:group-1' });
    });

    it('offers the event to handlers in order until one claims it, and names the claimant', async () => {
      const first = handler('subscriptions', 'unmatched');
      const second = handler('orders', 'paid');
      const third = handler('fees', 'paid');
      dispatcher.register(first);
      dispatcher.register(second);
      dispatcher.register(third);

      const result = await dispatcher.dispatch(success(), 'sig');

      expect(result).toEqual({ received: true, outcome: 'paid', handler: 'orders' });
      expect(third.handle).not.toHaveBeenCalled();
    });

    it('200 unmatched (and a warning) when no handler claims the event', async () => {
      dispatcher.register(handler('orders', 'unmatched'));
      await expect(dispatcher.dispatch(success(), 'sig')).resolves.toEqual({ received: true, outcome: 'unmatched' });
    });

    it('refuses to register the same handler name twice', () => {
      dispatcher.register(handler('orders', 'paid'));
      expect(() => dispatcher.register(handler('orders', 'paid'))).toThrow(/registered twice/);
    });
  });
});
