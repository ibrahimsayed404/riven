import { Test, TestingModule } from '@nestjs/testing';
import { BazaarsService } from './bazaars.service';
import { BazaarsRepository } from './bazaars.repository';
import { OrganizersService } from './organizers.service';
import { VendorsService } from '../vendors/vendors.service';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { BazaarStatus, ScheduleType, ApplicationStatus } from '@prisma/client';

describe('BazaarsService', () => {
  let service: BazaarsService;
  let bazaarsRepo: jest.Mocked<BazaarsRepository>;
  let organizersService: jest.Mocked<OrganizersService>;
  let vendorsService: jest.Mocked<VendorsService>;
  let searchIndexQueue: jest.Mocked<SearchIndexQueue>;

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
            updateApplicationStatus: jest.fn(),
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
      ],
    }).compile();

    service = module.get<BazaarsService>(BazaarsService);
    bazaarsRepo = module.get(BazaarsRepository);
    organizersService = module.get(OrganizersService);
    vendorsService = module.get(VendorsService);
    searchIndexQueue = module.get(SearchIndexQueue);
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

    it('should enqueue a search sync after publishing', async () => {
      organizersService.getOrganizerByOwnerId.mockResolvedValue(mockOrganizer);
      bazaarsRepo.findById.mockResolvedValue(mockBazaar);
      bazaarsRepo.updateStatus.mockResolvedValue({ ...mockBazaar, status: BazaarStatus.PUBLISHED });

      await service.publishBazaar('owner-1', 'bazaar-1');

      expect(searchIndexQueue.enqueue).toHaveBeenCalledWith({ type: 'BAZAAR', id: 'bazaar-1' });
    });
  });

  describe('getSearchDocument', () => {
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
});
