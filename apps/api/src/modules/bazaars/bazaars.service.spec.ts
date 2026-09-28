import { Test, TestingModule } from '@nestjs/testing';
import { BazaarsService } from './bazaars.service';
import { BazaarsRepository } from './bazaars.repository';
import { OrganizersService } from './organizers.service';
import { VendorsService } from '../vendors/vendors.service';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';
import { DomainEvents } from '../../common/events/domain-events.service';
import { AuditService } from '../audit/audit.service';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { BazaarStatus, ScheduleType, ApplicationStatus } from '@prisma/client';

describe('BazaarsService', () => {
  let service: BazaarsService;
  let bazaarsRepo: jest.Mocked<BazaarsRepository>;
  let organizersService: jest.Mocked<OrganizersService>;
  let vendorsService: jest.Mocked<VendorsService>;
  let searchIndexQueue: jest.Mocked<SearchIndexQueue>;
  let domainEvents: { emit: jest.Mock };
  let auditService: { record: jest.Mock };

  const mockOrganizer = {
    id: 'org-1',
    ownerId: 'owner-1',
    name: 'Org Owner',
    organizationName: 'Test Org',
    verified: true,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockUnverifiedOrganizer = {
    ...mockOrganizer,
    verified: false,
  };

  const mockBazaar = {
    id: 'bazaar-1',
    organizerId: 'org-1',
    name: 'Test Bazaar',
    description: null,
    coverMedia: [],
    scheduleType: ScheduleType.ONE_OFF,
    recurrenceRule: null,
    startDate: new Date(),
    endDate: new Date(),
    status: BazaarStatus.DRAFT,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    location: { lat: 10, lng: 10 },
  };

  const mockVendor = {
    id: 'vendor-1',
    ownerId: 'owner-2',
    name: 'Vendor Owner',
    businessName: 'Test Vendor',
    verified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BazaarsService,
        {
          provide: BazaarsRepository,
          useValue: {
            create: jest.fn(),
            findById: jest.fn(),
            update: jest.fn(),
            updateStatus: jest.fn(),
            createApplication: jest.fn(),
            findApplication: jest.fn(),
            findApplicationById: jest.fn(),
            findManyForAdmin: jest.fn(),
            findByIdForAdmin: jest.fn(),
            findApplicationsForAdmin: jest.fn(),
            findApplicationByIdForAdmin: jest.fn(),
            transitionApplication: jest.fn(),
            // B8b: existing tests assume a public (verified, not deleted) organizer.
            hasPublicOrganizer: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: OrganizersService,
          useValue: {
            getOrganizerByOwnerId: jest.fn(),
          },
        },
        {
          provide: SearchIndexQueue,
          useValue: { enqueue: jest.fn().mockResolvedValue(undefined), enqueueMany: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: VendorsService,
          useValue: {
            getMyProfile: jest.fn(),
          },
        },
        { provide: DomainEvents, useValue: { emit: jest.fn() } },
        { provide: AuditService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<BazaarsService>(BazaarsService);
    bazaarsRepo = module.get(BazaarsRepository);
    organizersService = module.get(OrganizersService);
    vendorsService = module.get(VendorsService);
    searchIndexQueue = module.get(SearchIndexQueue);
    domainEvents = module.get(DomainEvents);
    auditService = module.get(AuditService);
  });

  describe('createBazaar', () => {
    it('should create a bazaar if organizer is verified', async () => {
      organizersService.getOrganizerByOwnerId.mockResolvedValue(mockOrganizer);
      bazaarsRepo.create.mockResolvedValue(mockBazaar);

      const dto = {
        name: 'Test Bazaar',
        lat: 10,
        lng: 10,
        scheduleType: ScheduleType.ONE_OFF,
        startDate: new Date(),
      };

      const result = await service.createBazaar('owner-1', dto);
      expect(result).toEqual(mockBazaar);
      expect(bazaarsRepo.create).toHaveBeenCalled();
    });

    it('should throw ForbiddenException if organizer is unverified', async () => {
      organizersService.getOrganizerByOwnerId.mockResolvedValue(mockUnverifiedOrganizer);

      const dto = {
        name: 'Test Bazaar',
        lat: 10,
        lng: 10,
        scheduleType: ScheduleType.ONE_OFF,
        startDate: new Date(),
      };

      await expect(service.createBazaar('owner-1', dto)).rejects.toThrow(ForbiddenException);
    });

    const dated = (startDate: string, endDate?: string) => ({
      name: 'Test Bazaar', lat: 10, lng: 10, scheduleType: ScheduleType.ONE_OFF, startDate, endDate,
    });

    it('refuses an endDate before startDate with 400 BAZAAR_END_BEFORE_START, nothing written', async () => {
      organizersService.getOrganizerByOwnerId.mockResolvedValue(mockOrganizer);

      await expect(
        service.createBazaar('owner-1', dated('2026-10-10T10:00:00.000Z', '2026-10-05T10:00:00.000Z')),
      ).rejects.toMatchObject({ status: 400, response: { code: 'BAZAAR_END_BEFORE_START' } });
      expect(bazaarsRepo.create).not.toHaveBeenCalled();
    });

    it.each([
      ['no endDate (single-day event)', undefined],
      ['endDate equal to startDate', '2026-10-10T10:00:00.000Z'],
      ['endDate after startDate', '2026-10-11T20:00:00.000Z'],
    ])('accepts %s', async (_label, endDate) => {
      organizersService.getOrganizerByOwnerId.mockResolvedValue(mockOrganizer);
      bazaarsRepo.create.mockResolvedValue(mockBazaar);

      await service.createBazaar('owner-1', dated('2026-10-10T10:00:00.000Z', endDate));

      expect(bazaarsRepo.create).toHaveBeenCalled();
    });
  });

  describe('updateMyBazaar: date order', () => {
    const stored = {
      ...mockBazaar,
      startDate: new Date('2026-10-10T10:00:00.000Z'),
      endDate: new Date('2026-10-11T20:00:00.000Z'),
    };

    beforeEach(() => {
      organizersService.getOrganizerByOwnerId.mockResolvedValue(mockOrganizer);
      bazaarsRepo.findById.mockResolvedValue(stored);
      bazaarsRepo.update.mockResolvedValue(stored);
    });

    it.each([
      ['a new endDate before the stored startDate', { endDate: '2026-10-01T00:00:00.000Z' }],
      ['a new startDate after the stored endDate', { startDate: '2026-10-20T00:00:00.000Z' }],
      ['both new and backwards', { startDate: '2026-10-20T00:00:00.000Z', endDate: '2026-10-19T00:00:00.000Z' }],
    ])('refuses %s', async (_label, data) => {
      await expect(service.updateMyBazaar('owner-1', 'bazaar-1', data)).rejects.toMatchObject({
        response: { code: 'BAZAAR_END_BEFORE_START' },
      });
      expect(bazaarsRepo.update).not.toHaveBeenCalled();
      expect(searchIndexQueue.enqueue).not.toHaveBeenCalled();
    });

    it.each([
      ['a field that is not a date', { description: 'Food and music' }],
      ['clearing endDate', { endDate: null }],
      ['moving both dates forward in order', { startDate: '2026-11-01T10:00:00.000Z', endDate: '2026-11-02T10:00:00.000Z' }],
    ])('allows %s', async (_label, data) => {
      await service.updateMyBazaar('owner-1', 'bazaar-1', data as any);

      expect(bazaarsRepo.update).toHaveBeenCalledWith('bazaar-1', data);
    });
  });

  describe('cancelBazaar (organizer)', () => {
    beforeEach(() => organizersService.getOrganizerByOwnerId.mockResolvedValue(mockOrganizer));

    it('cancels a PUBLISHED bazaar and re-indexes it', async () => {
      bazaarsRepo.findById.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.PUBLISHED });
      bazaarsRepo.updateStatus.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.CANCELLED });

      await service.cancelBazaar('owner-1', 'bazaar-1');

      expect(bazaarsRepo.updateStatus).toHaveBeenCalledWith('bazaar-1', BazaarStatus.CANCELLED);
      expect(searchIndexQueue.enqueue).toHaveBeenCalledWith({ type: 'BAZAAR', id: 'bazaar-1' });
    });

    it('an already CANCELLED bazaar is a 200 no-op: nothing written or re-indexed', async () => {
      const cancelled = { ...mockBazaar, status: BazaarStatus.CANCELLED };
      bazaarsRepo.findById.mockResolvedValue(cancelled);

      await expect(service.cancelBazaar('owner-1', 'bazaar-1')).resolves.toBe(cancelled);
      expect(bazaarsRepo.updateStatus).not.toHaveBeenCalled();
      expect(searchIndexQueue.enqueue).not.toHaveBeenCalled();
    });

    it('a COMPLETED bazaar is 400 BAZAAR_COMPLETED', async () => {
      bazaarsRepo.findById.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.COMPLETED });

      await expect(service.cancelBazaar('owner-1', 'bazaar-1')).rejects.toMatchObject({
        response: { code: 'BAZAAR_COMPLETED' },
      });
      expect(bazaarsRepo.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('decideApplication (organizer)', () => {
    const pending = { id: 'app-1', bazaarId: 'bazaar-1', vendorId: 'vendor-1', applicationStatus: ApplicationStatus.PENDING };

    beforeEach(() => {
      organizersService.getOrganizerByOwnerId.mockResolvedValue(mockOrganizer);
      bazaarsRepo.findById.mockResolvedValue(mockBazaar);
    });

    it('accepts through the guarded transition, emits the event and returns the fresh row', async () => {
      const accepted = { ...pending, applicationStatus: ApplicationStatus.ACCEPTED };
      bazaarsRepo.findApplicationById.mockResolvedValueOnce(pending as any).mockResolvedValueOnce(accepted as any);
      bazaarsRepo.transitionApplication.mockResolvedValue(1);

      const result = await service.decideApplication('owner-1', 'bazaar-1', 'app-1', 'ACCEPTED');

      expect(bazaarsRepo.transitionApplication).toHaveBeenCalledWith('app-1', 'ACCEPTED');
      expect(domainEvents.emit.mock.calls[0][0]).toMatchObject({ boothListingId: 'app-1', bazaarId: 'bazaar-1', vendorId: 'vendor-1' });
      expect(result).toEqual(accepted);
    });

    it('a decision that lands first (0 rows moved) is 409 APPLICATION_STATE_CHANGED, no event', async () => {
      bazaarsRepo.findApplicationById.mockResolvedValue(pending as any);
      bazaarsRepo.transitionApplication.mockResolvedValue(0);

      await expect(service.decideApplication('owner-1', 'bazaar-1', 'app-1', 'ACCEPTED')).rejects.toMatchObject({
        status: 409,
        response: { code: 'APPLICATION_STATE_CHANGED' },
      });
      expect(domainEvents.emit).not.toHaveBeenCalled();
    });

    it('an already decided application is still 400 APPLICATION_NOT_PENDING, nothing written', async () => {
      bazaarsRepo.findApplicationById.mockResolvedValue({ ...pending, applicationStatus: ApplicationStatus.REJECTED } as any);

      await expect(service.decideApplication('owner-1', 'bazaar-1', 'app-1', 'ACCEPTED')).rejects.toMatchObject({
        response: { code: 'APPLICATION_NOT_PENDING' },
      });
      expect(bazaarsRepo.transitionApplication).not.toHaveBeenCalled();
    });

    it("another bazaar's application is 404 APPLICATION_NOT_FOUND", async () => {
      bazaarsRepo.findApplicationById.mockResolvedValue({ ...pending, bazaarId: 'other-bazaar' } as any);

      await expect(service.decideApplication('owner-1', 'bazaar-1', 'app-1', 'REJECTED')).rejects.toMatchObject({
        response: { code: 'APPLICATION_NOT_FOUND' },
      });
      expect(bazaarsRepo.transitionApplication).not.toHaveBeenCalled();
    });
  });

  describe('publishBazaar', () => {
    it('should publish a draft bazaar', async () => {
      organizersService.getOrganizerByOwnerId.mockResolvedValue(mockOrganizer);
      bazaarsRepo.findById.mockResolvedValue(mockBazaar);
      bazaarsRepo.updateStatus.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.PUBLISHED });

      const result = await service.publishBazaar('owner-1', 'bazaar-1');
      expect(result.status).toBe(BazaarStatus.PUBLISHED);
      expect(bazaarsRepo.updateStatus).toHaveBeenCalledWith('bazaar-1', BazaarStatus.PUBLISHED);
    });

    it('should throw BadRequestException if bazaar is not in DRAFT status', async () => {
      organizersService.getOrganizerByOwnerId.mockResolvedValue(mockOrganizer);
      bazaarsRepo.findById.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.COMPLETED });

      await expect(service.publishBazaar('owner-1', 'bazaar-1')).rejects.toThrow(BadRequestException);
    });

    it('emits bazaar.published after the write (ARCH-04)', async () => {
      organizersService.getOrganizerByOwnerId.mockResolvedValue(mockOrganizer);
      bazaarsRepo.findById.mockResolvedValue(mockBazaar);
      bazaarsRepo.updateStatus.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.PUBLISHED });

      await service.publishBazaar('owner-1', 'bazaar-1');

      expect(domainEvents.emit).toHaveBeenCalledTimes(1);
      expect(domainEvents.emit.mock.calls[0][0]).toMatchObject({ name: 'bazaar.published', bazaarId: 'bazaar-1' });
    });

    it('should enqueue a search sync after publishing', async () => {
      organizersService.getOrganizerByOwnerId.mockResolvedValue(mockOrganizer);
      bazaarsRepo.findById.mockResolvedValue(mockBazaar);
      bazaarsRepo.updateStatus.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.PUBLISHED });

      await service.publishBazaar('owner-1', 'bazaar-1');

      expect(searchIndexQueue.enqueue).toHaveBeenCalledWith({ type: 'BAZAAR', id: 'bazaar-1' });
    });
  });

  describe('getSearchDocument', () => {
    it('returns null for a PUBLISHED bazaar whose organizer is rejected or deleted (spec3 B8b)', async () => {
      bazaarsRepo.findById.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.PUBLISHED });
      bazaarsRepo.hasPublicOrganizer.mockResolvedValue(false);

      await expect(service.getSearchDocument('bazaar-1')).resolves.toBeNull();
      expect(bazaarsRepo.hasPublicOrganizer).toHaveBeenCalledWith('org-1');
    });

    it('returns null unless the bazaar is PUBLISHED and not deleted', async () => {
      bazaarsRepo.findById.mockResolvedValueOnce({ ...mockBazaar, status: BazaarStatus.DRAFT });
      await expect(service.getSearchDocument('bazaar-1')).resolves.toBeNull();

      bazaarsRepo.findById.mockResolvedValueOnce({ ...mockBazaar, status: BazaarStatus.PUBLISHED, deletedAt: new Date() });
      await expect(service.getSearchDocument('bazaar-1')).resolves.toBeNull();

      bazaarsRepo.findById.mockResolvedValueOnce(null);
      await expect(service.getSearchDocument('bazaar-1')).resolves.toBeNull();
    });

    it('maps a published bazaar to the allowlisted document with unix-second dates and _geo', async () => {
      const startDate = new Date('2026-01-01T00:00:00.000Z');
      bazaarsRepo.findById.mockResolvedValue({
        ...mockBazaar,
        status: BazaarStatus.PUBLISHED,
        startDate,
        endDate: null,
        location: { lat: 30.79, lng: 31 },
      });

      const doc = await service.getSearchDocument('bazaar-1');

      expect(doc).toEqual({
        id: 'bazaar-1',
        organizerId: 'org-1',
        name: 'Test Bazaar',
        description: null,
        coverMedia: [],
        scheduleType: ScheduleType.ONE_OFF,
        recurrenceRule: null,
        startDate: 1767225600,
        endDate: null,
        _geo: { lat: 30.79, lng: 31 },
      });
      expect(doc).not.toHaveProperty('status');
    });
  });

  describe('applyToBazaar', () => {
    it('should allow verified vendor to apply to a published bazaar', async () => {
      vendorsService.getMyProfile.mockResolvedValue(mockVendor as any);
      bazaarsRepo.findById.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.PUBLISHED });
      bazaarsRepo.findApplication.mockResolvedValue(null);
      bazaarsRepo.createApplication.mockResolvedValue({ id: 'app-1', bazaarId: 'bazaar-1', vendorId: 'vendor-1', applicationStatus: ApplicationStatus.PENDING, appliedAt: new Date(), decidedAt: null });

      const result = await service.applyToBazaar('owner-2', 'bazaar-1');
      expect(result.id).toBe('app-1');
    });

    it('should throw ConflictException if vendor already applied', async () => {
      vendorsService.getMyProfile.mockResolvedValue(mockVendor as any);
      bazaarsRepo.findById.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.PUBLISHED });
      bazaarsRepo.createApplication.mockRejectedValue({ code: 'P2002', meta: { target: ['bazaarId_vendorId'] } });

      await expect(service.applyToBazaar('owner-2', 'bazaar-1')).rejects.toThrow(ConflictException);
    });

    it('refuses a PUBLISHED bazaar whose organizer is rejected or deleted (spec3 B8b)', async () => {
      vendorsService.getMyProfile.mockResolvedValue(mockVendor as any);
      bazaarsRepo.findById.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.PUBLISHED });
      bazaarsRepo.hasPublicOrganizer.mockResolvedValue(false);

      await expect(service.applyToBazaar('owner-2', 'bazaar-1')).rejects.toMatchObject({
        response: { code: 'BAZAAR_NOT_ACCEPTING_APPLICATIONS' },
      });
      expect(bazaarsRepo.hasPublicOrganizer).toHaveBeenCalledWith('org-1');
      expect(bazaarsRepo.createApplication).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if bazaar is not published', async () => {
      vendorsService.getMyProfile.mockResolvedValue(mockVendor as any);
      bazaarsRepo.findById.mockResolvedValue(mockBazaar); // Status is DRAFT

      await expect(service.applyToBazaar('owner-2', 'bazaar-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw ForbiddenException if vendor is unverified', async () => {
      vendorsService.getMyProfile.mockResolvedValue({ ...mockVendor, verified: false } as any);

      await expect(service.applyToBazaar('owner-2', 'bazaar-1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('admin reads (specs/admin-module-spec2.md A3)', () => {
    it('listForAdmin passes filters through with no ownership scope and wraps { data, meta }', async () => {
      bazaarsRepo.findManyForAdmin.mockResolvedValue({ data: [{ id: 'b1', status: 'DRAFT' }] as any, total: 41 });

      const params = { status: 'DRAFT' as const, organizerId: 'org-9', search: 'souq', includeDeleted: true, page: 3, limit: 20 };
      const result = await service.listForAdmin(params);

      expect(bazaarsRepo.findManyForAdmin).toHaveBeenCalledWith(params);
      expect(organizersService.getOrganizerByOwnerId).not.toHaveBeenCalled();
      expect(result.meta).toEqual({ total: 41, page: 3, limit: 20, totalPages: 3 });
    });

    it('getBazaarForAdmin returns a DRAFT bazaar without resolving an owner', async () => {
      const detail = { id: 'b1', status: 'DRAFT', applicationCounts: { PENDING: 1, ACCEPTED: 0, REJECTED: 0 }, hasLayout: false };
      bazaarsRepo.findByIdForAdmin.mockResolvedValue(detail as any);

      await expect(service.getBazaarForAdmin('b1')).resolves.toBe(detail);
      expect(organizersService.getOrganizerByOwnerId).not.toHaveBeenCalled();
    });

    it('getBazaarForAdmin throws a coded 404 for an unknown id', async () => {
      bazaarsRepo.findByIdForAdmin.mockResolvedValue(null);

      await expect(service.getBazaarForAdmin('missing')).rejects.toMatchObject({ response: { code: 'BAZAAR_NOT_FOUND' } });
    });
  });

  describe('admin application reads (specs/admin-module-spec2.md A4)', () => {
    it('listApplicationsForAdmin passes filters through with no owner lookup and wraps { data, meta }', async () => {
      bazaarsRepo.findApplicationsForAdmin.mockResolvedValue({ data: [{ id: 'app-1' }] as any, total: 3 });

      const params = { bazaarId: 'b1', vendorId: 'v1', status: ApplicationStatus.PENDING, page: 1, limit: 2 };
      const result = await service.listApplicationsForAdmin(params);

      expect(bazaarsRepo.findApplicationsForAdmin).toHaveBeenCalledWith(params);
      expect(organizersService.getOrganizerByOwnerId).not.toHaveBeenCalled();
      expect(vendorsService.getMyProfile).not.toHaveBeenCalled();
      expect(result.meta).toEqual({ total: 3, page: 1, limit: 2, totalPages: 2 });
    });

    it('getApplicationForAdmin returns the application', async () => {
      const application = { id: 'app-1', applicationStatus: ApplicationStatus.ACCEPTED, booth: { id: 'booth-1', label: 'A-1' } };
      bazaarsRepo.findApplicationByIdForAdmin.mockResolvedValue(application as any);

      await expect(service.getApplicationForAdmin('app-1')).resolves.toBe(application);
    });

    it('getApplicationForAdmin throws a coded 404 for an unknown id', async () => {
      bazaarsRepo.findApplicationByIdForAdmin.mockResolvedValue(null);

      await expect(service.getApplicationForAdmin('missing')).rejects.toMatchObject({
        response: { code: 'APPLICATION_NOT_FOUND' },
      });
    });
  });

  describe('decideApplicationForAdmin (specs/admin-module-spec3.md B5)', () => {
    const pending = { id: 'app-1', bazaarId: 'b1', vendorId: 'v1', applicationStatus: ApplicationStatus.PENDING };

    it('accepts a PENDING application via the guarded transition, emits the event, audits after', async () => {
      bazaarsRepo.findApplicationByIdForAdmin
        .mockResolvedValueOnce(pending as any)
        .mockResolvedValueOnce({ ...pending, applicationStatus: ApplicationStatus.ACCEPTED } as any);
      bazaarsRepo.transitionApplication.mockResolvedValue(1);

      const result = await service.decideApplicationForAdmin('admin-1', 'app-1', 'ACCEPTED');

      expect(result.applicationStatus).toBe(ApplicationStatus.ACCEPTED);
      expect(bazaarsRepo.transitionApplication).toHaveBeenCalledWith('app-1', 'ACCEPTED');
      expect(domainEvents.emit.mock.calls[0][0]).toMatchObject({ boothListingId: 'app-1', bazaarId: 'b1', vendorId: 'v1' });
      expect(auditService.record).toHaveBeenCalledWith({
        actorId: 'admin-1',
        action: 'APPLICATION_ACCEPTED',
        targetType: 'APPLICATION',
        targetId: 'app-1',
        reason: null,
      });
      expect(bazaarsRepo.transitionApplication.mock.invocationCallOrder[0]).toBeLessThan(
        auditService.record.mock.invocationCallOrder[0],
      );
    });

    it('rejects a PENDING application with the reason in the audit and no event', async () => {
      bazaarsRepo.findApplicationByIdForAdmin.mockResolvedValue(pending as any);
      bazaarsRepo.transitionApplication.mockResolvedValue(1);

      await service.decideApplicationForAdmin('admin-1', 'app-1', 'REJECTED', 'Duplicate stall');

      expect(domainEvents.emit).not.toHaveBeenCalled();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'APPLICATION_REJECTED', reason: 'Duplicate stall' }),
      );
    });

    it('repeating the decision it already has is a no-op', async () => {
      bazaarsRepo.findApplicationByIdForAdmin.mockResolvedValue({ ...pending, applicationStatus: ApplicationStatus.ACCEPTED } as any);

      await service.decideApplicationForAdmin('admin-1', 'app-1', 'ACCEPTED');

      expect(bazaarsRepo.transitionApplication).not.toHaveBeenCalled();
      expect(domainEvents.emit).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it.each([
      [ApplicationStatus.ACCEPTED, 'REJECTED'],
      [ApplicationStatus.REJECTED, 'ACCEPTED'],
    ] as const)('no reversals: %s → %s is 400 APPLICATION_NOT_PENDING', async (from, to) => {
      bazaarsRepo.findApplicationByIdForAdmin.mockResolvedValue({ ...pending, applicationStatus: from } as any);

      await expect(service.decideApplicationForAdmin('admin-1', 'app-1', to)).rejects.toMatchObject({
        status: 400,
        response: { code: 'APPLICATION_NOT_PENDING' },
      });
      expect(bazaarsRepo.transitionApplication).not.toHaveBeenCalled();
    });

    it('a lost race (0 rows moved) is 409 APPLICATION_STATE_CHANGED with nothing audited', async () => {
      bazaarsRepo.findApplicationByIdForAdmin.mockResolvedValue(pending as any);
      bazaarsRepo.transitionApplication.mockResolvedValue(0);

      await expect(service.decideApplicationForAdmin('admin-1', 'app-1', 'ACCEPTED')).rejects.toMatchObject({
        status: 409,
        response: { code: 'APPLICATION_STATE_CHANGED' },
      });
      expect(domainEvents.emit).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });

  describe('cancelBazaarForAdmin (specs/admin-module-spec3.md B7)', () => {
    it.each([BazaarStatus.DRAFT, BazaarStatus.PUBLISHED])(
      'cancels a %s bazaar of any organizer, re-indexes, audits after the write',
      async (status) => {
        bazaarsRepo.findById.mockResolvedValue({ ...mockBazaar, status } as any);
        bazaarsRepo.findByIdForAdmin.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.CANCELLED } as any);

        await service.cancelBazaarForAdmin('admin-1', 'bazaar-1');

        expect(organizersService.getOrganizerByOwnerId).not.toHaveBeenCalled();
        expect(bazaarsRepo.updateStatus).toHaveBeenCalledWith('bazaar-1', BazaarStatus.CANCELLED);
        expect(searchIndexQueue.enqueue).toHaveBeenCalledWith({ type: 'BAZAAR', id: 'bazaar-1' });
        expect(auditService.record).toHaveBeenCalledWith({
          actorId: 'admin-1',
          action: 'BAZAAR_CANCELLED',
          targetType: 'BAZAAR',
          targetId: 'bazaar-1',
        });
        expect(bazaarsRepo.updateStatus.mock.invocationCallOrder[0]).toBeLessThan(
          auditService.record.mock.invocationCallOrder[0],
        );
      },
    );

    it('400 BAZAAR_COMPLETED for a finished bazaar (the organizer rule)', async () => {
      bazaarsRepo.findById.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.COMPLETED } as any);

      await expect(service.cancelBazaarForAdmin('admin-1', 'bazaar-1')).rejects.toMatchObject({
        status: 400,
        response: { code: 'BAZAAR_COMPLETED' },
      });
      expect(bazaarsRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('an already CANCELLED bazaar is a no-op', async () => {
      bazaarsRepo.findById.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.CANCELLED } as any);
      bazaarsRepo.findByIdForAdmin.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.CANCELLED } as any);

      await service.cancelBazaarForAdmin('admin-1', 'bazaar-1');

      expect(bazaarsRepo.updateStatus).not.toHaveBeenCalled();
      expect(searchIndexQueue.enqueue).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('404 BAZAAR_NOT_FOUND for a missing or soft-deleted bazaar', async () => {
      for (const found of [null, { ...mockBazaar, deletedAt: new Date() }]) {
        bazaarsRepo.findById.mockResolvedValueOnce(found as any);
        await expect(service.cancelBazaarForAdmin('admin-1', 'bazaar-1')).rejects.toMatchObject({
          response: { code: 'BAZAAR_NOT_FOUND' },
        });
      }
      expect(bazaarsRepo.updateStatus).not.toHaveBeenCalled();
    });
  });
});
