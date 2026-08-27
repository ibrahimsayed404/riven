import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { Prisma, Bazaar, BoothListing, BazaarStatus, ApplicationStatus, ScheduleType } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

export type BazaarWithLocation = Omit<Bazaar, 'location'> & {
  location: { lat: number; lng: number } | null;
};

export type BazaarPublicDetail = BazaarWithLocation & {
  acceptedVendors: { vendorId: string; businessName: string; logo: string | null }[];
};

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

  async findPublicById(id: string): Promise<BazaarPublicDetail | null> {
    const bazaar = await this.findById(id);
    if (!bazaar || bazaar.status !== BazaarStatus.PUBLISHED || bazaar.deletedAt) {
      return null;
    }

    const listings = await this.prisma.boothListing.findMany({
      where: { bazaarId: id, applicationStatus: ApplicationStatus.ACCEPTED },
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

  async transitionPastOneOffBazaars(): Promise<number> {
    const result = await this.prisma.$executeRaw`
      UPDATE "bazaars"
      SET "status" = 'COMPLETED'::"BazaarStatus"
      WHERE "scheduleType" = 'ONE_OFF'::"ScheduleType"
        AND "status" = 'PUBLISHED'::"BazaarStatus"
        AND (
          ("endDate" IS NOT NULL AND "endDate" < NOW())
          OR
          ("endDate" IS NULL AND "startDate" < NOW())
        )
    `;
    return result;
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

  updateApplicationStatus(id: string, status: ApplicationStatus): Promise<BoothListing> {
    return this.prisma.boothListing.update({
      where: { id },
      data: {
        applicationStatus: status,
        decidedAt: new Date(),
      },
    });
  }

  findVendorApplicationsPaginated(
    vendorId: string,
    page: number,
    limit: number,
    applicationStatus?: ApplicationStatus,
  ): Promise<{ data: BoothListing[]; total: number }> {
    const where: Prisma.BoothListingWhereInput = { vendorId };
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
      });
      return { data, total };
    });
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
}
