import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AdminAction, AdminTargetType, ApplicationStatus, BazaarStatus, Prisma, ScheduleType } from '@prisma/client';

import {
  AdminApplication,
  AdminBazaarDetail,
  BazaarsRepository,
  BazaarWithLocation,
  BazaarPublicDetail,
  BazaarWithDistance,
  IdPage,
} from './bazaars.repository';
import { OrganizersService } from './organizers.service';
import { VendorsService } from '../vendors/vendors.service';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';
import { BazaarSearchDocument, toUnixSeconds } from '../../infra/search/search-documents';
import { DomainEvents } from '../../common/events/domain-events.service';
import { BazaarPublishedEvent } from './events/bazaar-published.event';
import { BoothListingAcceptedEvent } from './events/booth-listing-accepted.event';
import { pageMeta } from '../../common/dto/pagination-query.dto';
import { AuditService } from '../audit/audit.service';

/**
 * endDate is optional (a single-day event) but never before startDate: the
 * completion job and discovery's `upcomingOnly` both read `endDate < now` as
 * "over", so a backwards range ends a bazaar before it opens. The schema has
 * the same rule as a CHECK constraint (bazaars_end_date_not_before_start).
 */
function assertEndNotBeforeStart(start: string | Date, end: string | Date | null | undefined): void {
  if (end == null) return;
  if (new Date(end).getTime() < new Date(start).getTime()) {
    throw new BadRequestException({ code: 'BAZAAR_END_BEFORE_START', message: 'endDate must not be before startDate.' });
  }
}

@Injectable()
export class BazaarsService {
  constructor(
    private readonly bazaarsRepository: BazaarsRepository,
    private readonly organizersService: OrganizersService,
    private readonly vendorsService: VendorsService,
    private readonly searchIndexQueue: SearchIndexQueue,
    private readonly domainEvents: DomainEvents,
    private readonly auditService: AuditService,
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

    assertEndNotBeforeStart(data.startDate, data.endDate);

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

    // A partial update is checked against the stored dates it leaves unchanged.
    assertEndNotBeforeStart(
      (data.startDate as string | Date | undefined) ?? bazaar.startDate,
      data.endDate === undefined ? bazaar.endDate : (data.endDate as string | Date | null),
    );

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
    // Already cancelled: nothing to write or re-index (same no-op as the admin cancel, spec3 B7).
    if (bazaar.status === BazaarStatus.CANCELLED) {
      return bazaar;
    }

    const cancelled = await this.bazaarsRepository.updateStatus(id, BazaarStatus.CANCELLED);
    await this.searchIndexQueue.enqueue({ type: 'BAZAAR', id });
    return cancelled;
  }

  // --- Search index support (read-only; the single authority on bazaar eligibility) ---

  /** The bazaar's search document, or null unless public (bazaar-visibility.ts: PUBLISHED, not deleted, organizer verified and not deleted). */
  async getSearchDocument(id: string): Promise<BazaarSearchDocument | null> {
    const bazaar = await this.bazaarsRepository.findById(id);
    if (!bazaar || bazaar.status !== BazaarStatus.PUBLISHED || bazaar.deletedAt !== null) {
      return null;
    }
    // spec3 B8b: a rejected or deleted organizer hides their bazaars (from search too).
    if (!(await this.bazaarsRepository.hasPublicOrganizer(bazaar.organizerId))) {
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

  /** Every bazaar of an organizer, any status — the ORGANIZER_BAZAARS fan-out pages this. */
  listBazaarIdsByOrganizer(organizerId: string, cursor: string | null, take: number): Promise<IdPage> {
    return this.bazaarsRepository.listIdsByOrganizer(organizerId, cursor, take);
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
    if (
      !bazaar ||
      bazaar.status !== BazaarStatus.PUBLISHED ||
      bazaar.deletedAt ||
      !(await this.bazaarsRepository.hasPublicOrganizer(bazaar.organizerId))
    ) {
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

    // Guarded PENDING → status, like the admin path: an admin decision that lands
    // between the read above and this write must not be overwritten (no reversals).
    const moved = await this.bazaarsRepository.transitionApplication(application.id, status);
    if (moved === 0) {
      throw new ConflictException({
        code: 'APPLICATION_STATE_CHANGED',
        message: 'The application was decided while this request was in flight. Reload and try again.',
      });
    }

    if (status === 'ACCEPTED') {
      // After the commit (fix.js ARCH-04): notifications' FOLLOWED_VENDOR_NEW_BAZAAR trigger.
      this.domainEvents.emit(new BoothListingAcceptedEvent(application.id, application.bazaarId, application.vendorId));
    }
    return this.bazaarsRepository.findApplicationById(application.id);
  }

  // --- Internal Passthrough for Other Modules ---

  // --- Admin (specs/admin-module-spec2.md A3): global reads, no ownership scope ---

  async listForAdmin(params: {
    status?: BazaarStatus;
    organizerId?: string;
    search?: string;
    includeDeleted: boolean;
    page: number;
    limit: number;
  }) {
    const { data, total } = await this.bazaarsRepository.findManyForAdmin(params);
    return { data, meta: pageMeta(total, params.page, params.limit) };
  }

  async getBazaarForAdmin(id: string): Promise<AdminBazaarDetail> {
    const bazaar = await this.bazaarsRepository.findByIdForAdmin(id);
    if (!bazaar) {
      throw new NotFoundException({ code: 'BAZAAR_NOT_FOUND', message: 'Bazaar not found.' });
    }
    return bazaar;
  }

  /**
   * Admin cancel (specs/admin-module-spec3.md B7) under exactly the organizer's
   * rule (cancelBazaar): any status except COMPLETED. Already CANCELLED is a
   * no-op; soft-deleted is 404. Applications and booths are untouched, and
   * nobody is notified — there is no notifications module.
   */
  async cancelBazaarForAdmin(adminId: string, id: string): Promise<AdminBazaarDetail> {
    const bazaar = await this.bazaarsRepository.findById(id);
    if (!bazaar || bazaar.deletedAt) {
      throw new NotFoundException({ code: 'BAZAAR_NOT_FOUND', message: 'Bazaar not found.' });
    }
    if (bazaar.status === BazaarStatus.COMPLETED) {
      throw new BadRequestException({ code: 'BAZAAR_COMPLETED', message: 'Cannot cancel a COMPLETED bazaar.' });
    }
    if (bazaar.status === BazaarStatus.CANCELLED) {
      return this.getBazaarForAdmin(id);
    }

    await this.bazaarsRepository.updateStatus(id, BazaarStatus.CANCELLED);
    await this.searchIndexQueue.enqueue({ type: 'BAZAAR', id });
    await this.auditService.record({
      actorId: adminId,
      action: AdminAction.BAZAAR_CANCELLED,
      targetType: AdminTargetType.BAZAAR,
      targetId: id,
    });

    return this.getBazaarForAdmin(id);
  }

  // --- Admin (specs/admin-module-spec2.md A4): read-only; admin decisions are Open Item B5 ---

  async listApplicationsForAdmin(params: {
    bazaarId?: string;
    vendorId?: string;
    status?: ApplicationStatus;
    page: number;
    limit: number;
  }) {
    const { data, total } = await this.bazaarsRepository.findApplicationsForAdmin(params);
    return { data, meta: pageMeta(total, params.page, params.limit) };
  }

  async getApplicationForAdmin(id: string): Promise<AdminApplication> {
    const application = await this.bazaarsRepository.findApplicationByIdForAdmin(id);
    if (!application) {
      throw new NotFoundException({ code: 'APPLICATION_NOT_FOUND', message: 'Application not found.' });
    }
    return application;
  }

  /**
   * Admin decision on a booth application (specs/admin-module-spec3.md B5).
   * PENDING → ACCEPTED | REJECTED only; no reversals. Repeating the decision the
   * application already has is a no-op. `reason` goes to the audit log only —
   * BoothListing has no reason column.
   */
  async decideApplicationForAdmin(
    adminId: string,
    id: string,
    status: 'ACCEPTED' | 'REJECTED',
    reason?: string,
  ): Promise<AdminApplication> {
    const application = await this.getApplicationForAdmin(id);
    if (application.applicationStatus === status) {
      return application;
    }
    if (application.applicationStatus !== ApplicationStatus.PENDING) {
      throw new BadRequestException({
        code: 'APPLICATION_NOT_PENDING',
        message: `Application is already ${application.applicationStatus}; decisions can't be reversed.`,
      });
    }

    const moved = await this.bazaarsRepository.transitionApplication(id, status);
    if (moved === 0) {
      throw new ConflictException({
        code: 'APPLICATION_STATE_CHANGED',
        message: 'The application was decided while this request was in flight. Reload and try again.',
      });
    }

    // Same side effect as the organizer path: the booth-assignment flow listens for it.
    if (status === 'ACCEPTED') {
      this.domainEvents.emit(new BoothListingAcceptedEvent(id, application.bazaarId, application.vendorId));
    }

    await this.auditService.record({
      actorId: adminId,
      action: status === 'ACCEPTED' ? AdminAction.APPLICATION_ACCEPTED : AdminAction.APPLICATION_REJECTED,
      targetType: AdminTargetType.APPLICATION,
      targetId: id,
      reason: reason ?? null,
    });

    return this.getApplicationForAdmin(id);
  }

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
