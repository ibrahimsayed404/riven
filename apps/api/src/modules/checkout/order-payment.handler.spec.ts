import { Logger } from '@nestjs/common';
import { PaymentExceptionType } from '@prisma/client';

import { PaymobPaymentEvent, PaymobWebhookDispatcher } from '../../infra/paymob/paymob-webhook.dispatcher';
import { AppliedPayment, CheckoutRepository } from './checkout.repository';
import { OrderPaymentHandler, orderGroupReference } from './order-payment.handler';

const group = (id = 'group-1') => ({ id, paymobTransactionId: null, orders: [] }) as any;

const event = (over: Partial<PaymobPaymentEvent> = {}): PaymobPaymentEvent => ({
  transactionId: '555',
  signedOrderId: '900',
  amountCents: 3040,
  currency: 'EGP',
  unsignedReference: null,
  raw: {},
  ...over,
});

const applied = (over: Partial<AppliedPayment> = {}): AppliedPayment => ({
  outcome: 'paid',
  claim: true,
  markPaid: true,
  exception: null,
  expectedCents: 3040,
  paidOrders: 1,
  ...over,
});

// The decision rules themselves are unit-tested in payment-decision.spec.ts and
// on real PostgreSQL in payment-webhook.e2e.spec.ts; this covers the handler's
// own job: signed matching, the reference check, and handing over to applyPayment.
describe('OrderPaymentHandler', () => {
  let handler: OrderPaymentHandler;
  let dispatcher: { register: jest.Mock; registerUnmatchedRecorder: jest.Mock };
  let repo: jest.Mocked<CheckoutRepository>;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    dispatcher = { register: jest.fn(), registerUnmatchedRecorder: jest.fn() };
    repo = {
      findGroupByPaymobOrderId: jest.fn(),
      applyPayment: jest.fn().mockResolvedValue(applied()),
      recordUnmatchedPayment: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<CheckoutRepository>;
    handler = new OrderPaymentHandler(dispatcher as unknown as PaymobWebhookDispatcher, repo);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('registers itself with the single dispatcher on init (PLAN-02)', () => {
    handler.onModuleInit();
    expect(dispatcher.register).toHaveBeenCalledWith(handler);
    expect(handler.name).toBe('order-groups');
  });

  it('registers the recorder that turns an unclaimed signed charge into an UNMATCHED_PAYMENT exception', async () => {
    handler.onModuleInit();
    const recorder = dispatcher.registerUnmatchedRecorder.mock.calls[0][0];
    await recorder(event({ transactionId: '777', amountCents: 500, currency: 'EGP' }));
    expect(repo.recordUnmatchedPayment).toHaveBeenCalledWith({ provider: 'PAYMOB', transactionId: '777', amountCents: 500, currency: 'EGP' });
  });

  it('the reference sent to Paymob is prefixed so future payers (subscriptions, fees) cannot collide', () => {
    expect(orderGroupReference('abc')).toBe('og:abc');
  });

  describe('matching (PAY-02)', () => {
    it('looks the group up only by the signed order.id — never by the transaction id or the unsigned reference', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group());
      await handler.handle(event({ unsignedReference: null }));
      expect(repo.findGroupByPaymobOrderId).toHaveBeenCalledWith('900');
    });

    it('an event with no signed order.id is unmatched without touching the database', async () => {
      await expect(handler.handle(event({ signedOrderId: null }))).resolves.toBe('unmatched');
      expect(repo.findGroupByPaymobOrderId).not.toHaveBeenCalled();
    });

    it('refuses when the unsigned reference disagrees with the group found by the signed id', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group('group-1'));
      await expect(handler.handle(event({ unsignedReference: 'og:group-OTHER' }))).resolves.toBe('unmatched');
      expect(repo.applyPayment).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('accepts a matching prefixed reference', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group('group-1'));
      await expect(handler.handle(event({ unsignedReference: 'og:group-1' }))).resolves.toBe('paid');
    });

    it('unmatched when no group has that order id — nothing written', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(null);
      await expect(handler.handle(event())).resolves.toBe('unmatched');
      expect(repo.applyPayment).not.toHaveBeenCalled();
    });
  });

  describe('handing over to the locked, atomic applyPayment (commerce/25 S1)', () => {
    it('passes the signed transaction id, amount and currency, tagged PAYMOB', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group('group-1'));
      await handler.handle(event());
      expect(repo.applyPayment).toHaveBeenCalledWith({ groupId: 'group-1', provider: 'PAYMOB', transactionId: '555', amountCents: 3040, currency: 'EGP' });
    });

    it.each([
      ['double_payment', PaymentExceptionType.DOUBLE_PAYMENT],
      ['orphan', PaymentExceptionType.LATE_PAYMENT],
      ['amount_mismatch', PaymentExceptionType.AMOUNT_MISMATCH],
      ['currency_mismatch', PaymentExceptionType.CURRENCY_MISMATCH],
    ] as const)('returns %s and logs an error naming the recorded exception', async (outcome, exception) => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group('group-1'));
      repo.applyPayment.mockResolvedValue(applied({ outcome, exception, markPaid: false, paidOrders: 0 }));
      await expect(handler.handle(event())).resolves.toBe(outcome);
      expect(errorSpy.mock.calls[0][0]).toContain(exception);
      expect(errorSpy.mock.calls[0][0]).toContain('Recorded as a payment exception');
    });

    it('a duplicate delivery is returned as such, without an error log', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group('group-1'));
      repo.applyPayment.mockResolvedValue(applied({ outcome: 'duplicate', claim: false, markPaid: false, paidOrders: 0 }));
      await expect(handler.handle(event())).resolves.toBe('duplicate');
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('a database failure propagates (the dispatcher leaves the event unprocessed for the retry)', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group('group-1'));
      repo.applyPayment.mockRejectedValue(new Error('lock timeout'));
      await expect(handler.handle(event())).rejects.toThrow('lock timeout');
    });
  });
});
