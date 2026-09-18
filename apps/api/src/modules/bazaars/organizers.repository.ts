import { Injectable } from '@nestjs/common';
import { Prisma, Organizer } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

const organizerProfileSelect = {
  id: true,
  ownerId: true,
  name: true,
  verified: true,
  rejectionReason: true,
} satisfies Prisma.OrganizerSelect;

export type OrganizerProfile = Prisma.OrganizerGetPayload<{ select: typeof organizerProfileSelect }>;

// Admin queue row. Includes ownerId and the owner's email on purpose — this
// shape is for /admin/* only and must never be returned from a public route.
const adminOrganizerRowSelect = {
  id: true,
  ownerId: true,
  name: true,
  verified: true,
  rejectionReason: true,
  createdAt: true,
  owner: { select: { id: true, name: true, email: true } },
} satisfies Prisma.OrganizerSelect;

export type AdminOrganizerRow = Prisma.OrganizerGetPayload<{ select: typeof adminOrganizerRowSelect }>;

/** pending = unverified with no reason; rejected = unverified with a reason. */
export type OrganizerModerationStatus = 'pending' | 'verified' | 'rejected';

export const ORGANIZER_MODERATION_STATUSES: readonly OrganizerModerationStatus[] = ['pending', 'verified', 'rejected'];

export interface OrganizerModerationState {
  id: string;
  verified: boolean;
  rejectionReason: string | null;
  deletedAt: Date | null;
}

function moderationStatusWhere(status: OrganizerModerationStatus): Prisma.OrganizerWhereInput {
  switch (status) {
    case 'pending':
      return { verified: false, rejectionReason: null };
    case 'verified':
      return { verified: true };
    case 'rejected':
      return { verified: false, rejectionReason: { not: null } };
  }
}

@Injectable()
export class OrganizersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByOwnerId(ownerId: string): Promise<OrganizerProfile | null> {
    return this.prisma.organizer.findUnique({ 
      where: { ownerId },
      select: organizerProfileSelect,
    });
  }

  findById(id: string): Promise<OrganizerProfile | null> {
    return this.prisma.organizer.findUnique({ 
      where: { id },
      select: organizerProfileSelect,
    });
  }

  update(id: string, data: Prisma.OrganizerUpdateInput): Promise<OrganizerProfile> {
    return this.prisma.organizer.update({
      where: { id },
      data,
      select: organizerProfileSelect,
    });
  }

  // --- Admin moderation ---

  /** Minimal state for a verify/reject decision. Unlike findById this exposes deletedAt. */
  findModerationState(id: string): Promise<OrganizerModerationState | null> {
    return this.prisma.organizer.findUnique({
      where: { id },
      select: { id: true, verified: true, rejectionReason: true, deletedAt: true },
    });
  }

  async findManyForAdmin(params: {
    status?: OrganizerModerationStatus;
    search?: string;
    page: number;
    limit: number;
  }): Promise<{ data: AdminOrganizerRow[]; total: number }> {
    const where: Prisma.OrganizerWhereInput = {
      deletedAt: null,
      ...(params.status ? moderationStatusWhere(params.status) : {}),
    };
    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { owner: { email: { contains: params.search, mode: 'insensitive' } } },
      ];
    }

    return this.prisma.$transaction(async (tx) => {
      const total = await tx.organizer.count({ where });
      const data = await tx.organizer.findMany({
        where,
        select: adminOrganizerRowSelect,
        orderBy: { createdAt: 'asc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      });
      return { data, total };
    });
  }

  /** Overview tile: organizers awaiting a first decision. */
  countPendingForAdmin(): Promise<number> {
    return this.prisma.organizer.count({ where: { verified: false, rejectionReason: null, deletedAt: null } });
  }
}
