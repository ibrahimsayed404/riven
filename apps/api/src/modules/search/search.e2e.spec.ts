import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { JwtService } from '@nestjs/jwt';
import { BazaarStatus, Role, ScheduleType, VendorType } from '@prisma/client';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import * as request from 'supertest';

import { AppModule } from '../../app.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { SEARCH_INDEXES } from '../../infra/search/search-index.config';
import { SearchIndexRegistry } from '../../infra/search/search-index.registry';
import { SEARCH_SYNC_QUEUE } from '../../infra/search/search-sync.job';

/**
 * Requires the docker stack (Postgres 5433, Redis 6379, Meilisearch 7700).
 * Uses its own index prefix so it never touches the development indexes, and
 * deletes those indexes before and after the run.
 *
 * Indexing is asynchronous twice over (BullMQ job → Meilisearch task), so every
 * assertion against the index goes through waitForIndexed() rather than
 * reading immediately after the HTTP call.
 */
process.env.MEILISEARCH_INDEX_PREFIX = 'riven_test_';

// Tanta, matching the discovery fixture.
const ORIGIN = { lat: 30.7865, lng: 31.0004 };
const DAY = 24 * 60 * 60 * 1000;
const future = (days: number) => new Date(Date.now() + days * DAY);
const past = (days: number) => new Date(Date.now() - days * DAY);

describe('SearchModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let registry: SearchIndexRegistry;
  let queue: Queue;

  let adminToken: string;
  let shopperToken: string;
  let shopperId: string;
  let organizerId: string;

  let verifiedVendorId: string;
  let unverifiedVendorId: string;
  let unverifiedOwnerId: string;
  let womenCategoryId: string;
  let maxiCategoryId: string;

  const ids: Record<string, string> = {};

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function waitForIndexed(index: 'products' | 'vendors' | 'bazaars', id: string, present: boolean, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let found = false;
      try {
        await registry.index(index).getDocument(id);
        found = true;
      } catch {
        found = false;
      }
      if (found === present) return;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${index}/${id} to be ${present ? 'present' : 'absent'} in Meilisearch`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async function reindexAndWait(waits: ['products' | 'vendors' | 'bazaars', string][]) {
    const res = await request(app.getHttpServer())
      .post('/admin/search/reindex')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(202);
    expect(res.body.enqueued).toEqual(['products', 'vendors', 'bazaars']);
    for (const [index, id] of waits) await waitForIndexed(index, id, true);
  }

  async function seedProduct(opts: {
    vendorId: string;
    title: string;
    description?: string;
    categoryId: string;
    basePrice: number;
    approvalStatus?: 'PENDING' | 'APPROVED' | 'REJECTED';
    isActive?: boolean;
    variants?: { sku: string; size?: string; color?: string; priceOverride?: number }[];
  }): Promise<string> {
    const product = await prisma.product.create({
      data: {
        vendorId: opts.vendorId,
        title: opts.title,
        description: opts.description ?? 'desc',
        categoryId: opts.categoryId,
        basePrice: opts.basePrice,
        images: ['https://cdn.example/1.jpg'],
        approvalStatus: opts.approvalStatus ?? 'APPROVED',
        isActive: opts.isActive ?? true,
        variants: opts.variants
          ? { create: opts.variants.map((v) => ({ sku: v.sku, size: v.size, color: v.color, priceOverride: v.priceOverride })) }
          : undefined,
      },
    });
    return product.id;
  }

  async function seedBazaar(opts: {
    name: string;
    lat: number;
    lng: number;
    startDate: Date;
    endDate: Date | null;
    status?: BazaarStatus;
    scheduleType?: ScheduleType;
  }): Promise<string> {
    const id = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "bazaars" (
        "id", "organizerId", "name", "description", "coverMedia",
        "scheduleType", "recurrenceRule", "startDate", "endDate", "status",
        "createdAt", "updatedAt", "deletedAt", "location"
      ) VALUES (
        ${id}, ${organizerId}, ${opts.name}, NULL, ARRAY[]::text[],
        ${opts.scheduleType ?? ScheduleType.ONE_OFF}::"ScheduleType",
        NULL,
        ${opts.startDate}::timestamp,
        ${opts.endDate}::timestamp,
        ${opts.status ?? BazaarStatus.PUBLISHED}::"BazaarStatus",
        NOW(), NOW(), NULL,
        ST_SetSRID(ST_MakePoint(${opts.lng}, ${opts.lat}), 4326)::geography
      )
    `;
    return id;
  }

  async function dropTestIndexes() {
    for (const name of SEARCH_INDEXES) {
      await registry.client.deleteIndexIfExists(registry.uid(name));
    }
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: (errors) =>
          new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: errors.flatMap((error) => Object.values(error.constraints ?? {})),
          }),
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    registry = app.get(SearchIndexRegistry);
    queue = app.get<Queue>(getQueueToken(SEARCH_SYNC_QUEUE));

    // Leftover jobs from an earlier run would race this one.
    await queue.obliterate({ force: true });
    await dropTestIndexes();

    await prisma.favorite.deleteMany();
    await prisma.productVariant.deleteMany();
    await prisma.product.deleteMany();
    await prisma.boothListing.deleteMany();
    await prisma.booth.deleteMany();
    await prisma.boothLayout.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.user.deleteMany();

    const admin = await prisma.user.create({
      data: { email: 'search-admin@example.com', passwordHash: 'hash', name: 'Search Admin', role: Role.ADMIN },
    });
    adminToken = await jwtService.signAsync({ sub: admin.id, role: Role.ADMIN });

    const shopper = await prisma.user.create({
      data: { email: 'search-shopper@example.com', passwordHash: 'hash', name: 'Search Shopper', role: Role.SHOPPER },
    });
    shopperId = shopper.id;
    shopperToken = await jwtService.signAsync({ sub: shopperId, role: Role.SHOPPER });

    const orgOwner = await prisma.user.create({
      data: { email: 'search-org@example.com', passwordHash: 'hash', name: 'Search Org', role: Role.ORGANIZER },
    });
    organizerId = (await prisma.organizer.create({ data: { ownerId: orgOwner.id, name: 'Search Org', verified: true } })).id;

    const women = await prisma.category.upsert({
      where: { slug: 'women' },
      update: {},
      create: { name: 'Women', slug: 'women' },
    });
    womenCategoryId = women.id;
    const dresses = await prisma.category.upsert({
      where: { slug: 'dresses' },
      update: { parentId: women.id },
      create: { name: 'Dresses', slug: 'dresses', parentId: women.id },
    });
    const maxi = await prisma.category.upsert({
      where: { slug: 'maxi-dresses' },
      update: { parentId: dresses.id },
      create: { name: 'Maxi Dresses', slug: 'maxi-dresses', parentId: dresses.id },
    });
    maxiCategoryId = maxi.id;

    const verifiedOwner = await prisma.user.create({
      data: { email: 'search-vendor-1@example.com', passwordHash: 'hash', name: 'V1', role: Role.VENDOR },
    });
    verifiedVendorId = (
      await prisma.vendor.create({
        data: {
          ownerId: verifiedOwner.id,
          name: 'Nour Atelier',
          category: 'fashion',
          description: 'Linen and cotton',
          verified: true,
          vendorType: VendorType.BOTH,
          hasFixedLocation: true,
        },
      })
    ).id;
    // ~1 km north of origin.
    await prisma.$executeRaw`
      UPDATE "vendors" SET "homeLocation" = ST_SetSRID(ST_MakePoint(${ORIGIN.lng}, ${ORIGIN.lat + 0.009}), 4326)::geography
      WHERE "id" = ${verifiedVendorId}
    `;

    unverifiedOwnerId = (
      await prisma.user.create({
        data: { email: 'search-vendor-2@example.com', passwordHash: 'hash', name: 'V2', role: Role.VENDOR },
      })
    ).id;
    unverifiedVendorId = (
      await prisma.vendor.create({
        data: { ownerId: unverifiedOwnerId, name: 'Hidden Studio', category: 'fashion', verified: false },
      })
    ).id;

    // Products of the verified vendor.
    ids.linen = await seedProduct({
      vendorId: verifiedVendorId,
      title: 'Linen maxi dress',
      description: 'Airy summer dress',
      categoryId: maxiCategoryId,
      basePrice: 500,
      variants: [
        { sku: 'LIN-S-RED', size: 'S', color: 'Red' },                       // 500 (base)
        { sku: 'LIN-M-BLUE', size: 'M', color: 'Blue', priceOverride: 800 },
        { sku: 'LIN-L-GREEN', size: 'L', color: 'Green', priceOverride: 1200 },
      ],
    });
    ids.arabic = await seedProduct({
      vendorId: verifiedVendorId,
      title: 'فستان كتان',
      description: 'فستان صيفي',
      categoryId: womenCategoryId,
      basePrice: 2000,
    });
    ids.pending = await seedProduct({
      vendorId: verifiedVendorId,
      title: 'Pending linen dress',
      categoryId: maxiCategoryId,
      basePrice: 300,
      approvalStatus: 'PENDING',
    });
    ids.inactive = await seedProduct({
      vendorId: verifiedVendorId,
      title: 'Inactive linen dress',
      categoryId: maxiCategoryId,
      basePrice: 300,
      isActive: false,
    });
    // Approved but owned by an unverified vendor: must not be searchable.
    ids.hidden = await seedProduct({
      vendorId: unverifiedVendorId,
      title: 'Hidden linen dress',
      categoryId: maxiCategoryId,
      basePrice: 700,
    });

    ids.bazaarNear = await seedBazaar({ name: 'Tanta Winter Bazaar', lat: ORIGIN.lat + 0.005, lng: ORIGIN.lng, startDate: future(3), endDate: future(5) });
    ids.bazaarFar = await seedBazaar({ name: 'Cairo Winter Bazaar', lat: 30.0444, lng: 31.2357, startDate: future(3), endDate: future(5) });
    ids.bazaarPast = await seedBazaar({ name: 'Old Winter Bazaar', lat: ORIGIN.lat, lng: ORIGIN.lng, startDate: past(10), endDate: past(8) });
    ids.bazaarDraft = await seedBazaar({ name: 'Draft Winter Bazaar', lat: ORIGIN.lat, lng: ORIGIN.lng, startDate: future(3), endDate: future(5), status: BazaarStatus.DRAFT });

    await reindexAndWait([
      ['products', ids.linen],
      ['products', ids.arabic],
      ['vendors', verifiedVendorId],
      ['bazaars', ids.bazaarNear],
      ['bazaars', ids.bazaarFar],
      ['bazaars', ids.bazaarPast],
    ]);
  }, 120_000);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await dropTestIndexes();
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // Index membership = public visibility
  // ---------------------------------------------------------------------------

  describe('index membership', () => {
    it('indexes only approved, active products of verified vendors', async () => {
      await waitForIndexed('products', ids.pending, false, 2_000);
      await waitForIndexed('products', ids.inactive, false, 2_000);
      await waitForIndexed('products', ids.hidden, false, 2_000);
    });

    it('indexes only verified vendors and PUBLISHED bazaars', async () => {
      await waitForIndexed('vendors', unverifiedVendorId, false, 2_000);
      await waitForIndexed('bazaars', ids.bazaarDraft, false, 2_000);
    });

    it('never leaks internal fields into a document', async () => {
      const doc = await registry.index('products').getDocument(ids.linen);
      expect(Object.keys(doc).sort()).toEqual(
        ['basePrice', 'categoryId', 'categoryPath', 'categorySlug', 'colors', 'description', 'id', 'image', 'maxPrice', 'minPrice', 'sizes', 'title', 'vendorId', 'vendorName'],
      );
      expect(doc).toMatchObject({ minPrice: 500, maxPrice: 1200, categoryPath: ['women', 'dresses', 'maxi-dresses'] });

      const vendor = await registry.index('vendors').getDocument(verifiedVendorId);
      expect(vendor).not.toHaveProperty('ownerId');
      expect(vendor).not.toHaveProperty('subscriptionStatus');
      expect(vendor).not.toHaveProperty('verified');
    });
  });

  // ---------------------------------------------------------------------------
  // Sync on writes
  // ---------------------------------------------------------------------------

  describe('sync', () => {
    it('approving a product adds it; rejecting removes it', async () => {
      const approve = await request(app.getHttpServer())
        .patch(`/admin/products/${ids.pending}/approve`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(approve.status).toBe(200);
      await waitForIndexed('products', ids.pending, true);

      const reject = await request(app.getHttpServer())
        .patch(`/admin/products/${ids.pending}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'not now' });
      expect(reject.status).toBe(200);
      await waitForIndexed('products', ids.pending, false);
    });

    it('verifying a vendor indexes the vendor and fans out to its approved products', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/admin/vendors/${unverifiedVendorId}/verify`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);

      await waitForIndexed('vendors', unverifiedVendorId, true);
      await waitForIndexed('products', ids.hidden, true);
    });

    it('a vendor editing a product resets it to PENDING and drops it from the index', async () => {
      const vendorToken = await jwtService.signAsync({ sub: unverifiedOwnerId, role: Role.VENDOR });
      const res = await request(app.getHttpServer())
        .patch(`/vendors/me/products/${ids.hidden}`)
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ title: 'Hidden linen dress v2' });
      expect(res.status).toBe(200);

      await waitForIndexed('products', ids.hidden, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Endpoints
  // ---------------------------------------------------------------------------

  describe('GET /search/products', () => {
    const get = (query: Record<string, string>) => request(app.getHttpServer()).get('/search/products').query({ q: 'linen', ...query });

    it('finds by title with typo tolerance and returns the envelope', async () => {
      const res = await request(app.getHttpServer()).get('/search/products').query({ q: 'linnen maxi' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, limit: 20 });
      expect(res.body.hits.map((h: { id: string }) => h.id)).toContain(ids.linen);
      expect(res.body).not.toHaveProperty('processingTimeMs');
      expect(res.body.hits[0]).toMatchObject({ isFavorite: false });
    });

    it('finds Arabic titles', async () => {
      const res = await request(app.getHttpServer()).get('/search/products').query({ q: 'فستان' });
      expect(res.status).toBe(200);
      expect(res.body.hits.map((h: { id: string }) => h.id)).toContain(ids.arabic);
    });

    it('applies price range overlap: maxPrice=900 keeps the 500/800/1200 product, minPrice=1300 drops it', async () => {
      const kept = await get({ maxPrice: '900' });
      expect(kept.body.hits.map((h: { id: string }) => h.id)).toContain(ids.linen);

      const dropped = await get({ minPrice: '1300' });
      expect(dropped.body.hits.map((h: { id: string }) => h.id)).not.toContain(ids.linen);
    });

    it('category=<slug> matches the whole subtree', async () => {
      const res = await request(app.getHttpServer()).get('/search/products').query({ q: 'dress', category: 'women' });
      expect(res.status).toBe(200);
      expect(res.body.hits.map((h: { id: string }) => h.id)).toEqual(expect.arrayContaining([ids.linen, ids.arabic]));
    });

    it('filters by size and color', async () => {
      const res = await get({ size: 'M', color: 'Blue' });
      expect(res.body.hits.map((h: { id: string }) => h.id)).toEqual([ids.linen]);
      const none = await get({ size: 'XL' });
      expect(none.body.hits).toEqual([]);
    });

    it('rejects a page beyond the window and radiusKm without coordinates', async () => {
      const page = await get({ page: '51' });
      expect(page.status).toBe(400);
      expect(page.body.error.code).toBe('SEARCH_QUERY_INVALID');

      const radius = await get({ radiusKm: '5' });
      expect(radius.status).toBe(400);
      expect(radius.body.error.code).toBe('SEARCH_QUERY_INVALID');
    });

    it('rejects unknown params and a missing q via the global pipe', async () => {
      const unknown = await get({ approvalStatus: 'PENDING' });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.code).toBe('VALIDATION_ERROR');

      const noQ = await request(app.getHttpServer()).get('/search/products');
      expect(noQ.status).toBe(400);
    });

    it('marks favorites for an authenticated shopper', async () => {
      await prisma.favorite.create({ data: { userId: shopperId, favorableType: 'PRODUCT', favorableId: ids.linen } });

      const res = await request(app.getHttpServer())
        .get('/search/products')
        .query({ q: 'linen maxi' })
        .set('Authorization', `Bearer ${shopperToken}`);

      const hit = res.body.hits.find((h: { id: string }) => h.id === ids.linen);
      expect(hit.isFavorite).toBe(true);
    });
  });

  describe('GET /search/vendors', () => {
    it('returns distance when coordinates are given, and only vendors inside the radius', async () => {
      const res = await request(app.getHttpServer())
        .get('/search/vendors')
        .query({ q: 'atelier', lat: ORIGIN.lat, lng: ORIGIN.lng, radiusKm: 5 });
      expect(res.status).toBe(200);
      expect(res.body.hits).toHaveLength(1);
      expect(res.body.hits[0]).toMatchObject({ id: verifiedVendorId, name: 'Nour Atelier', vendorType: 'BOTH' });
      expect(res.body.hits[0].distanceKm).toBeGreaterThan(0.5);
      expect(res.body.hits[0].distanceKm).toBeLessThan(2);
      expect(res.body.hits[0]).not.toHaveProperty('_geo');

      const far = await request(app.getHttpServer())
        .get('/search/vendors')
        .query({ q: 'atelier', lat: 30.0444, lng: 31.2357, radiusKm: 5 });
      expect(far.body.hits).toEqual([]);
    });

    it('filters by vendorType', async () => {
      const res = await request(app.getHttpServer()).get('/search/vendors').query({ q: 'atelier', vendorType: 'MARKETPLACE' });
      expect(res.body.hits).toEqual([]);
    });
  });

  describe('GET /search/bazaars', () => {
    it('hides past bazaars by default and includes them with upcomingOnly=false', async () => {
      const upcoming = await request(app.getHttpServer()).get('/search/bazaars').query({ q: 'winter' });
      expect(upcoming.status).toBe(200);
      const upcomingIds = upcoming.body.hits.map((h: { id: string }) => h.id);
      expect(upcomingIds).toEqual(expect.arrayContaining([ids.bazaarNear, ids.bazaarFar]));
      expect(upcomingIds).not.toContain(ids.bazaarPast);
      expect(upcomingIds).not.toContain(ids.bazaarDraft);
      expect(typeof upcoming.body.hits[0].startDate).toBe('string');

      const all = await request(app.getHttpServer()).get('/search/bazaars').query({ q: 'winter', upcomingOnly: 'false' });
      expect(all.body.hits.map((h: { id: string }) => h.id)).toContain(ids.bazaarPast);
    });

    it('orders equal-relevance hits by distance and reports distanceKm', async () => {
      const res = await request(app.getHttpServer())
        .get('/search/bazaars')
        .query({ q: 'winter bazaar', lat: ORIGIN.lat, lng: ORIGIN.lng, radiusKm: 150 });
      expect(res.status).toBe(200);
      const hits = res.body.hits as { id: string; distanceKm: number }[];
      expect(hits[0].id).toBe(ids.bazaarNear);
      expect(hits[0].distanceKm).toBeLessThan(1);
      expect(hits.find((h) => h.id === ids.bazaarFar)!.distanceKm).toBeGreaterThan(50);
    });
  });

  describe('GET /search', () => {
    it('returns one grouped result set per type', async () => {
      const res = await request(app.getHttpServer()).get('/search').query({ q: 'linen', limit: 5 });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['bazaars', 'products', 'vendors']);
      expect(res.body.products).toMatchObject({ page: 1, limit: 5 });
      expect(res.body.products.hits.map((h: { id: string }) => h.id)).toContain(ids.linen);
      expect(res.body.vendors.hits.map((h: { id: string }) => h.id)).toContain(verifiedVendorId);
    });

    it('honours types= and rejects unknown types', async () => {
      const only = await request(app.getHttpServer()).get('/search').query({ q: 'winter', types: 'bazaars' });
      expect(Object.keys(only.body)).toEqual(['bazaars']);

      const bad = await request(app.getHttpServer()).get('/search').query({ q: 'winter', types: 'events' });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('SEARCH_TYPE_INVALID');
    });
  });

  describe('POST /admin/search/reindex', () => {
    it('is admin-only', async () => {
      const anon = await request(app.getHttpServer()).post('/admin/search/reindex').send({});
      expect(anon.status).toBe(401);

      const shopper = await request(app.getHttpServer())
        .post('/admin/search/reindex')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({});
      expect(shopper.status).toBe(403);
    });

    it('validates the body', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/search/reindex')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ types: ['events'] });
      expect(res.status).toBe(400);
    });
  });
});
