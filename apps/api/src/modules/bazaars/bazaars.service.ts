import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationStatus, BazaarStatus, Prisma, ScheduleType } from '@prisma/client';

import { BazaarsRepository, BazaarWithLocation, BazaarPublicDetail, BazaarWithDistance, IdPage } from './bazaars.repository';
import { OrganizersService } from './organizers.service';
import { VendorsService } from '../vendors/vendors.service';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';
import { BazaarSearchDocument, toUnixSeconds } from '../../infra/search/search-documents';
import { DomainEvents } from '../../common/events/domain-events.service';
import { BazaarPublishedEvent } from './events/bazaar-published.event';
import { BoothListingAcceptedEvent } from './events/booth-listing-accepted.event';
import { pageMeta } from '../../common/dto/pagination-query.dto';

@Injectable()
export class BazaarsService {
  constructor(
    private readonly bazaarsRepository: BazaarsRepository,
    private readonly organizersService: OrganizersService,
    private readonly vendorsService: VendorsService,
    private readonly searchIndexQueue: SearchIndexQueue,
    private readonly domainEvents: DomainEvents,
  ) {}

  async createBazaar(
    ownerId: string,
    data: { name: string; description?: string; coverMedia?: string[]; lat: number; lng: number; scheduleType: ScheduleType; recurrenceRule?: string; startDate: string | Date; endDate?: string | Date; },
  ): Promise<BazaarWithLocation> {
    const organizer = await this.organizersService.getOrganizerByOwnerId(ownerId);

    if (!organizer.verified) {
      throw new ForbiddenException({ code: 'ORGANIZER_NOT_VERIFIED', message: 'Organizer must be verified to create bazaars.' });
    }

    if (data.scheduleType === ScheduleType.RECURRING && !data.recurrenceRule) {
      throw new BadRequestException({ code: 'RECURRENCE_RULE_REQUIRED', message: 'recurrenceRule is required when scheduleType is RECURRING' });
    }

    return this.bazaarsRepository.create({
      ...data,
      organizerId: organizer.id,
      status: BazaarStatus.DRAFT,
    });
  }

  async getMyBazaars(ownerId: string, page: number, limit: number) {
    const organizer = await this.organizersService.getOrganizerByOwnerId(ownerId);
    const { data, total } = await this.bazaarsRepository.findByOrganizerIdPaginated(organizer.id, page, limit);
    return { data, meta: pageMeta(total, page, limit) };
  }

  async getMyBazaarById(ownerId: string, id: string): Promise<BazaarWithLocation> {
    const organizer = await this.organizersService.getOrganizerByOwnerId(ownerId);
    const bazaar = await this.bazaarsRepository.findById(id);

    if (!bazaar || bazaar.organizerId !== organizer.id) {
      throw new NotFoundException({ code: 'BAZAAR_NOT_FOUND', message: 'Bazaar not found.' });
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
        throw new BadRequestException({ code: 'RECURRENCE_RULE_REQUIRED', message: 'recurrenceRule is required when scheduleType is RECURRING' });
      }
    }

    const updated = await this.bazaarsRepository.update(bazaar.id, data);
    await this.searchIndexQueue.enqueue({ type: 'BAZAAR', id: bazaar.id });
    return updated;
  }

  async publishBazaar(ownerId: string, id: string): Promise<BazaarWithLocation> {
    const bazaar = await this.getMyBazaarById(ownerId, id);

    if (bazaar.status !== BazaarStatus.DRAFT) {
      throw new BadRequestException({ code: 'BAZAAR_NOT_DRAFT', message: 'Only DRAFT bazaars can be published.' });
    }

    const published = await this.bazaarsRepository.updateStatus(id, BazaarStatus.PUBLISHED);
    await this.searchIndexQueue.enqueue({ type: 'BAZAAR', id });
    // After the commit (fix.js ARCH-04): notifications' BAZAAR_NEARBY trigger.
    this.domainEvents.emit(
      new BazaarPublishedEvent(
        published.id,
        published.organizerId,
        published.name,
        published.location,
        published.startDate,
      ),
    );
    return published;
  }

  async cancelBazaar(ownerId: string, id: string): Promise<BazaarWithLocation> {
    const bazaar = await this.getMyBazaarById(ownerId, id);

    if (bazaar.status === BazaarStatus.COMPLETED) {
      throw new BadRequestException({ code: 'BAZAAR_COMPLETED', message: 'Cannot cancel a COMPLETED bazaar.' });
    }

    const cancelled = await this.bazaarsRepository.updateStatus(id, BazaarStatus.CANCELLED);
    await this.searchIndexQueue.enqueue({ type: 'BAZAAR', id });
    return cancelled;
  }

  // --- Search index support (read-only; the single authority on bazaar eligibility) ---

  /** The bazaar's search document, or null unless PUBLISHED and not soft-deleted. */
  async getSearchDocument(id: string): Promise<BazaarSearchDocument | null> {
    const bazaar = await this.bazaarsRepository.findById(id);
    if (!bazaar || bazaar.status !== BazaarStatus.PUBLISHED || bazaar.deletedAt !== null) {
      return null;
    }
    // location is NOT NULL in the schema; a null here means a corrupt row, and a
    // bazaar with no coordinates is useless to a geo-filtered search anyway.
    if (!bazaar.location) return null;

    return {
      id: bazaar.id,
      organizerId: bazaar.organizerId,
      name: bazaar.name,
      description: bazaar.description,
      coverMedia: bazaar.coverMedia,
      scheduleType: bazaar.scheduleType,
      recurrenceRule: bazaar.recurrenceRule,
      startDate: toUnixSeconds(bazaar.startDate),
      endDate: bazaar.endDate ? toUnixSeconds(bazaar.endDate) : null,
      _geo: bazaar.location,
    };
  }

  listPublicBazaarIds(cursor: string | null, take: number): Promise<IdPage> {
    return this.bazaarsRepository.listPublicIds(cursor, take);
  }

  async getPublicBazaars(page: number, limit: number, filters: { lat?: number; lng?: number; radiusKm?: number; scheduleType?: ScheduleType }) {
    const { data, total } = await this.bazaarsRepository.findPublicPaginated(page, limit, filters);
    return { data, meta: pageMeta(total, page, limit) };
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

  /** SPEC-03: bazaar ratings are open to any shopper once the bazaar is PUBLISHED or COMPLETED. */
  isRateable(id: string): Promise<boolean> {
    return this.bazaarsRepository.isRateable(id);
  }

  async getPublicBazaarById(id: string): Promise<BazaarPublicDetail> {
    const bazaar = await this.bazaarsRepository.findPublicById(id);
    if (!bazaar) {
      throw new NotFoundException({ code: 'BAZAAR_NOT_FOUND', message: 'Bazaar not found.' });
    }
    return bazaar;
  }

  // --- Booth Applications ---

  async applyToBazaar(vendorOwnerId: string, bazaarId: string) {
    const vendor = await this.vendorsService.getMyProfile(vendorOwnerId);

    if (!vendor.verified) {
      throw new ForbiddenException({ code: 'VENDOR_NOT_VERIFIED', message: 'Only verified vendors can apply to bazaars.' });
    }

    const bazaar = await this.bazaarsRepository.findById(bazaarId);
    if (!bazaar || bazaar.status !== BazaarStatus.PUBLISHED || bazaar.deletedAt) {
      throw new BadRequestException({ code: 'BAZAAR_NOT_ACCEPTING_APPLICATIONS', message: 'Bazaar is not available for applications.' });
    }

    try {
      return await this.bazaarsRepository.createApplication(bazaarId, vendor.id);
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new ConflictException({ code: 'APPLICATION_EXISTS', message: 'You have already applied to this bazaar.' });
      }
      throw error;
    }
  }

  async withdrawApplication(vendorOwnerId: string, bazaarId: string) {
    const vendor = await this.vendorsService.getMyProfile(vendorOwnerId);
    const application = await this.bazaarsRepository.findApplication(bazaarId, vendor.id);

    if (!application) {
      throw new NotFoundException({ code: 'APPLICATION_NOT_FOUND', message: 'Application not found.' });
    }

    if (application.applicationStatus !== ApplicationStatus.PENDING) {
      throw new BadRequestException({ code: 'APPLICATION_NOT_PENDING', message: 'Cannot withdraw application that is no longer PENDING.' });
    }

    return this.bazaarsRepository.deleteApplication(application.id);
  }

  async getVendorApplications(vendorOwnerId: string, page: number, limit: number, status?: ApplicationStatus) {
    const vendor = await this.vendorsService.getMyProfile(vendorOwnerId);
    const { data, total } = await this.bazaarsRepository.findVendorApplicationsPaginated(vendor.id, page, limit, status);
    return { data, meta: pageMeta(total, page, limit) };
  }

  async getBazaarApplications(ownerId: string, bazaarId: string, page: number, limit: number, status?: ApplicationStatus) {
    const bazaar = await this.getMyBazaarById(ownerId, bazaarId);
    const { data, total } = await this.bazaarsRepository.findBazaarApplicationsPaginated(bazaar.id, page, limit, status);
    return { data, meta: pageMeta(total, page, limit) };
  }

  async decideApplication(ownerId: string, bazaarId: string, applicationId: string, status: 'ACCEPTED' | 'REJECTED') {
    const bazaar = await this.getMyBazaarById(ownerId, bazaarId);
    const application = await this.bazaarsRepository.findApplicationById(applicationId);

    if (!application || application.bazaarId !== bazaar.id) {
      throw new NotFoundException({ code: 'APPLICATION_NOT_FOUND', message: 'Application not found.' });
    }

    if (application.applicationStatus !== ApplicationStatus.PENDING) {
      throw new BadRequestException({ code: 'APPLICATION_NOT_PENDING', message: 'Can only make decisions on PENDING applications.' });
    }

    const decided = await this.bazaarsRepository.updateApplicationStatus(application.id, status);
    if (status === 'ACCEPTED') {
      // After the commit (fix.js ARCH-04): notifications' FOLLOWED_VENDOR_NEW_BAZAAR trigger.
      this.domainEvents.emit(new BoothListingAcceptedEvent(decided.id, decided.bazaarId, decided.vendorId));
    }
    return decided;
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

  /** Admin overview: bazaars per status, one query. */
  countByStatus(): Promise<{ status: BazaarStatus; count: number }[]> {
    return this.bazaarsRepository.groupByStatus();
  }
}
