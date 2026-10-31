import { OrderStatus, PaymentExceptionType } from '@prisma/client';

import { decidePayment } from './payment-decision';

const g = (orders: [OrderStatus, string][], paymobTransactionId: string | null = null) => ({
  paymobTransactionId,
  orders: orders.map(([status, subtotal]) => ({ status, subtotal })),
});
const charge = (over: Partial<{ transactionId: string; amountCents: number | null; currency: string | null }> = {}) => ({
  transactionId: 'tx-1',
  amountCents: 3040,
  currency: 'EGP',
  ...over,
});

describe('decidePayment (commerce/25 S1 — one charge, decided under the group lock)', () => {
  it('pays: right amount, EGP, PENDING orders → claim + mark paid, no exception', () => {
    expect(decidePayment(g([[OrderStatus.PENDING, '30.40']]), charge())).toEqual({
      outcome: 'paid', claim: true, markPaid: true, exception: null, expectedCents: 3040,
    });
  });

  it('expected total excludes cancelled sub-orders (a vendor order cancelled before payment)', () => {
    const d = decidePayment(g([[OrderStatus.CANCELLED, '30.30'], [OrderStatus.PENDING, '0.10']]), charge({ amountCents: 10 }));
    expect(d).toMatchObject({ outcome: 'paid', expectedCents: 10 });
  });

  it('the same transaction already recorded → duplicate: nothing claimed, paid or recorded', () => {
    expect(decidePayment(g([[OrderStatus.PAID, '30.40']], 'tx-1'), charge())).toMatchObject({
      outcome: 'duplicate', claim: false, markPaid: false, exception: null,
    });
  });

  it('a DIFFERENT transaction on a group that already recorded one → DOUBLE_PAYMENT, never applied, first one kept', () => {
    expect(decidePayment(g([[OrderStatus.PAID, '30.40']], 'tx-first'), charge({ transactionId: 'tx-second' }))).toMatchObject({
      outcome: 'double_payment', claim: false, markPaid: false, exception: PaymentExceptionType.DOUBLE_PAYMENT,
    });
  });

  it('the double-charge check wins over every other rule (even a wrong currency on the second charge)', () => {
    expect(decidePayment(g([[OrderStatus.PAID, '30.40']], 'tx-first'), charge({ transactionId: 'tx-2', currency: 'USD' })).exception).toBe(
      PaymentExceptionType.DOUBLE_PAYMENT,
    );
  });

  it.each([['USD'], ['egp'], [null]])('currency %s → CURRENCY_MISMATCH: exception only, group untouched, NOT paid', (currency) => {
    expect(decidePayment(g([[OrderStatus.PENDING, '30.40']]), charge({ currency }))).toMatchObject({
      outcome: 'currency_mismatch', claim: false, markPaid: false, exception: PaymentExceptionType.CURRENCY_MISMATCH,
    });
  });

  it('every order already cancelled (expired or cancelled first) → LATE_PAYMENT: exception only, NOT paid', () => {
    expect(decidePayment(g([[OrderStatus.CANCELLED, '30.40']]), charge())).toMatchObject({
      outcome: 'orphan', claim: false, markPaid: false, exception: PaymentExceptionType.LATE_PAYMENT, expectedCents: 0,
    });
  });

  it.each([[3039], [3041], [null]])('amount %s ≠ 3040 → AMOUNT_MISMATCH: exception only, group untouched (still expirable, still payable)', (amountCents) => {
    expect(decidePayment(g([[OrderStatus.PENDING, '30.40']]), charge({ amountCents }))).toMatchObject({
      outcome: 'amount_mismatch', claim: false, markPaid: false, exception: PaymentExceptionType.AMOUNT_MISMATCH,
    });
  });
});
