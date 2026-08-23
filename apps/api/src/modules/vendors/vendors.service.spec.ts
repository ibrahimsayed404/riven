import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { VendorsService } from './vendors.service';
import { VendorsRepository } from './vendors.repository';

describe('VendorsService', () => {
  let service: VendorsService;
  let vendorsRepository: jest.Mocked<VendorsRepository>;

  beforeEach(async () => {
    const vendorsRepositoryMock = {
      findByOwnerId: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      updateLocation: jest.fn(),
      findVendorLocation: jest.fn(),
      createProduct: jest.fn(),
      findProductByIdAndVendor: jest.fn(),
      findProductsPaginated: jest.fn(),
      updateProduct: jest.fn(),
      softDeleteProduct: jest.fn(),
      createProductVariant: jest.fn(),
      updateProductVariant: jest.fn(),
      deleteProductVariant: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorsService,
        { provide: VendorsRepository, useValue: vendorsRepositoryMock },
      ],
    }).compile();

    service = module.get<VendorsService>(VendorsService);
    vendorsRepository = module.get(VendorsRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createProduct', () => {
    it('should throw ForbiddenException if vendor is not verified', async () => {
      vendorsRepository.findByOwnerId.mockResolvedValue({ id: 'vendor-1', verified: false } as any);

      await expect(service.createProduct('owner-1', {
        title: 'Test Product',
        description: 'Desc',
        categoryId: 'cat-1',
        basePrice: 100,
        images: [],
      })).rejects.toThrow(ForbiddenException);
    });

    it('should call repository createProduct if verified', async () => {
      vendorsRepository.findByOwnerId.mockResolvedValue({ id: 'vendor-1', verified: true } as any);
      vendorsRepository.createProduct.mockResolvedValue({ id: 'prod-1' } as any);

      const result = await service.createProduct('owner-1', {
        title: 'Test Product',
        description: 'Desc',
        categoryId: 'cat-1',
        basePrice: 100,
        images: [],
      });

      expect(result).toEqual({ id: 'prod-1' });
      expect(vendorsRepository.createProduct).toHaveBeenCalledWith('vendor-1', expect.objectContaining({
        title: 'Test Product',
        approvalStatus: 'PENDING',
      }));
    });
  });

  describe('updateProduct', () => {
    it('should reset approvalStatus to PENDING', async () => {
      vendorsRepository.findByOwnerId.mockResolvedValue({ id: 'vendor-1', verified: true } as any);
      vendorsRepository.findProductByIdAndVendor.mockResolvedValue({ id: 'prod-1', vendorId: 'vendor-1' } as any);
      vendorsRepository.updateProduct.mockResolvedValue({ id: 'prod-1', approvalStatus: 'PENDING' } as any);

      await service.updateProduct('owner-1', 'prod-1', {
        title: 'Updated Title',
      });

      expect(vendorsRepository.updateProduct).toHaveBeenCalledWith('prod-1', expect.objectContaining({
        title: 'Updated Title',
        approvalStatus: 'PENDING',
        rejectionReason: null,
      }));
    });
  });

  describe('updateMyLocation', () => {
    it('should throw HttpException with 429 when called within cooldown window', async () => {
      vendorsRepository.findByOwnerId.mockResolvedValue({ id: 'vendor-1', verified: true } as any);
      
      // Call once, which succeeds and sets the timestamp
      await service.updateMyLocation('owner-1', { lat: 10, lng: 20 });
      
      // Call again immediately, should throw
      await expect(service.updateMyLocation('owner-1', { lat: 10, lng: 20 }))
        .rejects
        .toThrow(expect.objectContaining({
          status: 429
        }));
    });
  });
});
