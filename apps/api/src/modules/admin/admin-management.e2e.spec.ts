import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { BazaarStatus, Role, ScheduleType } from '@prisma/client';
import * as request from 'supertest';

import { AppModule } from '../../app.module';
import { PrismaService } from '../../infra/prisma/prisma.service';

// specs/admin-module-spec2.md — admin reads across domains, category management.
// Every route gets the same auth matrix: ADMIN 200, other roles 403, no token 401.
describe('Admin management — pass 2 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const tokens: Record<'admin' | 'vendor' | 'organizer' | 'shopper', string> = {
    admin: '',
    vendor: '',
    organizer: '',
    shopper: '',
  };
  let vendorId: string;
  let productId: string;
  let productCategoryId: string;
  let organizerId: string;
  let otherOrganizerToken: string;
  let draftBazaarId: string;
  let publishedBazaarId: string;
  let deletedBazaarId: string;
  let pendingApplicationId: string;
  let rejectedApplicationId: string;
  let shopperId: string;
  let otherShopperToken: string;
  let paidOrderId: string;
  let paidOrderGroupId: string;
  let cancelledOrderId: string;
  let otherShopperId: string;
  let lowCommentedRatingId: string;
  let highSilentRatingId: string;
  let emptyCommentRatingId: string;

  async function wipe() {
    await prisma.rating.deleteMany(); // Rating.orderId is RESTRICT: before orders
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    await prisma.orderGroup.deleteMany();
    await prisma.cartItem.deleteMany();
    await prisma.cart.deleteMany(); // Cart.userId is RESTRICT: before users
    await prisma.productVariant.deleteMany();
    await prisma.product.deleteMany();
    // Only this suite's categories (A7 creates some); other suites upsert their own.
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'mgmt-' } } });
    await prisma.booth.deleteMany();
    await prisma.boothListing.deleteMany();
    await prisma.boothLayout.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.adminAuditLog.deleteMany();
    await prisma.user.deleteMany();
  }

  async function register(path: string, body: Record<string, unknown>): Promise<string> {
    const res = await request(app.getHttpServer()).post(path).send({ password: 'Password123!', name: 'X', ...body });
    expect(res.status).toBe(201);
    return res.body.accessToken;
  }

  /** ADMIN → expected status; VENDOR / ORGANIZER / SHOPPER → 403; no token → 401. */
  function authMatrix(method: 'get' | 'post' | 'patch' | 'delete', path: () => string) {
    it(`${method.toUpperCase()} → 401 without a token`, () => {
      return request(app.getHttpServer())[method](path()).expect(401);
    });

    for (const role of ['vendor', 'organizer', 'shopper'] as const) {
      it(`${method.toUpperCase()} → 403 for a ${role.toUpperCase()} token`, () => {
        return request(app.getHttpServer())[method](path()).set('Authorization', `Bearer ${tokens[role]}`).expect(403);
      });
    }
  }

  /** Raw insert: Prisma Client can't write the geography column. */
  async function insertBazaar(name: string, status: BazaarStatus, deletedAt: Date | null = null): Promise<string> {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "bazaars" ("id", "organizerId", "name", "scheduleType", "startDate", "status", "location", "createdAt", "updatedAt", "deletedAt")
      VALUES (gen_random_uuid(), ${organizerId}, ${name}, ${ScheduleType.ONE_OFF}::"ScheduleType", NOW(), ${status}::"BazaarStatus",
              ST_SetSRID(ST_MakePoint(31.2, 30.05), 4326)::geography, NOW(), NOW(), ${deletedAt})
      RETURNING "id"
    `;
    return rows[0].id;
  }

  function asAdmin(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
    return request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${tokens.admin}`);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    await wipe();

    const admin = await prisma.user.create({
      data: { email: 'mgmt-admin@example.com', passwordHash: 'hash', name: 'Admin', role: Role.ADMIN },
    });
    tokens.admin = await app.get(JwtService).signAsync({ sub: admin.id, role: Role.ADMIN });

    tokens.vendor = await register('/auth/register/vendor', {
      email: 'mgmt-vendor@example.com',
      businessName: 'Mgmt Shop',
      category: 'FASHION',
      vendorType: 'MARKETPLACE',
    });
    tokens.organizer = await register('/auth/register/organizer', {
      email: 'mgmt-org@example.com',
      organizationName: 'Mgmt Events',
    });
    // Shopper registration returns the user, not a token pair — sign one like the admin's.
    const shopperRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'mgmt-shopper@example.com', password: 'Password123!', name: 'S', role: 'SHOPPER' })
      .expect(201);
    shopperId = shopperRes.body.id;
    tokens.shopper = await app.get(JwtService).signAsync({ sub: shopperId, role: Role.SHOPPER });

    // A second shopper, only to prove the shopper route still hides the first one's orders.
    const otherShopper = await prisma.user.create({
      data: { email: 'mgmt-shopper2@example.com', passwordHash: 'hash', name: 'S2', role: Role.SHOPPER },
    });
    otherShopperId = otherShopper.id;
    otherShopperToken = await app.get(JwtService).signAsync({ sub: otherShopper.id, role: Role.SHOPPER });

    otherOrganizerToken = await register('/auth/register/organizer', {
      email: 'mgmt-org2@example.com',
      organizationName: 'Other Events',
    });
    organizerId = (await prisma.organizer.findFirstOrThrow({ where: { owner: { email: 'mgmt-org@example.com' } } })).id;

    vendorId = (await prisma.vendor.findFirstOrThrow({ where: { owner: { email: 'mgmt-vendor@example.com' } } })).id;

    // Unverified vendor → a PENDING, inactive product with a soft-deleted variant: invisible on every public route.
    const category = await prisma.category.upsert({
      where: { slug: 'mgmt-e2e-cat' },
      update: {},
      create: { name: 'Mgmt E2E', slug: 'mgmt-e2e-cat' },
    });
    productCategoryId = category.id;
    const product = await prisma.product.create({
      data: {
        vendorId,
        title: 'Hidden',
        description: 'D',
        categoryId: category.id,
        basePrice: 10,
        images: [],
        isActive: false,
        variants: {
          create: [
            { sku: 'MGMT-A', size: 'M', stockQuantity: 3 },
            { sku: 'MGMT-B', size: 'L', stockQuantity: 0, deletedAt: new Date() },
          ],
        },
      },
    });
    productId = product.id;

    // Organizer X's bazaars: a DRAFT (owner-only everywhere else), a PUBLISHED one with a
    // pending application, and a soft-deleted one.
    draftBazaarId = await insertBazaar('Mgmt Draft Souq', BazaarStatus.DRAFT);
    publishedBazaarId = await insertBazaar('Mgmt Live Souq', BazaarStatus.PUBLISHED);
    deletedBazaarId = await insertBazaar('Mgmt Gone Souq', BazaarStatus.CANCELLED, new Date());
    pendingApplicationId = (await prisma.boothListing.create({ data: { bazaarId: publishedBazaarId, vendorId } })).id;
    // Older and already decided, on the soft-deleted bazaar (the A3 draft-bazaar
    // counts stay at zero): ordering and the status filter need a second row.
    rejectedApplicationId = (
      await prisma.boothListing.create({
        data: {
          bazaarId: deletedBazaarId,
          vendorId,
          applicationStatus: 'REJECTED',
          appliedAt: new Date(Date.now() - 86_400_000),
          decidedAt: new Date(),
        },
      })
    ).id;

    // Two order groups for the shopper at the one vendor: a PAID one with a Paymob
    // record, and an older CANCELLED one. Seeded directly — checkout needs Paymob.
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'MGMT-A' } });
    const paidGroup = await prisma.orderGroup.create({
      data: {
        userId: shopperId,
        paymobOrderId: 'pm-order-1',
        paymobIntentId: 'pm-intent-1',
        paymobTransactionId: 'pm-txn-1',
        paidAmountCents: 2000,
        paidAt: new Date(),
      },
    });
    paidOrderGroupId = paidGroup.id;
    paidOrderId = (
      await prisma.order.create({
        data: {
          orderGroupId: paidGroup.id,
          vendorId,
          userId: shopperId,
          status: 'PAID',
          subtotal: 20,
          items: {
            create: [{ productId, variantId: variant.id, titleSnapshot: 'Hidden', priceSnapshot: 10, quantity: 2 }],
          },
        },
      })
    ).id;
    const cancelledGroup = await prisma.orderGroup.create({ data: { userId: shopperId } });
    cancelledOrderId = (
      await prisma.order.create({
        data: {
          orderGroupId: cancelledGroup.id,
          vendorId,
          userId: shopperId,
          status: 'CANCELLED',
          subtotal: 10,
          createdAt: new Date(Date.now() - 86_400_000),
        },
      })
    ).id;

    // Three ratings, newest first: a 1-star with a comment (the moderation target),
    // a silent 5-star, and a 2-star whose comment is '' — which must count as none.
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    lowCommentedRatingId = (
      await prisma.rating.create({
        data: {
          userId: shopperId,
          targetType: 'VENDOR',
          targetId: vendorId,
          score: 1,
          comment: 'Rude seller',
          orderId: paidOrderId,
          createdAt: minutesAgo(1),
        },
      })
    ).id;
    highSilentRatingId = (
      await prisma.rating.create({
        data: { userId: shopperId, targetType: 'PRODUCT', targetId: productId, score: 5, createdAt: minutesAgo(2) },
      })
    ).id;
    emptyCommentRatingId = (
      await prisma.rating.create({
        data: {
          userId: otherShopperId,
          targetType: 'BAZAAR',
          targetId: publishedBazaarId,
          score: 2,
          comment: '',
          createdAt: minutesAgo(3),
        },
      })
    ).id;
  });

  afterAll(async () => {
    await wipe();
    await app.close();
  });

  // --- A1 -------------------------------------------------------------------

  describe('GET /admin/vendors/:id', () => {
    authMatrix('get', () => `/admin/vendors/${vendorId}`);

    it('returns an unverified vendor that the public route hides', async () => {
      await request(app.getHttpServer()).get(`/vendors/${vendorId}`).expect(404);

      const res = await asAdmin('get', `/admin/vendors/${vendorId}`).expect(200);
      expect(res.body).toMatchObject({
        id: vendorId,
        verified: false,
        rejectionReason: null,
        deletedAt: null,
        location: null,
        owner: { email: 'mgmt-vendor@example.com', isActive: true },
        productCounts: { PENDING: 1, APPROVED: 0, REJECTED: 0 },
      });
      expect(res.body.owner).not.toHaveProperty('passwordHash');
    });

    it('still returns the vendor after it is soft-deleted', async () => {
      const deletedAt = new Date();
      await prisma.vendor.update({ where: { id: vendorId }, data: { deletedAt } });
      try {
        const res = await asAdmin('get', `/admin/vendors/${vendorId}`).expect(200);
        expect(res.body.deletedAt).toBe(deletedAt.toISOString());
      } finally {
        await prisma.vendor.update({ where: { id: vendorId }, data: { deletedAt: null } });
      }
    });

    it('404 VENDOR_NOT_FOUND for an unknown or malformed id', async () => {
      for (const id of ['00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
        const res = await asAdmin('get', `/admin/vendors/${id}`).expect(404);
        expect(res.body.code).toBe('VENDOR_NOT_FOUND');
      }
    });
  });

  // --- A2 -------------------------------------------------------------------

  describe('GET /admin/products/:id', () => {
    authMatrix('get', () => `/admin/products/${productId}`);

    it('returns a PENDING, inactive product with every variant, which the public route hides', async () => {
      await request(app.getHttpServer()).get(`/products/${productId}`).expect(404);

      const res = await asAdmin('get', `/admin/products/${productId}`).expect(200);
      expect(res.body).toMatchObject({
        id: productId,
        approvalStatus: 'PENDING',
        isActive: false,
        deletedAt: null,
        vendor: { id: vendorId, verified: false },
        category: { slug: 'mgmt-e2e-cat' },
      });
      expect(res.body.variants.map((v: { sku: string }) => v.sku)).toEqual(['MGMT-A', 'MGMT-B']);
      expect(res.body.variants[1].deletedAt).not.toBeNull();
    });

    it('404 PRODUCT_NOT_FOUND for an unknown id', async () => {
      const res = await asAdmin('get', '/admin/products/00000000-0000-0000-0000-000000000000').expect(404);
      expect(res.body.code).toBe('PRODUCT_NOT_FOUND');
    });
  });

  // --- A3 -------------------------------------------------------------------

  describe('GET /admin/bazaars', () => {
    authMatrix('get', () => '/admin/bazaars');

    it('lists every bazaar of every organizer, DRAFT included, soft-deleted excluded by default', async () => {
      const res = await asAdmin('get', '/admin/bazaars').expect(200);
      const ids = res.body.data.map((b: { id: string }) => b.id);
      expect(ids).toEqual(expect.arrayContaining([draftBazaarId, publishedBazaarId]));
      expect(ids).not.toContain(deletedBazaarId);
      expect(res.body.meta).toEqual({ total: 2, page: 1, limit: 20, totalPages: 1 });

      const draft = res.body.data.find((b: { id: string }) => b.id === draftBazaarId);
      expect(draft).toMatchObject({
        status: 'DRAFT',
        organizer: { id: organizerId, name: 'Mgmt Events', verified: false },
        location: { lat: 30.05, lng: 31.2 },
      });
    });

    it('filters by status, organizerId, search and includeDeleted', async () => {
      const byStatus = await asAdmin('get', '/admin/bazaars?status=DRAFT').expect(200);
      expect(byStatus.body.data.map((b: { id: string }) => b.id)).toEqual([draftBazaarId]);

      const bySearch = await asAdmin('get', '/admin/bazaars?search=live').expect(200);
      expect(bySearch.body.data.map((b: { id: string }) => b.id)).toEqual([publishedBazaarId]);

      const byOrganizer = await asAdmin('get', `/admin/bazaars?organizerId=${organizerId}&includeDeleted=true`).expect(200);
      expect(byOrganizer.body.meta.total).toBe(3);
      expect(byOrganizer.body.data.map((b: { id: string }) => b.id)).toContain(deletedBazaarId);
    });

    it('400 on an unknown status, a non-UUID organizerId, or an unlisted query field', async () => {
      await asAdmin('get', '/admin/bazaars?status=OPEN').expect(400);
      await asAdmin('get', '/admin/bazaars?organizerId=abc').expect(400);
      await asAdmin('get', '/admin/bazaars?owner=me').expect(400);
    });
  });

  describe('GET /admin/bazaars/:id', () => {
    authMatrix('get', () => `/admin/bazaars/${draftBazaarId}`);

    it('returns a DRAFT bazaar that the public route hides', async () => {
      await request(app.getHttpServer()).get(`/bazaars/${draftBazaarId}`).expect(404);

      const res = await asAdmin('get', `/admin/bazaars/${draftBazaarId}`).expect(200);
      expect(res.body).toMatchObject({
        id: draftBazaarId,
        status: 'DRAFT',
        organizer: { id: organizerId },
        location: { lat: 30.05, lng: 31.2 },
        applicationCounts: { PENDING: 0, ACCEPTED: 0, REJECTED: 0 },
        hasLayout: false,
      });
    });

    it('counts applications and returns soft-deleted bazaars', async () => {
      const live = await asAdmin('get', `/admin/bazaars/${publishedBazaarId}`).expect(200);
      expect(live.body.applicationCounts).toEqual({ PENDING: 1, ACCEPTED: 0, REJECTED: 0 });

      const gone = await asAdmin('get', `/admin/bazaars/${deletedBazaarId}`).expect(200);
      expect(gone.body.deletedAt).not.toBeNull();
    });

    it('does not shadow the booth-layout route under the same prefix', async () => {
      const res = await asAdmin('get', `/admin/bazaars/${draftBazaarId}/layout`);
      expect(res.body.code).not.toBe('BAZAAR_NOT_FOUND');
      expect(res.body).not.toHaveProperty('applicationCounts');
    });

    it('404 BAZAAR_NOT_FOUND for an unknown id', async () => {
      const res = await asAdmin('get', '/admin/bazaars/00000000-0000-0000-0000-000000000000').expect(404);
      expect(res.body.code).toBe('BAZAAR_NOT_FOUND');
    });

    it('ownership still holds on the organizer route: another organizer cannot read it', async () => {
      await request(app.getHttpServer())
        .get(`/organizers/me/bazaars/${draftBazaarId}`)
        .set('Authorization', `Bearer ${otherOrganizerToken}`)
        .expect((r) => expect([403, 404]).toContain(r.status));
    });
  });

  // --- A4 -------------------------------------------------------------------

  describe('GET /admin/applications', () => {
    authMatrix('get', () => '/admin/applications');

    it('lists applications across every bazaar, newest first, with both sides embedded', async () => {
      const res = await asAdmin('get', '/admin/applications').expect(200);

      expect(res.body.data.map((a: { id: string }) => a.id)).toEqual([pendingApplicationId, rejectedApplicationId]);
      expect(res.body.meta).toEqual({ total: 2, page: 1, limit: 20, totalPages: 1 });
      expect(res.body.data[0]).toMatchObject({
        applicationStatus: 'PENDING',
        decidedAt: null,
        bazaar: { id: publishedBazaarId, name: 'Mgmt Live Souq', status: 'PUBLISHED' },
        vendor: { id: vendorId, name: 'Mgmt Shop', verified: false },
        booth: null,
      });
    });

    it('filters by status, bazaarId and vendorId', async () => {
      const rejected = await asAdmin('get', '/admin/applications?status=REJECTED').expect(200);
      expect(rejected.body.data.map((a: { id: string }) => a.id)).toEqual([rejectedApplicationId]);

      const byBazaar = await asAdmin('get', `/admin/applications?bazaarId=${publishedBazaarId}`).expect(200);
      expect(byBazaar.body.data.map((a: { id: string }) => a.id)).toEqual([pendingApplicationId]);

      const byVendor = await asAdmin('get', `/admin/applications?vendorId=${vendorId}&limit=1`).expect(200);
      expect(byVendor.body.meta).toEqual({ total: 2, page: 1, limit: 1, totalPages: 2 });
    });

    it('400 on an unknown status, a non-UUID id filter, or an unlisted query field', async () => {
      await asAdmin('get', '/admin/applications?status=APPROVED').expect(400);
      await asAdmin('get', '/admin/applications?bazaarId=abc').expect(400);
      await asAdmin('get', '/admin/applications?organizerId=00000000-0000-0000-0000-000000000000').expect(400);
    });
  });

  describe('GET /admin/applications/:id', () => {
    authMatrix('get', () => `/admin/applications/${pendingApplicationId}`);

    it('returns one application, including one on a soft-deleted bazaar', async () => {
      const res = await asAdmin('get', `/admin/applications/${rejectedApplicationId}`).expect(200);
      expect(res.body).toMatchObject({
        id: rejectedApplicationId,
        applicationStatus: 'REJECTED',
        bazaar: { id: deletedBazaarId, status: 'CANCELLED' },
        vendor: { id: vendorId },
      });
      expect(res.body.decidedAt).not.toBeNull();
    });

    it('404 APPLICATION_NOT_FOUND for an unknown id', async () => {
      const res = await asAdmin('get', '/admin/applications/00000000-0000-0000-0000-000000000000').expect(404);
      expect(res.body.code).toBe('APPLICATION_NOT_FOUND');
    });

    it('ownership still holds on the organizer route: another organizer cannot list these applications', async () => {
      await request(app.getHttpServer())
        .get(`/organizers/me/bazaars/${publishedBazaarId}/applications`)
        .set('Authorization', `Bearer ${otherOrganizerToken}`)
        .expect((r) => expect([403, 404]).toContain(r.status));
    });
  });

  // --- A5 -------------------------------------------------------------------

  describe('GET /admin/orders', () => {
    authMatrix('get', () => '/admin/orders');

    it('lists every order, newest first, with both parties and no items', async () => {
      const res = await asAdmin('get', '/admin/orders').expect(200);

      expect(res.body.data.map((o: { id: string }) => o.id)).toEqual([paidOrderId, cancelledOrderId]);
      expect(res.body.meta).toEqual({ total: 2, page: 1, limit: 20, totalPages: 1 });
      expect(res.body.data[0]).toMatchObject({
        status: 'PAID',
        subtotal: '20',
        vendor: { id: vendorId, name: 'Mgmt Shop' },
        user: { id: shopperId, email: 'mgmt-shopper@example.com' },
      });
      expect(res.body.data[0]).not.toHaveProperty('items');
      expect(res.body.data[0]).not.toHaveProperty('orderGroup');
      expect(res.body.data[0].user).not.toHaveProperty('passwordHash');
    });

    it('filters by status, vendorId, userId and orderGroupId', async () => {
      const cancelled = await asAdmin('get', '/admin/orders?status=CANCELLED').expect(200);
      expect(cancelled.body.data.map((o: { id: string }) => o.id)).toEqual([cancelledOrderId]);

      const byGroup = await asAdmin('get', `/admin/orders?orderGroupId=${paidOrderGroupId}`).expect(200);
      expect(byGroup.body.data.map((o: { id: string }) => o.id)).toEqual([paidOrderId]);

      const byParties = await asAdmin('get', `/admin/orders?vendorId=${vendorId}&userId=${shopperId}&limit=1`).expect(200);
      expect(byParties.body.meta).toEqual({ total: 2, page: 1, limit: 1, totalPages: 2 });
    });

    it('400 on an unknown status, a non-UUID id filter, or an unlisted query field', async () => {
      await asAdmin('get', '/admin/orders?status=REFUNDED').expect(400);
      await asAdmin('get', '/admin/orders?userId=abc').expect(400);
      await asAdmin('get', '/admin/orders?bazaarId=00000000-0000-0000-0000-000000000000').expect(400);
    });
  });

  describe('GET /admin/orders/:id', () => {
    authMatrix('get', () => `/admin/orders/${paidOrderId}`);

    it('returns items and the payment record, which only this admin route exposes', async () => {
      const res = await asAdmin('get', `/admin/orders/${paidOrderId}`).expect(200);
      expect(res.body).toMatchObject({
        id: paidOrderId,
        status: 'PAID',
        vendor: { id: vendorId },
        user: { id: shopperId },
        orderGroup: {
          id: paidOrderGroupId,
          paidAmountCents: 2000,
          paymobOrderId: 'pm-order-1',
          paymobIntentId: 'pm-intent-1',
          paymobTransactionId: 'pm-txn-1',
        },
      });
      expect(res.body.items).toEqual([
        expect.objectContaining({ productId, titleSnapshot: 'Hidden', priceSnapshot: '10', quantity: 2 }),
      ]);
    });

    it('the shopper route still does not expose the payment record', async () => {
      const res = await request(app.getHttpServer())
        .get(`/orders/${paidOrderId}`)
        .set('Authorization', `Bearer ${tokens.shopper}`)
        .expect(200);
      expect(res.body).not.toHaveProperty('orderGroup');
    });

    it('404 ORDER_NOT_FOUND for an unknown id', async () => {
      const res = await asAdmin('get', '/admin/orders/00000000-0000-0000-0000-000000000000').expect(404);
      expect(res.body.code).toBe('ORDER_NOT_FOUND');
    });

    it('ownership still holds on the shopper route: another shopper cannot read it', async () => {
      const res = await request(app.getHttpServer())
        .get(`/orders/${paidOrderId}`)
        .set('Authorization', `Bearer ${otherShopperToken}`)
        .expect(404);
      expect(res.body.code).toBe('ORDER_NOT_FOUND');
    });
  });

  // --- A6 -------------------------------------------------------------------

  describe('GET /admin/ratings', () => {
    authMatrix('get', () => '/admin/ratings');

    const ids = (res: request.Response) => res.body.data.map((r: { id: string }) => r.id);

    it('lists every rating newest first, with the reviewer the public list hides', async () => {
      const res = await asAdmin('get', '/admin/ratings').expect(200);

      expect(ids(res)).toEqual([lowCommentedRatingId, highSilentRatingId, emptyCommentRatingId]);
      expect(res.body.meta).toEqual({ total: 3, page: 1, limit: 20, totalPages: 1 });
      expect(res.body.data[0]).toMatchObject({
        targetType: 'VENDOR',
        targetId: vendorId,
        score: 1,
        comment: 'Rude seller',
        orderId: paidOrderId,
        user: { id: shopperId, email: 'mgmt-shopper@example.com', isActive: true },
      });
      expect(res.body.data[0].user).not.toHaveProperty('passwordHash');
    });

    it('hasComment treats an empty comment as none; maxScore is inclusive; filters combine', async () => {
      expect(ids(await asAdmin('get', '/admin/ratings?hasComment=true').expect(200))).toEqual([lowCommentedRatingId]);
      expect(ids(await asAdmin('get', '/admin/ratings?hasComment=false').expect(200))).toEqual([
        highSilentRatingId,
        emptyCommentRatingId,
      ]);
      expect(ids(await asAdmin('get', '/admin/ratings?maxScore=2').expect(200))).toEqual([
        lowCommentedRatingId,
        emptyCommentRatingId,
      ]);
      expect(ids(await asAdmin('get', '/admin/ratings?hasComment=true&maxScore=2').expect(200))).toEqual([
        lowCommentedRatingId,
      ]);
    });

    it('filters by targetType, targetId and userId', async () => {
      expect(ids(await asAdmin('get', '/admin/ratings?targetType=PRODUCT').expect(200))).toEqual([highSilentRatingId]);
      expect(ids(await asAdmin('get', `/admin/ratings?targetId=${vendorId}`).expect(200))).toEqual([lowCommentedRatingId]);
      expect(ids(await asAdmin('get', `/admin/ratings?userId=${otherShopperId}`).expect(200))).toEqual([
        emptyCommentRatingId,
      ]);
    });

    it('400 on out-of-range score, non-boolean hasComment, bad enum, non-UUID, or an unlisted field', async () => {
      for (const query of ['maxScore=0', 'maxScore=6', 'hasComment=yes', 'targetType=SHOP', 'userId=abc', 'cursor=x']) {
        await asAdmin('get', `/admin/ratings?${query}`).expect(400);
      }
    });

    it('the public ratings list still shows only the reviewer name', async () => {
      const res = await request(app.getHttpServer())
        .get(`/social/ratings?targetType=VENDOR&targetId=${vendorId}`)
        .expect(200);
      expect(res.body.data[0]).toMatchObject({ id: lowCommentedRatingId, reviewerName: 'S' });
      expect(res.body.data[0]).not.toHaveProperty('user');
      expect(JSON.stringify(res.body)).not.toContain('mgmt-shopper@example.com');
    });
  });

  // --- A7 -------------------------------------------------------------------
  // The first admin writes in this suite: every successful change must leave an
  // audit row, and every rejected or no-op one must leave none.

  describe('/admin/categories', () => {
    let rootId: string;
    let childId: string;

    const auditRows = (action: 'CATEGORY_CREATED' | 'CATEGORY_UPDATED', targetId: string) =>
      prisma.adminAuditLog.findMany({ where: { action, targetType: 'CATEGORY', targetId } });

    describe('guards', () => {
      authMatrix('get', () => '/admin/categories');
      authMatrix('post', () => '/admin/categories');
      authMatrix('patch', () => `/admin/categories/${productCategoryId}`);
    });

    it('GET lists categories flat, with non-deleted product and child counts', async () => {
      const res = await asAdmin('get', '/admin/categories').expect(200);
      const cat = res.body.find((c: { id: string }) => c.id === productCategoryId);
      expect(cat).toEqual({
        id: productCategoryId,
        name: 'Mgmt E2E',
        slug: 'mgmt-e2e-cat',
        parentId: null,
        productCount: 1,
        childCount: 0,
      });
    });

    it('POST creates a root (name trimmed) and a child, each audited with the admin as actor', async () => {
      const root = await asAdmin('post', '/admin/categories').send({ name: '  Mgmt Root  ', slug: 'mgmt-root' }).expect(201);
      expect(root.body).toMatchObject({ name: 'Mgmt Root', slug: 'mgmt-root', parentId: null });
      rootId = root.body.id;

      const child = await asAdmin('post', '/admin/categories')
        .send({ name: 'Mgmt Child', slug: 'mgmt-child', parentId: rootId })
        .expect(201);
      expect(child.body.parentId).toBe(rootId);
      childId = child.body.id;

      const [row] = await auditRows('CATEGORY_CREATED', rootId);
      expect(row).toMatchObject({ targetType: 'CATEGORY', targetId: rootId });
      const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'mgmt-admin@example.com' } });
      expect(row.actorId).toBe(admin.id);
      expect(await auditRows('CATEGORY_CREATED', childId)).toHaveLength(1);

      // The public tree picks the child up under its root.
      const tree = await request(app.getHttpServer()).get('/categories').expect(200);
      const publicRoot = tree.body.find((n: { id: string }) => n.id === rootId);
      expect(publicRoot.children.map((n: { slug: string }) => n.slug)).toEqual(['mgmt-child']);
    });

    it('POST rejects a duplicate slug (409), a bad slug or unknown field (400), an unknown parent (404) — auditing none', async () => {
      const before = await prisma.adminAuditLog.count();

      const dup = await asAdmin('post', '/admin/categories').send({ name: 'Again', slug: 'mgmt-root' }).expect(409);
      expect(dup.body.code).toBe('CATEGORY_SLUG_TAKEN');

      for (const slug of ['Mgmt Bad', 'mgmt--double', '-mgmt', 'mgmt_under']) {
        await asAdmin('post', '/admin/categories').send({ name: 'Bad', slug }).expect(400);
      }
      await asAdmin('post', '/admin/categories').send({ name: '   ', slug: 'mgmt-blank' }).expect(400);
      await asAdmin('post', '/admin/categories').send({ name: 'X', slug: 'mgmt-x', icon: 'star' }).expect(400);

      const orphan = await asAdmin('post', '/admin/categories')
        .send({ name: 'Orphan', slug: 'mgmt-orphan', parentId: '00000000-0000-0000-0000-000000000000' })
        .expect(404);
      expect(orphan.body.code).toBe('CATEGORY_PARENT_NOT_FOUND');

      expect(await prisma.adminAuditLog.count()).toBe(before);
    });

    it('PATCH refuses cycles (itself or a descendant), empty bodies and unknown ids', async () => {
      for (const parentId of [rootId, childId]) {
        const res = await asAdmin('patch', `/admin/categories/${rootId}`).send({ parentId }).expect(400);
        expect(res.body.code).toBe('CATEGORY_CYCLE');
      }

      const empty = await asAdmin('patch', `/admin/categories/${rootId}`).send({}).expect(400);
      expect(empty.body.code).toBe('CATEGORY_UPDATE_EMPTY');

      const missing = await asAdmin('patch', '/admin/categories/00000000-0000-0000-0000-000000000000')
        .send({ name: 'X' })
        .expect(404);
      expect(missing.body.code).toBe('CATEGORY_NOT_FOUND');

      const dup = await asAdmin('patch', `/admin/categories/${childId}`).send({ slug: 'mgmt-root' }).expect(409);
      expect(dup.body.code).toBe('CATEGORY_SLUG_TAKEN');

      expect(await auditRows('CATEGORY_UPDATED', rootId)).toHaveLength(0);
    });

    it('PATCH renames and re-slugs (audited); an identical PATCH is a no-op that audits nothing', async () => {
      const renamed = await asAdmin('patch', `/admin/categories/${childId}`)
        .send({ name: 'Mgmt Kid', slug: 'mgmt-kid' })
        .expect(200);
      expect(renamed.body).toMatchObject({ id: childId, name: 'Mgmt Kid', slug: 'mgmt-kid', parentId: rootId });
      expect(await auditRows('CATEGORY_UPDATED', childId)).toHaveLength(1);

      await asAdmin('patch', `/admin/categories/${childId}`).send({ name: 'Mgmt Kid', slug: 'mgmt-kid' }).expect(200);
      expect(await auditRows('CATEGORY_UPDATED', childId)).toHaveLength(1);
    });

    it('PATCH moves a category with products under a parent and back to the root', async () => {
      const moved = await asAdmin('patch', `/admin/categories/${productCategoryId}`).send({ parentId: rootId }).expect(200);
      expect(moved.body.parentId).toBe(rootId);

      const counts = await asAdmin('get', '/admin/categories').expect(200);
      expect(counts.body.find((c: { id: string }) => c.id === rootId).childCount).toBe(2);

      const back = await asAdmin('patch', `/admin/categories/${productCategoryId}`).send({ parentId: null }).expect(200);
      expect(back.body.parentId).toBeNull();
      expect(await auditRows('CATEGORY_UPDATED', productCategoryId)).toHaveLength(2);
    });
  });

  // ===========================================================================
  // Part B — specs/admin-module-spec3.md
  // ===========================================================================

  /** Audit rows for one action on one target, straight from the table. */
  const auditFor = (action: string, targetId: string) =>
    prisma.adminAuditLog.findMany({ where: { action: action as never, targetId } });

  // --- B2 -------------------------------------------------------------------

  describe('PATCH /admin/vendors/:id (B2)', () => {
    authMatrix('patch', () => `/admin/vendors/${vendorId}`);

    it('edits text/images of a VERIFIED vendor without touching verification; repeat = no audit', async () => {
      await prisma.vendor.update({ where: { id: vendorId }, data: { verified: true } });
      try {
        const res = await asAdmin('patch', `/admin/vendors/${vendorId}`)
          .send({ businessName: 'Mgmt Shop Renamed', brandStory: 'Handmade since 2020' })
          .expect(200);
        expect(res.body).toMatchObject({ id: vendorId, name: 'Mgmt Shop Renamed', brandStory: 'Handmade since 2020', verified: true });
        expect(await auditFor('VENDOR_EDITED', vendorId)).toHaveLength(1);

        await asAdmin('patch', `/admin/vendors/${vendorId}`).send({ businessName: 'Mgmt Shop Renamed' }).expect(200);
        expect(await auditFor('VENDOR_EDITED', vendorId)).toHaveLength(1);
      } finally {
        await prisma.vendor.update({ where: { id: vendorId }, data: { verified: false, name: 'Mgmt Shop', brandStory: null } });
      }
    });

    it('400 on fields outside the text/image scope (category, verified, vendorType)', async () => {
      for (const body of [{ category: 'FOOD' }, { verified: true }, { vendorType: 'BOTH' }]) {
        await asAdmin('patch', `/admin/vendors/${vendorId}`).send(body).expect(400);
      }
    });

    it('404 VENDOR_NOT_FOUND for an unknown vendor', async () => {
      const res = await asAdmin('patch', '/admin/vendors/00000000-0000-0000-0000-000000000000')
        .send({ description: 'x' })
        .expect(404);
      expect(res.body.code).toBe('VENDOR_NOT_FOUND');
    });
  });

  describe('PATCH /admin/products/:id (B2)', () => {
    authMatrix('patch', () => `/admin/products/${productId}`);

    it('edits an APPROVED product and it stays APPROVED (no re-review); repeat = no audit', async () => {
      await prisma.product.update({ where: { id: productId }, data: { approvalStatus: 'APPROVED' } });
      try {
        const res = await asAdmin('patch', `/admin/products/${productId}`)
          .send({ title: 'Hidden (fixed typo)', images: ['https://cdn.example.com/p.jpg'] })
          .expect(200);
        expect(res.body).toMatchObject({
          id: productId,
          title: 'Hidden (fixed typo)',
          images: ['https://cdn.example.com/p.jpg'],
          approvalStatus: 'APPROVED',
        });
        expect(await auditFor('PRODUCT_EDITED', productId)).toHaveLength(1);

        await asAdmin('patch', `/admin/products/${productId}`).send({ title: 'Hidden (fixed typo)' }).expect(200);
        expect(await auditFor('PRODUCT_EDITED', productId)).toHaveLength(1);
      } finally {
        await prisma.product.update({ where: { id: productId }, data: { approvalStatus: 'PENDING', title: 'Hidden', images: [] } });
      }
    });

    it('400 on fields outside the text/image scope (price, category, isActive, approvalStatus)', async () => {
      for (const body of [{ basePrice: 1 }, { categoryId: productCategoryId }, { isActive: true }, { approvalStatus: 'APPROVED' }]) {
        await asAdmin('patch', `/admin/products/${productId}`).send(body).expect(400);
      }
    });

    it('404 PRODUCT_NOT_FOUND for an unknown product', async () => {
      const res = await asAdmin('patch', '/admin/products/00000000-0000-0000-0000-000000000000')
        .send({ title: 'x' })
        .expect(404);
      expect(res.body.code).toBe('PRODUCT_NOT_FOUND');
    });

    it('the owner route is unchanged: a vendor edit still resets the product to PENDING', async () => {
      // Owner routes need a verified vendor; flip it for this check only.
      await prisma.vendor.update({ where: { id: vendorId }, data: { verified: true } });
      await prisma.product.update({ where: { id: productId }, data: { approvalStatus: 'APPROVED', isActive: true } });
      try {
        await request(app.getHttpServer())
          .patch(`/vendors/me/products/${productId}`)
          .set('Authorization', `Bearer ${tokens.vendor}`)
          .send({ description: 'vendor edit' })
          .expect(200);
        const row = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
        expect(row.approvalStatus).toBe('PENDING');
      } finally {
        await prisma.vendor.update({ where: { id: vendorId }, data: { verified: false } });
        await prisma.product.update({ where: { id: productId }, data: { description: 'D', isActive: false } });
      }
    });
  });

  // --- B3 -------------------------------------------------------------------

  describe('DELETE /admin/products/:id (B3a)', () => {
    authMatrix('delete', () => `/admin/products/${productId}`);

    it('soft-deletes (row kept, cart line kept), audits once; repeat is a no-op', async () => {
      const variant = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'MGMT-A' } });
      const cart = await prisma.cart.create({ data: { userId: shopperId } });
      const line = await prisma.cartItem.create({ data: { cartId: cart.id, productId, variantId: variant.id, quantity: 1 } });
      try {
        await asAdmin('delete', `/admin/products/${productId}`).expect(204);

        const row = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
        expect(row.deletedAt).not.toBeNull();
        // Decided behaviour: carts are not touched; checkout refuses the line (PUBLIC_PRODUCT_WHERE).
        expect(await prisma.cartItem.findUnique({ where: { id: line.id } })).not.toBeNull();
        expect(await auditFor('PRODUCT_DELETED', productId)).toHaveLength(1);

        await asAdmin('delete', `/admin/products/${productId}`).expect(204);
        expect(await auditFor('PRODUCT_DELETED', productId)).toHaveLength(1);

        const edit = await asAdmin('patch', `/admin/products/${productId}`).send({ title: 'x' }).expect(404);
        expect(edit.body.code).toBe('PRODUCT_NOT_FOUND');
      } finally {
        await prisma.cartItem.delete({ where: { id: line.id } });
        await prisma.cart.delete({ where: { id: cart.id } });
        await prisma.product.update({ where: { id: productId }, data: { deletedAt: null } });
      }
    });

    it('404 PRODUCT_NOT_FOUND for an unknown product', async () => {
      const res = await asAdmin('delete', '/admin/products/00000000-0000-0000-0000-000000000000').expect(404);
      expect(res.body.code).toBe('PRODUCT_NOT_FOUND');
    });
  });

  describe('DELETE /admin/categories/:id (B3b)', () => {
    authMatrix('delete', () => `/admin/categories/${productCategoryId}`);

    it('409 CATEGORY_IN_USE while it has products — a soft-deleted product still counts', async () => {
      await prisma.product.update({ where: { id: productId }, data: { deletedAt: new Date() } });
      try {
        const res = await asAdmin('delete', `/admin/categories/${productCategoryId}`).expect(409);
        expect(res.body).toMatchObject({ code: 'CATEGORY_IN_USE', details: { productCount: 1, childCount: 0 } });
      } finally {
        await prisma.product.update({ where: { id: productId }, data: { deletedAt: null } });
      }
    });

    it('409 while it has sub-categories; deletes (204, audited) once empty', async () => {
      const parent = await prisma.category.create({ data: { name: 'Mgmt Parent', slug: 'mgmt-del-parent' } });
      const child = await prisma.category.create({ data: { name: 'Mgmt Child', slug: 'mgmt-del-child', parentId: parent.id } });

      const busy = await asAdmin('delete', `/admin/categories/${parent.id}`).expect(409);
      expect(busy.body.details).toEqual({ productCount: 0, childCount: 1 });

      await asAdmin('delete', `/admin/categories/${child.id}`).expect(204);
      await asAdmin('delete', `/admin/categories/${parent.id}`).expect(204);

      expect(await prisma.category.findUnique({ where: { id: parent.id } })).toBeNull();
      expect(await auditFor('CATEGORY_DELETED', parent.id)).toHaveLength(1);
      expect(await auditFor('CATEGORY_DELETED', child.id)).toHaveLength(1);
    });

    it('404 CATEGORY_NOT_FOUND for an unknown category', async () => {
      const res = await asAdmin('delete', '/admin/categories/00000000-0000-0000-0000-000000000000').expect(404);
      expect(res.body.code).toBe('CATEGORY_NOT_FOUND');
    });
  });

  describe('admin rating moderation (B3c)', () => {
    authMatrix('delete', () => `/admin/ratings/${highSilentRatingId}`);
    authMatrix('patch', () => `/admin/ratings/${lowCommentedRatingId}/clear-comment`);

    it('clear-comment removes the text and keeps the score; repeat is a no-op', async () => {
      const res = await asAdmin('patch', `/admin/ratings/${lowCommentedRatingId}/clear-comment`).expect(200);
      expect(res.body).toMatchObject({ id: lowCommentedRatingId, score: 1, comment: null });
      expect(await auditFor('RATING_COMMENT_CLEARED', lowCommentedRatingId)).toHaveLength(1);

      await asAdmin('patch', `/admin/ratings/${lowCommentedRatingId}/clear-comment`).expect(200);
      expect(await auditFor('RATING_COMMENT_CLEARED', lowCommentedRatingId)).toHaveLength(1);
    });

    it('delete removes the rating entirely and audits it', async () => {
      await asAdmin('delete', `/admin/ratings/${highSilentRatingId}`).expect(204);
      expect(await prisma.rating.findUnique({ where: { id: highSilentRatingId } })).toBeNull();
      expect(await auditFor('RATING_DELETED', highSilentRatingId)).toHaveLength(1);

      const again = await asAdmin('delete', `/admin/ratings/${highSilentRatingId}`).expect(404);
      expect(again.body.code).toBe('RATING_NOT_FOUND');
    });
  });

  // --- B5 -------------------------------------------------------------------

  describe('admin decisions on applications (B5)', () => {
    authMatrix('patch', () => `/admin/applications/${pendingApplicationId}/accept`);
    authMatrix('patch', () => `/admin/applications/${pendingApplicationId}/reject`);

    it('accepts a PENDING application once; no reversal; repeat is a no-op', async () => {
      try {
        const res = await asAdmin('patch', `/admin/applications/${pendingApplicationId}/accept`).expect(200);
        expect(res.body).toMatchObject({ id: pendingApplicationId, applicationStatus: 'ACCEPTED' });
        expect(res.body.decidedAt).not.toBeNull();
        expect(await auditFor('APPLICATION_ACCEPTED', pendingApplicationId)).toHaveLength(1);

        await asAdmin('patch', `/admin/applications/${pendingApplicationId}/accept`).expect(200);
        expect(await auditFor('APPLICATION_ACCEPTED', pendingApplicationId)).toHaveLength(1);

        const reversal = await asAdmin('patch', `/admin/applications/${pendingApplicationId}/reject`).send({}).expect(400);
        expect(reversal.body.code).toBe('APPLICATION_NOT_PENDING');
      } finally {
        await prisma.boothListing.update({
          where: { id: pendingApplicationId },
          data: { applicationStatus: 'PENDING', decidedAt: null },
        });
      }
    });

    it('a REJECTED application cannot be accepted', async () => {
      const res = await asAdmin('patch', `/admin/applications/${rejectedApplicationId}/accept`).expect(400);
      expect(res.body.code).toBe('APPLICATION_NOT_PENDING');
      expect(await auditFor('APPLICATION_ACCEPTED', rejectedApplicationId)).toHaveLength(0);
    });

    it('rejects a PENDING application; the reason is kept in the audit log', async () => {
      const app2 = await prisma.boothListing.create({ data: { bazaarId: draftBazaarId, vendorId } });
      try {
        const res = await asAdmin('patch', `/admin/applications/${app2.id}/reject`)
          .send({ reason: 'Stall type not allowed at this bazaar' })
          .expect(200);
        expect(res.body.applicationStatus).toBe('REJECTED');
        const [row] = await auditFor('APPLICATION_REJECTED', app2.id);
        expect(row.reason).toBe('Stall type not allowed at this bazaar');
      } finally {
        await prisma.boothListing.delete({ where: { id: app2.id } });
      }
    });

    it('400 on an empty reason or unknown field; 404 on an unknown application', async () => {
      await asAdmin('patch', `/admin/applications/${pendingApplicationId}/reject`).send({ reason: '' }).expect(400);
      await asAdmin('patch', `/admin/applications/${pendingApplicationId}/reject`).send({ status: 'X' }).expect(400);
      const res = await asAdmin('patch', '/admin/applications/00000000-0000-0000-0000-000000000000/accept').expect(404);
      expect(res.body.code).toBe('APPLICATION_NOT_FOUND');
    });

    it('the organizer route is unchanged: another organizer still cannot decide it', async () => {
      await request(app.getHttpServer())
        .patch(`/organizers/me/bazaars/${publishedBazaarId}/applications/${pendingApplicationId}/accept`)
        .set('Authorization', `Bearer ${otherOrganizerToken}`)
        .expect((r) => expect([403, 404]).toContain(r.status));
      const row = await prisma.boothListing.findUniqueOrThrow({ where: { id: pendingApplicationId } });
      expect(row.applicationStatus).toBe('PENDING');
    });
  });

  // --- B6 -------------------------------------------------------------------

  describe('PATCH /admin/orders/:id/cancel (B6)', () => {
    authMatrix('patch', () => `/admin/orders/${paidOrderId}/cancel`);

    it('cancels the whole unpaid checkout, restores stock, audits one row per order', async () => {
      const variant = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'MGMT-A' } });
      const group = await prisma.orderGroup.create({ data: { userId: shopperId } });
      const line = (quantity: number) => ({
        create: [{ productId, variantId: variant.id, titleSnapshot: 'Hidden', priceSnapshot: 10, quantity }],
      });
      const first = await prisma.order.create({
        data: { orderGroupId: group.id, vendorId, userId: shopperId, status: 'PENDING', subtotal: 20, items: line(2) },
      });
      const second = await prisma.order.create({
        data: { orderGroupId: group.id, vendorId, userId: shopperId, status: 'PENDING', subtotal: 10, items: line(1) },
      });
      try {
        const res = await asAdmin('patch', `/admin/orders/${first.id}/cancel`).expect(200);
        expect(res.body).toMatchObject({ id: first.id, status: 'CANCELLED' });
        expect(res.body.cancelledOrderIds.sort()).toEqual([first.id, second.id].sort());

        const siblings = await prisma.order.findMany({ where: { orderGroupId: group.id } });
        expect(siblings.map((o) => o.status)).toEqual(['CANCELLED', 'CANCELLED']);
        const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
        expect(after.stockQuantity).toBe(variant.stockQuantity + 3);
        expect(await auditFor('ORDER_CANCELLED', first.id)).toHaveLength(1);
        expect(await auditFor('ORDER_CANCELLED', second.id)).toHaveLength(1);

        // Repeat on a now-CANCELLED order: 200 no-op, no extra audit, no second restock.
        const again = await asAdmin('patch', `/admin/orders/${first.id}/cancel`).expect(200);
        expect(again.body.cancelledOrderIds).toEqual([]);
        expect(await auditFor('ORDER_CANCELLED', first.id)).toHaveLength(1);
        expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } })).stockQuantity).toBe(
          variant.stockQuantity + 3,
        );
      } finally {
        await prisma.productVariant.update({ where: { id: variant.id }, data: { stockQuantity: variant.stockQuantity } });
      }
    });

    it('400 ORDER_NOT_CANCELLABLE for a PAID order — no refunds', async () => {
      const res = await asAdmin('patch', `/admin/orders/${paidOrderId}/cancel`).expect(400);
      expect(res.body.code).toBe('ORDER_NOT_CANCELLABLE');
      expect((await prisma.order.findUniqueOrThrow({ where: { id: paidOrderId } })).status).toBe('PAID');
      expect(await auditFor('ORDER_CANCELLED', paidOrderId)).toHaveLength(0);
    });

    it('404 ORDER_NOT_FOUND for an unknown order', async () => {
      const res = await asAdmin('patch', '/admin/orders/00000000-0000-0000-0000-000000000000/cancel').expect(404);
      expect(res.body.code).toBe('ORDER_NOT_FOUND');
    });
  });

  // --- B7 -------------------------------------------------------------------

  describe('PATCH /admin/bazaars/:id/cancel (B7)', () => {
    authMatrix('patch', () => `/admin/bazaars/${publishedBazaarId}/cancel`);

    it("cancels another organizer's PUBLISHED bazaar, hides it, audits once; repeat is a no-op", async () => {
      const id = await insertBazaar('Mgmt Cancel Me', BazaarStatus.PUBLISHED);

      const res = await asAdmin('patch', `/admin/bazaars/${id}/cancel`).expect(200);
      expect(res.body).toMatchObject({ id, status: 'CANCELLED' });
      await request(app.getHttpServer()).get(`/bazaars/${id}`).expect(404);
      expect(await auditFor('BAZAAR_CANCELLED', id)).toHaveLength(1);

      await asAdmin('patch', `/admin/bazaars/${id}/cancel`).expect(200);
      expect(await auditFor('BAZAAR_CANCELLED', id)).toHaveLength(1);
    });

    it('a DRAFT bazaar can be cancelled too (organizer rule: anything but COMPLETED)', async () => {
      const id = await insertBazaar('Mgmt Draft Cancel', BazaarStatus.DRAFT);
      const res = await asAdmin('patch', `/admin/bazaars/${id}/cancel`).expect(200);
      expect(res.body.status).toBe('CANCELLED');
    });

    it('400 BAZAAR_COMPLETED for a finished bazaar; 404 for soft-deleted or unknown', async () => {
      const done = await insertBazaar('Mgmt Done', BazaarStatus.COMPLETED);
      const completed = await asAdmin('patch', `/admin/bazaars/${done}/cancel`).expect(400);
      expect(completed.body.code).toBe('BAZAAR_COMPLETED');

      for (const id of [deletedBazaarId, '00000000-0000-0000-0000-000000000000']) {
        const res = await asAdmin('patch', `/admin/bazaars/${id}/cancel`).expect(404);
        expect(res.body.code).toBe('BAZAAR_NOT_FOUND');
      }
    });

    it('the organizer route is unchanged: another organizer still cannot cancel it', async () => {
      await request(app.getHttpServer())
        .patch(`/organizers/me/bazaars/${publishedBazaarId}/cancel`)
        .set('Authorization', `Bearer ${otherOrganizerToken}`)
        .expect((r) => expect([403, 404]).toContain(r.status));
      const row = await prisma.bazaar.findUniqueOrThrow({ where: { id: publishedBazaarId } });
      expect(row.status).toBe('PUBLISHED');
    });
  });

  // --- B8b ------------------------------------------------------------------

  describe('bazaar visibility follows the organizer (B8b)', () => {
    /** Is the PUBLISHED fixture bazaar visible on every public read (detail, list, discovery)? */
    async function publicEverywhere(): Promise<boolean[]> {
      const detail = await request(app.getHttpServer()).get(`/bazaars/${publishedBazaarId}`);
      const list = await request(app.getHttpServer()).get('/bazaars').query({ limit: 100 }).expect(200);
      const nearby = await request(app.getHttpServer())
        .get('/discovery/bazaars')
        .query({ lat: 30.05, lng: 31.2, radiusKm: 5, limit: 50 })
        .expect(200);
      return [
        detail.status === 200,
        list.body.data.some((b: { id: string }) => b.id === publishedBazaarId),
        nearby.body.data.some((b: { id: string }) => b.id === publishedBazaarId),
      ];
    }

    it('hidden while unverified, shown on verify, hidden on reject, restored on re-verify — status never changes', async () => {
      try {
        // Fixture organizer is unverified: its PUBLISHED bazaar is hidden everywhere.
        expect(await publicEverywhere()).toEqual([false, false, false]);

        await asAdmin('patch', `/admin/organizers/${organizerId}/verify`).expect(200);
        expect(await publicEverywhere()).toEqual([true, true, true]);

        await asAdmin('patch', `/admin/organizers/${organizerId}/reject`).send({ reason: 'Fraud report' }).expect(200);
        expect(await publicEverywhere()).toEqual([false, false, false]);

        await asAdmin('patch', `/admin/organizers/${organizerId}/verify`).expect(200);
        expect(await publicEverywhere()).toEqual([true, true, true]);

        const row = await prisma.bazaar.findUniqueOrThrow({ where: { id: publishedBazaarId } });
        expect(row.status).toBe('PUBLISHED');
      } finally {
        await prisma.organizer.update({ where: { id: organizerId }, data: { verified: false, rejectionReason: null } });
      }
    });

    it('a deleted organizer hides the bazaar too, and a vendor cannot apply to it', async () => {
      await prisma.organizer.update({ where: { id: organizerId }, data: { verified: true } });
      await prisma.vendor.update({ where: { id: vendorId }, data: { verified: true } });
      const target = await insertBazaar('Mgmt Apply Target', BazaarStatus.PUBLISHED);
      try {
        await request(app.getHttpServer()).get(`/bazaars/${target}`).expect(200);

        await prisma.organizer.update({ where: { id: organizerId }, data: { deletedAt: new Date() } });
        await request(app.getHttpServer()).get(`/bazaars/${target}`).expect(404);

        const apply = await request(app.getHttpServer())
          .post(`/bazaars/${target}/apply`)
          .set('Authorization', `Bearer ${tokens.vendor}`)
          .expect(400);
        expect(apply.body.code).toBe('BAZAAR_NOT_ACCEPTING_APPLICATIONS');
      } finally {
        await prisma.organizer.update({ where: { id: organizerId }, data: { verified: false, deletedAt: null } });
        await prisma.vendor.update({ where: { id: vendorId }, data: { verified: false } });
      }
    });
  });

  // --- B8c ------------------------------------------------------------------

  describe('booth-layout admin actions are audited (B8c)', () => {
    it('layout create/update → BAZAAR rows; booth lifecycle → BOOTH rows; idempotent unassign records nothing', async () => {
      await prisma.boothListing.update({ where: { id: pendingApplicationId }, data: { applicationStatus: 'ACCEPTED' } });
      const grid = { rows: 4, cols: 4, cellSize: 10 };
      try {
        await asAdmin('post', `/admin/bazaars/${publishedBazaarId}/layout`).send({ gridConfig: grid }).expect(201);
        await asAdmin('patch', `/admin/bazaars/${publishedBazaarId}/layout`).send({ gridConfig: { ...grid, rows: 5 } }).expect(200);
        const booth = await asAdmin('post', `/admin/bazaars/${publishedBazaarId}/layout/booths`)
          .send({ label: 'A-1', positionX: 0, positionY: 0, width: 1, height: 1 })
          .expect(201);
        const boothId = booth.body.id as string;

        await asAdmin('patch', `/admin/booths/${boothId}`).send({ label: 'A-2' }).expect(200);
        await asAdmin('patch', `/admin/booths/${boothId}/assign`).send({ boothListingId: pendingApplicationId }).expect(200);
        await asAdmin('patch', `/admin/booths/${boothId}/unassign`).expect(200);
        await asAdmin('patch', `/admin/booths/${boothId}/unassign`).expect(200); // no-op
        await asAdmin('delete', `/admin/booths/${boothId}`).expect(200);

        const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'mgmt-admin@example.com' } });
        const rows = await prisma.adminAuditLog.findMany({
          where: { action: { in: ['BOOTH_LAYOUT_CREATED', 'BOOTH_LAYOUT_UPDATED', 'BOOTH_CREATED', 'BOOTH_UPDATED', 'BOOTH_ASSIGNED', 'BOOTH_UNASSIGNED', 'BOOTH_DELETED'] } },
          orderBy: { createdAt: 'asc' },
        });
        expect(rows.map((r) => [r.action, r.targetType, r.targetId])).toEqual([
          ['BOOTH_LAYOUT_CREATED', 'BAZAAR', publishedBazaarId],
          ['BOOTH_LAYOUT_UPDATED', 'BAZAAR', publishedBazaarId],
          ['BOOTH_CREATED', 'BOOTH', boothId],
          ['BOOTH_UPDATED', 'BOOTH', boothId],
          ['BOOTH_ASSIGNED', 'BOOTH', boothId],
          ['BOOTH_UNASSIGNED', 'BOOTH', boothId],
          ['BOOTH_DELETED', 'BOOTH', boothId],
        ]);
        expect(rows.every((r) => r.actorId === admin.id)).toBe(true);
      } finally {
        await prisma.booth.deleteMany();
        await prisma.boothLayout.deleteMany();
        await prisma.boothListing.update({ where: { id: pendingApplicationId }, data: { applicationStatus: 'PENDING' } });
      }
    });
  });
});
