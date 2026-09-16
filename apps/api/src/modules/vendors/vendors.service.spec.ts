import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { VendorsService } from './vendors.service';
import { VendorsRepository } from './vendors.repository';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';

describe('VendorsService', () => {
  let service: VendorsService;
  let vendorsRepository: jest.Mocked<VendorsRepository>;
  let searchIndexQueue: jest.Mocked<SearchIndexQueue>;

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
      findForSearch: jest.fn(),
      listPublicIds: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorsService,
        { provide: VendorsRepository, useValue: vendorsRepositoryMock },
        {
          provide: SearchIndexQueue,
          useValue: { enqueue: jest.fn().mockResolvedValue(undefined), enqueueMany: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<VendorsService>(VendorsService);
    vendorsRepository = module.get(VendorsRepository);
    searchIndexQueue = module.get(SearchIndexQueue);
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

  describe('verifyVendor', () => {
    it('enqueues exactly two jobs: the vendor and a product fan-out, never per product', async () => {
      vendorsRepository.findById.mockResolvedValue({ id: 'vendor-1', verified: false } as any);
      vendorsRepository.update.mockResolvedValue({ id: 'vendor-1', verified: true } as any);

      await service.verifyVendor('vendor-1');

      expect(vendorsRepository.update).toHaveBeenCalledWith('vendor-1', { verified: true });
      expect(searchIndexQueue.enqueueMany).toHaveBeenCalledWith([
        { type: 'VENDOR', id: 'vendor-1' },
        { type: 'VENDOR_PRODUCTS', vendorId: 'vendor-1' },
      ]);
    });
  });

  describe('product writes enqueue a PRODUCT sync', () => {
    beforeEach(() => {
      vendorsRepository.findByOwnerId.mockResolvedValue({ id: 'vendor-1', verified: true } as any);
      vendorsRepository.findProductByIdAndVendor.mockResolvedValue({ id: 'prod-1', variants: [{ id: 'var-1' }] } as any);
    });

    it('createProduct enqueues even though the product starts PENDING', async () => {
      vendorsRepository.createProduct.mockResolvedValue({ id: 'prod-new' } as any);

      await service.createProduct('owner-1', { title: 'T', description: 'D', categoryId: 'c', basePrice: 1, images: [] });

      expect(searchIndexQueue.enqueue).toHaveBeenCalledWith({ type: 'PRODUCT', id: 'prod-new' });
    });

    it('updateProduct / deleteProduct enqueue the product', async () => {
      vendorsRepository.updateProduct.mockResolvedValue({ id: 'prod-1' } as any);
      vendorsRepository.softDeleteProduct.mockResolvedValue({ id: 'prod-1' } as any);

      await service.updateProduct('owner-1', 'prod-1', { title: 'New' });
      await service.deleteProduct('owner-1', 'prod-1');

      expect(searchIndexQueue.enqueue).toHaveBeenCalledTimes(2);
      expect(searchIndexQueue.enqueue).toHaveBeenCalledWith({ type: 'PRODUCT', id: 'prod-1' });
    });

    it('variant writes re-index the parent product', async () => {
      vendorsRepository.createProductVariant.mockResolvedValue({ id: 'var-2' } as any);
      vendorsRepository.updateProductVariant.mockResolvedValue({ id: 'var-1' } as any);
      vendorsRepository.deleteProductVariant.mockResolvedValue({ id: 'var-1' } as any);

      await service.createProductVariant('owner-1', 'prod-1', { sku: 'S2' });
      await service.updateProductVariant('owner-1', 'prod-1', 'var-1', { stockQuantity: 3 });
      await service.deleteProductVariant('owner-1', 'prod-1', 'var-1');

      expect(searchIndexQueue.enqueue).toHaveBeenCalledTimes(3);
      expect(searchIndexQueue.enqueue).toHaveBeenLastCalledWith({ type: 'PRODUCT', id: 'prod-1' });
    });
  });

  describe('getSearchDocument', () => {
    const vendor = {
      id: 'vendor-1',
      name: 'Nour Atelier',
      category: 'fashion',
      description: 'd',
      brandStory: null,
      logoUrl: null,
      bannerUrl: null,
      vendorType: 'BOTH',
      hasFixedLocation: true,
    };

    it('returns null when the vendor is unverified or deleted', async () => {
      vendorsRepository.findForSearch.mockResolvedValue(null);

      await expect(service.getSearchDocument('vendor-1')).resolves.toBeNull();
      expect(vendorsRepository.findVendorLocation).not.toHaveBeenCalled();
    });

    it('includes _geo when a home location exists', async () => {
      vendorsRepository.findForSearch.mockResolvedValue(vendor as any);
      vendorsRepository.findVendorLocation.mockResolvedValue({ lat: 30.79, lng: 31 });

      await expect(service.getSearchDocument('vendor-1')).resolves.toEqual({
        ...vendor,
        _geo: { lat: 30.79, lng: 31 },
      });
    });

    it('omits _geo entirely (not null) when there is no home location', async () => {
      vendorsRepository.findForSearch.mockResolvedValue(vendor as any);
      vendorsRepository.findVendorLocation.mockResolvedValue(null);

      const doc = await service.getSearchDocument('vendor-1');

      expect(doc).toEqual(vendor);
      expect(doc).not.toHaveProperty('_geo');
    });
  });
});
