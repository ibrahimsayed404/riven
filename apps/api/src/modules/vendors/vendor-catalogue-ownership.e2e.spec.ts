import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';

import { AppModule } from '../../app.module';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * Characterization tests (specs/architecture-and-query-performance-plan.md §3.8):
 * pin today's answers when one vendor touches another vendor's catalogue, BEFORE
 * the catalogue routes move from the vendors module to the products module (S7).
 * The expected status/code pairs are what the API returns on 2026-10-31.
 */
const PREFIX = 'own-cat-';
const PASS = 'Passw0rd1';

describe('Vendor catalogue ownership (characterization e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokenA: string;
  let tokenB: string;
  let productA: string;
  let variantA: string;

  async function cleanup() {
    const vendors = await prisma.vendor.findMany({ where: { owner: { email: { startsWith: PREFIX } } }, select: { id: true } });
    const ids = vendors.map((v) => v.id);
    if (ids.length) {
      await prisma.$executeRawUnsafe('TRUNCATE "inventory_movements"'); // append-only ledger (commerce/25 S3)
      await prisma.cartItem.deleteMany({ where: { product: { vendorId: { in: ids } } } });
      await prisma.productVariant.deleteMany({ where: { product: { vendorId: { in: ids } } } });
      await prisma.product.deleteMany({ where: { vendorId: { in: ids } } });
      await prisma.vendor.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.refreshToken.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  }

  async function vendor(name: string): Promise<string> {
    const email = `${PREFIX}${name}@example.com`;
    const reg = await request(app.getHttpServer())
      .post('/auth/register/vendor')
      .send({ email, password: PASS, name, businessName: `${name} shop`, category: 'FASHION', vendorType: 'MARKETPLACE' });
    if (reg.status !== 201) throw new Error(`register ${name}: ${JSON.stringify(reg.body)}`);
    await prisma.vendor.updateMany({ where: { owner: { email } }, data: { verified: true } });
    return reg.body.accessToken;
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await cleanup();

    tokenA = await vendor('a');
    tokenB = await vendor('b');
    const category = await prisma.category.upsert({ where: { slug: 'own-cat-category' }, update: {}, create: { name: 'Own Cat', slug: 'own-cat-category' } });
    const product = await request(app.getHttpServer())
      .post('/vendors/me/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'A tee', description: 'x', categoryId: category.id, basePrice: 100, images: ['https://cdn.example.com/a.jpg'] });
    if (product.status !== 201) throw new Error(`create product: ${JSON.stringify(product.body)}`);
    productA = product.body.id;
    const variant = await request(app.getHttpServer())
      .post(`/vendors/me/products/${productA}/variants`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ sku: `OWN-CAT-${Date.now()}`, stockQuantity: 5 });
    if (variant.status !== 201) throw new Error(`create variant: ${JSON.stringify(variant.body)}`);
    variantA = variant.body.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.category.deleteMany({ where: { slug: 'own-cat-category' } });
    await app.close();
  });

  const asB = (method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: object) => {
    const req = request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${tokenB}`);
    return body ? req.send(body) : req;
  };

  it("GET /vendors/me/products never lists another vendor's product", async () => {
    const res = await asB('get', '/vendors/me/products');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(productA);
  });

  it.each([
    ['GET', 'get', () => `/vendors/me/products/${productA}`, undefined],
    ['PATCH', 'patch', () => `/vendors/me/products/${productA}`, { title: 'hijack' }],
    ['DELETE', 'delete', () => `/vendors/me/products/${productA}`, undefined],
    ['POST variant', 'post', () => `/vendors/me/products/${productA}/variants`, { sku: `OWN-CAT-X-${Date.now()}` }],
    ['PATCH variant', 'patch', () => `/vendors/me/products/${productA}/variants/${variantA}`, { size: 'XL' }],
    ['POST stock-adjustment', 'post', () => `/vendors/me/products/${productA}/variants/${variantA}/stock-adjustments`, { change: -1, reason: 'hijack' }],
    ['GET stock-movements', 'get', () => `/vendors/me/products/${productA}/variants/${variantA}/stock-movements`, undefined],
    ['DELETE variant', 'delete', () => `/vendors/me/products/${productA}/variants/${variantA}`, undefined],
  ] as const)("%s on another vendor's product → 404 PRODUCT_NOT_FOUND, nothing changes", async (_label, method, path, body) => {
    const res = await asB(method, path(), body);
    expect({ status: res.status, code: res.body?.code, message: res.body?.message }).toEqual({
      status: 404,
      code: 'PRODUCT_NOT_FOUND',
      message: 'Product not found or does not belong to you.',
    });
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productA } });
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantA } });
    expect({ title: product.title, deleted: product.deletedAt, size: variant.size, stock: variant.stockQuantity, vDeleted: variant.deletedAt }).toEqual({
      title: 'A tee',
      deleted: null,
      size: null,
      stock: 5,
      vDeleted: null,
    });
  });

  it("a variant id that belongs to another of the caller's products is 404 VARIANT_NOT_FOUND", async () => {
    const own = await request(app.getHttpServer())
      .post('/vendors/me/products')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ title: 'B tee', description: 'x', categoryId: (await prisma.category.findUniqueOrThrow({ where: { slug: 'own-cat-category' } })).id, basePrice: 50, images: ['https://cdn.example.com/b.jpg'] });
    expect(own.status).toBe(201);
    const res = await asB('patch', `/vendors/me/products/${own.body.id}/variants/${variantA}`, { size: 'XL' });
    expect({ status: res.status, code: res.body?.code }).toEqual({ status: 404, code: 'VARIANT_NOT_FOUND' });
  });

  it('a shopper token is refused on the catalogue routes (403 FORBIDDEN_ROLE)', async () => {
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: `${PREFIX}shopper@example.com`, password: PASS, name: 'S' });
    expect(reg.status).toBe(201); // shopper registration returns the user only; log in for a token
    const login = await request(app.getHttpServer()).post('/auth/login').send({ email: `${PREFIX}shopper@example.com`, password: PASS });
    const res = await request(app.getHttpServer()).get('/vendors/me/products').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect({ status: res.status, code: res.body?.code }).toEqual({ status: 403, code: 'FORBIDDEN_ROLE' });
  });
});
