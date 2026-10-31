import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { OrderStatus, Prisma, Role, VendorType } from '@prisma/client';
import * as request from 'supertest';

import { AppModule } from '../../app.module';
import { PrismaService } from '../../infra/prisma/prisma.service';

// specs/commerce/23 R0.8 (manual expire-overdue) and R4 health endpoints (22 §4.3).
// PROCESS_ROLE=api: this process neither runs the expiry worker nor owns the
// schedule, so no background run competes with the assertions below.
// ConfigModule.forRoot reads the .env file when AppModule is imported (before
// beforeAll runs) and its validated value wins over a later process.env write.
// So use the token a local .env already sets, and fall back to the test value.
const HEALTH_TOKEN = process.env.HEALTH_CHECK_TOKEN || 'test-health-token-0123456789';

describe('Admin maintenance + health endpoints (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let shopperToken: string;
  let adminId: string;
  let shopperId: string;
  let vendorId: string;
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    process.env.PROCESS_ROLE = 'api';
    process.env.HEALTH_CHECK_TOKEN = HEALTH_TOKEN;
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    await wipe();
    const admin = await prisma.user.create({ data: { email: 'mnt-admin@example.com', passwordHash: 'x', name: 'A', role: Role.ADMIN } });
    const shopper = await prisma.user.create({ data: { email: 'mnt-shopper@example.com', passwordHash: 'x', name: 'S', role: Role.SHOPPER } });
    const vendorUser = await prisma.user.create({ data: { email: 'mnt-vendor@example.com', passwordHash: 'x', name: 'V', role: Role.VENDOR } });
    adminId = admin.id;
    shopperId = shopper.id;
    const jwt = app.get(JwtService);
    adminToken = await jwt.signAsync({ sub: admin.id, role: Role.ADMIN });
    shopperToken = await jwt.signAsync({ sub: shopper.id, role: Role.SHOPPER });
    vendorId = (await prisma.vendor.create({ data: { ownerId: vendorUser.id, name: 'Mnt Shop', verified: true, vendorType: VendorType.MARKETPLACE } })).id;
    const category = await prisma.category.create({ data: { name: 'Mnt', slug: 'mnt-category' } });
    productId = (await prisma.product.create({ data: { vendorId, title: 'Mnt Tee', description: 'x', categoryId: category.id, basePrice: new Prisma.Decimal(100) } })).id;
    variantId = (await prisma.productVariant.create({ data: { productId, sku: 'MNT-1', stockQuantity: 8 } })).id;
  });

  afterAll(async () => {
    await wipe();
    await app?.close();
    delete process.env.PROCESS_ROLE;
    delete process.env.HEALTH_CHECK_TOKEN;
  });

  async function wipe() {
    await prisma.rating.deleteMany();
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    // payment_exceptions → order_groups is RESTRICT and its rows are never deleted (trigger); TRUNCATE skips row triggers.
    await prisma.$executeRawUnsafe('TRUNCATE "payment_exceptions", "inventory_movements"');
    await prisma.idempotencyKey.deleteMany(); // key → order group is RESTRICT (keys left by smoke runs, commerce/25 S4)
    await prisma.orderGroup.deleteMany();
    await prisma.maintenanceRun.deleteMany();
    await prisma.productVariant.deleteMany({ where: { sku: { startsWith: 'MNT-' } } });
    await prisma.product.deleteMany({ where: { title: 'Mnt Tee' } });
    await prisma.category.deleteMany({ where: { slug: 'mnt-category' } });
    await prisma.vendor.deleteMany({ where: { name: 'Mnt Shop' } });
    await prisma.adminAuditLog.deleteMany({ where: { actor: { email: { startsWith: 'mnt-' } } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: 'mnt-' } } });
  }

  async function abandonedCheckout(qty: number) {
    const group = await prisma.orderGroup.create({ data: { userId: shopperId, createdAt: new Date(Date.now() - 3 * 60 * 60_000) } });
    await prisma.order.create({
      data: {
        orderGroupId: group.id,
        vendorId,
        userId: shopperId,
        status: OrderStatus.PENDING,
        subtotal: new Prisma.Decimal(10),
        items: { create: [{ productId, variantId, titleSnapshot: 'Mnt Tee', priceSnapshot: new Prisma.Decimal(5), quantity: qty }] },
      },
    });
    await prisma.productVariant.update({ where: { id: variantId }, data: { stockQuantity: { decrement: qty } } });
    return group.id;
  }

  describe('POST /admin/maintenance/expire-overdue', () => {
    const path = '/admin/maintenance/expire-overdue';

    it('401 without a token, 403 for a shopper', async () => {
      await request(app.getHttpServer()).post(path).send({ reason: 'x' }).expect(401);
      await request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${shopperToken}`).send({ reason: 'x' }).expect(403);
    });

    it('400 without a reason, and for unknown fields', async () => {
      await request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${adminToken}`).send({}).expect(400);
      await request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${adminToken}`).send({ reason: 'x', batchSize: 5 }).expect(400);
    });

    it('releases an abandoned checkout, records the run (triggeredBy = admin) and an audit row with the reason', async () => {
      const groupId = await abandonedCheckout(3);
      expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stockQuantity).toBe(5);

      const res = await request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'backlog after outage' })
        .expect(200);

      expect(res.body).toMatchObject({ status: 'SUCCEEDED', released: 1, ordersCancelled: 1 });
      expect((await prisma.order.findFirstOrThrow({ where: { orderGroupId: groupId } })).status).toBe(OrderStatus.CANCELLED);
      expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).stockQuantity).toBe(8);
      expect(await prisma.maintenanceRun.findUniqueOrThrow({ where: { id: res.body.runId } })).toMatchObject({
        command: 'EXPIRE_OVERDUE',
        triggeredBy: adminId,
        status: 'SUCCEEDED',
        jobId: null,
      });
      expect(
        await prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: res.body.runId } }),
      ).toMatchObject({ actorId: adminId, action: 'MAINTENANCE_EXPIRE_OVERDUE', targetType: 'MAINTENANCE_RUN', reason: 'backlog after outage' });
    });

    it('a call that releases nothing is still recorded and audited', async () => {
      const res = await request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${adminToken}`).send({ reason: 'check' }).expect(200);
      expect(res.body).toMatchObject({ status: 'SUCCEEDED', released: 0 });
      expect(await prisma.adminAuditLog.count({ where: { targetId: res.body.runId, reason: 'check' } })).toBe(1);
    });
  });

  describe('GET /health/dependencies, /health/maintenance', () => {
    it('401 with a wrong token; the public /health stays open', async () => {
      await request(app.getHttpServer()).get('/health/dependencies').set('x-health-token', 'wrong-token-of-the-same-size!').expect(401);
      await request(app.getHttpServer()).get('/health/maintenance').expect(401);
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('dependencies: PostgreSQL and Redis up → 200', async () => {
      const res = await request(app.getHttpServer()).get('/health/dependencies').set('x-health-token', HEALTH_TOKEN).expect(200);
      expect(res.body).toEqual({ status: 'ok', postgres: 'up', redis: 'up' });
    });

    it('maintenance: a fresh run → 200 ok', async () => {
      // Test fixtures (here and in other suites sharing this database) create
      // variants with stock directly, without ledger rows; production writers
      // always record one. Reconcile them first, exactly as the deploy runbook
      // does (scripts/ledger-catch-up.sql), so LEDGER-DRIFT reflects real drift.
      await prisma.$executeRawUnsafe(`
        INSERT INTO "inventory_movements" ("id", "variantId", "type", "quantityDelta", "quantityBefore", "quantityAfter", "source", "reason")
        SELECT gen_random_uuid()::text, v."id", 'OPENING_BALANCE', v."stockQuantity" - COALESCE(l.total, 0), COALESCE(l.total, 0), v."stockQuantity", 'migration', 'test fixture catch-up'
        FROM "product_variants" v
        LEFT JOIN (SELECT "variantId", SUM("quantityDelta") AS total FROM "inventory_movements" GROUP BY "variantId") l ON l."variantId" = v."id"
        WHERE v."stockQuantity" <> COALESCE(l.total, 0) AND COALESCE(l.total, 0) >= 0`);
      await prisma.$executeRawUnsafe('TRUNCATE "payment_exceptions"');
      await request(app.getHttpServer()).post('/admin/maintenance/expire-overdue').set('Authorization', `Bearer ${adminToken}`).send({ reason: 'x' }).expect(200);
      const res = await request(app.getHttpServer()).get('/health/maintenance').set('x-health-token', HEALTH_TOKEN).expect(200);
      expect(res.body.status).toBe('ok');
    });

    it('maintenance: an overdue checkout and an old last success → 503 with A1 and A5 (coded body)', async () => {
      await prisma.maintenanceRun.deleteMany();
      await prisma.maintenanceRun.create({
        data: { command: 'EXPIRE_OVERDUE', triggeredBy: 'schedule', status: 'SUCCEEDED', startedAt: new Date(Date.now() - 60 * 60_000), finishedAt: new Date(Date.now() - 59 * 60_000) },
      });
      await abandonedCheckout(1);

      const res = await request(app.getHttpServer()).get('/health/maintenance').set('x-health-token', HEALTH_TOKEN).expect(503);
      expect(res.body.code).toBe('MAINTENANCE_ALERT');
      const codes = res.body.details.conditions.map((c: { code: string }) => c.code);
      expect(codes).toEqual(expect.arrayContaining(['A1', 'A5']));
    });

    it('maintenance: a variant whose stock does not match its ledger → LEDGER-DRIFT (commerce/25 §10)', async () => {
      await prisma.productVariant.update({ where: { id: variantId }, data: { stockQuantity: { increment: 7 } } }); // a write that skipped the ledger
      const res = await request(app.getHttpServer()).get('/health/maintenance').set('x-health-token', HEALTH_TOKEN).expect(503);
      expect(res.body.details.conditions.map((c: { code: string }) => c.code)).toContain('LEDGER-DRIFT');
      await prisma.productVariant.update({ where: { id: variantId }, data: { stockQuantity: { decrement: 7 } } });
    });

    it('maintenance: an open payment exception → PAY-EXC; a signed payment stuck unprocessed for 15 min → PAY-STUCK', async () => {
      await prisma.paymentException.create({
        data: { type: 'UNMATCHED_PAYMENT', provider: 'PAYMOB', providerTransactionId: `mt-${Date.now()}`, amountCents: 100, currency: 'EGP', detail: 'test' },
      });
      await prisma.paymentProviderEvent.create({
        data: { provider: 'PAYMOB', providerTransactionId: `mt-stuck-${Date.now()}`, kind: 'PAYMENT', payload: {}, receivedAt: new Date(Date.now() - 16 * 60_000) },
      });
      const res = await request(app.getHttpServer()).get('/health/maintenance').set('x-health-token', HEALTH_TOKEN).expect(503);
      expect(res.body.details.conditions.map((c: { code: string }) => c.code)).toEqual(expect.arrayContaining(['PAY-EXC', 'PAY-STUCK']));
      await prisma.$executeRawUnsafe('TRUNCATE "payment_exceptions", "payment_provider_events"');
    });
  });
});
