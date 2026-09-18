import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AppModule } from '../../app.module';
import { Role, ApplicationStatus, BazaarStatus, ScheduleType } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';

describe('BazaarsModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminToken: string;
  let organizerToken: string;
  let vendorToken: string;

  let organizerId: string;
  let vendorId: string;
  let bazaarId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();

    prisma = app.get(PrismaService);

    // Clean up database before tests
    await prisma.boothListing.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.user.deleteMany();

    // Create Admin
    const admin = await prisma.user.create({
      data: { email: 'admin-bazaar@example.com', passwordHash: 'hash', name: 'Admin', role: Role.ADMIN },
    });
    const jwtService = app.get(JwtService);
    adminToken = await jwtService.signAsync({
      sub: admin.id,
      role: Role.ADMIN,
    });

    // Create Organizer (via registration)
    const orgRes = await request(app.getHttpServer())
      .post('/auth/register/organizer')
      .send({ email: 'org1@example.com', password: 'Password123!', name: 'Org Owner', organizationName: 'Org Corp' });
    expect(orgRes.status).toBe(201);
    organizerToken = orgRes.body.accessToken;

    const orgUser = await prisma.user.findUnique({ where: { email: 'org1@example.com' }, include: { organizer: true }});
    organizerId = orgUser!.organizer!.id;

    // Create Vendor
    const vendorRes = await request(app.getHttpServer())
      .post('/auth/register/vendor')
      .send({ email: 'ven1@example.com', password: 'Password123!', name: 'Ven Owner', businessName: 'Ven Corp', category: 'FASHION', vendorType: 'BAZAAR_ONLY' });
    expect(vendorRes.status).toBe(201);
    vendorToken = vendorRes.body.accessToken;
    
    const vendorUser = await prisma.user.findUnique({ where: { email: 'ven1@example.com' }, include: { vendor: true }});
    vendorId = vendorUser!.vendor!.id;
  });

  afterAll(async () => {
    await prisma.boothListing.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.user.deleteMany();
    await app.close();
  });

  it('1. Organizer fails to create bazaar before verification', async () => {
    const res = await request(app.getHttpServer())
      .post('/organizers/me/bazaars')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        name: 'Unverified Bazaar',
        lat: 10,
        lng: 10,
        scheduleType: ScheduleType.ONE_OFF,
        startDate: new Date().toISOString(),
      });
    expect(res.status).toBe(403);
  });

  it('2. Admin verifies Organizer', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/admin/organizers/${organizerId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });

  it('3. Verified Organizer creates a Bazaar', async () => {
    const res = await request(app.getHttpServer())
      .post('/organizers/me/bazaars')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        name: 'My Cool Bazaar',
        lat: 30.0444,
        lng: 31.2357,
        scheduleType: ScheduleType.ONE_OFF,
        startDate: new Date().toISOString(),
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe(BazaarStatus.DRAFT);
    bazaarId = res.body.id;
  });

  it('4. Admin verifies Vendor', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/admin/vendors/${vendorId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('5. Vendor fails to apply to DRAFT bazaar', async () => {
    const res = await request(app.getHttpServer())
      .post(`/bazaars/${bazaarId}/apply`)
      .set('Authorization', `Bearer ${vendorToken}`);
    expect(res.status).toBe(400); // Bad Request because not PUBLISHED
  });

  it('6. Organizer publishes the Bazaar', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/organizers/me/bazaars/${bazaarId}/publish`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(BazaarStatus.PUBLISHED);
  });

  it('7. Vendor applies to PUBLISHED bazaar', async () => {
    const res = await request(app.getHttpServer())
      .post(`/bazaars/${bazaarId}/apply`)
      .set('Authorization', `Bearer ${vendorToken}`);
    expect(res.status).toBe(201);
    expect(res.body.applicationStatus).toBe(ApplicationStatus.PENDING);
  });

  it('7b. Vendor application list embeds the bazaar with its location', async () => {
    const res = await request(app.getHttpServer())
      .get('/vendors/me/bazaar-applications')
      .set('Authorization', `Bearer ${vendorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);

    const [row] = res.body.data;
    expect(row.bazaarId).toBe(bazaarId);
    expect(row.applicationStatus).toBe(ApplicationStatus.PENDING);
    expect(row.bazaar).toEqual(
      expect.objectContaining({
        id: bazaarId,
        name: 'My Cool Bazaar',
        status: BazaarStatus.PUBLISHED,
        coverMedia: [],
        location: { lat: 30.0444, lng: 31.2357 },
      }),
    );
    expect(typeof row.bazaar.startDate).toBe('string');
    // Only the summary fields — the organizer's internals stay out.
    expect(row.bazaar).not.toHaveProperty('organizerId');
  });

  it('8. Vendor cannot apply twice', async () => {
    const res = await request(app.getHttpServer())
      .post(`/bazaars/${bazaarId}/apply`)
      .set('Authorization', `Bearer ${vendorToken}`);
    expect(res.status).toBe(409); // Conflict
  });

  it('9. Organizer accepts application', async () => {
    // Get applications first to get the ID
    const appsRes = await request(app.getHttpServer())
      .get(`/organizers/me/bazaars/${bazaarId}/applications`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(appsRes.status).toBe(200);
    const appId = appsRes.body.data[0].id;

    const res = await request(app.getHttpServer())
      .patch(`/organizers/me/bazaars/${bazaarId}/applications/${appId}/accept`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.applicationStatus).toBe(ApplicationStatus.ACCEPTED);
  });

  it('10. Public endpoint shows Bazaar with accepted vendors', async () => {
    const res = await request(app.getHttpServer())
      .get(`/bazaars/${bazaarId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(BazaarStatus.PUBLISHED);
    expect(res.body.acceptedVendors).toHaveLength(1);
    expect(res.body.acceptedVendors[0].vendorId).toBe(vendorId);
  });
});
