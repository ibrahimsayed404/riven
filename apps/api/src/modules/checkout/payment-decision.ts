import { OrderStatus, PaymentExceptionType, Prisma } from '@prisma/client';

import { PLATFORM_CURRENCY, toCents } from '../../common/money';

export type PaymentOutcome = 'duplicate' | 'double_payment' | 'currency_mismatch' | 'orphan' | 'amount_mismatch' | 'paid';

export interface PaymentDecision {
  outcome: PaymentOutcome;
  /**
   * Record the transaction on the group. Only a payment that is applied claims
   * the group (commerce/25 §10): a mismatched or late charge lives on its
   * exception row instead, so the group stays expirable and payable.
   */
  claim: boolean;
  /** Move every PENDING order to PAID. */
  markPaid: boolean;
  exception: PaymentExceptionType | null;
  expectedCents: number;
}

/**
 * What one successful charge does to an order group — decided on the group as
 * read UNDER ITS ROW LOCK (specs/commerce/25 S1; the same lock expiry and
 * cancel take first), so the decision and its writes commit together or not
 * at all. Pure: no database access, so every rule has a plain unit test.
 *
 * - same transaction already recorded        → duplicate (nothing written)
 * - group already recorded another charge    → double_payment (exception; the first stays)
 * - currency missing or not EGP              → currency_mismatch (exception only; group untouched)
 * - nothing left to pay (cancelled/expired)  → orphan (LATE_PAYMENT exception only)
 * - amount differs from the open total       → amount_mismatch (exception only; group untouched)
 * - otherwise                                → paid (transaction recorded on the group, PENDING → PAID)
 *
 * After a mismatch the group is unchanged: it still expires on time (its stock
 * is released) and a later correct payment is applied normally.
 */
export function decidePayment(
  group: { paymobTransactionId: string | null; orders: { status: OrderStatus; subtotal: Prisma.Decimal | number | string }[] },
  charge: { transactionId: string; amountCents: number | null; currency: string | null },
): PaymentDecision {
  const expectedCents = group.orders
    .filter((order) => order.status !== OrderStatus.CANCELLED)
    .reduce((sum, order) => sum + toCents(order.subtotal), 0);
  const result = (outcome: PaymentOutcome, claim: boolean, exception: PaymentExceptionType | null): PaymentDecision => ({
    outcome,
    claim,
    markPaid: outcome === 'paid',
    exception,
    expectedCents,
  });

  if (group.paymobTransactionId === charge.transactionId) return result('duplicate', false, null);
  if (group.paymobTransactionId !== null) return result('double_payment', false, PaymentExceptionType.DOUBLE_PAYMENT);
  if (charge.currency !== PLATFORM_CURRENCY) return result('currency_mismatch', false, PaymentExceptionType.CURRENCY_MISMATCH);

  const hasPending = group.orders.some((order) => order.status === OrderStatus.PENDING);
  if (expectedCents === 0 || !hasPending) return result('orphan', false, PaymentExceptionType.LATE_PAYMENT);
  if (charge.amountCents !== expectedCents) return result('amount_mismatch', false, PaymentExceptionType.AMOUNT_MISMATCH);
  return result('paid', true, null);
}
