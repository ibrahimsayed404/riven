import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';

describe('Checkout and Orders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;

  let shopperToken: string;
  let shopperId: string;
  let vendor1Id: string;
  let vendor1Token: string;
  let product1Id: string;
  let variant1Id: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get<PrismaService>(PrismaService);
    jwtService = app.get<JwtService>(JwtService);

    // Clean up
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
    await prisma.boothListing.deleteMany();
    await prisma.booth.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.adminAuditLog.deleteMany();
    await prisma.user.deleteMany();
    await prisma.category.deleteMany();

    // Create Shopper
    const shopper = await prisma.user.create({
      data: {
        email: 'shopper.checkout@example.com',
        name: 'Shopper Check',
        passwordHash: 'hash',
        role: Role.SHOPPER,
      },
    });
    shopperId = shopper.id;
    shopperToken = jwtService.sign({ sub: shopper.id, email: shopper.email, role: Role.SHOPPER });

    // Create Vendor 1
    const vendorUser = await prisma.user.create({
      data: {
        email: 'vendor1.checkout@example.com',
        name: 'Vendor 1',
        passwordHash: 'hash',
        role: Role.VENDOR,
      },
    });
    vendor1Token = jwtService.sign({ sub: vendorUser.id, email: vendorUser.email, role: Role.VENDOR });

    const vendor1 = await prisma.vendor.create({
      data: {
        ownerId: vendorUser.id,
        name: 'Vendor 1 Shop',
        category: 'OTHER',
        verified: true,
      },
    });
    vendor1Id = vendor1.id;

    // Create Category
    const category = await prisma.category.upsert({
      where: { slug: 'tech' },
      update: {},
      create: { name: 'Tech', slug: 'tech' },
    });

    // Create Product and Variant
    const product = await prisma.product.create({
      data: {
        vendorId: vendor1.id,
        title: 'Laptop',
        description: 'A good laptop',
        categoryId: category.id,
        basePrice: 1000,
        approvalStatus: 'APPROVED',
        isActive: true,
        variants: {
          create: [{ sku: 'LAP-001', stockQuantity: 10 }],
        },
      },
      include: { variants: true },
    });

    product1Id = product.id;
    variant1Id = product.variants[0].id;
  });

  afterAll(async () => {
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
    await prisma.boothListing.deleteMany();
    await prisma.booth.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.adminAuditLog.deleteMany();
    await prisma.user.deleteMany();
    await prisma.category.deleteMany();
    await app.close();
  });

  describe('Full Flow', () => {
    it('shopper should be able to add item to cart', async () => {
      const response = await request(app.getHttpServer())
        .post('/cart/items')
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({
          productId: product1Id,
          variantId: variant1Id,
          quantity: 2,
        })
        .expect(201);
        
      expect(response.body.quantity).toBe(2);
    });

    let createdOrderId: string;

    it('shopper should be able to checkout', async () => {
      const response = await request(app.getHttpServer())
        .post('/checkout')
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(201);

      expect(response.body.userId).toBe(shopperId);
      expect(response.body.orders.length).toBe(1);
      
      const order = response.body.orders[0];
      expect(order.vendorId).toBe(vendor1Id);
      expect(order.status).toBe('PENDING');
      expect(order.items.length).toBe(1);
      expect(order.items[0].quantity).toBe(2);
      expect(Number(order.subtotal)).toBe(2000);

      createdOrderId = order.id;

      // Verify stock was decremented
      const variant = await prisma.productVariant.findUnique({ where: { id: variant1Id } });
      expect(variant!.stockQuantity).toBe(8); // 10 - 2

      // Verify cart was cleared
      const cart = await prisma.cart.findUnique({ where: { userId: shopperId }, include: { items: true } });
      expect(cart!.items.length).toBe(0);
    });

    it('vendor order list and detail carry the shopper contact; shopper views do not', async () => {
      const contact = {
        id: shopperId,
        name: 'Shopper Check',
        email: 'shopper.checkout@example.com',
        phone: null,
      };

      const list = await request(app.getHttpServer())
        .get('/vendors/me/orders')
        .set('Authorization', `Bearer ${vendor1Token}`)
        .expect(200);
      expect(list.body.total).toBe(1);
      expect(list.body.data[0].id).toBe(createdOrderId);
      expect(list.body.data[0].user).toEqual(contact);
      expect(list.body.data[0]).not.toHaveProperty('items');

      const detail = await request(app.getHttpServer())
        .get(`/vendors/me/orders/${createdOrderId}`)
        .set('Authorization', `Bearer ${vendor1Token}`)
        .expect(200);
      expect(detail.body.user).toEqual(contact);
      expect(detail.body.items).toHaveLength(1);
      // Only the contact fields — never the hash or anything else off the User row.
      expect(Object.keys(detail.body.user).sort()).toEqual(['email', 'id', 'name', 'phone']);

      const shopperList = await request(app.getHttpServer())
        .get('/orders')
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);
      expect(shopperList.body.data[0]).not.toHaveProperty('user');
    });

    it('shopper cannot transition order to invalid state', async () => {
      // Shopper trying to access a vendor route should get 403 Forbidden
      await request(app.getHttpServer())
        .patch(`/vendors/me/orders/${createdOrderId}/status`)
        .set('Authorization', `Bearer ${shopperToken}`)
        .send({ status: 'FULFILLED' })
        .expect(403);
    });

    it('vendor can transition order to FULFILLED', async () => {
      // We must manually update order to PAID because it's PENDING and vendor can only update to FULFILLED if it is PAID
      await prisma.order.update({
        where: { id: createdOrderId },
        data: { status: 'PAID' },
      });

      const response = await request(app.getHttpServer())
        .patch(`/vendors/me/orders/${createdOrderId}/status`)
        .set('Authorization', `Bearer ${vendor1Token}`)
        .send({ status: 'FULFILLED' })
        .expect(200);

      expect(response.body.status).toBe('FULFILLED');
    });

    it('vendor can transition order to SHIPPED', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/vendors/me/orders/${createdOrderId}/status`)
        .set('Authorization', `Bearer ${vendor1Token}`)
        .send({ status: 'SHIPPED' })
        .expect(200);

      expect(response.body.status).toBe('SHIPPED');
    });

    it('shopper can confirm delivery', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/orders/${createdOrderId}/confirm-delivery`)
        .set('Authorization', `Bearer ${shopperToken}`)
        .expect(200);

      expect(response.body.status).toBe('DELIVERED');
    });
  });
});
