import { Injectable } from '@nestjs/common';
import { Prisma, Organizer } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

const organizerProfileSelect = {
  id: true,
  ownerId: true,
  name: true,
  verified: true,
} satisfies Prisma.OrganizerSelect;

export type OrganizerProfile = Prisma.OrganizerGetPayload<{ select: typeof organizerProfileSelect }>;

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
}
