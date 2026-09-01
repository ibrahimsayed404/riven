import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationStatus, BazaarStatus, Bazaar, Prisma, ScheduleType } from '@prisma/client';

import { BazaarsRepository, BazaarWithLocation, BazaarPublicDetail, BazaarWithDistance } from './bazaars.repository';
import { OrganizersService } from './organizers.service';
import { VendorsService } from '../vendors/vendors.service';

@Injectable()
export class BazaarsService {
  constructor(
    private readonly bazaarsRepository: BazaarsRepository,
    private readonly organizersService: OrganizersService,
    private readonly vendorsService: VendorsService,
  ) {}

  async createBazaar(
    ownerId: string,
    data: { name: string; description?: string; coverMedia?: string[]; lat: number; lng: number; scheduleType: ScheduleType; recurrenceRule?: string; startDate: string | Date; endDate?: string | Date; },
  ): Promise<BazaarWithLocation> {
    const organizer = await this.organizersService.getOrganizerByOwnerId(ownerId);
    
    if (!organizer.verified) {
      throw new ForbiddenException('Organizer must be verified to create bazaars.');
    }

    if (data.scheduleType === ScheduleType.RECURRING && !data.recurrenceRule) {
      throw new BadRequestException('recurrenceRule is required when scheduleType is RECURRING');
    }

    return this.bazaarsRepository.create({
      ...data,
      organizerId: organizer.id,
      status: BazaarStatus.DRAFT,
    });
  }

  async getMyBazaars(ownerId: string, page: number, limit: number) {
    const organizer = await this.organizersService.getOrganizerByOwnerId(ownerId);
    return this.bazaarsRepository.findByOrganizerIdPaginated(organizer.id, page, limit);
  }

  async getMyBazaarById(ownerId: string, id: string): Promise<BazaarWithLocation> {
    const organizer = await this.organizersService.getOrganizerByOwnerId(ownerId);
    const bazaar = await this.bazaarsRepository.findById(id);

    if (!bazaar || bazaar.organizerId !== organizer.id) {
      throw new NotFoundException('Bazaar not found.');
    }

    return bazaar;
  }

  async updateMyBazaar(
    ownerId: string,
    id: string,
    data: Prisma.BazaarUpdateInput & { lat?: number; lng?: number },
  ): Promise<BazaarWithLocation> {
    const bazaar = await this.getMyBazaarById(ownerId, id);

    if (data.scheduleType && data.scheduleType !== bazaar.scheduleType) {
      if (data.scheduleType === ScheduleType.RECURRING && !data.recurrenceRule && !bazaar.recurrenceRule) {
        throw new BadRequestException('recurrenceRule is required when scheduleType is RECURRING');
      }
    }

    return this.bazaarsRepository.update(bazaar.id, data);
  }

  async publishBazaar(ownerId: string, id: string): Promise<BazaarWithLocation> {
    const bazaar = await this.getMyBazaarById(ownerId, id);

    if (bazaar.status !== BazaarStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT bazaars can be published.');
    }

    return this.bazaarsRepository.updateStatus(id, BazaarStatus.PUBLISHED) as Promise<BazaarWithLocation>;
  }

  async cancelBazaar(ownerId: string, id: string): Promise<BazaarWithLocation> {
    const bazaar = await this.getMyBazaarById(ownerId, id);

    if (bazaar.status === BazaarStatus.COMPLETED) {
      throw new BadRequestException('Cannot cancel a COMPLETED bazaar.');
    }

    return this.bazaarsRepository.updateStatus(id, BazaarStatus.CANCELLED) as Promise<BazaarWithLocation>;
  }

  async getPublicBazaars(page: number, limit: number, filters: { lat?: number; lng?: number; radiusKm?: number; scheduleType?: ScheduleType }) {
    return this.bazaarsRepository.findPublicPaginated(page, limit, filters);
  }

  /**
   * Thin passthrough for the discovery module. It exists so DiscoveryService
   * never touches BazaarsRepository directly — the bazaars module owns that table.
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
    return this.bazaarsRepository.findNearby(filters, limit, cursor);
  }

  async getPublicBazaarById(id: string): Promise<BazaarPublicDetail> {
    const bazaar = await this.bazaarsRepository.findPublicById(id);
    if (!bazaar) {
      throw new NotFoundException('Bazaar not found.');
    }
    return bazaar;
  }

  // --- Booth Applications ---

  async applyToBazaar(vendorOwnerId: string, bazaarId: string) {
    const vendor = await this.vendorsService.getMyProfile(vendorOwnerId);
    
    if (!vendor.verified) {
      throw new ForbiddenException('Only verified vendors can apply to bazaars.');
    }

    const bazaar = await this.bazaarsRepository.findById(bazaarId);
    if (!bazaar || bazaar.status !== BazaarStatus.PUBLISHED || bazaar.deletedAt) {
      throw new BadRequestException('Bazaar is not available for applications.');
    }

    try {
      return await this.bazaarsRepository.createApplication(bazaarId, vendor.id);
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new ConflictException('You have already applied to this bazaar.');
      }
      throw error;
    }
  }

  async withdrawApplication(vendorOwnerId: string, bazaarId: string) {
    const vendor = await this.vendorsService.getMyProfile(vendorOwnerId);
    const application = await this.bazaarsRepository.findApplication(bazaarId, vendor.id);

    if (!application) {
      throw new NotFoundException('Application not found.');
    }

    if (application.applicationStatus !== ApplicationStatus.PENDING) {
      throw new BadRequestException('Cannot withdraw application that is no longer PENDING.');
    }

    return this.bazaarsRepository.deleteApplication(application.id);
  }

  async getVendorApplications(vendorOwnerId: string, page: number, limit: number, status?: ApplicationStatus) {
    const vendor = await this.vendorsService.getMyProfile(vendorOwnerId);
    return this.bazaarsRepository.findVendorApplicationsPaginated(vendor.id, page, limit, status);
  }

  async getBazaarApplications(ownerId: string, bazaarId: string, page: number, limit: number, status?: ApplicationStatus) {
    const bazaar = await this.getMyBazaarById(ownerId, bazaarId);
    return this.bazaarsRepository.findBazaarApplicationsPaginated(bazaar.id, page, limit, status);
  }

  async decideApplication(ownerId: string, bazaarId: string, applicationId: string, status: 'ACCEPTED' | 'REJECTED') {
    const bazaar = await this.getMyBazaarById(ownerId, bazaarId);
    const application = await this.bazaarsRepository.findApplicationById(applicationId);

    if (!application || application.bazaarId !== bazaar.id) {
      throw new NotFoundException('Application not found.');
    }

    if (application.applicationStatus !== ApplicationStatus.PENDING) {
      throw new BadRequestException('Can only make decisions on PENDING applications.');
    }

    return this.bazaarsRepository.updateApplicationStatus(application.id, status);
  }

  // --- Internal Passthrough for Other Modules ---
  
  async findById(id: string): Promise<BazaarWithLocation | null> {
    return this.bazaarsRepository.findById(id);
  }

  async findPublicById(id: string): Promise<BazaarPublicDetail | null> {
    return this.bazaarsRepository.findPublicById(id);
  }

  async findApplicationById(id: string) {
    return this.bazaarsRepository.findApplicationById(id);
  }
}
