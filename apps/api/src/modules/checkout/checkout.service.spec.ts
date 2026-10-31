import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PaymobService } from '../../infra/paymob/paymob.service';
import { CartChangedError, CheckoutRepository, OutOfStockError } from './checkout.repository';
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
      attachPaymobIntent: jest
        .fn()
        .mockImplementation(async (_id: string, intent: any) => ({ attached: true, paymobIntentId: intent.intentId, paymobClientUrl: intent.clientUrl ?? null })),
      findGroupWithOrders: jest.fn(),
      claimIdempotencyKey: jest.fn(),
      takeOverStaleIdempotencyKey: jest.fn(),
      completeIdempotencyKey: jest.fn().mockResolvedValue(undefined),
      releaseIdempotencyKey: jest.fn().mockResolvedValue(undefined),
      deleteExpiredIdempotencyKey: jest.fn().mockResolvedValue(undefined),
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
    expect(repo.attachPaymobIntent).toHaveBeenCalledWith('group-1', { intentId: 'int-1', paymobOrderId: 'po-1', clientUrl: 'https://pay' });
    expect(result).toMatchObject({ paymobIntentId: 'int-1', clientUrl: 'https://pay', paymentSetupFailed: false });
    // the exact lines (and quantities) it priced are what the transaction removes from the cart
    expect(repo.createOrderGroup.mock.calls[0][0].cartLines).toEqual([{ id: 'a', quantity: 3 }, { id: 'b', quantity: 1 }]);
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
      response: { code: 'CHECKOUT_ITEM_UNAVAILABLE', details: { items: [{ cartItemId: 'item-1', variantId: 'var-1', reason: 'OUT_OF_STOCK' }] } },
    });
  });

  it('a cart changed under the checkout (parallel checkout of the same cart) re-reads the cart: usually CART_EMPTY', async () => {
    repo.findCartWithItems.mockResolvedValueOnce(cartWith([line()])).mockResolvedValueOnce(null);
    repo.createOrderGroup.mockRejectedValueOnce(new CartChangedError());
    await expect(service.checkoutCart('user-1')).rejects.toMatchObject({ response: { code: 'CART_EMPTY' } });
    expect(repo.findCartWithItems).toHaveBeenCalledTimes(2);
  });

  it('a racing setup already stored an intention: answers with the STORED one, never the new URL', async () => {
    repo.findCartWithItems.mockResolvedValue(cartWith([line()]));
    repo.createOrderGroup.mockResolvedValue({ id: 'group-1', orders: [{ subtotal: D(20.2) }] } as any);
    paymob.createIntention.mockResolvedValue({ intentId: 'int-NEW', paymobOrderId: 'po-new', clientUrl: 'https://pay/new' });
    repo.attachPaymobIntent.mockResolvedValueOnce({ attached: false, paymobIntentId: 'int-FIRST', paymobClientUrl: 'https://pay/first' });
    await expect(service.checkoutCart('user-1')).resolves.toMatchObject({ paymobIntentId: 'int-FIRST', clientUrl: 'https://pay/first', paymentSetupFailed: false });
  });

  it('retries a serialization conflict (P2034) and gives up with 503 CHECKOUT_CONTENDED (never a 500) after 3 tries', async () => {
    repo.findCartWithItems.mockResolvedValue(cartWith([line()]));
    const conflict = new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 't' });
    repo.createOrderGroup.mockRejectedValue(conflict);

    await expect(service.checkoutCart('user-1')).rejects.toMatchObject({ status: 503, response: { code: 'CHECKOUT_CONTENDED' } });
    expect(repo.createOrderGroup).toHaveBeenCalledTimes(3);
  });

  describe('retryPaymentSetup', () => {
    it('404 / 403 / 400 with codes (ERR-01)', async () => {
      repo.findGroupWithOrders.mockResolvedValue(null);
      await expect(service.retryPaymentSetup('u', 'g')).rejects.toBeInstanceOf(NotFoundException);

      repo.findGroupWithOrders.mockResolvedValue({ id: 'g', userId: 'other', paymobIntentId: null, orders: [] } as any);
      await expect(service.retryPaymentSetup('u', 'g')).rejects.toBeInstanceOf(ForbiddenException);

      // an intention exists but its page was never stored (older rows): nothing to hand back
      repo.findGroupWithOrders.mockResolvedValue({ id: 'g', userId: 'u', paymobIntentId: 'x', paymobClientUrl: null, orders: [] } as any);
      await expect(service.retryPaymentSetup('u', 'g')).rejects.toMatchObject({ response: { code: 'PAYMENT_ALREADY_SET_UP' } });

      repo.findGroupWithOrders.mockResolvedValue({ id: 'g', userId: 'u', paymobIntentId: null, orders: [{ status: 'CANCELLED' }] } as any);
      await expect(service.retryPaymentSetup('u', 'g')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates the intention for the integer total and stores both ids', async () => {
      repo.findGroupWithOrders.mockResolvedValue({
        id: 'g', userId: 'u', paymobIntentId: null,
        orders: [{ status: 'PENDING', subtotal: D('10.05') }, { status: 'PENDING', subtotal: D('0.95') }],
      } as any);
      paymob.createIntention.mockResolvedValue({ intentId: 'int-2', paymobOrderId: null, clientUrl: 'https://pay/2' });

      const result = await service.retryPaymentSetup('u', 'g');

      expect(paymob.createIntention).toHaveBeenCalledWith(1100, 'og:g');
      expect(repo.attachPaymobIntent).toHaveBeenCalledWith('g', { intentId: 'int-2', paymobOrderId: null, clientUrl: 'https://pay/2' });
      expect(result).toEqual({ paymobIntentId: 'int-2', clientUrl: 'https://pay/2' });
    });

    it('an intention already exists: hands back its stored page, creates nothing (R25, commerce/25 §10)', async () => {
      repo.findGroupWithOrders.mockResolvedValue({
        id: 'g', userId: 'u', paymobIntentId: 'int-1', paymobClientUrl: 'https://pay/1', orders: [{ status: 'PENDING', subtotal: D('11') }],
      } as any);
      await expect(service.retryPaymentSetup('u', 'g')).resolves.toEqual({ paymobIntentId: 'int-1', clientUrl: 'https://pay/1' });
      expect(paymob.createIntention).not.toHaveBeenCalled();
    });

    it('two retries racing: the loser returns the winner\'s stored intention, not its own', async () => {
      repo.findGroupWithOrders.mockResolvedValue({ id: 'g', userId: 'u', paymobIntentId: null, orders: [{ status: 'PENDING', subtotal: D('11') }] } as any);
      paymob.createIntention.mockResolvedValue({ intentId: 'int-LOSER', paymobOrderId: null, clientUrl: 'https://pay/loser' });
      repo.attachPaymobIntent.mockResolvedValueOnce({ attached: false, paymobIntentId: 'int-WINNER', paymobClientUrl: 'https://pay/winner' });
      await expect(service.retryPaymentSetup('u', 'g')).resolves.toEqual({ paymobIntentId: 'int-WINNER', clientUrl: 'https://pay/winner' });
    });

    it('a cancelled (expired) group never hands out a payment page, even if an intention exists', async () => {
      repo.findGroupWithOrders.mockResolvedValue({
        id: 'g', userId: 'u', paymobIntentId: 'int-1', paymobClientUrl: 'https://pay/1', orders: [{ status: 'CANCELLED', subtotal: D('11') }],
      } as any);
      await expect(service.retryPaymentSetup('u', 'g')).rejects.toMatchObject({ response: { code: 'ORDER_GROUP_NOT_PENDING' } });
    });
  });

  describe('Idempotency-Key (TD-07, commerce/25 S4)', () => {
    const KEY = 'a3f1c2d4-0000-4000-8000-000000000001';
    const keyRow = (over: Partial<any> = {}) => ({
      id: 'idem-1',
      status: 'IN_PROGRESS',
      orderGroupId: null,
      responseBody: null,
      lockedUntil: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 86_400_000),
      ...over,
    });
    const okCheckout = () => {
      repo.findCartWithItems.mockResolvedValue(cartWith([line()]));
      repo.createOrderGroup.mockResolvedValue({ id: 'group-1', orders: [{ subtotal: D('20.20') }] } as any);
      paymob.createIntention.mockRejectedValue(new Error('paymob off'));
    };

    it('without a key nothing changes: no key row is touched', async () => {
      okCheckout();
      await service.checkoutCart('user-1');
      expect(repo.claimIdempotencyKey).not.toHaveBeenCalled();
      expect(repo.createOrderGroup).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKeyId: undefined }));
    });

    it.each([['short'], ['has space in it'], ['\u00fcnicode-key-123'], ['x'.repeat(129)]])('400 IDEMPOTENCY_KEY_INVALID for %s', async (key) => {
      await expect(service.checkoutCart('user-1', key)).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_INVALID' } });
      expect(repo.claimIdempotencyKey).not.toHaveBeenCalled();
    });

    it('first use: holds the key, links it inside the order transaction, stores the response', async () => {
      okCheckout();
      repo.claimIdempotencyKey.mockResolvedValue({ row: keyRow() as any, created: true });
      const result = await service.checkoutCart('user-1', KEY);
      expect(repo.claimIdempotencyKey).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', scope: 'checkout', key: KEY }));
      expect(repo.createOrderGroup).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKeyId: 'idem-1' }));
      expect(repo.completeIdempotencyKey).toHaveBeenCalledWith('idem-1', 201, expect.objectContaining({ id: 'group-1', paymentSetupFailed: true }));
      expect(result).toMatchObject({ id: 'group-1' });
    });

    it('a COMPLETED key replays the stored response: no second order', async () => {
      repo.claimIdempotencyKey.mockResolvedValue({ row: keyRow({ status: 'COMPLETED', orderGroupId: 'group-1', responseBody: { id: 'group-1' } }) as any, created: false });
      await expect(service.checkoutCart('user-1', KEY)).resolves.toEqual({ id: 'group-1' });
      expect(repo.createOrderGroup).not.toHaveBeenCalled();
    });

    it('order committed but the response never stored (crash after commit): answers from the order, never re-runs', async () => {
      repo.claimIdempotencyKey.mockResolvedValue({ row: keyRow({ orderGroupId: 'group-1', lockedUntil: new Date(0) }) as any, created: false });
      repo.findGroupWithOrders.mockResolvedValue({ id: 'group-1', paymobIntentId: null, paymobClientUrl: null, orders: [] } as any);
      await expect(service.checkoutCart('user-1', KEY)).resolves.toMatchObject({ id: 'group-1', paymentSetupFailed: true });
      repo.findGroupWithOrders.mockResolvedValue({ id: 'group-1', paymobIntentId: 'int-1', paymobClientUrl: 'https://pay/1', orders: [] } as any);
      await expect(service.checkoutCart('user-1', KEY)).resolves.toMatchObject({ clientUrl: 'https://pay/1', paymentSetupFailed: false });
      expect(repo.createOrderGroup).not.toHaveBeenCalled();
    });

    it('409 while the first request still holds the key, even after its order committed (no half-finished replay)', async () => {
      repo.claimIdempotencyKey.mockResolvedValue({ row: keyRow({ orderGroupId: 'group-1' }) as any, created: false });
      await expect(service.checkoutCart('user-1', KEY)).rejects.toMatchObject({ status: 409, response: { code: 'IDEMPOTENCY_KEY_IN_PROGRESS' } });
      expect(repo.findGroupWithOrders).not.toHaveBeenCalled();
    });

    it('409 IDEMPOTENCY_KEY_IN_PROGRESS while another request holds the key', async () => {
      repo.claimIdempotencyKey.mockResolvedValue({ row: keyRow() as any, created: false });
      await expect(service.checkoutCart('user-1', KEY)).rejects.toMatchObject({ status: 409, response: { code: 'IDEMPOTENCY_KEY_IN_PROGRESS' } });
      expect(repo.createOrderGroup).not.toHaveBeenCalled();
    });

    it('a lapsed lock with no order (crashed before commit) is taken over once and the checkout runs', async () => {
      okCheckout();
      repo.claimIdempotencyKey.mockResolvedValue({ row: keyRow({ lockedUntil: new Date(0) }) as any, created: false });
      repo.takeOverStaleIdempotencyKey.mockResolvedValue(true);
      await expect(service.checkoutCart('user-1', KEY)).resolves.toMatchObject({ id: 'group-1' });
      repo.takeOverStaleIdempotencyKey.mockResolvedValue(false);
      await expect(service.checkoutCart('user-1', KEY)).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_IN_PROGRESS' } });
    });

    it('an expired key is deleted and claimed afresh', async () => {
      okCheckout();
      repo.claimIdempotencyKey
        .mockResolvedValueOnce({ row: keyRow({ status: 'COMPLETED', expiresAt: new Date(0) }) as any, created: false })
        .mockResolvedValueOnce({ row: keyRow({ id: 'idem-2' }) as any, created: true });
      await service.checkoutCart('user-1', KEY);
      expect(repo.deleteExpiredIdempotencyKey).toHaveBeenCalledWith('idem-1');
      expect(repo.createOrderGroup).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKeyId: 'idem-2' }));
    });

    it('a failed checkout (e.g. empty cart) frees the key so a corrected retry can use it', async () => {
      const row = keyRow();
      repo.claimIdempotencyKey.mockResolvedValue({ row: row as any, created: true });
      repo.findCartWithItems.mockResolvedValue(null);
      await expect(service.checkoutCart('user-1', KEY)).rejects.toMatchObject({ response: { code: 'CART_EMPTY' } });
      // released only while THIS request still holds it (its own lockedUntil), commerce/25 §12
      expect(repo.releaseIdempotencyKey).toHaveBeenCalledWith('idem-1', row.lockedUntil);
      expect(repo.completeIdempotencyKey).not.toHaveBeenCalled();
    });

    it('after a takeover the release is bound to the NEW lock, so it can never free a key another request holds', async () => {
      repo.claimIdempotencyKey.mockResolvedValue({ row: keyRow({ lockedUntil: new Date(0) }) as any, created: false });
      repo.takeOverStaleIdempotencyKey.mockResolvedValue(true);
      repo.findCartWithItems.mockResolvedValue(null);
      await expect(service.checkoutCart('user-1', KEY)).rejects.toMatchObject({ response: { code: 'CART_EMPTY' } });
      const newLock = repo.takeOverStaleIdempotencyKey.mock.calls[0][1];
      expect(newLock.getTime()).toBeGreaterThan(Date.now());
      expect(repo.releaseIdempotencyKey).toHaveBeenCalledWith('idem-1', newLock);
    });

    it('every checkout attempt carries one overall deadline well inside the 60 s key lock', async () => {
      okCheckout();
      repo.claimIdempotencyKey.mockResolvedValue({ row: keyRow() as any, created: true });
      const before = Date.now();
      await service.checkoutCart('user-1', KEY);
      const { deadline } = repo.createOrderGroup.mock.calls[0][0] as { deadline: number };
      expect(deadline - before).toBeGreaterThanOrEqual(19_000);
      expect(deadline - before).toBeLessThanOrEqual(21_000);
    });

    it.each([
      ['a changed cart', () => new CartChangedError()],
      ['contention', () => new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 't' })],
    ])('after %s past the deadline, no further attempt starts → 503 CHECKOUT_CONTENDED (key lock never outlived)', async (_label, failure) => {
      let now = 1_000_000;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        repo.claimIdempotencyKey.mockResolvedValue({ row: keyRow() as any, created: true });
        repo.findCartWithItems.mockResolvedValue(cartWith([line()]));
        repo.createOrderGroup.mockImplementation(async () => {
          now += 25_000; // this attempt ran past the 20 s budget
          throw failure();
        });
        await expect(service.checkoutCart('user-1', KEY)).rejects.toMatchObject({ status: 503, response: { code: 'CHECKOUT_CONTENDED' } });
        expect(repo.createOrderGroup).toHaveBeenCalledTimes(1);
      } finally {
        clock.mockRestore();
      }
    });
  });
});
