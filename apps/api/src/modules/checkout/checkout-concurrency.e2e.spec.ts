import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, Role, VendorType } from '@prisma/client';

import { PaymobService } from '../../infra/paymob/paymob.service';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CheckoutRepository } from './checkout.repository';
import { CheckoutService } from './checkout.service';

/**
 * specs/commerce/25 slice S2 on real PostgreSQL: concurrent checkouts never
 * reserve the same units, a failed checkout reserves nothing, and the database
 * itself refuses negative stock and non-positive quantities. Each buyer runs on
 * its own connection (independent promises through the pooled client), never in
 * one shared transaction. Refuses to run unless DATABASE_URL is a *_test database.
 * CHECKOUT_RACE_ITERATIONS (default 10) sets how often each race repeats.
 */
const ITERATIONS = Number(process.env.CHECKOUT_RACE_ITERATIONS ?? 10);
const BUYERS = 10;
const PREFIX = 'cc-';

describe('Checkout concurrency and stock constraints (e2e, real PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;

  const buyerIds: string[] = [];
  const cartIds: string[] = [];
  let productId: string;
  let variantA: string;
  let variantB: string;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? '';
    if (!/\/[^/?]+_test(\?|$)/.test(url)) {
      throw new Error('checkout-concurrency e2e must run against a *_test database (it wipes order data).');
    }

    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule],
      providers: [
        CheckoutRepository,
        CheckoutService,
        // Paymob is never reached: orders and reservations are the subject here.
        { provide: PaymobService, useValue: { createIntention: jest.fn().mockRejectedValue(new Error('paymob off in this test')) } },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    checkout = moduleRef.get(CheckoutService);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await wipe();
    await prisma.$executeRawUnsafe('TRUNCATE "inventory_movements"'); // append-only ledger (commerce/25 S3) → variants, groups, users are RESTRICT
    await prisma.productVariant.deleteMany({ where: { sku: { startsWith: 'CC-' } } });
    await prisma.product.deleteMany({ where: { title: { startsWith: 'CC ' } } });
    await prisma.vendor.deleteMany({ where: { owner: { email: { startsWith: PREFIX } } } });
    await prisma.category.deleteMany({ where: { slug: 'cc-category' } });
    await prisma.cart.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

    const vendorUser = await prisma.user.create({ data: { email: `${PREFIX}vendor@example.com`, passwordHash: 'x', name: 'V', role: Role.VENDOR } });
    const vendor = await prisma.vendor.create({ data: { ownerId: vendorUser.id, name: 'CC Shop', verified: true, vendorType: VendorType.MARKETPLACE } });
    const category = await prisma.category.create({ data: { name: 'CC', slug: 'cc-category' } });
    productId = (
      await prisma.product.create({ data: { vendorId: vendor.id, title: 'CC Tee', description: 'x', categoryId: category.id, basePrice: new Prisma.Decimal(100) } })
    ).id;
    variantA = (await prisma.productVariant.create({ data: { productId, sku: 'CC-A', stockQuantity: 0 } })).id;
    variantB = (await prisma.productVariant.create({ data: { productId, sku: 'CC-B', stockQuantity: 0 } })).id;

    for (let i = 0; i < BUYERS; i++) {
      const user = await prisma.user.create({ data: { email: `${PREFIX}buyer${i}@example.com`, passwordHash: 'x', name: `B${i}`, role: Role.SHOPPER } });
      buyerIds.push(user.id);
      cartIds.push((await prisma.cart.create({ data: { userId: user.id } })).id);
    }
  });

  afterAll(async () => {
    await wipe();
    await moduleRef?.close();
  });

  async function wipe() {
    await prisma.cartItem.deleteMany({ where: { cart: { user: { email: { startsWith: PREFIX } } } } });
    await prisma.orderItem.deleteMany({ where: { order: { user: { email: { startsWith: PREFIX } } } } });
    await prisma.order.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
    // payment_exceptions → order_groups is RESTRICT and its rows are never deleted (trigger); TRUNCATE skips row triggers.
    await prisma.$executeRawUnsafe('TRUNCATE "payment_exceptions", "inventory_movements"');
    await prisma.orderGroup.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
  }

  async function reset(stock: { a: number; b?: number }) {
    await wipe();
    await prisma.productVariant.update({ where: { id: variantA }, data: { stockQuantity: stock.a } });
    await prisma.productVariant.update({ where: { id: variantB }, data: { stockQuantity: stock.b ?? 0 } });
  }

  const putInCart = (buyer: number, variantId: string, quantity: number) =>
    prisma.cartItem.create({ data: { cartId: cartIds[buyer], productId, variantId, quantity } });
  const stockOf = async (variantId: string) => (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stockQuantity;
  const reservedFor = async (variantId: string) =>
    (await prisma.orderItem.aggregate({ where: { variantId, order: { status: { not: 'CANCELLED' } } }, _sum: { quantity: true } }))._sum.quantity ?? 0;
  const codeOf = (reason: unknown) => (reason as { response?: { code?: string } })?.response?.code;

  it(`${BUYERS} buyers race for the last 3 units: exactly 3 checkouts succeed, never more (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await reset({ a: 3 });
      for (let b = 0; b < BUYERS; b++) await putInCart(b, variantA, 1);

      const results = await Promise.allSettled(buyerIds.map((id) => checkout.checkoutCart(id)));

      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(won).toHaveLength(3);
      expect(await stockOf(variantA)).toBe(0);
      expect(await reservedFor(variantA)).toBe(3); // stock + reserved = the 3 units, no unit sold twice
      // every loser is told the item ran out — never "contended", never an unhandled error (READ COMMITTED, commerce/25 §10)
      for (const loss of lost) expect(codeOf(loss.reason)).toBe('CHECKOUT_ITEM_UNAVAILABLE');
      expect(await prisma.orderGroup.count({ where: { user: { email: { startsWith: PREFIX } } } })).toBe(3);
    }
  });

  it(`${BUYERS} buyers, plenty of stock: every one succeeds — contention never turns into an error (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await reset({ a: 100 });
      for (let b = 0; b < BUYERS; b++) await putInCart(b, variantA, 1);
      const results = await Promise.allSettled(buyerIds.map((id) => checkout.checkoutCart(id)));
      expect(results.filter((r) => r.status === 'rejected').map((r) => codeOf((r as PromiseRejectedResult).reason))).toEqual([]);
      expect(await stockOf(variantA)).toBe(100 - BUYERS);
    }
  });

  it(`the same shopper submitting checkout 5 times at once (no Idempotency-Key) gets exactly ONE order (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await reset({ a: 50 });
      await putInCart(0, variantA, 2);
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => checkout.checkoutCart(buyerIds[0])));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) if (r.status === 'rejected') expect(codeOf(r.reason)).toBe('CART_EMPTY');
      expect(await prisma.orderGroup.count({ where: { userId: buyerIds[0] } })).toBe(1);
      expect(await stockOf(variantA)).toBe(48); // reserved once
    }
  });

  it(`a double submit that takes ALL remaining stock: one order, every duplicate is CART_EMPTY — never "out of stock" (×${ITERATIONS})`, async () => {
    // The cart lines are removed first in the transaction, so a duplicate waits
    // on the first request and then sees its lines gone (commerce/25 §11).
    for (let i = 0; i < ITERATIONS; i++) {
      await reset({ a: 2 });
      await putInCart(0, variantA, 2);
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => checkout.checkoutCart(buyerIds[0])));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) if (r.status === 'rejected') expect(codeOf(r.reason)).toBe('CART_EMPTY');
      expect(await stockOf(variantA)).toBe(0);
    }
  });

  it('a product withdrawn after the pre-check is not sold: the guarded decrement re-checks visibility, nothing reserved, reported as PRODUCT_UNAVAILABLE', async () => {
    await reset({ a: 5 });
    await putInCart(0, variantA, 1);
    const repo = moduleRef.get(CheckoutRepository);
    // The pre-check still sees the product (the race window), then the vendor deactivates it.
    const spy = jest.spyOn(repo, 'findPurchasableProductIds').mockImplementationOnce(async (ids) => {
      await prisma.product.update({ where: { id: productId }, data: { isActive: false } });
      return new Set(ids);
    });
    try {
      await expect(checkout.checkoutCart(buyerIds[0])).rejects.toMatchObject({
        response: { code: 'CHECKOUT_ITEM_UNAVAILABLE', details: { items: [expect.objectContaining({ reason: 'PRODUCT_UNAVAILABLE' })] } },
      });
      expect(await stockOf(variantA)).toBe(5);
      expect(await prisma.orderGroup.count({ where: { userId: buyerIds[0] } })).toBe(0);
      expect(await prisma.cartItem.count({ where: { cartId: cartIds[0] } })).toBe(1); // cart untouched (rolled back)
    } finally {
      spy.mockRestore();
      await prisma.product.update({ where: { id: productId }, data: { isActive: true } });
    }
  });

  it(`two payment setups racing for one group store exactly ONE intention; both callers get that one (×${ITERATIONS})`, async () => {
    const repo = moduleRef.get(CheckoutRepository);
    for (let i = 0; i < ITERATIONS; i++) {
      await reset({ a: 5 });
      await putInCart(0, variantA, 1);
      const { id: groupId } = await checkout.checkoutCart(buyerIds[0]); // Paymob is off here: no intention yet
      const [x, y] = await Promise.all([
        repo.attachPaymobIntent(groupId, { intentId: `pi-x-${i}`, paymobOrderId: `9${i}1`, clientUrl: `https://pay.example/x${i}` }),
        repo.attachPaymobIntent(groupId, { intentId: `pi-y-${i}`, paymobOrderId: `9${i}2`, clientUrl: `https://pay.example/y${i}` }),
      ]);
      expect([x.attached, y.attached].filter(Boolean)).toHaveLength(1);
      expect(x.paymobIntentId).toBe(y.paymobIntentId); // the loser is handed the winner's page, never its own
      expect(x.paymobClientUrl).toBe(y.paymobClientUrl);
      const stored = await prisma.orderGroup.findUniqueOrThrow({ where: { id: groupId } });
      expect(stored.paymobIntentId).toBe(x.paymobIntentId);
    }
  });

  it(`two buyers race for the last unit: exactly one succeeds (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await reset({ a: 1 });
      await putInCart(0, variantA, 1);
      await putInCart(1, variantA, 1);

      const results = await Promise.allSettled([checkout.checkoutCart(buyerIds[0]), checkout.checkoutCart(buyerIds[1])]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await stockOf(variantA)).toBe(0);
      expect(await reservedFor(variantA)).toBe(1);
    }
  });

  it('a checkout that fails on one line reserves nothing: other lines keep their stock, no order, cart untouched', async () => {
    await reset({ a: 5, b: 1 });
    await putInCart(0, variantA, 2);
    await putInCart(0, variantB, 2); // only 1 left → the whole checkout must fail

    await expect(checkout.checkoutCart(buyerIds[0])).rejects.toMatchObject({ response: { code: 'CHECKOUT_ITEM_UNAVAILABLE' } });

    expect(await stockOf(variantA)).toBe(5);
    expect(await stockOf(variantB)).toBe(1);
    expect(await prisma.orderGroup.count({ where: { userId: buyerIds[0] } })).toBe(0);
    expect(await prisma.cartItem.count({ where: { cartId: cartIds[0] } })).toBe(2);
  });

  it('the stock decrement inside the transaction (not only the pre-check) stops an oversell', async () => {
    // Both buyers pass the pre-check against stock 2; only the conditional
    // decrement can stop the second one. Run the race until both pre-checks
    // overlap at least once; the invariant must hold every time.
    for (let i = 0; i < ITERATIONS; i++) {
      await reset({ a: 2 });
      await putInCart(0, variantA, 2);
      await putInCart(1, variantA, 2);
      const results = await Promise.allSettled([checkout.checkoutCart(buyerIds[0]), checkout.checkoutCart(buyerIds[1])]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await stockOf(variantA)).toBe(0);
    }
  });

  describe('database CHECK constraints (any writer, not only checkout)', () => {
    it('refuses negative stock', async () => {
      await reset({ a: 1 });
      await expect(prisma.productVariant.update({ where: { id: variantA }, data: { stockQuantity: -1 } })).rejects.toThrow(/23514|check constraint/);
      await expect(prisma.productVariant.update({ where: { id: variantA }, data: { stockQuantity: { decrement: 2 } } })).rejects.toThrow(/23514|check constraint/);
      expect(await stockOf(variantA)).toBe(1);
    });

    it('refuses a cart line or order line with quantity 0 or less', async () => {
      await reset({ a: 1 });
      await expect(putInCart(0, variantA, 0)).rejects.toThrow(/23514|check constraint/);
      const group = await prisma.orderGroup.create({ data: { userId: buyerIds[0] } });
      const vendorId = (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).vendorId;
      await expect(
        prisma.order.create({
          data: {
            orderGroupId: group.id,
            vendorId,
            userId: buyerIds[0],
            subtotal: new Prisma.Decimal(0),
            items: { create: [{ productId, variantId: variantA, titleSnapshot: 'CC Tee', priceSnapshot: new Prisma.Decimal(1), quantity: -1 }] },
          },
        }),
      ).rejects.toThrow(/23514|check constraint/);
    });
  });
});
