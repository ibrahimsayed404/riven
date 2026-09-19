import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AppModule } from '../../app.module';
import { Role } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';

describe('BoothsModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminToken: string;
  let bazaarId: string;
  let boothListingId: string;
  let layoutId: string;
  let boothId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();

    prisma = app.get(PrismaService);

    // Clean up
    await prisma.booth.deleteMany();
    await prisma.boothLayout.deleteMany();
    await prisma.boothListing.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.adminAuditLog.deleteMany();
    await prisma.user.deleteMany();

    // Create Admin
    const admin = await prisma.user.create({
      data: { email: 'admin-booth@example.com', passwordHash: 'hash', name: 'Admin Booths', role: Role.ADMIN },
    });
    const jwtService = app.get(JwtService);
    adminToken = await jwtService.signAsync({
      sub: admin.id,
      role: Role.ADMIN,
    });

    // Create Organizer (via registration)
    const orgRes = await request(app.getHttpServer())
      .post('/auth/register/organizer')
      .send({ email: 'org-booth@example.com', password: 'Password123!', name: 'Org Owner', organizationName: 'Org Booths' });
    const organizerToken = orgRes.body.accessToken;

    const orgUser = await prisma.user.findUnique({ where: { email: 'org-booth@example.com' }, include: { organizer: true }});
    await prisma.organizer.update({ where: { id: orgUser!.organizer!.id }, data: { verified: true } });

    // Create Bazaar via API
    const createBazaarRes = await request(app.getHttpServer())
      .post('/organizers/me/bazaars')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        name: 'Booth Bazaar',
        lat: 30,
        lng: 30,
        scheduleType: 'ONE_OFF',
        startDate: new Date().toISOString(),
      });
    expect(createBazaarRes.status).toBe(201);
    bazaarId = createBazaarRes.body.id;

    // Publish Bazaar via API
    const publishRes = await request(app.getHttpServer())
      .patch(`/organizers/me/bazaars/${bazaarId}/publish`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(publishRes.status).toBe(200);

    // Create Vendor
    const vendorRes = await request(app.getHttpServer())
      .post('/auth/register/vendor')
      .send({ email: 'ven-booth@example.com', password: 'Password123!', name: 'Ven Owner', businessName: 'Vendor Booths', category: 'FOOD', vendorType: 'BAZAAR_ONLY' });
    expect(vendorRes.status).toBe(201);
    const vendorToken = vendorRes.body.accessToken;
    
    const vendorUser = await prisma.user.findUnique({ where: { email: 'ven-booth@example.com' }, include: { vendor: true }});
    await prisma.vendor.update({ where: { id: vendorUser!.vendor!.id }, data: { verified: true } });

    // Apply to Bazaar via API
    const applyRes = await request(app.getHttpServer())
      .post(`/bazaars/${bazaarId}/apply`)
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({});
    expect(applyRes.status).toBe(201);
    boothListingId = applyRes.body.id;

    // Accept Application via API
    const acceptRes = await request(app.getHttpServer())
      .patch(`/organizers/me/bazaars/${bazaarId}/applications/${boothListingId}/accept`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(acceptRes.status).toBe(200);
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. Admin creates layout', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/bazaars/${bazaarId}/layout`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        gridConfig: { rows: 10, cols: 10, cellSize: 50 },
      });

    expect(res.status).toBe(201);
    expect(res.body.bazaarId).toBe(bazaarId);
    layoutId = res.body.id;
  });

  it('2. Admin creates booth', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/bazaars/${bazaarId}/layout/booths`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        label: 'A1',
        positionX: 0,
        positionY: 0,
        width: 1,
        height: 1,
      });

    expect(res.status).toBe(201);
    expect(res.body.layoutId).toBe(layoutId);
    boothId = res.body.id;
  });

  it('3. Admin creates another booth', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/bazaars/${bazaarId}/layout/booths`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        label: 'A2', // will remain unassigned
        positionX: 1,
        positionY: 0,
        width: 1,
        height: 1,
      });

    expect(res.status).toBe(201);
  });

  it('3.5 Admin fails to create booth with duplicate label (409)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/bazaars/${bazaarId}/layout/booths`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        label: 'A1', // already exists in layout
        positionX: 2,
        positionY: 0,
        width: 1,
        height: 1,
      });

    expect(res.status).toBe(409);
  });

  it('4. Admin assigns booth to application', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/admin/booths/${boothId}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ boothListingId });

    expect(res.status).toBe(200);
    expect(res.body.boothListingId).toBe(boothListingId);
  });

  it('5. Admin tries to delete occupied booth (blocked)', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/admin/booths/${boothId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Unassign');
  });

  it('6. Public endpoint shows correct shape with expanded vendor data', async () => {
    const res = await request(app.getHttpServer()).get(`/bazaars/${bazaarId}/layout`);

    expect(res.status).toBe(200);
    expect(res.body.bazaarId).toBe(bazaarId);
    expect(res.body.gridConfig.rows).toBe(10);
    expect(res.body.booths).toHaveLength(2);

    const assignedBooth = res.body.booths.find((b: any) => b.label === 'A1');
    expect(assignedBooth.vendor).not.toBeNull();
    expect(assignedBooth.vendor.businessName).toBe('Vendor Booths');

    const emptyBooth = res.body.booths.find((b: any) => b.label === 'A2');
    expect(emptyBooth.vendor).toBeNull();
  });

  it('7. Admin unassigns booth', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/admin/booths/${boothId}/unassign`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.boothListingId).toBeNull();
  });

  it('8. Admin deletes empty booth successfully', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/admin/booths/${boothId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
  });
});
