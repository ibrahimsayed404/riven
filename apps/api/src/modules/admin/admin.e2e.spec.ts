import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { BazaarStatus, OrderStatus, Role, ScheduleType } from '@prisma/client';
import * as request from 'supertest';

import { AppModule } from '../../app.module';
import { PrismaService } from '../../infra/prisma/prisma.service';

// specs/admin-module-spec.md §4.5, §4.6, §8 — overview counts, audit-log read, guards.
describe('AdminModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminToken: string;
  let vendorToken: string;
  let adminId: string;
  let vendorId: string;
  let organizerId: string;
  let productId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    const jwtService = app.get(JwtService);

    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    await prisma.orderGroup.deleteMany();
    await prisma.productVariant.deleteMany();
    await prisma.product.deleteMany();
    await prisma.boothListing.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.adminAuditLog.deleteMany();
    await prisma.user.deleteMany();

    const admin = await prisma.user.create({
      data: { email: 'admin-admin@example.com', passwordHash: 'hash', name: 'Admin', role: Role.ADMIN },
    });
    adminId = admin.id;
    adminToken = await jwtService.signAsync({ sub: admin.id, role: Role.ADMIN });

    // One vendor (pending), one organizer (pending), one shopper — via the real registration routes.
    const vendorRes = await request(app.getHttpServer())
      .post('/auth/register/vendor')
      .send({ email: 'admin-vendor@example.com', password: 'Password123!', name: 'V', businessName: 'V Shop', category: 'FASHION', vendorType: 'MARKETPLACE' });
    expect(vendorRes.status).toBe(201);
    vendorToken = vendorRes.body.accessToken;
    vendorId = (await prisma.vendor.findFirstOrThrow({ where: { owner: { email: 'admin-vendor@example.com' } } })).id;

    const orgRes = await request(app.getHttpServer())
      .post('/auth/register/organizer')
      .send({ email: 'admin-org@example.com', password: 'Password123!', name: 'O', organizationName: 'O Events' });
    expect(orgRes.status).toBe(201);
    organizerId = (await prisma.organizer.findFirstOrThrow({ where: { owner: { email: 'admin-org@example.com' } } })).id;

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'admin-shopper@example.com', password: 'Password123!', name: 'S', role: 'SHOPPER' })
      .expect(201);

    // A product (no approval gate to be "pending" on) and a published bazaar, seeded directly (the vendor is unverified, so it cannot create one via its own route).
    const category = await prisma.category.upsert({
      where: { slug: 'admin-e2e-cat' },
      update: {},
      create: { name: 'Admin E2E', slug: 'admin-e2e-cat' },
    });
    const product = await prisma.product.create({
      data: { vendorId, title: 'P', description: 'D', categoryId: category.id, basePrice: 10, images: [] },
    });
    productId = product.id;

    await prisma.$executeRaw`
      INSERT INTO "bazaars" ("id", "organizerId", "name", "scheduleType", "startDate", "status", "location", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${organizerId}, 'B', ${ScheduleType.ONE_OFF}::"ScheduleType", NOW(), ${BazaarStatus.PUBLISHED}::"BazaarStatus",
              ST_SetSRID(ST_MakePoint(31.2, 30.0), 4326)::geography, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    await prisma.orderGroup.deleteMany();
    await prisma.productVariant.deleteMany();
    await prisma.product.deleteMany();
    await prisma.boothListing.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.adminAuditLog.deleteMany();
    await prisma.user.deleteMany();
    await app.close();
  });

  describe('guards', () => {
    it('GET /admin/overview → 401 without a token', () => {
      return request(app.getHttpServer()).get('/admin/overview').expect(401);
    });

    it('GET /admin/overview → 403 for a VENDOR token', () => {
      return request(app.getHttpServer())
        .get('/admin/overview')
        .set('Authorization', `Bearer ${vendorToken}`)
        .expect(403);
    });

    it('GET /admin/audit-log → 403 for a VENDOR token', () => {
      return request(app.getHttpServer())
        .get('/admin/audit-log')
        .set('Authorization', `Bearer ${vendorToken}`)
        .expect(403);
    });
  });

  describe('GET /admin/overview', () => {
    it('reflects the seeded rows and contains every enum key, absent ones as 0', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/overview')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.pending).toEqual({ vendors: 1, organizers: 1 });
      expect(res.body.users).toEqual({ SHOPPER: 1, VENDOR: 1, ORGANIZER: 1, ADMIN: 1 });
      expect(Object.keys(res.body.orders).sort()).toEqual(Object.values(OrderStatus).sort());
      expect(Object.values(res.body.orders).every((n) => n === 0)).toBe(true);
      expect(res.body.bazaars).toEqual({ DRAFT: 0, PUBLISHED: 1, CANCELLED: 0, COMPLETED: 0 });
    });

    it('pending counts move after moderation decisions', async () => {
      await request(app.getHttpServer())
        .patch(`/admin/vendors/${vendorId}/verify`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/admin/organizers/${organizerId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'No venue contract' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/admin/products/${productId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'P edited' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/admin/overview')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // A rejected organizer is not pending: pending means "no decision yet".
      expect(res.body.pending).toEqual({ vendors: 0, organizers: 0 });
    });
  });

  describe('GET /admin/audit-log', () => {
    it('lists the three rows just written, newest first, with the actor embedded', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/audit-log')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.meta.total).toBe(3);
      expect(res.body.data.map((r: any) => r.action)).toEqual(['PRODUCT_EDITED', 'ORGANIZER_REJECTED', 'VENDOR_VERIFIED']);
      expect(res.body.data[1]).toMatchObject({
        targetType: 'ORGANIZER',
        targetId: organizerId,
        reason: 'No venue contract',
        actor: { id: adminId, name: 'Admin', email: 'admin-admin@example.com' },
      });
    });

    it('filters by targetType, action and actorId', async () => {
      const byType = await request(app.getHttpServer())
        .get('/admin/audit-log?targetType=VENDOR')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(byType.body.data).toHaveLength(1);
      expect(byType.body.data[0].targetId).toBe(vendorId);

      const byAction = await request(app.getHttpServer())
        .get('/admin/audit-log?action=PRODUCT_EDITED')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(byAction.body.data).toHaveLength(1);
      expect(byAction.body.data[0].targetId).toBe(productId);

      const byActor = await request(app.getHttpServer())
        .get(`/admin/audit-log?actorId=${adminId}&limit=2`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(byActor.body.data).toHaveLength(2);
      expect(byActor.body.meta).toEqual({ total: 3, page: 1, limit: 2, totalPages: 2 });
    });

    it('rejects an unknown action or a non-UUID actorId', async () => {
      await request(app.getHttpServer())
        .get('/admin/audit-log?action=SOMETHING_ELSE')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
      await request(app.getHttpServer())
        .get('/admin/audit-log?actorId=not-a-uuid')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });
  });
});
