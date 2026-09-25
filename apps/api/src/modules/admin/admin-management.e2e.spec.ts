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
  let organizerId: string;
  let otherOrganizerToken: string;
  let draftBazaarId: string;
  let publishedBazaarId: string;
  let deletedBazaarId: string;
  let pendingApplicationId: string;
  let rejectedApplicationId: string;

  async function wipe() {
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    await prisma.orderGroup.deleteMany();
    await prisma.cartItem.deleteMany();
    await prisma.productVariant.deleteMany();
    await prisma.product.deleteMany();
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
  function authMatrix(method: 'get' | 'post' | 'patch', path: () => string) {
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

  function asAdmin(method: 'get' | 'post' | 'patch', path: string) {
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
    tokens.shopper = await app.get(JwtService).signAsync({ sub: shopperRes.body.id, role: Role.SHOPPER });

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
    // App boot + five bcrypt(12) registrations: past Jest's 5 s default on a loaded
    // machine, which failed the whole suite intermittently (2 of 7 runs, 2026-09-25).
  }, 30_000);

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
});
