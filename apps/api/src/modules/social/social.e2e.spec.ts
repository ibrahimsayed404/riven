import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import {
  ApprovalStatus,
  FavorableType,
  FollowableType,
  OrderStatus,
  RatingTargetType,
  Role,
  VendorType,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../infra/prisma/prisma.service';

describe('SocialModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  let shopperId: string;
  let shopperToken: string;

  let otherShopperId: string;
  let otherShopperToken: string;

  let vendorId: string;
  let productId: string;
  let variantId: string;

  let deliveredOrderId: string;
  let pendingOrderId: string;
  let otherShopperDeliveredOrderId: string;

  async function cleanDatabase() {
    await prisma.rating.deleteMany();
    await prisma.favorite.deleteMany();
    await prisma.follow.deleteMany();
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    await prisma.orderGroup.deleteMany();
    await prisma.cartItem.deleteMany();
    await prisma.cart.deleteMany();
    await prisma.productVariant.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    await prisma.boothListing.deleteMany();
    await prisma.booth.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.adminAuditLog.deleteMany();
    await prisma.user.deleteMany();
  }

  async function seedOrder(opts: {
    userId: string;
    vendorId: string;
    status: OrderStatus;
    productId: string;
    variantId: string;
  }): Promise<string> {
    const orderGroupId = randomUUID();
    const orderId = randomUUID();
    const orderItemId = randomUUID();

    // Raw SQL insertion to mirror seed helper patterns
    await prisma.$executeRaw`
      INSERT INTO "order_groups" ("id", "userId", "createdAt")
      VALUES (${orderGroupId}, ${opts.userId}, NOW())
    `;

    await prisma.$executeRaw`
      INSERT INTO "orders" ("id", "orderGroupId", "vendorId", "userId", "status", "subtotal", "createdAt", "updatedAt")
      VALUES (${orderId}, ${orderGroupId}, ${opts.vendorId}, ${opts.userId}, ${opts.status}::"OrderStatus", 100.00::money, NOW(), NOW())
    `;

    await prisma.$executeRaw`
      INSERT INTO "order_items" ("id", "orderId", "productId", "variantId", "titleSnapshot", "priceSnapshot", "quantity")
      VALUES (${orderItemId}, ${orderId}, ${opts.productId}, ${opts.variantId}, 'Test Item', 100.00::money, 1)
    `;

    return orderId;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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

    await cleanDatabase();

    // 1. Create Shopper
    const shopper = await prisma.user.create({
      data: {
        email: 'shopper-social@example.com',
        name: 'Social Shopper',
        passwordHash: 'hash',
        role: Role.SHOPPER,
      },
    });
    shopperId = shopper.id;
    shopperToken = await jwtService.signAsync({ sub: shopperId, role: Role.SHOPPER });

    // 2. Create Other Shopper
    const otherShopper = await prisma.user.create({
      data: {
        email: 'other-shopper-social@example.com',
        name: 'Other Shopper',
        passwordHash: 'hash',
        role: Role.SHOPPER,
      },
    });
    otherShopperId = otherShopper.id;
    otherShopperToken = await jwtService.signAsync({ sub: otherShopperId, role: Role.SHOPPER });

    // 3. Create Vendor User & Vendor
    const vendorUser = await prisma.user.create({
      data: {
        email: 'vendor-social@example.com',
        name: 'Vendor Owner',
        passwordHash: 'hash',
        role: Role.VENDOR,
      },
    });
    const vendor = await prisma.vendor.create({
      data: {
        ownerId: vendorUser.id,
        name: 'Artisan Goods',
        category: 'Crafts',
        vendorType: VendorType.MARKETPLACE,
      },
    });
    vendorId = vendor.id;

    // 4. Create Category, Product, Variant
    const category = await prisma.category.create({
      data: { name: 'Crafts', slug: `crafts-${Date.now()}` },
    });

    const product = await prisma.product.create({
      data: {
        vendorId,
        categoryId: category.id,
        title: 'Handmade Mug',
        description: 'Ceramic coffee mug',
        basePrice: 25.0,
      },
    });
    productId = product.id;

    const variant = await prisma.productVariant.create({
      data: {
        productId,
        sku: `MUG-${Date.now()}`,
        stockQuantity: 10,
      },
    });
    variantId = variant.id;

    // 5. Seed Orders
    deliveredOrderId = await seedOrder({
      userId: shopperId,
      vendorId,
      status: OrderStatus.DELIVERED,
      productId,
      variantId,
    });

    pendingOrderId = await seedOrder({
      userId: shopperId,
      vendorId,
      status: OrderStatus.PENDING,
      productId,
      variantId,
    });

    otherShopperDeliveredOrderId = await seedOrder({
      userId: otherShopperId,
      vendorId,
      status: OrderStatus.DELIVERED,
      productId,
      variantId,
    });
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // Favorites
  // ---------------------------------------------------------------------------

  describe('POST & DELETE /social/favorites', () => {
    it('requires authentication with SHOPPER role', async () => {
      const res = await request(app.getHttpServer())
        .post('/social/favorites')
        .send({ favorableType: FavorableType.PRODUCT, favorableId: productId });
      expect(res.status).toBe(401);
    });

    it('idempotently adds a favorite (returns 200 on create and duplicate)', async () => {
      // First attempt
      const res1 = await request(app.getHttpServer())
        .post('/social/favorites')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ favorableType: FavorableType.PRODUCT, favorableId: productId });
      expect(res1.status).toBe(200);
      expect(res1.body.favorableId).toBe(productId);

      // Duplicate attempt should not throw 409
      const res2 = await request(app.getHttpServer())
        .post('/social/favorites')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ favorableType: FavorableType.PRODUCT, favorableId: productId });
      expect(res2.status).toBe(200);
    });

    it('returns caller own favorites and paginates with cursor', async () => {
      // Add a second favorite
      await request(app.getHttpServer())
        .post('/social/favorites')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ favorableType: FavorableType.VENDOR, favorableId: vendorId });

      // Page 1 with limit 1
      const page1 = await request(app.getHttpServer())
        .get('/social/favorites?limit=1')
        .set('Authorization', `Bearer ${shopperToken}`);
      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.nextCursor).toBeDefined();

      // Page 2
      const page2 = await request(app.getHttpServer())
        .get(`/social/favorites?limit=1&cursor=${page1.body.nextCursor}`)
        .set('Authorization', `Bearer ${shopperToken}`);
      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    });

    it('idempotently removes a favorite using deleteMany', async () => {
      const res1 = await request(app.getHttpServer())
        .delete('/social/favorites')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ favorableType: FavorableType.PRODUCT, favorableId: productId });
      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);

      // Deleting again does not throw
      const res2 = await request(app.getHttpServer())
        .delete('/social/favorites')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ favorableType: FavorableType.PRODUCT, favorableId: productId });
      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Follows
  // ---------------------------------------------------------------------------

  describe('POST & DELETE /social/follows', () => {
    it('idempotently adds and removes follows', async () => {
      // Add follow
      const addRes1 = await request(app.getHttpServer())
        .post('/social/follows')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ followableType: FollowableType.VENDOR, followableId: vendorId });
      expect(addRes1.status).toBe(200);

      // Duplicate add
      const addRes2 = await request(app.getHttpServer())
        .post('/social/follows')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ followableType: FollowableType.VENDOR, followableId: vendorId });
      expect(addRes2.status).toBe(200);

      // List follows
      const listRes = await request(app.getHttpServer())
        .get('/social/follows')
        .set('Authorization', `Bearer ${shopperToken}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.some((f: any) => f.followableId === vendorId)).toBe(true);

      // Delete follow
      const delRes1 = await request(app.getHttpServer())
        .delete('/social/follows')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ followableType: FollowableType.VENDOR, followableId: vendorId });
      expect(delRes1.status).toBe(200);
      expect(delRes1.body.success).toBe(true);

      // Duplicate delete
      const delRes2 = await request(app.getHttpServer())
        .delete('/social/follows')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ followableType: FollowableType.VENDOR, followableId: vendorId });
      expect(delRes2.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Ratings & Verified Purchase Gate
  // ---------------------------------------------------------------------------

  describe('POST /social/ratings & Verified Purchase Gate', () => {
    const unpurchasedVendorId = randomUUID();
    const unpurchasedProductId = randomUUID();

    it('rejects rating if order status is PENDING (not DELIVERED)', async () => {
      const res = await request(app.getHttpServer())
        .post('/social/ratings')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({
          targetType: RatingTargetType.VENDOR,
          targetId: vendorId,
          score: 5,
          orderId: pendingOrderId,
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_VERIFIED_PURCHASE');
    });

    it('rejects rating if order belongs to another shopper', async () => {
      const res = await request(app.getHttpServer())
        .post('/social/ratings')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({
          targetType: RatingTargetType.VENDOR,
          targetId: vendorId,
          score: 5,
          orderId: otherShopperDeliveredOrderId,
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_VERIFIED_PURCHASE');
    });

    it('rejects rating a mismatched vendor not involved in the order', async () => {
      const res = await request(app.getHttpServer())
        .post('/social/ratings')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({
          targetType: RatingTargetType.VENDOR,
          targetId: unpurchasedVendorId,
          score: 5,
          orderId: deliveredOrderId,
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_VERIFIED_PURCHASE');
    });

    it('rejects rating a mismatched product not in the order', async () => {
      const res = await request(app.getHttpServer())
        .post('/social/ratings')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({
          targetType: RatingTargetType.PRODUCT,
          targetId: unpurchasedProductId,
          score: 4,
          orderId: deliveredOrderId,
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_VERIFIED_PURCHASE');
    });

    it('validates score range (1-5)', async () => {
      const resZero = await request(app.getHttpServer())
        .post('/social/ratings')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({
          targetType: RatingTargetType.VENDOR,
          targetId: vendorId,
          score: 0,
          orderId: deliveredOrderId,
        });
      expect(resZero.status).toBe(400);

      const resSix = await request(app.getHttpServer())
        .post('/social/ratings')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({
          targetType: RatingTargetType.VENDOR,
          targetId: vendorId,
          score: 6,
          orderId: deliveredOrderId,
        });
      expect(resSix.status).toBe(400);
    });

    it('succeeds when verified purchase check passes for vendor', async () => {
      const res = await request(app.getHttpServer())
        .post('/social/ratings')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({
          targetType: RatingTargetType.VENDOR,
          targetId: vendorId,
          score: 4,
          comment: 'Very good vendor service',
          orderId: deliveredOrderId,
        });

      expect(res.status).toBe(200);
      expect(res.body.score).toBe(4);
      expect(res.body.comment).toBe('Very good vendor service');
      expect(res.body.orderId).toBe(deliveredOrderId);
    });

    it('upserts existing rating when submitted again by the same shopper for same target', async () => {
      const res = await request(app.getHttpServer())
        .post('/social/ratings')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({
          targetType: RatingTargetType.VENDOR,
          targetId: vendorId,
          score: 5,
          comment: 'Upgraded review: Outstanding!',
          orderId: deliveredOrderId,
        });

      expect(res.status).toBe(200);
      expect(res.body.score).toBe(5);
      expect(res.body.comment).toBe('Upgraded review: Outstanding!');

      // Ensure DB contains exactly 1 rating for this shopper+vendor
      const count = await prisma.rating.count({
        where: {
          userId: shopperId,
          targetType: RatingTargetType.VENDOR,
          targetId: vendorId,
        },
      });
      expect(count).toBe(1);
    });

    it('succeeds when verified purchase check passes for product', async () => {
      const res = await request(app.getHttpServer())
        .post('/social/ratings')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({
          targetType: RatingTargetType.PRODUCT,
          targetId: productId,
          score: 5,
          comment: 'Top quality mug',
          orderId: deliveredOrderId,
        });

      expect(res.status).toBe(200);
      expect(res.body.targetId).toBe(productId);
      expect(res.body.score).toBe(5);
    });

    it('returns aggregate summary via GET /social/ratings/summary without auth', async () => {
      // Add a rating from otherShopper on the vendor as well
      await prisma.rating.create({
        data: {
          userId: otherShopperId,
          targetType: RatingTargetType.VENDOR,
          targetId: vendorId,
          score: 3,
          comment: 'Average',
          orderId: otherShopperDeliveredOrderId,
        },
      });

      // Shopper rated 5, otherShopper rated 3 -> avg 4.0, count 2
      const res = await request(app.getHttpServer())
        .get(`/social/ratings/summary?targetType=${RatingTargetType.VENDOR}&targetId=${vendorId}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ average: 4, count: 2 });
    });

    it('returns public reviews with reviewerName and omits internal userId', async () => {
      const res = await request(app.getHttpServer())
        .get(`/social/ratings?targetType=${RatingTargetType.VENDOR}&targetId=${vendorId}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
      for (const review of res.body.data) {
        expect(review.reviewerName).toBeDefined();
        expect(review.userId).toBeUndefined();
      }
    });
  });
});
