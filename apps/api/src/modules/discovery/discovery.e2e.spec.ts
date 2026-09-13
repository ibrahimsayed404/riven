import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BazaarStatus, FavorableType, Role, ScheduleType } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as request from 'supertest';

import { AppModule } from '../../app.module';
import { PrismaService } from '../../infra/prisma/prisma.service';

// Tahrir Square. Every fixture below is offset north of this point so the
// expected ordering is a straight function of latitude.
const ORIGIN = { lat: 30.0444, lng: 31.2357 };

const DAY = 24 * 60 * 60 * 1000;
const past = (days: number) => new Date(Date.now() - days * DAY);
const future = (days: number) => new Date(Date.now() + days * DAY);

describe('DiscoveryModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let organizerId: string;
  let shopperId: string;
  let shopperToken: string;

  const ids: Record<string, string> = {};

  async function seedBazaar(opts: {
    name: string;
    lat: number;
    lng: number;
    startDate: Date;
    endDate: Date | null;
    status?: BazaarStatus;
    scheduleType?: ScheduleType;
    recurrenceRule?: string | null;
    deletedAt?: Date | null;
  }): Promise<string> {
    const id = randomUUID();

    // Seeded with raw SQL rather than through the organizer API: this suite is
    // testing the spatial query, and Prisma Client cannot write a geography column.
    await prisma.$executeRaw`
      INSERT INTO "bazaars" (
        "id", "organizerId", "name", "description", "coverMedia",
        "scheduleType", "recurrenceRule", "startDate", "endDate", "status",
        "createdAt", "updatedAt", "deletedAt", "location"
      ) VALUES (
        ${id}, ${organizerId}, ${opts.name}, NULL, ARRAY[]::text[],
        ${opts.scheduleType ?? ScheduleType.ONE_OFF}::"ScheduleType",
        ${opts.recurrenceRule ?? null},
        ${opts.startDate}::timestamp,
        ${opts.endDate}::timestamp,
        ${opts.status ?? BazaarStatus.PUBLISHED}::"BazaarStatus",
        NOW(), NOW(), ${opts.deletedAt ?? null}::timestamp,
        ST_SetSRID(ST_MakePoint(${opts.lng}, ${opts.lat}), 4326)::geography
      )
    `;

    return id;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Mirrors main.ts exactly. transform:true is load-bearing here — without it
    // @Type(() => Number) never runs and every lat/lng arrives as a string.
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

    await prisma.favorite.deleteMany();
    await prisma.boothListing.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.user.deleteMany();

    const shopper = await prisma.user.create({
      data: {
        email: 'discovery-shopper@example.com',
        passwordHash: 'hash',
        name: 'Discovery Shopper',
        role: Role.SHOPPER,
      },
    });
    shopperId = shopper.id;
    shopperToken = await jwtService.signAsync({ sub: shopperId, role: Role.SHOPPER });

    const owner = await prisma.user.create({
      data: {
        email: 'discovery-org@example.com',
        passwordHash: 'hash',
        name: 'Discovery Org Owner',
        role: Role.ORGANIZER,
      },
    });
    const organizer = await prisma.organizer.create({
      data: { ownerId: owner.id, name: 'Discovery Org', verified: true },
    });
    organizerId = organizer.id;

    // ~0.62 km north of origin
    ids.near = await seedBazaar({
      name: 'Near Bazaar',
      lat: 30.05,
      lng: ORIGIN.lng,
      startDate: future(3),
      endDate: future(4),
    });

    await prisma.favorite.create({
      data: {
        userId: shopperId,
        favorableType: FavorableType.BAZAAR,
        favorableId: ids.near,
      },
    });
    // ~5.1 km
    ids.mid = await seedBazaar({
      name: 'Mid Bazaar',
      lat: 30.09,
      lng: ORIGIN.lng,
      startDate: future(2),
      endDate: future(3),
    });
    // ~17.3 km
    ids.far = await seedBazaar({
      name: 'Far Bazaar',
      lat: 30.2,
      lng: ORIGIN.lng,
      startDate: future(1),
      endDate: future(2),
    });
    // Tanta — ~85 km away, comfortably outside the 25 km default radius but within 150 km
    ids.tanta = await seedBazaar({
      name: 'Tanta Bazaar',
      lat: 30.7865,
      lng: 31.0004,
      startDate: future(1),
      endDate: future(2),
    });
    // Finished last week: excluded unless upcomingOnly=false
    ids.past = await seedBazaar({
      name: 'Past Bazaar',
      lat: 30.0455,
      lng: ORIGIN.lng,
      startDate: past(9),
      endDate: past(7),
    });
    // Started months ago, no end date. Stays visible: nothing expands RRULE yet
    // and transitionPastOneOffBazaars never completes RECURRING bazaars.
    ids.recurring = await seedBazaar({
      name: 'Recurring Bazaar',
      lat: 30.0465,
      lng: ORIGIN.lng,
      startDate: past(90),
      endDate: null,
      scheduleType: ScheduleType.RECURRING,
      recurrenceRule: 'FREQ=WEEKLY;BYDAY=FR',
    });
    ids.draft = await seedBazaar({
      name: 'Draft Bazaar',
      lat: 30.0446,
      lng: ORIGIN.lng,
      startDate: future(3),
      endDate: future(4),
      status: BazaarStatus.DRAFT,
    });
    ids.deleted = await seedBazaar({
      name: 'Deleted Bazaar',
      lat: 30.0447,
      lng: ORIGIN.lng,
      startDate: future(3),
      endDate: future(4),
      deletedAt: past(1),
    });
  });

  afterAll(async () => {
    await prisma.favorite.deleteMany();
    await prisma.boothListing.deleteMany();
    await prisma.bazaar.deleteMany();
    await prisma.organizer.deleteMany();
    await prisma.vendor.deleteMany();
    await prisma.user.deleteMany();
    await app.close();
  });

  const discover = (query: string, token?: string) => {
    const req = request(app.getHttpServer()).get(`/discovery/bazaars${query}`);
    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req;
  };

  describe('distance ordering', () => {
    it('returns published bazaars nearest first', async () => {
      const res = await discover(`?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=25`);

      expect(res.status).toBe(200);

      const names = res.body.data.map((b: { name: string }) => b.name);
      expect(names).toEqual(['Recurring Bazaar', 'Near Bazaar', 'Mid Bazaar', 'Far Bazaar']);
    });

    it('reports distances that ascend and agree with distanceKm', async () => {
      const res = await discover(`?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=25`);

      const metres = res.body.data.map((b: { distanceMeters: number }) => b.distanceMeters);
      expect(metres).toEqual([...metres].sort((a: number, b: number) => a - b));

      for (const bazaar of res.body.data) {
        expect(bazaar.distanceKm).toBeCloseTo(bazaar.distanceMeters / 1000, 2);
      }
    });

    it('excludes anything beyond the radius', async () => {
      const res = await discover(`?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=25`);

      const returned = res.body.data.map((b: { id: string }) => b.id);
      expect(returned).not.toContain(ids.tanta);
    });

    it('includes a distant bazaar once the radius is widened', async () => {
      const res = await discover(`?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=150`);

      const returned = res.body.data.map((b: { id: string }) => b.id);
      expect(returned).toContain(ids.tanta);
    });
  });

  describe('visibility gating', () => {
    it('hides DRAFT and soft-deleted bazaars', async () => {
      const res = await discover(`?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=25`);

      const returned = res.body.data.map((b: { id: string }) => b.id);
      expect(returned).not.toContain(ids.draft);
      expect(returned).not.toContain(ids.deleted);
    });

    it('hides a finished bazaar by default', async () => {
      const res = await discover(`?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=25`);

      const returned = res.body.data.map((b: { id: string }) => b.id);
      expect(returned).not.toContain(ids.past);
    });

    it('reveals a finished bazaar when upcomingOnly=false', async () => {
      const res = await discover(
        `?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=25&upcomingOnly=false`,
      );

      const returned = res.body.data.map((b: { id: string }) => b.id);
      expect(returned).toContain(ids.past);
    });

    it('keeps a RECURRING bazaar visible despite a long-past start date', async () => {
      const res = await discover(`?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=25`);

      const returned = res.body.data.map((b: { id: string }) => b.id);
      expect(returned).toContain(ids.recurring);
    });

    it('filters by scheduleType', async () => {
      const res = await discover(
        `?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=25&scheduleType=RECURRING`,
      );

      const returned = res.body.data.map((b: { id: string }) => b.id);
      expect(returned).toEqual([ids.recurring]);
    });

    it('omits internal columns', async () => {
      const res = await discover(`?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=25`);

      expect(res.body.data[0]).not.toHaveProperty('status');
      expect(res.body.data[0]).not.toHaveProperty('deletedAt');
      expect(res.body.data[0]).not.toHaveProperty('createdAt');
      expect(res.body.data[0]).not.toHaveProperty('updatedAt');
      expect(res.body.data[0].isFavorite).toBe(false);
    });
  });

  describe('keyset pagination', () => {
    it('walks the whole feed without repeating or skipping a row', async () => {
      const first = await discover(`?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=25&limit=2`);

      expect(first.status).toBe(200);
      expect(first.body.data).toHaveLength(2);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const second = await discover(
        `?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=25&limit=2&cursor=${encodeURIComponent(
          first.body.nextCursor,
        )}`,
      );

      expect(second.status).toBe(200);
      expect(second.body.data).toHaveLength(2);
      expect(second.body.nextCursor).toBeNull();

      const walked = [...first.body.data, ...second.body.data].map((b: { id: string }) => b.id);
      expect(new Set(walked).size).toBe(4);
    });
  });

  describe('no-origin fallback', () => {
    it('sorts by startDate and returns null distances', async () => {
      const res = await discover('');

      expect(res.status).toBe(200);
      expect(res.body.data[0].distanceMeters).toBeNull();
      expect(res.body.data[0].distanceKm).toBeNull();

      const starts = res.body.data.map((b: { startDate: string }) => Date.parse(b.startDate));
      expect(starts).toEqual([...starts].sort((a: number, b: number) => a - b));
    });
  });

  describe('validation', () => {
    it('rejects lat without lng', async () => {
      const res = await discover(`?lat=${ORIGIN.lat}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a radius beyond the 150 km ceiling', async () => {
      const res = await discover(`?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}&radiusKm=500`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an unknown query parameter', async () => {
      const res = await discover('?sortBy=name');

      expect(res.status).toBe(400);
    });

    it('rejects a malformed cursor with INVALID_CURSOR', async () => {
      const res = await discover('?cursor=not-a-real-cursor');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CURSOR');
    });
  });

  describe('isFavorite resolution', () => {
    it('returns isFavorite: true for an authenticated request on a favorited bazaar and false for unfavorited', async () => {
      const res = await discover(`?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`, shopperToken);
      expect(res.status).toBe(200);

      const nearBazaar = res.body.data.find((b: { id: string }) => b.id === ids.near);
      const otherBazaar = res.body.data.find((b: { id: string }) => b.id === ids.mid);

      expect(nearBazaar).toBeDefined();
      expect(nearBazaar.isFavorite).toBe(true);
      expect(otherBazaar).toBeDefined();
      expect(otherBazaar.isFavorite).toBe(false);
    });

    it('returns isFavorite: false for all bazaars on an anonymous request', async () => {
      const res = await discover(`?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`);
      expect(res.status).toBe(200);

      const nearBazaar = res.body.data.find((b: { id: string }) => b.id === ids.near);
      expect(nearBazaar).toBeDefined();
      expect(nearBazaar.isFavorite).toBe(false);
    });
  });
});
