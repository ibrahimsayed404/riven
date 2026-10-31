import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { OrderStatus, Prisma, PrismaClient, Role, VendorType } from '@prisma/client';

import { PrismaModule } from '../../../infra/prisma/prisma.module';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { AuditModule } from '../../audit/audit.module';
import { CheckoutRepository } from '../../checkout/checkout.repository';
import { OrdersRepository } from '../orders.repository';
import { MaintenanceRunsRepository } from '../maintenance-runs.repository';
import { ReservationExpiryService } from './reservation-expiry.service';

/**
 * specs/commerce/23 R0 on real PostgreSQL (TD-01 condition): races use
 * independent connections, never one transaction. Wipes order data of the
 * configured database, so it refuses to run unless that database is a *_test one.
 * RACE_ITERATIONS (default 20) sets how often each race repeats; the R0 review
 * asks for ≥ 200 — run with RACE_ITERATIONS=200 before accepting R0.
 */
const ITERATIONS = Number(process.env.RACE_ITERATIONS ?? 20);
const HOUR = 60 * 60_000;

describe('Reservation expiry R0 (e2e, real PostgreSQL)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let orders: OrdersRepository;
  let checkout: CheckoutRepository;
  let runs: MaintenanceRunsRepository;
  let expiry: ReservationExpiryService;

  let shopperId: string;
  let adminId: string;
  let vendorId: string;
  let productId: string;
  const variantIds: string[] = [];

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? '';
    if (!/\/[^/?]+_test(\?|$)/.test(url)) {
      throw new Error('reservation-expiry e2e must run against a *_test database (it wipes order data).');
    }

    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, AuditModule],
      providers: [OrdersRepository, CheckoutRepository, MaintenanceRunsRepository, ReservationExpiryService],
    }).compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    orders = moduleRef.get(OrdersRepository);
    checkout = moduleRef.get(CheckoutRepository);
    runs = moduleRef.get(MaintenanceRunsRepository);
    expiry = moduleRef.get(ReservationExpiryService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    await wipeOrders();
    await prisma.$executeRawUnsafe('TRUNCATE "inventory_movements"'); // append-only ledger (commerce/25 S3) → variants, groups, users are RESTRICT
    await prisma.adminAuditLog.deleteMany({ where: { actor: { email: { startsWith: 'r0-' } } } });
    await prisma.cartItem.deleteMany({ where: { cart: { user: { email: { startsWith: 'r0-' } } } } });
    await prisma.cart.deleteMany({ where: { user: { email: { startsWith: 'r0-' } } } });
    await prisma.productVariant.deleteMany({ where: { sku: { startsWith: 'R0-' } } });
    await prisma.product.deleteMany({ where: { title: { startsWith: 'R0 ' } } });
    await prisma.vendor.deleteMany({ where: { owner: { email: { startsWith: 'r0-' } } } });
    await prisma.category.deleteMany({ where: { slug: 'r0-category' } });
    await prisma.user.deleteMany({ where: { email: { startsWith: 'r0-' } } });

    shopperId = (await prisma.user.create({ data: { email: 'r0-shopper@example.com', passwordHash: 'x', name: 'S', role: Role.SHOPPER } })).id;
    adminId = (await prisma.user.create({ data: { email: 'r0-admin@example.com', passwordHash: 'x', name: 'A', role: Role.ADMIN } })).id;
    const vendorUser = await prisma.user.create({ data: { email: 'r0-vendor@example.com', passwordHash: 'x', name: 'V', role: Role.VENDOR } });
    vendorId = (await prisma.vendor.create({ data: { ownerId: vendorUser.id, name: 'R0 Shop', verified: true, vendorType: VendorType.MARKETPLACE } })).id;
    const category = await prisma.category.create({ data: { name: 'R0', slug: 'r0-category' } });
    productId = (
      await prisma.product.create({ data: { vendorId, title: 'R0 Tee', description: 'x', categoryId: category.id, basePrice: new Prisma.Decimal(100) } })
    ).id;
    for (let i = 0; i < 4; i++) {
      variantIds.push((await prisma.productVariant.create({ data: { productId, sku: `R0-${i}`, stockQuantity: 1000 } })).id);
    }
    await prisma.cart.create({ data: { userId: shopperId } });
  });

  afterAll(async () => {
    await wipeOrders();
    await moduleRef?.close();
  });

  beforeEach(async () => {
    await wipeOrders();
    await prisma.productVariant.updateMany({ where: { id: { in: variantIds } }, data: { stockQuantity: 1000 } });
  });

  async function wipeOrders() {
    await prisma.rating.deleteMany();
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    // payment_exceptions → order_groups is RESTRICT and its rows are never deleted (trigger); TRUNCATE skips row triggers.
    await prisma.$executeRawUnsafe('TRUNCATE "payment_exceptions", "inventory_movements"');
    await prisma.idempotencyKey.deleteMany(); // key → order group is RESTRICT (keys left by smoke runs, commerce/25 S4)
    await prisma.orderGroup.deleteMany();
    await prisma.maintenanceRun.deleteMany();
  }

  /** A checkout as the expiry sees it: group + PENDING order(s) with items; stock already reserved (decremented). */
  async function makeGroup(opts: {
    createdAt?: Date;
    items?: { variant: number; qty: number }[];
    statuses?: OrderStatus[];
    paymobTransactionId?: string | null;
  } = {}): Promise<string> {
    const items = opts.items ?? [{ variant: 0, qty: 2 }];
    const group = await prisma.orderGroup.create({
      data: {
        userId: shopperId,
        createdAt: opts.createdAt ?? new Date(Date.now() - 2 * HOUR),
        paymobTransactionId: opts.paymobTransactionId ?? null,
      },
    });
    for (const status of opts.statuses ?? [OrderStatus.PENDING]) {
      await prisma.order.create({
        data: {
          orderGroupId: group.id,
          vendorId,
          userId: shopperId,
          status,
          subtotal: new Prisma.Decimal(10),
          items: {
            create: items.map((it) => ({
              productId,
              variantId: variantIds[it.variant],
              titleSnapshot: 'R0 Tee',
              priceSnapshot: new Prisma.Decimal(5),
              quantity: it.qty,
            })),
          },
        },
      });
    }
    const orderCount = (opts.statuses ?? [OrderStatus.PENDING]).length;
    for (const it of items) {
      await prisma.productVariant.update({
        where: { id: variantIds[it.variant] },
        data: { stockQuantity: { decrement: it.qty * orderCount } },
      });
    }
    return group.id;
  }

  const stock = async (i: number) => (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantIds[i] } })).stockQuantity;
  const statuses = async (groupId: string) =>
    (await prisma.order.findMany({ where: { orderGroupId: groupId }, select: { status: true } })).map((o) => o.status);
  const run = (budgetMs = 60_000) => expiry.run({ triggeredBy: 'schedule', budgetMs });

  // ------------------------------------------------------------------ parity

  it('candidate parity: the keyset query selects exactly the pre-R0 filter, at the same cutoff instant (1 ms boundaries, ties)', async () => {
    const cutoff = new Date(Date.now() - HOUR);
    const tie = new Date(cutoff.getTime() - 5 * 60_000);
    await makeGroup({ createdAt: new Date(cutoff.getTime() - 1) }); // eligible (1 ms before)
    await makeGroup({ createdAt: new Date(cutoff.getTime() + 1) }); // not eligible (1 ms after)
    await makeGroup({ createdAt: cutoff }); // not eligible (lt, not lte)
    await makeGroup({ createdAt: tie });
    await makeGroup({ createdAt: tie }); // tie on createdAt, ordered by id
    await makeGroup({ createdAt: tie, paymobTransactionId: 'tx-parity' }); // payment recorded → excluded
    await makeGroup({ statuses: [OrderStatus.PENDING, OrderStatus.PAID] }); // mixed → excluded
    await makeGroup({ statuses: [OrderStatus.SHIPPED] }); // excluded
    await makeGroup({ statuses: [OrderStatus.PENDING, OrderStatus.PENDING] }); // eligible (two vendors' orders)

    // The pre-R0 filter, verbatim (orders.repository.ts before R0).
    const expected = await prisma.orderGroup.findMany({
      where: {
        createdAt: { lt: cutoff },
        paymobTransactionId: null,
        orders: { some: { status: OrderStatus.PENDING }, none: { status: { not: OrderStatus.PENDING } } },
      },
      select: { id: true },
    });

    const seen: string[] = [];
    let cursor: { createdAt: Date; id: string } | undefined;
    for (;;) {
      const page = await orders.findStalePendingGroups(cutoff, 2, cursor);
      if (page.length === 0) break;
      seen.push(...page.map((g) => g.id));
      cursor = page[page.length - 1];
    }

    expect(new Set(seen)).toEqual(new Set(expected.map((g) => g.id)));
    expect(seen).toHaveLength(new Set(seen).size); // never re-selected
    expect(seen).toHaveLength(4);
  });

  // ------------------------------------------------------------------ basic release

  it('releases an abandoned checkout once: orders CANCELLED, stock restored once, run recorded', async () => {
    const g = await makeGroup({ items: [{ variant: 0, qty: 3 }, { variant: 1, qty: 2 }] });
    expect(await stock(0)).toBe(997);

    const first = await run();
    const second = await run();

    expect(first).toMatchObject({ status: 'SUCCEEDED', released: 1, processed: 1 });
    expect(second).toMatchObject({ status: 'SUCCEEDED', released: 0, processed: 0 });
    expect(await statuses(g)).toEqual([OrderStatus.CANCELLED]);
    expect([await stock(0), await stock(1)]).toEqual([1000, 1000]);

    const row = await prisma.maintenanceRun.findUniqueOrThrow({ where: { id: first.runId } });
    expect(row).toMatchObject({ command: 'EXPIRE_OVERDUE', triggeredBy: 'schedule', status: 'SUCCEEDED', released: 1, backlogAtStart: 1 });
    expect(row.finishedAt).not.toBeNull();
  });

  it('a group that received only a WRONG charge (amount mismatch) is still released by expiry; the charge stays on record (commerce/25 §10)', async () => {
    const g = await makeGroup({ items: [{ variant: 0, qty: 2 }] }); // subtotal 10.00 EGP = 1000 piastres
    const decided = await checkout.applyPayment({ groupId: g, provider: 'PAYMOB', transactionId: `tx-wrong-${g}`, amountCents: 1, currency: 'EGP' });
    expect(decided.outcome).toBe('amount_mismatch');
    expect((await prisma.orderGroup.findUniqueOrThrow({ where: { id: g } })).paymobTransactionId).toBeNull();

    const result = await run();
    expect(result.released).toBe(1);
    expect(await statuses(g)).toEqual([OrderStatus.CANCELLED]);
    expect(await stock(0)).toBe(1000);
    expect(await prisma.paymentException.findMany({ where: { orderGroupId: g } })).toEqual([
      expect.objectContaining({ type: 'AMOUNT_MISMATCH', amountCents: 1, status: 'OPEN' }),
    ]);
  });

  it('never releases a group whose payment was recorded, or that is not old enough', async () => {
    await makeGroup({ paymobTransactionId: 'tx-1' });
    await makeGroup({ createdAt: new Date(Date.now() - 30 * 60_000) });
    const result = await run();
    expect(result.released).toBe(0);
    expect(await stock(0)).toBe(996);
  });

  // ------------------------------------------------------------------ concurrency (independent connections)

  it(`C-MNT1 / AT-MNT-08: two overlapping runs release every group exactly once (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await wipeOrders();
      await prisma.productVariant.updateMany({ where: { id: { in: variantIds } }, data: { stockQuantity: 1000 } });
      const groups = await Promise.all(Array.from({ length: 8 }, (_, k) => makeGroup({ items: [{ variant: k % 4, qty: 1 }, { variant: (k + 1) % 4, qty: 2 }] })));

      const [a, b] = await Promise.all([run(), run()]);
      // Under Serializable, restocking the same variant from two runs can exhaust
      // a group's retries; such a group is counted as failed, left PENDING and
      // released by the next run — never released twice.
      const catchUp = await run();

      expect(a.released + b.released + catchUp.released).toBe(groups.length);
      expect(catchUp.released).toBe(a.failed + b.failed);
      for (const g of groups) expect(await statuses(g)).toEqual([OrderStatus.CANCELLED]);
      for (let v = 0; v < 4; v++) expect(await stock(v)).toBe(1000);
    }
  }, 120_000); // ×20 two-run races with Serializable retries: ~30–40 s on a laptop, over Jest's 30 s default

  it(`AT-MNT-23: a manual retry while the first manual run is RUNNING is safe — two run rows, exactly-once release, two audit writes (×${Math.max(3, Math.floor(ITERATIONS / 4))})`, async () => {
    for (let i = 0; i < Math.max(3, Math.floor(ITERATIONS / 4)); i++) {
      await wipeOrders();
      await prisma.adminAuditLog.deleteMany({ where: { actorId: adminId } });
      await prisma.productVariant.updateMany({ where: { id: { in: variantIds } }, data: { stockQuantity: 1000 } });
      const groups = await Promise.all(Array.from({ length: 10 }, (_, k) => makeGroup({ items: [{ variant: k % 4, qty: 1 }] })));

      const [a, b] = await Promise.all([expiry.runManual(adminId, 'first click'), expiry.runManual(adminId, 'retry')]);
      const catchUp = await run();

      expect(a.runId).not.toBe(b.runId);
      expect(a.released + b.released + catchUp.released).toBe(groups.length);
      // Skips never make a run PARTIAL; only failed groups do (then caught up next run).
      expect(a.status).toBe(a.failed > 0 ? 'PARTIAL' : 'SUCCEEDED');
      expect(b.status).toBe(b.failed > 0 ? 'PARTIAL' : 'SUCCEEDED');
      const rows = await prisma.maintenanceRun.findMany({ where: { id: { in: [a.runId, b.runId] } } });
      expect(rows.every((r) => r.status === 'SUCCEEDED' || r.status === 'PARTIAL')).toBe(true);
      expect(rows.every((r) => r.triggeredBy === adminId)).toBe(true);
      for (let v = 0; v < 4; v++) expect(await stock(v)).toBe(1000);
      const audits = await prisma.adminAuditLog.findMany({ where: { actorId: adminId, action: 'MAINTENANCE_EXPIRE_OVERDUE' } });
      expect(audits.map((x) => x.reason).sort()).toEqual(['first click', 'retry']);
      expect(new Set(audits.map((x) => x.targetId))).toEqual(new Set([a.runId, b.runId]));
    }
  });

  it(`expiry ∥ shopper cancel on the same group: stock restored exactly once (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await wipeOrders();
      await prisma.productVariant.updateMany({ where: { id: { in: variantIds } }, data: { stockQuantity: 1000 } });
      const g = await makeGroup({ items: [{ variant: 0, qty: 3 }, { variant: 2, qty: 1 }] });

      const [, cancel] = await Promise.all([run(), delay(Math.random() * 5).then(() => orders.cancelPendingGroup(g, { source: 'shopper_cancel', actorUserId: shopperId }))]);

      expect(await statuses(g)).toEqual([OrderStatus.CANCELLED]);
      expect([await stock(0), await stock(2)]).toEqual([1000, 1000]);
      expect(['released', 'notEligible']).toContain(cancel.outcome);
    }
  });

  it(`expiry ∥ payment webhook: never PAID and CANCELLED in one group, no restock of a paid order (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await wipeOrders();
      await prisma.productVariant.updateMany({ where: { id: { in: variantIds } }, data: { stockQuantity: 1000 } });
      const g = await makeGroup({ statuses: [OrderStatus.PENDING, OrderStatus.PENDING], items: [{ variant: 1, qty: 2 }] });

      // The real webhook path (commerce/25 S1): applyPayment takes the same group
      // lock first and decides under it. Two PENDING orders of 10.00 = 2000 piastres.
      const [, payment] = await Promise.all([
        run(),
        delay(Math.random() * 5).then(() =>
          checkout.applyPayment({ groupId: g, provider: 'PAYMOB', transactionId: `tx-${i}`, amountCents: 2000, currency: 'EGP' }),
        ),
      ]);

      const s = await statuses(g);
      expect(new Set(s).size).toBe(1); // E1: all PAID or all CANCELLED
      const group = await prisma.orderGroup.findUniqueOrThrow({ where: { id: g } });
      const exceptions = await prisma.paymentException.findMany({ where: { orderGroupId: g } });
      // E4: the payment is always recorded — on the group when applied, on its
      // LATE_PAYMENT exception when expiry won (commerce/25 §10: only an applied
      // payment claims the group).
      expect(group.paymobTransactionId ?? exceptions[0]?.providerTransactionId).toBe(`tx-${i}`);
      if (s[0] === OrderStatus.PAID) {
        expect(payment.outcome).toBe('paid');
        expect(payment.paidOrders).toBe(2);
        expect(exceptions).toHaveLength(0);
        expect(await stock(1)).toBe(996); // E3: still reserved for the paid orders
      } else {
        expect(s[0]).toBe(OrderStatus.CANCELLED);
        expect(payment.outcome).toBe('orphan'); // late payment: recorded, never applied
        expect(payment.paidOrders).toBe(0);
        expect(exceptions.map((e) => e.type)).toEqual(['LATE_PAYMENT']); // the money is not silently lost
        expect(await stock(1)).toBe(1000);
      }
    }
  });

  it(`cancel ∥ checkout on shared variants in opposite cart order: exact stock arithmetic, nothing escapes unhandled (×${ITERATIONS})`, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await wipeOrders();
      await prisma.productVariant.updateMany({ where: { id: { in: variantIds } }, data: { stockQuantity: 1000 } });
      const g = await makeGroup({ items: [{ variant: 3, qty: 1 }, { variant: 0, qty: 1 }] });

      const draft = {
        vendorId,
        subtotalCents: 1000,
        items: [3, 2, 1, 0].map((v) => ({ productId, variantId: variantIds[v], titleSnapshot: 'R0 Tee', priceSnapshotCents: 500, quantity: 1 })),
      };
      const cart = await prisma.cart.findUniqueOrThrow({ where: { userId: shopperId } });
      await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
      // the checkout removes exactly the cart lines it priced (commerce/25 §10)
      const lines = [];
      for (const v of [3, 2, 1, 0]) {
        lines.push(await prisma.cartItem.create({ data: { cartId: cart.id, productId, variantId: variantIds[v], quantity: 1 } }));
      }
      const results = await Promise.allSettled([
        orders.cancelPendingGroup(g, { source: 'shopper_cancel', actorUserId: shopperId }),
        checkout.createOrderGroup({ userId: shopperId, cartId: cart.id, cartLines: lines.map((l) => ({ id: l.id, quantity: l.quantity })), orders: [draft] }),
      ]);

      expect(results[0].status).toBe('fulfilled'); // cancel retries any transient conflict
      const checkoutOk = results[1].status === 'fulfilled';
      expect(await statuses(g)).toEqual([OrderStatus.CANCELLED]);
      // variants 0 and 3: +1 from the cancel, −1 if the checkout committed
      expect(await stock(0)).toBe(checkoutOk ? 999 : 1000);
      expect(await stock(3)).toBe(checkoutOk ? 999 : 1000);
      expect(await stock(1)).toBe(checkoutOk ? 999 : 1000);
    }
  });

  // ------------------------------------------------------------------ locks, faults, failures

  it('AT-MNT-22: a group locked by another connection is skipped (not retried in that run) and released by a later run once the lock is gone', async () => {
    const locked = await makeGroup({ items: [{ variant: 0, qty: 2 }] });
    const other = await makeGroup({ items: [{ variant: 1, qty: 1 }] });
    const holder = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let lockTaken!: () => void;
    const taken = new Promise<void>((resolve) => (lockTaken = resolve));

    const holding = holder.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "order_groups" WHERE "id" = ${locked} FOR UPDATE`;
        lockTaken();
        await held;
      },
      { timeout: 60_000 },
    );
    try {
      await taken;
      const first = await run();
      const second = await run(); // lock still held across two runs
      expect(first).toMatchObject({ released: 1, skipped: 1, processed: 2 });
      expect(second).toMatchObject({ released: 0, skipped: 1, processed: 1 });
      expect(await statuses(locked)).toEqual([OrderStatus.PENDING]);
      expect(await statuses(other)).toEqual([OrderStatus.CANCELLED]);
    } finally {
      release();
      await holding;
      await holder.$disconnect();
    }

    const third = await run();
    expect(third).toMatchObject({ released: 1, skipped: 0 });
    expect(await statuses(locked)).toEqual([OrderStatus.CANCELLED]);
    expect(await stock(0)).toBe(1000);
  });

  describe('with a test-only fault trigger on one variant', () => {
    let faultySku: string;

    beforeAll(async () => {
      faultySku = 'R0-3';
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION r0_test_fault() RETURNS trigger AS $$
        BEGIN
          IF NEW."sku" = '${faultySku}' AND NEW."stockQuantity" > OLD."stockQuantity" THEN
            RAISE EXCEPTION 'r0 test fault';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS r0_test_fault ON "product_variants"`);
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER r0_test_fault BEFORE UPDATE ON "product_variants" FOR EACH ROW EXECUTE FUNCTION r0_test_fault()`,
      );
    });

    afterAll(async () => {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS r0_test_fault ON "product_variants"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS r0_test_fault()`);
    });

    it('AT-MNT-14 / AT-MNT-15: the always-failing OLDEST group rolls back completely, never blocks newer groups, and fails again next run', async () => {
      const failing = await makeGroup({ createdAt: new Date(Date.now() - 5 * HOUR), items: [{ variant: 0, qty: 1 }, { variant: 3, qty: 1 }] });
      const newer = await Promise.all([1, 2, 3].map((k) => makeGroup({ createdAt: new Date(Date.now() - (2 + k / 10) * HOUR), items: [{ variant: 1, qty: 1 }] })));

      const first = await run();
      expect(first).toMatchObject({ status: 'PARTIAL', failed: 1, released: 3, processed: 4 });
      expect(first.error).toContain('r0 test fault');
      expect(await statuses(failing)).toEqual([OrderStatus.PENDING]); // rolled back: orders untouched
      expect(await stock(0)).toBe(999); // no partial restock of the healthy variant either
      for (const g of newer) expect(await statuses(g)).toEqual([OrderStatus.CANCELLED]);

      const second = await run();
      expect(second).toMatchObject({ status: 'PARTIAL', failed: 1, released: 0, processed: 1 });
    });
  });

  it('stale RUNNING rows: two closers close a row once; a young RUNNING row is never closed', async () => {
    const old = await prisma.maintenanceRun.create({
      data: { command: 'EXPIRE_OVERDUE', triggeredBy: 'schedule', startedAt: new Date(Date.now() - 30 * 60_000) },
    });
    const young = await prisma.maintenanceRun.create({ data: { command: 'EXPIRE_OVERDUE', triggeredBy: 'schedule' } });

    const [a, b] = await Promise.all([
      runs.closeStale('EXPIRE_OVERDUE', new Date(Date.now() - 15 * 60_000)),
      runs.closeStale('EXPIRE_OVERDUE', new Date(Date.now() - 15 * 60_000)),
    ]);

    expect(a + b).toBe(1);
    expect(await prisma.maintenanceRun.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: 'FAILED', error: 'stale' });
    expect(await prisma.maintenanceRun.findUniqueOrThrow({ where: { id: young.id } })).toMatchObject({ status: 'RUNNING' });
    // and the owner of a closed row cannot overwrite it
    expect(await runs.finish(old.id, { status: 'SUCCEEDED', batches: 0, candidates: 0, processed: 0, released: 0, skipped: 0, failed: 0, error: null })).toBe(false);
  });

  // ------------------------------------------------------------------ createdAt source (23 §11.12)

  it('production creation path: Prisma 6 sends createdAt itself (application clock, UTC) — the database default is not used', async () => {
    const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
    const queries: string[] = [];
    logged.$on('query', (e) => queries.push(e.query));
    try {
      const before = Date.now();
      const created = await logged.orderGroup.create({ data: { userId: shopperId } });
      const insert = queries.find((q) => /INSERT INTO "public"\."order_groups"/.test(q));
      expect(insert).toBeDefined();
      // Observed 2026-10-28: INSERT INTO "public"."order_groups" ("id","userId","createdAt") VALUES ($1,$2,$3)
      expect(insert).toMatch(/\("id","userId","createdAt"\)/);
      expect(Math.abs(created.createdAt.getTime() - before)).toBeLessThan(5_000);
    } finally {
      await logged.$disconnect();
    }
  });

  it('a non-UTC session TimeZone does not shift createdAt, because Prisma binds the value in UTC', async () => {
    const shift = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Tokyo'`); // fixed +09:00, no DST
      const created = await tx.orderGroup.create({ data: { userId: shopperId } });
      return created.createdAt.getTime() - Date.now();
    });
    // No shift: the value comes from Prisma (application clock, sent in UTC), not
    // from CURRENT_TIMESTAMP, so the session zone does not matter (23 §11.12, C-e).
    expect(Math.abs(shift)).toBeLessThan(5_000);
  });
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
