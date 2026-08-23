import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { UserLocation } from './dto/user-profile-response.dto';

/**
 * Explicit select that NEVER includes passwordHash.
 * This is the primary defence against leaking password hashes —
 * we don't rely on serialization alone.
 */
const userProfileSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  interests: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} satisfies Prisma.UserSelect;

export type UserProfile = Prisma.UserGetPayload<{ select: typeof userProfileSelect }>;

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<UserProfile | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: userProfileSelect,
    });
  }

  findByIdWithPasswordHash(
    id: string,
  ): Promise<(UserProfile & { passwordHash: string }) | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: { ...userProfileSelect, passwordHash: true },
    });
  }

  updateProfile(
    id: string,
    data: { name?: string; phone?: string; interests?: string[] },
  ): Promise<UserProfile> {
    return this.prisma.user.update({
      where: { id },
      data,
      select: userProfileSelect,
    });
  }

  async updateLocation(id: string, lat: number, lng: number): Promise<void> {
    // PostGIS point: ST_MakePoint takes (longitude, latitude) — note the order.
    await this.prisma.$executeRaw`
      UPDATE "users"
      SET "location" = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      WHERE "id" = ${id}
    `;
  }

  async findUserLocation(id: string): Promise<UserLocation | null> {
    const result = await this.prisma.$queryRaw<{ lat: number; lng: number }[]>`
      SELECT
        ST_Y("location"::geometry) AS "lat",
        ST_X("location"::geometry) AS "lng"
      FROM "users"
      WHERE "id" = ${id} AND "location" IS NOT NULL
    `;

    return result.length > 0 ? { lat: result[0].lat, lng: result[0].lng } : null;
  }

  softDelete(id: string): Promise<UserProfile> {
    return this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date() },
      select: userProfileSelect,
    });
  }

  reactivate(id: string): Promise<UserProfile> {
    return this.prisma.user.update({
      where: { id },
      data: { deletedAt: null },
      select: userProfileSelect,
    });
  }

  async findManyPaginated(params: {
    role?: Role;
    search?: string;
    includeDeleted: boolean;
    page: number;
    limit: number;
  }): Promise<{ users: UserProfile[]; total: number }> {
    const where: Prisma.UserWhereInput = {};

    if (!params.includeDeleted) {
      where.deletedAt = null;
    }

    if (params.role) {
      where.role = params.role;
    }

    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { email: { contains: params.search, mode: 'insensitive' } },
        { phone: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: userProfileSelect,
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { users, total };
  }
}
