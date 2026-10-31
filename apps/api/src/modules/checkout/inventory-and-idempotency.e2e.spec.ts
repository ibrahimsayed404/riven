import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, Role, VendorType } from '@prisma/client';
import { randomUUID } from 'crypto';

import { PaymobService } from '../../infra/paymob/paymob.service';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
// eslint-disable-next-line no-restricted-imports -- e2e: drives the real repositories on real PostgreSQL
import { OrdersRepository } from '../orders/orders.repository';
// eslint-disable-next-line no-restricted-imports -- e2e: drives the real repositories on real PostgreSQL
import { VendorsRepository } from '../vendors/vendors.repository';
import { CheckoutRepository } from './checkout.repository';
import { CheckoutService } from './checkout.service';

/**
 * specs/commerce/25 slices S3 (stock ledger + vendor delta, TD-08) and S4
 * (checkout Idempotency-Key, TD-07) on real PostgreSQL. Independent promises =
 * independent pooled connections. Refuses to run unless DATABASE_URL is a
 * *_test database. RACE_ITERATIONS (default 10) repeats the races.
 */
const ITERATIONS = Number(process.env.RACE_ITERATIONS ?? 10);
const PREFIX = 'il-';
const BUYERS = 10;

describe('Stock ledger (S3) and checkout idempotency (S4) (e2e, real PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let vendors: VendorsRepository;
  let orders: OrdersRepository;

  let vendorUserId: string;
  let productId: string;
  const buyerIds: string[] = [];
  const cartIds: string[] = [];

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? '';
    if (!/\/[^/?]+_test(\?|$)/.test(url)) {
      throw new Error('inventory-and-idempotency e2e must run against a *_test database (it wipes order data).');
    }
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule],
      providers: [
        CheckoutRepository,
        CheckoutService,
        VendorsRepository,
        OrdersRepository,
        { provide: PaymobService, useValue: { createIntention: jest.fn().mockRejectedValue(new Error('paymob off in this test')) } },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    checkout = moduleRef.get(CheckoutService);
    vendors = moduleRef.get(VendorsRepository);
    orders = moduleRef.get(OrdersRepository);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await wipe();
    await prisma.productVariant.deleteMany({ where: { sku: { startsWith: 'IL-' } } });
    await prisma.product.deleteMany({ where: { title: { startsWith: 'IL ' } } });
    await prisma.vendor.deleteMany({ where: { owner: { email: { startsWith: PREFIX } } } });
    await prisma.category.deleteMany({ where: { slug: 'il-category' } });
    await prisma.cart.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });

    const vendorUser = await prisma.user.create({ data: { email: `${PREFIX}vendor@example.com`, passwordHash: 'x', name: 'V', role: Role.VENDOR } });
    vendorUserId = vendorUser.id;
    const vendor = await prisma.vendor.create({ data: { ownerId: vendorUser.id, name: 'IL Shop', verified: true, vendorType: VendorType.MARKETPLACE } });
    const category = await prisma.category.create({ data: { name: 'IL', slug: 'il-category' } });
    productId = (
      await prisma.product.create({ data: { vendorId: vendor.id, title: 'IL Tee', description: 'x', categoryId: category.id, basePrice: new Prisma.Decimal(100) } })
    ).id;
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
    await prisma.$executeRawUnsafe('TRUNCATE "payment_exceptions", "inventory_movements", "idempotency_keys"');
    await prisma.cartItem.deleteMany({ where: { cart: { user: { email: { startsWith: PREFIX } } } } });
    await prisma.orderItem.deleteMany({ where: { order: { user: { email: { startsWith: PREFIX } } } } });
    await prisma.order.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
    await prisma.orderGroup.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
  }

  /** A fresh variant created the way vendors create it: its initial stock is the first ledger row. */
  async function freshVariant(stock: number): Promise<string> {
    const variant = await vendors.createProductVariant(productId, { sku: `IL-${randomUUID().slice(0, 8)}`, stockQuantity: stock }, vendorUserId);
    return variant.id;
  }
  const putInCart = (buyer: number, variantId: string, quantity: number) =>
    prisma.cartItem.create({ data: { cartId: cartIds[buyer], productId, variantId, quantity } });
  const stockOf = async (variantId: string) => (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stockQuantity;
  const ledgerSum = async (variantId: string) =>
    (await prisma.inventoryMovement.aggregate({ where: { variantId }, _sum: { quantityDelta: true } }))._sum.quantityDelta ?? 0;
  const onOpenOrders = async (variantId: string) =>
    (await prisma.orderItem.aggregate({ where: { variantId, order: { status: { not: 'CANCELLED' } } }, _sum: { quantity: true } }))._sum.quantity ?? 0;

  describe('S3 — the ledger and the vendor delta (TD-08)', () => {
    it(`#3 vendor adjustments racing ${BUYERS} checkouts: no lost update, never oversold, ledger == counter (×${ITERATIONS})`, async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await wipe();
        const variant = await freshVariant(6);
        for (let b = 0; b < BUYERS; b++) await putInCart(b, variant, 1);

        const adjustments = [-2, +3, -1, -4, +1];
        const [checkouts, applied] = await Promise.all([
          Promise.allSettled(buyerIds.map((id) => checkout.checkoutCart(id))),
          Promise.all(adjustments.map((change) => vendors.adjustVariantStock({ variantId: variant, change, reason: 'race test', actorUserId: vendorUserId }))),
        ]);

        const sold = await onOpenOrders(variant);
        const appliedSum = adjustments.reduce((sum, change, k) => (applied[k] ? sum + change : sum), 0);
        const stock = await stockOf(variant);
        expect(stock).toBeGreaterThanOrEqual(0);
        expect(stock).toBe(6 + appliedSum - sold); // every applied change and every reservation counted exactly once
        expect(await ledgerSum(variant)).toBe(stock); // the ledger reconciles with the counter
        expect(checkouts.filter((r) => r.status === 'fulfilled')).toHaveLength(sold);
        // a refused adjustment wrote nothing
        expect(await prisma.inventoryMovement.count({ where: { variantId: variant, type: 'VENDOR_ADJUSTMENT', reason: 'race test' } })).toBe(applied.filter(Boolean).length);
      }
    });

    it('a vendor cannot take back units already reserved by checkouts (409 path): reservations stay protected', async () => {
      await wipe();
      const variant = await freshVariant(5);
      await putInCart(0, variant, 5);
      await checkout.checkoutCart(buyerIds[0]);
      expect(await stockOf(variant)).toBe(0);

      expect(await vendors.adjustVariantStock({ variantId: variant, change: -1, reason: 'recount', actorUserId: vendorUserId })).toBeNull();
      expect(await stockOf(variant)).toBe(0);
      expect(await onOpenOrders(variant)).toBe(5);
    });

    it('every writer leaves a ledger row: initial stock, RESERVE, RELEASE on cancel, vendor adjustments — and the sum is the counter', async () => {
      await wipe();
      const variant = await freshVariant(10);
      await putInCart(0, variant, 3);
      const group = await checkout.checkoutCart(buyerIds[0]);
      await orders.cancelPendingGroup(group.id, { source: 'shopper_cancel', actorUserId: buyerIds[0] });
      await vendors.adjustVariantStock({ variantId: variant, change: 4, reason: 'restock from supplier', actorUserId: vendorUserId });

      const rows = await prisma.inventoryMovement.findMany({ where: { variantId: variant }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => [r.type, r.quantityDelta, r.quantityBefore, r.quantityAfter, r.source])).toEqual([
        ['VENDOR_ADJUSTMENT', 10, 0, 10, 'vendor'],
        ['RESERVE', -3, 10, 7, 'checkout'],
        ['RELEASE', 3, 7, 10, 'shopper_cancel'],
        ['VENDOR_ADJUSTMENT', 4, 10, 14, 'vendor'],
      ]);
      expect(rows[1].orderGroupId).toBe(group.id);
      expect(rows[1].actorUserId).toBe(buyerIds[0]);
      expect(rows[2].orderGroupId).toBe(group.id);
      expect(rows[3].reason).toBe('restock from supplier');
      expect(await ledgerSum(variant)).toBe(await stockOf(variant));
    });

    it('the ledger is append-only and its arithmetic is enforced by the database', async () => {
      await wipe();
      const variant = await freshVariant(2);
      const [row] = await prisma.inventoryMovement.findMany({ where: { variantId: variant } });
      await expect(prisma.inventoryMovement.update({ where: { id: row.id }, data: { reason: 'rewritten' } })).rejects.toThrow(/append-only/);
      await expect(prisma.inventoryMovement.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
      await expect(
        prisma.inventoryMovement.create({
          data: { variantId: variant, type: 'VENDOR_ADJUSTMENT', quantityDelta: 1, quantityBefore: 2, quantityAfter: 9, source: 'vendor' },
        }),
      ).rejects.toThrow(/23514|check constraint/);
      await expect(
        prisma.inventoryMovement.create({ data: { variantId: variant, type: 'RESERVE', quantityDelta: -1, quantityBefore: 2, quantityAfter: 1, source: 'checkout' } }),
      ).rejects.toThrow(/23514|check constraint/); // a RESERVE must name its order group
    });
  });

  describe('S4 — checkout Idempotency-Key (TD-07)', () => {
    it('a retry with the same key after a lost response returns the SAME order: one group, stock taken once', async () => {
      await wipe();
      const variant = await freshVariant(5);
      await putInCart(0, variant, 2);
      const key = randomUUID();

      const first = await checkout.checkoutCart(buyerIds[0], key);
      const retry = await checkout.checkoutCart(buyerIds[0], key); // the client never saw `first`
      expect((retry as { id: string }).id).toBe(first.id);
      expect(await prisma.orderGroup.count({ where: { userId: buyerIds[0] } })).toBe(1);
      expect(await stockOf(variant)).toBe(3);
      expect(await prisma.inventoryMovement.count({ where: { variantId: variant, type: 'RESERVE' } })).toBe(1);
    });

    it(`the same key sent 5 times at once creates exactly one order (×${ITERATIONS})`, async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await wipe();
        const variant = await freshVariant(10);
        await putInCart(0, variant, 1);
        const key = randomUUID();

        const results = await Promise.allSettled(Array.from({ length: 5 }, () => checkout.checkoutCart(buyerIds[0], key)));

        expect(await prisma.orderGroup.count({ where: { userId: buyerIds[0] } })).toBe(1);
        expect(await stockOf(variant)).toBe(9);
        const groupIds = new Set(results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled').map((r) => r.value.id));
        expect(groupIds.size).toBe(1); // every success is the same order
        for (const r of results) {
          if (r.status === 'rejected') expect((r.reason as any).response?.code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
        }
      }
    });

    it('a failed checkout frees its key: the same key works once the cart is fixed', async () => {
      await wipe();
      const variant = await freshVariant(1);
      await putInCart(0, variant, 2); // more than in stock
      const key = randomUUID();
      await expect(checkout.checkoutCart(buyerIds[0], key)).rejects.toMatchObject({ response: { code: 'CHECKOUT_ITEM_UNAVAILABLE' } });
      expect(await prisma.idempotencyKey.count({ where: { userId: buyerIds[0] } })).toBe(0);

      await prisma.cartItem.updateMany({ where: { cartId: cartIds[0] }, data: { quantity: 1 } });
      await expect(checkout.checkoutCart(buyerIds[0], key)).resolves.toMatchObject({ id: expect.any(String) });
      expect(await stockOf(variant)).toBe(0);
    });

    it('releasing a key is holder-aware: a release with a stale lock never frees a key another request took over', async () => {
      const repo = moduleRef.get(CheckoutRepository);
      const past = new Date(Date.now() - 1_000);
      const { row } = await repo.claimIdempotencyKey({
        userId: buyerIds[0], scope: 'checkout', key: 'holder-aware-key-1', lockedUntil: past, expiresAt: new Date(Date.now() + 86_400_000),
      });
      // the first holder's lock lapsed; a second request takes the key over with a new lock
      const newLock = new Date(Date.now() + 60_000);
      expect(await repo.takeOverStaleIdempotencyKey(row.id, newLock)).toBe(true);

      await repo.releaseIdempotencyKey(row.id, past); // the first (stale) holder fails and tries to free it
      expect(await prisma.idempotencyKey.findUnique({ where: { id: row.id } })).not.toBeNull(); // still held by the second

      await repo.releaseIdempotencyKey(row.id, newLock); // the current holder frees it
      expect(await prisma.idempotencyKey.findUnique({ where: { id: row.id } })).toBeNull();
    });

    it('different keys are different checkouts; without a key behaviour is unchanged', async () => {
      await wipe();
      const variant = await freshVariant(10);
      await putInCart(0, variant, 1);
      const a = await checkout.checkoutCart(buyerIds[0], randomUUID());
      await putInCart(0, variant, 1);
      const b = await checkout.checkoutCart(buyerIds[0], randomUUID());
      await putInCart(0, variant, 1);
      const c = await checkout.checkoutCart(buyerIds[0]);
      expect(new Set([a.id, b.id, c.id]).size).toBe(3);
      expect(await stockOf(variant)).toBe(7);
    });
  });
});
