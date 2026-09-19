import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PaymobService } from '../../infra/paymob/paymob.service';
import { CheckoutRepository, OutOfStockError } from './checkout.repository';
import { CheckoutService } from './checkout.service';

const D = (n: number | string) => new Prisma.Decimal(n);

function cartWith(items: any[]) {
  return { id: 'cart-1', userId: 'user-1', items } as any;
}

const line = (over: Partial<any> = {}) => ({
  id: 'item-1',
  productId: 'prod-1',
  variantId: 'var-1',
  quantity: 2,
  product: { id: 'prod-1', vendorId: 'v-1', title: 'Shirt', basePrice: D('10.10') },
  variant: { id: 'var-1', stockQuantity: 5, priceOverride: null, deletedAt: null },
  ...over,
});

describe('CheckoutService', () => {
  let service: CheckoutService;
  let repo: jest.Mocked<CheckoutRepository>;
  let paymob: jest.Mocked<PaymobService>;

  beforeEach(() => {
    repo = {
      findCartWithItems: jest.fn(),
      findPurchasableProductIds: jest.fn().mockResolvedValue(new Set(['prod-1', 'prod-2'])),
      createOrderGroup: jest.fn(),
      setPaymobIntent: jest.fn().mockResolvedValue({}),
      findGroupWithOrders: jest.fn(),
    } as unknown as jest.Mocked<CheckoutRepository>;
    paymob = { createIntention: jest.fn() } as unknown as jest.Mocked<PaymobService>;
    service = new CheckoutService(repo, paymob);
  });

  it('CART_EMPTY when there is no cart or no lines', async () => {
    repo.findCartWithItems.mockResolvedValue(null);
    await expect(service.checkoutCart('user-1')).rejects.toMatchObject({ response: { code: 'CART_EMPTY' } });
  });

  it('reports every unavailable line in details (LOGIC-01) — hidden product, deleted variant, short stock', async () => {
    repo.findCartWithItems.mockResolvedValue(
      cartWith([
        line({ id: 'a', productId: 'gone' }),
        line({ id: 'b', productId: 'prod-2', variant: { stockQuantity: 5, priceOverride: null, deletedAt: new Date() } }),
        line({ id: 'c', quantity: 9 }),
        line({ id: 'd' }),
      ]),
    );

    await expect(service.checkoutCart('user-1')).rejects.toMatchObject({
      response: {
        code: 'CHECKOUT_ITEM_UNAVAILABLE',
        details: {
          items: [
            { cartItemId: 'a', reason: 'PRODUCT_UNAVAILABLE' },
            { cartItemId: 'b', reason: 'PRODUCT_UNAVAILABLE' },
            { cartItemId: 'c', reason: 'OUT_OF_STOCK' },
          ],
        },
      },
    });
    expect(repo.createOrderGroup).not.toHaveBeenCalled();
  });

  it('drafts one order per vendor with integer-piastre math and asks Paymob for the integer total (PAY-04)', async () => {
    repo.findCartWithItems.mockResolvedValue(
      cartWith([
        line({ id: 'a', quantity: 3 }), // 3 x 10.10 = 3030
        line({
          id: 'b', productId: 'prod-2', variantId: 'var-2', quantity: 1,
          product: { id: 'prod-2', vendorId: 'v-2', title: 'Bag', basePrice: D('0.20') },
          variant: { id: 'var-2', stockQuantity: 1, priceOverride: D('0.10'), deletedAt: null }, // override wins: 10
        }),
      ]),
    );
    repo.createOrderGroup.mockResolvedValue({
      id: 'group-1', userId: 'user-1',
      orders: [{ id: 'o1', subtotal: D('30.30') }, { id: 'o2', subtotal: D('0.10') }],
    } as any);
    paymob.createIntention.mockResolvedValue({ intentId: 'int-1', paymobOrderId: 'po-1', clientUrl: 'https://pay' });

    const result = await service.checkoutCart('user-1');

    const drafts = repo.createOrderGroup.mock.calls[0][0].orders;
    expect(drafts).toEqual([
      expect.objectContaining({ vendorId: 'v-1', subtotalCents: 3030 }),
      expect.objectContaining({ vendorId: 'v-2', subtotalCents: 10 }),
    ]);
    expect(drafts[0].items[0]).toMatchObject({ priceSnapshotCents: 1010, quantity: 3 });
    // 30.30 + 0.10 as floats would be 30.400000000000002; as cents it is exactly 3040.
    expect(paymob.createIntention).toHaveBeenCalledWith(3040, 'og:group-1');
    expect(repo.setPaymobIntent).toHaveBeenCalledWith('group-1', { intentId: 'int-1', paymobOrderId: 'po-1' });
    expect(result).toMatchObject({ paymobIntentId: 'int-1', clientUrl: 'https://pay', paymentSetupFailed: false });
  });

  it('returns paymentSetupFailed when Paymob is down; orders stay created', async () => {
    repo.findCartWithItems.mockResolvedValue(cartWith([line()]));
    repo.createOrderGroup.mockResolvedValue({ id: 'group-1', orders: [{ subtotal: D(20.2) }] } as any);
    paymob.createIntention.mockRejectedValue(new Error('down'));

    const result = await service.checkoutCart('user-1');
    expect(result).toMatchObject({ id: 'group-1', paymentSetupFailed: true });
    expect(result).not.toHaveProperty('paymobIntentId');
  });

  it('maps OutOfStockError from the transaction to CHECKOUT_ITEM_UNAVAILABLE', async () => {
    repo.findCartWithItems.mockResolvedValue(cartWith([line()]));
    repo.createOrderGroup.mockRejectedValue(new OutOfStockError('var-1'));

    await expect(service.checkoutCart('user-1')).rejects.toMatchObject({
      response: { code: 'CHECKOUT_ITEM_UNAVAILABLE', details: { items: [{ variantId: 'var-1', reason: 'OUT_OF_STOCK' }] } },
    });
  });

  it('retries a serialization conflict (P2034) and gives up with CHECKOUT_CONTENDED after 3 tries', async () => {
    repo.findCartWithItems.mockResolvedValue(cartWith([line()]));
    const conflict = new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 't' });
    repo.createOrderGroup.mockRejectedValue(conflict);

    await expect(service.checkoutCart('user-1')).rejects.toMatchObject({ response: { code: 'CHECKOUT_CONTENDED' } });
    expect(repo.createOrderGroup).toHaveBeenCalledTimes(3);
  });

  describe('retryPaymentSetup', () => {
    it('404 / 403 / 400 with codes (ERR-01)', async () => {
      repo.findGroupWithOrders.mockResolvedValue(null);
      await expect(service.retryPaymentSetup('u', 'g')).rejects.toBeInstanceOf(NotFoundException);

      repo.findGroupWithOrders.mockResolvedValue({ id: 'g', userId: 'other', paymobIntentId: null, orders: [] } as any);
      await expect(service.retryPaymentSetup('u', 'g')).rejects.toBeInstanceOf(ForbiddenException);

      repo.findGroupWithOrders.mockResolvedValue({ id: 'g', userId: 'u', paymobIntentId: 'x', orders: [] } as any);
      await expect(service.retryPaymentSetup('u', 'g')).rejects.toMatchObject({ response: { code: 'PAYMENT_ALREADY_SET_UP' } });

      repo.findGroupWithOrders.mockResolvedValue({ id: 'g', userId: 'u', paymobIntentId: null, orders: [{ status: 'CANCELLED' }] } as any);
      await expect(service.retryPaymentSetup('u', 'g')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates the intention for the integer total and stores both ids', async () => {
      repo.findGroupWithOrders.mockResolvedValue({
        id: 'g', userId: 'u', paymobIntentId: null,
        orders: [{ status: 'PENDING', subtotal: D('10.05') }, { status: 'PENDING', subtotal: D('0.95') }],
      } as any);
      paymob.createIntention.mockResolvedValue({ intentId: 'int-2', paymobOrderId: null, clientUrl: undefined });

      const result = await service.retryPaymentSetup('u', 'g');

      expect(paymob.createIntention).toHaveBeenCalledWith(1100, 'og:g');
      expect(repo.setPaymobIntent).toHaveBeenCalledWith('g', { intentId: 'int-2', paymobOrderId: null });
      expect(result).toEqual({ paymobIntentId: 'int-2', clientUrl: undefined });
    });
  });
});
