import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../infra/prisma/prisma.service';

describe('VendorsModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let vendorToken: string;
  let adminToken: string;
  let vendorId: string;
  let productId: string;
  let categoryId: string;

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
      }),
    );
    await app.init();
    
    prisma = moduleFixture.get(PrismaService);
    
    // Clean up
    await prisma.productVariant.deleteMany();
    await prisma.product.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.boothListing.deleteMany();
    await prisma.booth.deleteMany();
    await prisma.boothLayout.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.user.deleteMany();

    // Create an admin user for admin actions
    const adminRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'admin-vendor-test@example.com',
        password: 'Password123!',
        name: 'Admin Test',
        role: 'SHOPPER'
      });
    
    if (adminRes.status !== 201) throw new Error('Admin Registration Error: ' + JSON.stringify(adminRes.body));
    adminToken = adminRes.body.accessToken;

    // Manually promote admin via DB
    await prisma.user.updateMany({
      where: { email: 'admin-vendor-test@example.com' },
      data: { role: 'ADMIN' }
    });

    const category = await prisma.category.upsert({
      where: { slug: 'test-category' },
      update: {},
      create: {
        name: 'Test Category',
        slug: 'test-category'
      }
    });
    categoryId = category.id;

    const adminLoginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'admin-vendor-test@example.com',
        password: 'Password123!',
      });
    if (adminLoginRes.status !== 200 && adminLoginRes.status !== 201) throw new Error('Admin Login Error: ' + JSON.stringify(adminLoginRes.body));
    adminToken = adminLoginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.productVariant.deleteMany();
    await prisma.product.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.boothListing.deleteMany();
    await prisma.booth.deleteMany();
    await prisma.boothLayout.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.user.deleteMany();
    await app.close();
  });

  it('/auth/register/vendor (POST) - registration success', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register/vendor')
      .send({
        email: 'vendor1@example.com',
        password: 'Password123!',
        name: 'Vendor One',
        businessName: 'Vendor One Shop',
        category: 'Food',
        vendorType: 'MARKETPLACE'
      });
      
    if (res.status !== 201) throw new Error('Vendor Registration Error: ' + JSON.stringify(res.body));
    expect(res.body).toHaveProperty('accessToken');
    vendorToken = res.body.accessToken;

    const vendorRes = await request(app.getHttpServer())
      .get('/vendors/me')
      .set('Authorization', `Bearer ${vendorToken}`)
      .expect(200);
      
    vendorId = vendorRes.body.id;
    expect(vendorRes.body.verified).toBe(false);
  });

  it('/vendors/me/products (POST) - blocked for unverified vendor', () => {
    return request(app.getHttpServer())
      .post('/vendors/me/products')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({
        title: 'Test Product',
        description: 'Desc',
        categoryId,
        basePrice: 100,
        images: []
      })
      .expect(403);
  });

  it('/admin/vendors/:id/verify (PATCH) - admin can verify vendor', () => {
    return request(app.getHttpServer())
      .patch(`/admin/vendors/${vendorId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('/vendors/me/products (POST) - succeeds for verified vendor', async () => {
    const res = await request(app.getHttpServer())
      .post('/vendors/me/products')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({
        title: 'Test Product',
        description: 'Desc',
        categoryId,
        basePrice: 100,
        images: []
      })
      .expect(201);
      
    productId = res.body.id;
    expect(res.body.approvalStatus).toBe('PENDING');
  });

  it('/admin/products/:id/reject (PATCH) - admin reject persists reason', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/admin/products/${productId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Inappropriate content' })
      .expect(200);
      
    expect(res.body.approvalStatus).toBe('REJECTED');
    expect(res.body.rejectionReason).toBe('Inappropriate content');

    const vendorCheck = await request(app.getHttpServer())
      .get(`/vendors/me/products/${productId}`)
      .set('Authorization', `Bearer ${vendorToken}`)
      .expect(200);
      
    expect(vendorCheck.body.approvalStatus).toBe('REJECTED');
    expect(vendorCheck.body.rejectionReason).toBe('Inappropriate content');
  });

  it('/vendors/me/products/:id (PATCH) - edit resets approvalStatus to PENDING', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/vendors/me/products/${productId}`)
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ title: 'Fixed Product' })
      .expect(200);
      
    expect(res.body.approvalStatus).toBe('PENDING');
    expect(res.body.rejectionReason).toBeNull();
  });

  it('/products (GET) - excludes products from unverified vendors', async () => {
    // Approve the product first
    await request(app.getHttpServer())
      .patch(`/admin/products/${productId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // List products
    const listRes = await request(app.getHttpServer())
      .get('/products')
      .expect(200);
      
    expect(listRes.body.data.some((p: any) => p.id === productId)).toBe(true);

    // Unverify vendor (manually via DB since we don't have an endpoint for it)
    await prisma.vendor.update({
      where: { id: vendorId },
      data: { verified: false }
    });

    // List products again
    const listRes2 = await request(app.getHttpServer())
      .get('/products')
      .expect(200);
      
    expect(listRes2.body.data.some((p: any) => p.id === productId)).toBe(false);
  });
});
