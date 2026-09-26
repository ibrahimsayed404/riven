import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { Prisma, Bazaar, BoothListing, BazaarStatus, ApplicationStatus, ScheduleType } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { PUBLIC_BAZAAR_WHERE, PUBLIC_ORGANIZER_SQL, PUBLIC_ORGANIZER_WHERE } from './bazaar-visibility';

export type BazaarWithLocation = Omit<Bazaar, 'location'> & {
  location: { lat: number; lng: number } | null;
};

export type BazaarPublicDetail = BazaarWithLocation & {
  acceptedVendors: { vendorId: string; businessName: string; logo: string | null }[];
};

export type BazaarWithDistance = BazaarWithLocation & {
  distanceMeters: number | null;
};

/** A batch of ids for keyset iteration (reindex). */
export type IdPage = { ids: string[]; nextCursor: string | null };
// What a vendor sees in their own applications list: the listing plus enough
// of the bazaar to render a row without a second request.
export type VendorApplication = BoothListing & {
  bazaar: Pick<Bazaar, 'id' | 'name' | 'coverMedia' | 'startDate' | 'endDate' | 'status'> & {
    location: { lat: number; lng: number } | null;
  };
};

// Admin row: every scalar column (Prisma can't select the geography one — the
// page's locations are merged in from one raw query) plus the organizer, so the
// list renders without a second request. /admin/* only, never public.
const adminBazaarRowSelect = {
  id: true,
  organizerId: true,
  name: true,
  description: true,
  coverMedia: true,
  scheduleType: true,
  recurrenceRule: true,
  startDate: true,
  endDate: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  organizer: { select: { id: true, name: true, verified: true } },
} satisfies Prisma.BazaarSelect;

export type AdminBazaarRow = Prisma.BazaarGetPayload<{ select: typeof adminBazaarRowSelect }> & {
  location: { lat: number; lng: number } | null;
};

export type AdminBazaarDetail = AdminBazaarRow & {
  applicationCounts: Record<ApplicationStatus, number>;
  hasLayout: boolean;
};

// Admin application row: the listing plus enough of both sides — and the booth,
// if one is assigned — to render without a second request. /admin/* only.
const adminApplicationSelect = {
  id: true,
  bazaarId: true,
  vendorId: true,
  applicationStatus: true,
  appliedAt: true,
  decidedAt: true,
  bazaar: { select: { id: true, name: true, status: true, startDate: true } },
  vendor: { select: { id: true, name: true, verified: true } },
  booth: { select: { id: true, label: true } },
} satisfies Prisma.BoothListingSelect;

export type AdminApplication = Prisma.BoothListingGetPayload<{ select: typeof adminApplicationSelect }>;

@Injectable()
export class BazaarsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: { name: string; description?: string; coverMedia?: string[]; lat: number; lng: number; scheduleType: ScheduleType; recurrenceRule?: string; startDate: string | Date; endDate?: string | Date; organizerId: string; status: BazaarStatus; }): Promise<BazaarWithLocation> {
    const { lat, lng, ...rest } = data;
    const id = crypto.randomUUID();

    // Since 'location' is an Unsupported type, Prisma omits '.create' on the delegate.
    // We must use $executeRaw for the initial insert.
    await this.prisma.$executeRaw`
      INSERT INTO "bazaars" (
        "id", "organizerId", "name", "description", "coverMedia",
        "scheduleType", "recurrenceRule", "startDate", "endDate", "status",
        "createdAt", "updatedAt", "location"
      ) VALUES (
        ${id}, ${rest.organizerId}, ${rest.name}, ${rest.description ?? null}, ${rest.coverMedia ?? []},
        ${rest.scheduleType}::"ScheduleType", ${rest.recurrenceRule ?? null}, ${rest.startDate}::timestamp, ${rest.endDate ?? null}::timestamp, ${rest.status}::"BazaarStatus",
        NOW(), NOW(), ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      )
    `;

    return this.findById(id) as Promise<BazaarWithLocation>;
  }

  async findById(id: string): Promise<BazaarWithLocation | null> {
    const bazaars = await this.prisma.$queryRaw<
      (Bazaar & { lat: number | null; lng: number | null })[]
    >`
      SELECT
        "id", "organizerId", "name", "description", "coverMedia",
        "scheduleType", "recurrenceRule", "startDate", "endDate", "status",
        "createdAt", "updatedAt", "deletedAt",
        ST_Y("location"::geometry) AS "lat",
        ST_X("location"::geometry) AS "lng"
      FROM "bazaars"
      WHERE "id" = ${id}
    `;

    if (!bazaars.length) {
      return null;
    }

    const { lat, lng, ...rest } = bazaars[0];
    return {
      ...rest,
      location: lat !== null && lng !== null ? { lat, lng } : null,
    };
  }

  /** A bazaar shoppers may rate: it has been published (running or finished) and is not deleted. */
  async isRateable(id: string): Promise<boolean> {
    const count = await this.prisma.bazaar.count({
      where: {
        id,
        deletedAt: null,
        status: { in: [BazaarStatus.PUBLISHED, BazaarStatus.COMPLETED] },
        organizer: PUBLIC_ORGANIZER_WHERE,
      },
    });
    return count > 0;
  }

  /** The organizer half of the visibility rule, for callers that already hold a bazaar row. */
  async hasPublicOrganizer(organizerId: string): Promise<boolean> {
    const count = await this.prisma.organizer.count({ where: { id: organizerId, ...PUBLIC_ORGANIZER_WHERE } });
    return count > 0;
  }

  /** Every bazaar of an organizer, any status, keyset-paged — for the ORGANIZER_BAZAARS fan-out. */
  async listIdsByOrganizer(organizerId: string, cursor: string | null, take: number): Promise<IdPage> {
    const where: Prisma.BazaarWhereInput = { organizerId };
    const rows = await this.prisma.bazaar.findMany({
      where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const ids = rows.slice(0, take).map((row) => row.id);
    return { ids, nextCursor: hasMore ? ids[ids.length - 1] : null };
  }

  async findPublicById(id: string): Promise<BazaarPublicDetail | null> {
    const bazaar = await this.findById(id);
    if (!bazaar || bazaar.status !== BazaarStatus.PUBLISHED || bazaar.deletedAt) {
      return null;
    }
    if (!(await this.hasPublicOrganizer(bazaar.organizerId))) {
      return null;
    }

    // A revoked or self-deleted vendor is invisible everywhere else; keep the
    // bazaar page consistent with that.
    const listings = await this.prisma.boothListing.findMany({
      where: {
        bazaarId: id,
        applicationStatus: ApplicationStatus.ACCEPTED,
        vendor: { verified: true, deletedAt: null },
      },
      include: {
        vendor: {
          select: {
            name: true,
            logo: true,
          },
        },
      },
    });

    return {
      ...bazaar,
      acceptedVendors: listings.map((l) => ({
        vendorId: l.vendorId,
        businessName: l.vendor.name, // the vendor's 'name' property maps to businessName in spec
        logo: l.vendor.logo,
      })),
    };
  }

  async findByOrganizerIdPaginated(
    organizerId: string,
    page: number,
    limit: number,
  ): Promise<{ data: BazaarWithLocation[]; total: number }> {
    const offset = (page - 1) * limit;

    const totalRes = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count FROM "bazaars" WHERE "organizerId" = ${organizerId}
    `;
    const total = Number(totalRes[0].count);

    const bazaars = await this.prisma.$queryRaw<
      (Bazaar & { lat: number | null; lng: number | null })[]
    >`
      SELECT
        "id", "organizerId", "name", "description", "coverMedia",
        "scheduleType", "recurrenceRule", "startDate", "endDate", "status",
        "createdAt", "updatedAt", "deletedAt",
        ST_Y("location"::geometry) AS "lat",
        ST_X("location"::geometry) AS "lng"
      FROM "bazaars"
      WHERE "organizerId" = ${organizerId}
      ORDER BY "createdAt" DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return {
      data: bazaars.map(({ lat, lng, ...rest }) => ({
        ...rest,
        location: lat !== null && lng !== null ? { lat, lng } : null,
      })),
      total,
    };
  }

  async findPublicPaginated(
    page: number,
    limit: number,
    filters: { lat?: number; lng?: number; radiusKm?: number; scheduleType?: ScheduleType },
  ): Promise<{ data: BazaarWithLocation[]; total: number }> {
    const offset = (page - 1) * limit;

    // Base conditions
    const conditions = [
      Prisma.sql`"status" = 'PUBLISHED'::"BazaarStatus"`,
      Prisma.sql`"deletedAt" IS NULL`,
      PUBLIC_ORGANIZER_SQL, // spec3 B8b: a rejected or deleted organizer hides their bazaars
    ];

    if (filters.scheduleType) {
      conditions.push(Prisma.sql`"scheduleType" = ${filters.scheduleType}::"ScheduleType"`);
    }

    if (filters.lat !== undefined && filters.lng !== undefined && filters.radiusKm !== undefined) {
      conditions.push(
        Prisma.sql`ST_DWithin("location", ST_SetSRID(ST_MakePoint(${filters.lng}, ${filters.lat}), 4326)::geography, ${filters.radiusKm * 1000})`
      );
    }

    const whereClause = Prisma.sql`${Prisma.join(conditions, ' AND ')}`;

    const totalRes = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count FROM "bazaars" WHERE ${whereClause}
    `;
    const total = Number(totalRes[0].count);

    const bazaars = await this.prisma.$queryRaw<
      (Bazaar & { lat: number | null; lng: number | null })[]
    >`
      SELECT
        "id", "organizerId", "name", "description", "coverMedia",
        "scheduleType", "recurrenceRule", "startDate", "endDate", "status",
        "createdAt", "updatedAt", "deletedAt",
        ST_Y("location"::geometry) AS "lat",
        ST_X("location"::geometry) AS "lng"
      FROM "bazaars"
      WHERE ${whereClause}
      ORDER BY "createdAt" DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return {
      data: bazaars.map(({ lat, lng, ...rest }) => ({
        ...rest,
        location: lat !== null && lng !== null ? { lat, lng } : null,
      })),
      total,
    };
  }

  /**
   * Distance-sorted feed of published bazaars, backing GET /discovery/bazaars.
   *
   * Keyset paginated rather than offset: there is no COUNT query, and the
   * caller detects "more pages" from the extra row this fetches (LIMIT n + 1).
   */
  async findNearby(
    filters: {
      lat?: number;
      lng?: number;
      radiusKm: number;
      scheduleType?: ScheduleType;
      upcomingOnly: boolean;
    },
    limit: number,
    cursor?: { sortValue: number | Date; id: string },
  ): Promise<{ data: BazaarWithDistance[]; hasMore: boolean }> {
    // The DTO guarantees lat/lng arrive together, so testing one is enough.
    // Built once and reused in SELECT / ST_DWithin / ORDER BY so the
    // lng-then-lat argument order cannot drift between them.
    const origin =
      filters.lat !== undefined && filters.lng !== undefined
        ? Prisma.sql`ST_SetSRID(ST_MakePoint(${filters.lng}, ${filters.lat}), 4326)::geography`
        : null;

    const distanceExpr = origin
      ? Prisma.sql`ST_Distance("location", ${origin})`
      : Prisma.sql`NULL::double precision`;

    const conditions = [
      Prisma.sql`"status" = 'PUBLISHED'::"BazaarStatus"`,
      Prisma.sql`"deletedAt" IS NULL`,
      PUBLIC_ORGANIZER_SQL, // spec3 B8b: a rejected or deleted organizer hides their bazaars
    ];

    if (filters.scheduleType) {
      conditions.push(Prisma.sql`"scheduleType" = ${filters.scheduleType}::"ScheduleType"`);
    }

    if (origin) {
      conditions.push(Prisma.sql`ST_DWithin("location", ${origin}, ${filters.radiusKm * 1000})`);
    }

    // RECURRING bazaars have no dependable end date until RRULE expansion exists,
    // and transitionPastOneOffBazaars deliberately never completes them — so they
    // stay visible regardless of how long ago their first occurrence started.
    if (filters.upcomingOnly) {
      conditions.push(Prisma.sql`(
        "scheduleType" = 'RECURRING'::"ScheduleType"
        OR ("endDate" IS NOT NULL AND "endDate" >= NOW())
        OR ("endDate" IS NULL AND "startDate" >= NOW() - INTERVAL '1 day')
      )`);
    }

    if (cursor) {
      conditions.push(
        origin
          ? Prisma.sql`(${distanceExpr}, "id") > (${cursor.sortValue}::double precision, ${cursor.id})`
          : Prisma.sql`("startDate", "id") > (${cursor.sortValue}, ${cursor.id})`,
      );
    }

    const whereClause = Prisma.sql`${Prisma.join(conditions, ' AND ')}`;
    const orderBy = origin
      ? Prisma.sql`${distanceExpr} ASC, "id" ASC`
      : Prisma.sql`"startDate" ASC, "id" ASC`;

    const rows = await this.prisma.$queryRaw<
      (Bazaar & { lat: number | null; lng: number | null; distanceMeters: number | null })[]
    >`
      SELECT
        "id", "organizerId", "name", "description", "coverMedia",
        "scheduleType", "recurrenceRule", "startDate", "endDate", "status",
        "createdAt", "updatedAt", "deletedAt",
        ST_Y("location"::geometry) AS "lat",
        ST_X("location"::geometry) AS "lng",
        ${distanceExpr} AS "distanceMeters"
      FROM "bazaars"
      WHERE ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: page.map(({ lat, lng, distanceMeters, ...rest }) => ({
        ...rest,
        location: lat !== null && lng !== null ? { lat, lng } : null,
        distanceMeters,
      })),
      hasMore,
    };
  }

  async update(id: string, data: Prisma.BazaarUpdateInput & { lat?: number; lng?: number }): Promise<BazaarWithLocation> {
    const { lat, lng, ...rest } = data;

    if (Object.keys(rest).length > 0) {
      await this.prisma.bazaar.update({
        where: { id },
        data: rest as any,
      });
    }

    if (lat !== undefined && lng !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE "bazaars"
        SET "location" = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
        WHERE "id" = ${id}
      `;
    }

    return this.findById(id) as Promise<BazaarWithLocation>;
  }

  async updateStatus(id: string, status: BazaarStatus): Promise<BazaarWithLocation> {
    await this.prisma.bazaar.update({
      where: { id },
      data: { status },
    });

    return this.findById(id) as Promise<BazaarWithLocation>;
  }

  /**
   * Returns the ids it completed (not just a count) so the caller can drop
   * them from the search index — a COMPLETED bazaar is no longer public.
   *
   * A ONE_OFF bazaar with no endDate is a single-day event: it stays PUBLISHED
   * for one day after startDate, the same grace window findNearby applies, so
   * shoppers can still find it while it is running.
   */
  async transitionPastOneOffBazaars(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "bazaars"
      SET "status" = 'COMPLETED'::"BazaarStatus"
      WHERE "scheduleType" = 'ONE_OFF'::"ScheduleType"
        AND "status" = 'PUBLISHED'::"BazaarStatus"
        AND (
          ("endDate" IS NOT NULL AND "endDate" < NOW())
          OR
          ("endDate" IS NULL AND "startDate" < NOW() - INTERVAL '1 day')
        )
      RETURNING "id"
    `;
    return rows.map((row) => row.id);
  }

  /** Publicly visible bazaar ids, keyset-paged, for reindexing. */
  async listPublicIds(cursor: string | null, take: number): Promise<IdPage> {
    const where: Prisma.BazaarWhereInput = PUBLIC_BAZAAR_WHERE;
    const rows = await this.prisma.bazaar.findMany({
      where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const ids = rows.slice(0, take).map((row) => row.id);
    return { ids, nextCursor: hasMore ? ids[ids.length - 1] : null };
  }

  // --- BoothListing (Applications) ---

  createApplication(bazaarId: string, vendorId: string): Promise<BoothListing> {
    return this.prisma.boothListing.create({
      data: { bazaarId, vendorId },
    });
  }

  findApplication(bazaarId: string, vendorId: string): Promise<BoothListing | null> {
    return this.prisma.boothListing.findUnique({
      where: {
        bazaarId_vendorId: { bazaarId, vendorId },
      },
    });
  }

  findApplicationById(id: string): Promise<BoothListing | null> {
    return this.prisma.boothListing.findUnique({
      where: { id },
    });
  }

  deleteApplication(id: string): Promise<BoothListing> {
    return this.prisma.boothListing.delete({
      where: { id },
    });
  }

  async findVendorApplicationsPaginated(
    vendorId: string,
    page: number,
    limit: number,
    applicationStatus?: ApplicationStatus,
  ): Promise<{ data: VendorApplication[]; total: number }> {
    const where: Prisma.BoothListingWhereInput = { vendorId };
    if (applicationStatus) {
      where.applicationStatus = applicationStatus;
    }

    const { rows, total } = await this.prisma.$transaction(async (tx) => {
      const total = await tx.boothListing.count({ where });
      const rows = await tx.boothListing.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { appliedAt: 'desc' },
        include: {
          bazaar: {
            select: {
              id: true,
              name: true,
              coverMedia: true,
              startDate: true,
              endDate: true,
              status: true,
            },
          },
        },
      });
      return { rows, total };
    });

    // Prisma can't select the geography column, so the page's locations come
    // from one raw query and are merged here rather than fetched per row.
    const locations = await this.findLocationsByIds(rows.map((row) => row.bazaarId));

    const data = rows.map(({ bazaar, ...listing }) => ({
      ...listing,
      bazaar: { ...bazaar, location: locations.get(bazaar.id) ?? null },
    }));
    return { data, total };
  }

  private async findLocationsByIds(ids: string[]): Promise<Map<string, { lat: number; lng: number }>> {
    const locations = new Map<string, { lat: number; lng: number }>();
    if (ids.length === 0) {
      return locations;
    }

    const rows = await this.prisma.$queryRaw<{ id: string; lat: number | null; lng: number | null }[]>`
      SELECT "id", ST_Y("location"::geometry) AS "lat", ST_X("location"::geometry) AS "lng"
      FROM "bazaars"
      WHERE "id" IN (${Prisma.join(ids)})
    `;
    for (const row of rows) {
      if (row.lat !== null && row.lng !== null) {
        locations.set(row.id, { lat: row.lat, lng: row.lng });
      }
    }
    return locations;
  }

  findBazaarApplicationsPaginated(
    bazaarId: string,
    page: number,
    limit: number,
    applicationStatus?: ApplicationStatus,
  ): Promise<{ data: BoothListing[]; total: number }> {
    const where: Prisma.BoothListingWhereInput = { bazaarId };
    if (applicationStatus) {
      where.applicationStatus = applicationStatus;
    }

    return this.prisma.$transaction(async (tx) => {
      const total = await tx.boothListing.count({ where });
      const data = await tx.boothListing.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { appliedAt: 'desc' },
        include: {
          vendor: {
            select: { name: true, logo: true },
          },
        },
      });
      return { data, total };
    });
  }

  // --- Admin (specs/admin-module-spec2.md A3) ---

  /**
   * Every bazaar regardless of organizer or status — DRAFT included, which no
   * other route shows to anyone but its owner. Soft-deleted only on request.
   */
  async findManyForAdmin(params: {
    status?: BazaarStatus;
    organizerId?: string;
    search?: string;
    includeDeleted: boolean;
    page: number;
    limit: number;
  }): Promise<{ data: AdminBazaarRow[]; total: number }> {
    const where: Prisma.BazaarWhereInput = {};
    if (!params.includeDeleted) where.deletedAt = null;
    if (params.status) where.status = params.status;
    if (params.organizerId) where.organizerId = params.organizerId;
    if (params.search) where.name = { contains: params.search, mode: 'insensitive' };

    const { rows, total } = await this.prisma.$transaction(async (tx) => {
      const total = await tx.bazaar.count({ where });
      const rows = await tx.bazaar.findMany({
        where,
        select: adminBazaarRowSelect,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      });
      return { rows, total };
    });

    const locations = await this.findLocationsByIds(rows.map((row) => row.id));
    const data = rows.map((row) => ({ ...row, location: locations.get(row.id) ?? null }));
    return { data, total };
  }

  /** Admin detail: no status/ownership/deletedAt filter. */
  async findByIdForAdmin(id: string): Promise<AdminBazaarDetail | null> {
    const bazaar = await this.prisma.bazaar.findUnique({
      where: { id },
      select: { ...adminBazaarRowSelect, boothLayout: { select: { id: true } } },
    });
    if (!bazaar) return null;

    const [locations, grouped] = await Promise.all([
      this.findLocationsByIds([id]),
      this.prisma.boothListing.groupBy({
        by: ['applicationStatus'],
        where: { bazaarId: id },
        _count: { _all: true },
      }),
    ]);

    const applicationCounts: Record<ApplicationStatus, number> = { PENDING: 0, ACCEPTED: 0, REJECTED: 0 };
    for (const row of grouped) applicationCounts[row.applicationStatus] = row._count._all;

    const { boothLayout, ...rest } = bazaar;
    return { ...rest, location: locations.get(id) ?? null, applicationCounts, hasLayout: boothLayout !== null };
  }

  // --- Admin (specs/admin-module-spec2.md A4) ---

  /** Every application on every bazaar — no organizer or vendor scope. */
  findApplicationsForAdmin(params: {
    bazaarId?: string;
    vendorId?: string;
    status?: ApplicationStatus;
    page: number;
    limit: number;
  }): Promise<{ data: AdminApplication[]; total: number }> {
    const where: Prisma.BoothListingWhereInput = {};
    if (params.bazaarId) where.bazaarId = params.bazaarId;
    if (params.vendorId) where.vendorId = params.vendorId;
    if (params.status) where.applicationStatus = params.status;

    return this.prisma.$transaction(async (tx) => {
      const total = await tx.boothListing.count({ where });
      const data = await tx.boothListing.findMany({
        where,
        select: adminApplicationSelect,
        orderBy: { appliedAt: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      });
      return { data, total };
    });
  }

  findApplicationByIdForAdmin(id: string): Promise<AdminApplication | null> {
    return this.prisma.boothListing.findUnique({
      where: { id },
      select: adminApplicationSelect,
    });
  }

  /**
   * Application decision, organizer or admin (spec3 B5): PENDING → status only.
   * The status guard lives in the WHERE, so two concurrent decisions can't
   * overwrite each other — the loser sees 0 rows and the service reports a
   * conflict. Returns rows moved.
   */
  async transitionApplication(id: string, status: 'ACCEPTED' | 'REJECTED'): Promise<number> {
    const { count } = await this.prisma.boothListing.updateMany({
      where: { id, applicationStatus: ApplicationStatus.PENDING },
      data: { applicationStatus: status, decidedAt: new Date() },
    });
    return count;
  }

  /** One GROUP BY, not one count per status. Excludes soft-deleted bazaars. */
  async groupByStatus(): Promise<{ status: BazaarStatus; count: number }[]> {
    const rows = await this.prisma.bazaar.groupBy({
      by: ['status'],
      _count: { _all: true },
      where: { deletedAt: null },
    });
    return rows.map((row) => ({ status: row.status, count: row._count._all }));
  }
}
