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
    await prisma.adminAuditLog.deleteMany();
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
    await prisma.adminAuditLog.deleteMany();
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
        category: 'FOOD',
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

  it('/admin/vendors?status=pending (GET) - queue lists the unverified vendor with its owner email', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/vendors?status=pending')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const row = res.body.data.find((v: any) => v.id === vendorId);
    expect(row).toBeDefined();
    expect(row.verified).toBe(false);
    expect(row.rejectionReason).toBeNull();
    expect(row.owner.email).toBe('vendor1@example.com');
    expect(res.body.meta.total).toBeGreaterThanOrEqual(1);
  });

  it('/admin/vendors (GET) - rejects an unknown status value', () => {
    return request(app.getHttpServer())
      .get('/admin/vendors?status=whatever')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('/admin/vendors/:id/verify (PATCH) - admin can verify vendor; writes an audit row', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/admin/vendors/${vendorId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toEqual({ id: vendorId, verified: true, rejectionReason: null });

    const audit = await prisma.adminAuditLog.findMany({ where: { targetId: vendorId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'VENDOR_VERIFIED', targetType: 'VENDOR', reason: null });

    const queue = await request(app.getHttpServer())
      .get('/admin/vendors?status=pending')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(queue.body.data.some((v: any) => v.id === vendorId)).toBe(false);
  });

  it('/admin/vendors/:id/verify (PATCH) - repeating verify is a 200 no-op with no second audit row', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/vendors/${vendorId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const audit = await prisma.adminAuditLog.count({ where: { targetId: vendorId } });
    expect(audit).toBe(1);
  });

  it('/vendors/me/products (POST) - succeeds for verified vendor and is immediately public (no approval gate)', async () => {
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
    expect(res.body).not.toHaveProperty('approvalStatus');

    const publicList = await request(app.getHttpServer()).get('/products').expect(200);
    expect(publicList.body.data.some((p: any) => p.id === productId)).toBe(true);
  });

  it('/admin/products (GET) - lists the product for the admin view too', async () => {
    const queue = await request(app.getHttpServer())
      .get('/admin/products?vendorId=' + vendorId)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const row = queue.body.data.find((p: any) => p.id === productId);
    expect(row).toBeDefined();
    expect(row.vendor).toEqual({ id: vendorId, name: 'Vendor One Shop', verified: true });
  });

  it('/vendors/me/products/:id (PATCH) - edit does not hide the product', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/vendors/me/products/${productId}`)
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ title: 'Fixed Product' })
      .expect(200);

    expect(res.body.title).toBe('Fixed Product');

    const publicDetail = await request(app.getHttpServer()).get(`/products/${productId}`).expect(200);
    expect(publicDetail.body.title).toBe('Fixed Product');
  });

  it('/products (GET) - excludes products from unverified vendors', async () => {
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

  // The previous test left the vendor unverified via a direct DB write, so it is
  // back in the pending state (verified=false, rejectionReason=null).
  describe('reject / revoke', () => {
    it('/admin/vendors/:id/reject (PATCH) - requires a reason', () => {
      return request(app.getHttpServer())
        .patch(`/admin/vendors/${vendorId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(400);
    });

    it('/admin/vendors/:id/reject (PATCH) - persists the reason, vendor sees it on /vendors/me, audit row written', async () => {
      const before = await prisma.adminAuditLog.count({ where: { targetId: vendorId } });

      const res = await request(app.getHttpServer())
        .patch(`/admin/vendors/${vendorId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Missing commercial registration' })
        .expect(200);
      expect(res.body).toEqual({ id: vendorId, verified: false, rejectionReason: 'Missing commercial registration' });

      const me = await request(app.getHttpServer())
        .get('/vendors/me')
        .set('Authorization', `Bearer ${vendorToken}`)
        .expect(200);
      expect(me.body.rejectionReason).toBe('Missing commercial registration');

      const queue = await request(app.getHttpServer())
        .get('/admin/vendors?status=rejected')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(queue.body.data.some((v: any) => v.id === vendorId)).toBe(true);

      const after = await prisma.adminAuditLog.findMany({ where: { targetId: vendorId }, orderBy: { createdAt: 'desc' } });
      expect(after).toHaveLength(before + 1);
      expect(after[0]).toMatchObject({ action: 'VENDOR_REJECTED', reason: 'Missing commercial registration' });
    });

    it('/admin/vendors/:id/reject (PATCH) - same reason again is a no-op: no new audit row', async () => {
      const before = await prisma.adminAuditLog.count({ where: { targetId: vendorId } });

      await request(app.getHttpServer())
        .patch(`/admin/vendors/${vendorId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Missing commercial registration' })
        .expect(200);

      expect(await prisma.adminAuditLog.count({ where: { targetId: vendorId } })).toBe(before);
    });

    it('/admin/vendors/:id/verify (PATCH) - re-approval clears the reason', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/admin/vendors/${vendorId}/verify`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body).toEqual({ id: vendorId, verified: true, rejectionReason: null });

      const me = await request(app.getHttpServer())
        .get('/vendors/me')
        .set('Authorization', `Bearer ${vendorToken}`)
        .expect(200);
      expect(me.body.verified).toBe(true);
      expect(me.body.rejectionReason).toBeNull();
    });

    it('/admin/vendors/:id/reject (PATCH) - revoking a verified vendor hides its approved products', async () => {
      const visibleBefore = await request(app.getHttpServer()).get('/products').expect(200);
      expect(visibleBefore.body.data.some((p: any) => p.id === productId)).toBe(true);

      await request(app.getHttpServer())
        .patch(`/admin/vendors/${vendorId}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Fraud report' })
        .expect(200);

      const visibleAfter = await request(app.getHttpServer()).get('/products').expect(200);
      expect(visibleAfter.body.data.some((p: any) => p.id === productId)).toBe(false);
    });

    it('/admin/vendors/:id/reject (PATCH) - 404 with VENDOR_NOT_FOUND for an unknown id', async () => {
      const res = await request(app.getHttpServer())
        .patch('/admin/vendors/00000000-0000-0000-0000-000000000000/reject')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'x' })
        .expect(404);
      expect(res.body.code).toBe('VENDOR_NOT_FOUND');
    });

    it('/admin/vendors (GET) - vendor role gets 403', () => {
      return request(app.getHttpServer())
        .get('/admin/vendors')
        .set('Authorization', `Bearer ${vendorToken}`)
        .expect(403);
    });
  });
});
