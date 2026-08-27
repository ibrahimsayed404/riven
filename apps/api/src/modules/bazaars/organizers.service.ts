import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { OrganizersRepository, OrganizerProfile } from './organizers.repository';

@Injectable()
export class OrganizersService {
  constructor(private readonly organizersRepository: OrganizersRepository) {}

  async getOrganizerByOwnerId(ownerId: string): Promise<OrganizerProfile> {
    const organizer = await this.organizersRepository.findByOwnerId(ownerId);
    if (!organizer) {
      throw new NotFoundException('Organizer profile not found.');
    }
    return organizer;
  }

  async getOrganizerById(id: string): Promise<OrganizerProfile> {
    const organizer = await this.organizersRepository.findById(id);
    if (!organizer) {
      throw new NotFoundException('Organizer profile not found.');
    }
    return organizer;
  }

  async updateMyProfile(ownerId: string, data: Prisma.OrganizerUpdateInput): Promise<OrganizerProfile> {
    const organizer = await this.getOrganizerByOwnerId(ownerId);
    return this.organizersRepository.update(organizer.id, data);
  }

  async verifyOrganizer(id: string): Promise<OrganizerProfile> {
    const organizer = await this.getOrganizerById(id);
    return this.organizersRepository.update(organizer.id, { verified: true });
  }
}
