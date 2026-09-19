import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PaymobPaymentEvent, PaymobWebhookDispatcher } from '../../infra/paymob/paymob-webhook.dispatcher';
import { CheckoutRepository } from './checkout.repository';
import { OrderPaymentHandler, orderGroupReference } from './order-payment.handler';

const D = (n: number | string) => new Prisma.Decimal(n);

function group(
  orders: { status: string; subtotal: string }[],
  over: { id?: string; paymobTransactionId?: string | null } = {},
) {
  return {
    id: over.id ?? 'group-1',
    paymobTransactionId: over.paymobTransactionId ?? null,
    orders: orders.map((o, i) => ({ id: `o${i}`, status: o.status, subtotal: D(o.subtotal) })),
  } as any;
}

const event = (over: Partial<PaymobPaymentEvent> = {}): PaymobPaymentEvent => ({
  transactionId: '555',
  signedOrderId: '900',
  amountCents: 3040,
  unsignedReference: null,
  raw: {},
  ...over,
});

describe('OrderPaymentHandler', () => {
  let handler: OrderPaymentHandler;
  let dispatcher: { register: jest.Mock };
  let repo: jest.Mocked<CheckoutRepository>;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    dispatcher = { register: jest.fn() };
    repo = {
      findGroupByPaymobOrderId: jest.fn(),
      recordPayment: jest.fn().mockResolvedValue({ recorded: true, paidOrders: 1 }),
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

  it('the reference sent to Paymob is prefixed so future payers (subscriptions, fees) cannot collide', () => {
    expect(orderGroupReference('abc')).toBe('og:abc');
  });

  describe('matching (PAY-02)', () => {
    it('looks the group up only by the signed order.id — never by the transaction id or the unsigned reference', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group([{ status: 'PENDING', subtotal: '30.40' }]));
      await handler.handle(event({ unsignedReference: 'attacker-chosen' }));
      expect(repo.findGroupByPaymobOrderId).toHaveBeenCalledWith('900');
    });

    it('an event with no signed order.id is unmatched without touching the database', async () => {
      await expect(handler.handle(event({ signedOrderId: null }))).resolves.toBe('unmatched');
      expect(repo.findGroupByPaymobOrderId).not.toHaveBeenCalled();
    });

    it('refuses when the unsigned reference disagrees with the group found by the signed id', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group([{ status: 'PENDING', subtotal: '30.40' }], { id: 'group-1' }));
      await expect(handler.handle(event({ unsignedReference: 'og:group-OTHER' }))).resolves.toBe('unmatched');
      expect(repo.recordPayment).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    });

    it('accepts a matching prefixed reference', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group([{ status: 'PENDING', subtotal: '30.40' }], { id: 'group-1' }));
      await expect(handler.handle(event({ unsignedReference: 'og:group-1' }))).resolves.toBe('paid');
    });

    it('unmatched when no group has that order id — nothing written', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(null);
      await expect(handler.handle(event())).resolves.toBe('unmatched');
      expect(repo.recordPayment).not.toHaveBeenCalled();
    });
  });

  describe('applying the payment (PAY-01, PAY-04)', () => {
    it('marks PENDING orders PAID when the amount equals the non-cancelled total, and records the transaction', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group([{ status: 'PENDING', subtotal: '30.30' }, { status: 'PENDING', subtotal: '0.10' }]));
      await expect(handler.handle(event({ amountCents: 3040 }))).resolves.toBe('paid');
      expect(repo.recordPayment).toHaveBeenCalledWith({ groupId: 'group-1', transactionId: '555', amountCents: 3040, markPaid: true });
    });

    it('a cancelled sub-order is excluded from the expected amount; the remaining PENDING one is paid', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group([{ status: 'CANCELLED', subtotal: '30.30' }, { status: 'PENDING', subtotal: '0.10' }]));
      await expect(handler.handle(event({ amountCents: 10 }))).resolves.toBe('paid');
      expect(repo.recordPayment).toHaveBeenCalledWith(expect.objectContaining({ markPaid: true, amountCents: 10 }));
    });

    it('amount mismatch: transaction recorded, orders NOT marked paid, error logged', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group([{ status: 'PENDING', subtotal: '30.40' }]));
      repo.recordPayment.mockResolvedValue({ recorded: true, paidOrders: 0 });
      await expect(handler.handle(event({ amountCents: 3039 }))).resolves.toBe('amount_mismatch');
      expect(repo.recordPayment).toHaveBeenCalledWith(expect.objectContaining({ markPaid: false, amountCents: 3039 }));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('amount mismatch'));
    });

    it('payment for a fully cancelled group is an orphan: recorded for refund, nothing paid', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group([{ status: 'CANCELLED', subtotal: '30.40' }]));
      repo.recordPayment.mockResolvedValue({ recorded: true, paidOrders: 0 });
      await expect(handler.handle(event())).resolves.toBe('orphan');
      expect(repo.recordPayment).toHaveBeenCalledWith(expect.objectContaining({ markPaid: false }));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('manual refund'));
    });

    it('a replayed webhook (same transaction id already recorded) is a duplicate: no write at all', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group([{ status: 'PAID', subtotal: '30.40' }], { paymobTransactionId: '555' }));
      await expect(handler.handle(event())).resolves.toBe('duplicate');
      expect(repo.recordPayment).not.toHaveBeenCalled();
    });

    it('a DIFFERENT transaction for a group that already recorded one is a double charge: logged for refund, first record kept', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group([{ status: 'PAID', subtotal: '30.40' }], { paymobTransactionId: '555' }));
      await expect(handler.handle(event({ transactionId: '777' }))).resolves.toBe('double_payment');
      expect(repo.recordPayment).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('charged twice'));
    });

    it('losing the race to a concurrent delivery (guarded write claimed nothing) is a duplicate', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group([{ status: 'PENDING', subtotal: '30.40' }]));
      repo.recordPayment.mockResolvedValue({ recorded: false, paidOrders: 0 });
      await expect(handler.handle(event())).resolves.toBe('duplicate');
    });

    it('if a cancel raced the write and zero orders moved, the outcome is orphan, not paid', async () => {
      repo.findGroupByPaymobOrderId.mockResolvedValue(group([{ status: 'PENDING', subtotal: '30.40' }]));
      repo.recordPayment.mockResolvedValue({ recorded: true, paidOrders: 0 });
      await expect(handler.handle(event())).resolves.toBe('orphan');
    });
  });
});
