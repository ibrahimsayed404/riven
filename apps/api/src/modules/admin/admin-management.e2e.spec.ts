import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
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
});
