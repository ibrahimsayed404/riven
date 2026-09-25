import { Test, TestingModule } from '@nestjs/testing';
import { BoothsService } from './booths.service';
import { BoothsRepository } from './booths.repository';
import { BazaarsService } from '../bazaars/bazaars.service';
import { AuditService } from '../audit/audit.service';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { ApplicationStatus } from '@prisma/client';

const mockBoothsRepository = {
  createLayout: jest.fn(),
  findLayoutByBazaarId: jest.fn(),
  updateLayoutGridConfig: jest.fn(),
  createBooth: jest.fn(),
  findBoothById: jest.fn(),
  updateBooth: jest.fn(),
  deleteBooth: jest.fn(),
  assignBooth: jest.fn(),
  unassignBooth: jest.fn(),
  findPublicLayoutByBazaarId: jest.fn(),
};

const mockBazaarsService = {
  findById: jest.fn(),
  findPublicById: jest.fn(),
  findApplicationById: jest.fn(),
};

const mockAuditService = { record: jest.fn().mockResolvedValue(undefined) };

describe('BoothsService', () => {
  let service: BoothsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BoothsService,
        { provide: BoothsRepository, useValue: mockBoothsRepository },
        { provide: BazaarsService, useValue: mockBazaarsService },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<BoothsService>(BoothsService);
    jest.clearAllMocks();
  });

  describe('Layout Management', () => {
    it('should create layout successfully', async () => {
      mockBazaarsService.findById.mockResolvedValue({ id: 'b1' });
      mockBoothsRepository.createLayout.mockResolvedValue({ id: 'l1', bazaarId: 'b1' });

      const result = await service.createLayout('admin-1', 'b1', { rows: 5, cols: 5, cellSize: 10 });
      expect(result.id).toBe('l1');
    });

    it('should throw ConflictException on layout creation conflict (409)', async () => {
      mockBazaarsService.findById.mockResolvedValue({ id: 'b1' });
      mockBoothsRepository.createLayout.mockRejectedValue({
        code: 'P2002',
        meta: { target: ['bazaarId'] },
      });

      await expect(service.createLayout('admin-1', 'b1', { rows: 5, cols: 5, cellSize: 10 })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('Booth Management', () => {
    it('should throw ConflictException on booth label conflict (409)', async () => {
      mockBoothsRepository.findLayoutByBazaarId.mockResolvedValue({ id: 'l1', bazaarId: 'b1' });
      mockBoothsRepository.createBooth.mockRejectedValue({
        code: 'P2002',
        meta: { target: ['layoutId', 'label'] },
      });

      await expect(
        service.createBooth('admin-1', 'b1', { label: 'A1', positionX: 0, positionY: 0, width: 1, height: 1 }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw BadRequestException on delete-blocked-when-occupied (400)', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue({ id: 'booth1', boothListingId: 'app1' });
      await expect(service.deleteBooth('admin-1', 'booth1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('Assign Validation Chain', () => {
    it('1. Booth exists (404 if not)', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue(null);
      await expect(service.assignBooth('admin-1', 'booth1', 'app1')).rejects.toThrow(NotFoundException);
    });

    it('2. Booth is unassigned (400 if already assigned)', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue({ id: 'booth1', boothListingId: 'existing' });
      await expect(service.assignBooth('admin-1', 'booth1', 'app1')).rejects.toThrow(BadRequestException);
    });

    it('3. The BoothListing exists (404 if not)', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue({ id: 'booth1', boothListingId: null });
      mockBazaarsService.findApplicationById.mockResolvedValue(null);
      await expect(service.assignBooth('admin-1', 'booth1', 'app1')).rejects.toThrow(NotFoundException);
    });

    it('4. The BoothListing.applicationStatus === ACCEPTED (400 if not)', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue({ id: 'booth1', boothListingId: null });
      mockBazaarsService.findApplicationById.mockResolvedValue({ id: 'app1', applicationStatus: ApplicationStatus.PENDING });
      await expect(service.assignBooth('admin-1', 'booth1', 'app1')).rejects.toThrow(BadRequestException);
    });

    it('5. The BoothListing.bazaarId matches layout bazaarId (400 if not)', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue({ id: 'booth1', boothListingId: null, layoutId: 'l1' });
      mockBazaarsService.findApplicationById.mockResolvedValue({ id: 'app1', bazaarId: 'b2', applicationStatus: ApplicationStatus.ACCEPTED });
      mockBoothsRepository.findLayoutByBazaarId.mockResolvedValue({ id: 'l2', bazaarId: 'b2' }); // Layout is for a DIFFERENT bazaar

      await expect(service.assignBooth('admin-1', 'booth1', 'app1')).rejects.toThrow(BadRequestException);
    });

    it('should assign successfully when all checks pass', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue({ id: 'booth1', boothListingId: null, layoutId: 'l1' });
      mockBazaarsService.findApplicationById.mockResolvedValue({ id: 'app1', bazaarId: 'b1', applicationStatus: ApplicationStatus.ACCEPTED });
      mockBoothsRepository.findLayoutByBazaarId.mockResolvedValue({ id: 'l1', bazaarId: 'b1' });
      mockBoothsRepository.assignBooth.mockResolvedValue({ id: 'booth1', boothListingId: 'app1' });

      const result = await service.assignBooth('admin-1', 'booth1', 'app1');
      expect(result.boothListingId).toBe('app1');
    });
  });

  describe('Unassign Idempotency', () => {
    it('should return booth without db update if already unassigned', async () => {
      const booth = { id: 'booth1', boothListingId: null };
      mockBoothsRepository.findBoothById.mockResolvedValue(booth);
      
      const result = await service.unassignBooth('admin-1', 'booth1');
      
      expect(result).toEqual(booth);
      expect(mockBoothsRepository.unassignBooth).not.toHaveBeenCalled();
    });
  });

  describe('audit of admin writes (specs/admin-module-spec3.md B8c)', () => {
    const recorded = () => mockAuditService.record.mock.calls.map((c) => c[0]);

    it('layout create/update audit against the BAZAAR, after the write', async () => {
      mockBazaarsService.findById.mockResolvedValue({ id: 'b1' });
      mockBoothsRepository.createLayout.mockResolvedValue({ id: 'l1', bazaarId: 'b1' });
      mockBoothsRepository.findLayoutByBazaarId.mockResolvedValue({ id: 'l1' });
      mockBoothsRepository.updateLayoutGridConfig.mockResolvedValue({ id: 'l1' });

      await service.createLayout('admin-1', 'b1', { rows: 5, cols: 5, cellSize: 10 });
      await service.updateLayout('admin-1', 'b1', { rows: 6, cols: 6, cellSize: 10 });

      expect(recorded()).toEqual([
        { actorId: 'admin-1', action: 'BOOTH_LAYOUT_CREATED', targetType: 'BAZAAR', targetId: 'b1' },
        { actorId: 'admin-1', action: 'BOOTH_LAYOUT_UPDATED', targetType: 'BAZAAR', targetId: 'b1' },
      ]);
      expect(mockBoothsRepository.createLayout.mock.invocationCallOrder[0]).toBeLessThan(
        mockAuditService.record.mock.invocationCallOrder[0],
      );
    });

    it('booth create/update/delete/assign/unassign audit against the BOOTH', async () => {
      mockBoothsRepository.findLayoutByBazaarId.mockResolvedValue({ id: 'l1' });
      mockBoothsRepository.createBooth.mockResolvedValue({ id: 'booth-new' });
      mockBoothsRepository.findBoothById
        .mockResolvedValueOnce({ id: 'booth1', boothListingId: null }) // update
        .mockResolvedValueOnce({ id: 'booth1', boothListingId: null }) // delete
        .mockResolvedValueOnce({ id: 'booth1', layoutId: 'l1', boothListingId: null }) // assign
        .mockResolvedValueOnce({ id: 'booth1', boothListingId: 'app1' }); // unassign
      mockBoothsRepository.updateBooth.mockResolvedValue({ id: 'booth1' });
      mockBoothsRepository.deleteBooth.mockResolvedValue({ id: 'booth1' });
      mockBazaarsService.findApplicationById.mockResolvedValue({ id: 'app1', bazaarId: 'b1', applicationStatus: ApplicationStatus.ACCEPTED });
      mockBoothsRepository.assignBooth.mockResolvedValue({ id: 'booth1', boothListingId: 'app1' });
      mockBoothsRepository.unassignBooth.mockResolvedValue({ id: 'booth1', boothListingId: null });

      await service.createBooth('admin-1', 'b1', { label: 'A1', positionX: 0, positionY: 0, width: 1, height: 1 });
      await service.updateBooth('admin-1', 'booth1', { label: 'A2' });
      await service.deleteBooth('admin-1', 'booth1');
      await service.assignBooth('admin-1', 'booth1', 'app1');
      await service.unassignBooth('admin-1', 'booth1');

      expect(recorded().map((e) => [e.action, e.targetType, e.targetId])).toEqual([
        ['BOOTH_CREATED', 'BOOTH', 'booth-new'],
        ['BOOTH_UPDATED', 'BOOTH', 'booth1'],
        ['BOOTH_DELETED', 'BOOTH', 'booth1'],
        ['BOOTH_ASSIGNED', 'BOOTH', 'booth1'],
        ['BOOTH_UNASSIGNED', 'BOOTH', 'booth1'],
      ]);
    });

    it('a refused write or an idempotent unassign records nothing', async () => {
      mockBoothsRepository.findBoothById
        .mockResolvedValueOnce({ id: 'booth1', boothListingId: 'app1' }) // delete refused: assigned
        .mockResolvedValueOnce({ id: 'booth1', boothListingId: null }); // unassign no-op

      await expect(service.deleteBooth('admin-1', 'booth1')).rejects.toThrow(BadRequestException);
      await service.unassignBooth('admin-1', 'booth1');

      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });

  describe('Public Endpoint', () => {
    it('should return 404 if bazaar is not visible', async () => {
      mockBazaarsService.findPublicById.mockResolvedValue(null);
      await expect(service.getPublicLayout('b1')).rejects.toThrow(NotFoundException);
    });

    it('should return 404 if layout not yet created', async () => {
      mockBazaarsService.findPublicById.mockResolvedValue({ id: 'b1' });
      mockBoothsRepository.findPublicLayoutByBazaarId.mockResolvedValue(null);
      await expect(service.getPublicLayout('b1')).rejects.toThrow(NotFoundException);
    });
  });
});
