import { Test, TestingModule } from '@nestjs/testing';
import { BoothsService } from './booths.service';
import { BoothsRepository } from './booths.repository';
import { BazaarsService } from '../bazaars/bazaars.service';
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

describe('BoothsService', () => {
  let service: BoothsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BoothsService,
        { provide: BoothsRepository, useValue: mockBoothsRepository },
        { provide: BazaarsService, useValue: mockBazaarsService },
      ],
    }).compile();

    service = module.get<BoothsService>(BoothsService);
    jest.clearAllMocks();
  });

  describe('Layout Management', () => {
    it('should create layout successfully', async () => {
      mockBazaarsService.findById.mockResolvedValue({ id: 'b1' });
      mockBoothsRepository.createLayout.mockResolvedValue({ id: 'l1', bazaarId: 'b1' });

      const result = await service.createLayout('b1', { rows: 5, cols: 5, cellSize: 10 });
      expect(result.id).toBe('l1');
    });

    it('should throw ConflictException on layout creation conflict (409)', async () => {
      mockBazaarsService.findById.mockResolvedValue({ id: 'b1' });
      mockBoothsRepository.createLayout.mockRejectedValue({
        code: 'P2002',
        meta: { target: ['bazaarId'] },
      });

      await expect(service.createLayout('b1', { rows: 5, cols: 5, cellSize: 10 })).rejects.toThrow(
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
        service.createBooth('b1', { label: 'A1', positionX: 0, positionY: 0, width: 1, height: 1 }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw BadRequestException on delete-blocked-when-occupied (400)', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue({ id: 'booth1', boothListingId: 'app1' });
      await expect(service.deleteBooth('booth1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('Assign Validation Chain', () => {
    it('1. Booth exists (404 if not)', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue(null);
      await expect(service.assignBooth('booth1', 'app1')).rejects.toThrow(NotFoundException);
    });

    it('2. Booth is unassigned (400 if already assigned)', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue({ id: 'booth1', boothListingId: 'existing' });
      await expect(service.assignBooth('booth1', 'app1')).rejects.toThrow(BadRequestException);
    });

    it('3. The BoothListing exists (404 if not)', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue({ id: 'booth1', boothListingId: null });
      mockBazaarsService.findApplicationById.mockResolvedValue(null);
      await expect(service.assignBooth('booth1', 'app1')).rejects.toThrow(NotFoundException);
    });

    it('4. The BoothListing.applicationStatus === ACCEPTED (400 if not)', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue({ id: 'booth1', boothListingId: null });
      mockBazaarsService.findApplicationById.mockResolvedValue({ id: 'app1', applicationStatus: ApplicationStatus.PENDING });
      await expect(service.assignBooth('booth1', 'app1')).rejects.toThrow(BadRequestException);
    });

    it('5. The BoothListing.bazaarId matches layout bazaarId (400 if not)', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue({ id: 'booth1', boothListingId: null, layoutId: 'l1' });
      mockBazaarsService.findApplicationById.mockResolvedValue({ id: 'app1', bazaarId: 'b2', applicationStatus: ApplicationStatus.ACCEPTED });
      mockBoothsRepository.findLayoutByBazaarId.mockResolvedValue({ id: 'l2', bazaarId: 'b2' }); // Layout is for a DIFFERENT bazaar

      await expect(service.assignBooth('booth1', 'app1')).rejects.toThrow(BadRequestException);
    });

    it('should assign successfully when all checks pass', async () => {
      mockBoothsRepository.findBoothById.mockResolvedValue({ id: 'booth1', boothListingId: null, layoutId: 'l1' });
      mockBazaarsService.findApplicationById.mockResolvedValue({ id: 'app1', bazaarId: 'b1', applicationStatus: ApplicationStatus.ACCEPTED });
      mockBoothsRepository.findLayoutByBazaarId.mockResolvedValue({ id: 'l1', bazaarId: 'b1' });
      mockBoothsRepository.assignBooth.mockResolvedValue({ id: 'booth1', boothListingId: 'app1' });

      const result = await service.assignBooth('booth1', 'app1');
      expect(result.boothListingId).toBe('app1');
    });
  });

  describe('Unassign Idempotency', () => {
    it('should return booth without db update if already unassigned', async () => {
      const booth = { id: 'booth1', boothListingId: null };
      mockBoothsRepository.findBoothById.mockResolvedValue(booth);
      
      const result = await service.unassignBooth('booth1');
      
      expect(result).toEqual(booth);
      expect(mockBoothsRepository.unassignBooth).not.toHaveBeenCalled();
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
