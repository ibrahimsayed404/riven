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

  // Dependency order, so leftovers from any other suite (products, orders,
  // ratings, booths) can't block the vendor/user deletes (same as booths.e2e).
  async function wipe() {
    await prisma.rating.deleteMany(); // Rating.orderId is RESTRICT: before orders
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    await prisma.orderGroup.deleteMany();
    await prisma.cartItem.deleteMany();
    await prisma.cart.deleteMany(); // Cart.userId is RESTRICT: before users
    await prisma.productVariant.deleteMany();
    await prisma.product.deleteMany();
    await prisma.booth.deleteMany();
    await prisma.boothLayout.deleteMany();
    await prisma.boothListing.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.adminAuditLog.deleteMany();
    await prisma.user.deleteMany();
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();

    prisma = app.get(PrismaService);

    await wipe();

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
    // close() even if the wipe throws: an unclosed app keeps its BullMQ workers
    // alive, jest never exits, and those workers go on consuming the shared queue.
    try {
      await wipe();
    } finally {
      await app.close();
    }
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

  it('1b. Admin queue lists the organizer as pending; reject + re-verify round-trip with audit rows', async () => {
    const pending = await request(app.getHttpServer())
      .get('/admin/organizers?status=pending')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const row = pending.body.data.find((o: any) => o.id === organizerId);
    expect(row).toBeDefined();
    expect(row.owner.email).toBe('org1@example.com');

    const rejected = await request(app.getHttpServer())
      .patch(`/admin/organizers/${organizerId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Need proof of venue booking' })
      .expect(200);
    expect(rejected.body).toEqual({ id: organizerId, verified: false, rejectionReason: 'Need proof of venue booking' });

    const me = await request(app.getHttpServer())
      .get('/organizers/me')
      .set('Authorization', `Bearer ${organizerToken}`)
      .expect(200);
    expect(me.body.rejectionReason).toBe('Need proof of venue booking');

    // Same reason again: 200, no second audit row.
    await request(app.getHttpServer())
      .patch(`/admin/organizers/${organizerId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Need proof of venue booking' })
      .expect(200);

    const audit = await prisma.adminAuditLog.findMany({ where: { targetId: organizerId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'ORGANIZER_REJECTED', targetType: 'ORGANIZER', reason: 'Need proof of venue booking' });
  });

  it('2. Admin verifies Organizer', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/admin/organizers/${organizerId}/verify`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.rejectionReason).toBeNull();

    const audit = await prisma.adminAuditLog.findMany({ where: { targetId: organizerId }, orderBy: { createdAt: 'desc' } });
    expect(audit).toHaveLength(2);
    expect(audit[0].action).toBe('ORGANIZER_VERIFIED');
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

  // Found by the live endpoint run on 2026-09-26: a backwards range was accepted,
  // and the completion job would end such a bazaar before it opens.
  it('3b. endDate before startDate is refused on create and update, and by the DB constraint', async () => {
    const start = new Date(Date.now() + 10 * 86_400_000);
    const before = new Date(start.getTime() - 86_400_000).toISOString();

    const created = await request(app.getHttpServer())
      .post('/organizers/me/bazaars')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Backwards', lat: 30, lng: 31, scheduleType: ScheduleType.ONE_OFF, startDate: start.toISOString(), endDate: before });
    expect(created.status).toBe(400);
    expect(created.body.code).toBe('BAZAAR_END_BEFORE_START');

    // Partial update: the new endDate is checked against the stored startDate.
    const patched = await request(app.getHttpServer())
      .patch(`/organizers/me/bazaars/${bazaarId}`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ endDate: new Date(Date.now() - 86_400_000).toISOString() });
    expect(patched.status).toBe(400);
    expect(patched.body.code).toBe('BAZAAR_END_BEFORE_START');

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "bazaars" SET "endDate" = "startDate" - interval '1 day' WHERE "id" = $1`,
        bazaarId,
      ),
    ).rejects.toThrow(/bazaars_end_date_not_before_start/);
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
    expect(res.body.meta.total).toBe(1);

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

  it('11. Organizer cancel; cancelling again is a 200 no-op that writes nothing', async () => {
    const cancel = () =>
      request(app.getHttpServer())
        .patch(`/organizers/me/bazaars/${bazaarId}/cancel`)
        .set('Authorization', `Bearer ${organizerToken}`);

    const first = await cancel();
    expect(first.status).toBe(200);
    expect(first.body.status).toBe(BazaarStatus.CANCELLED);

    const second = await cancel();
    expect(second.status).toBe(200);
    expect(second.body.status).toBe(BazaarStatus.CANCELLED);
    expect(second.body.updatedAt).toBe(first.body.updatedAt);
  });
});
