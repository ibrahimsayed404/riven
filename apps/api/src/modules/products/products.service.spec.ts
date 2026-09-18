import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProductsService } from './products.service';
import { ProductsRepository } from './products.repository';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';
import { AuditService } from '../audit/audit.service';

describe('ProductsService', () => {
  let service: ProductsService;
  let productsRepository: jest.Mocked<ProductsRepository>;
  let searchIndexQueue: jest.Mocked<SearchIndexQueue>;
  let auditService: jest.Mocked<AuditService>;

  beforeEach(async () => {
    const productsRepositoryMock = {
      findManyPaginated: jest.fn(),
      findById: jest.fn(),
      updateAdminStatus: jest.fn(),
      findForSearch: jest.fn(),
      findCategoryPath: jest.fn(),
      listIdsByVendor: jest.fn(),
      listPublicIds: jest.fn(),
      findModerationState: jest.fn(),
      findManyForAdmin: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: ProductsRepository, useValue: productsRepositoryMock },
        {
          provide: SearchIndexQueue,
          useValue: { enqueue: jest.fn().mockResolvedValue(undefined), enqueueMany: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: AuditService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
    productsRepository = module.get(ProductsRepository);
    searchIndexQueue = module.get(SearchIndexQueue);
    auditService = module.get(AuditService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('listProducts', () => {
    it('should call repository with default pagination', async () => {
      productsRepository.findManyPaginated.mockResolvedValue({ data: [], total: 0 });

      await service.listProducts({});

      expect(productsRepository.findManyPaginated).toHaveBeenCalledWith({
        page: 1,
        limit: 20,
        categoryId: undefined,
        vendorId: undefined,
        search: undefined,
      });
    });
  });

  // specs/admin-module-spec.md §4.3 — idempotent approve/reject with audit.
  describe('approveProduct / rejectProduct', () => {
    const state = (approvalStatus: 'PENDING' | 'APPROVED' | 'REJECTED', rejectionReason: string | null, deletedAt: Date | null = null) =>
      ({ id: 'prod-1', approvalStatus, rejectionReason, deletedAt }) as any;

    beforeEach(() => {
      productsRepository.updateAdminStatus.mockImplementation(async (_id, data: any) => ({ id: 'prod-1', ...data }) as any);
    });

    it('PENDING → approve: writes, enqueues, audits PRODUCT_APPROVED', async () => {
      productsRepository.findModerationState.mockResolvedValue(state('PENDING', null));

      const result = await service.approveProduct('admin-1', 'prod-1');

      expect(productsRepository.updateAdminStatus).toHaveBeenCalledWith('prod-1', { approvalStatus: 'APPROVED', rejectionReason: null });
      expect(searchIndexQueue.enqueue).toHaveBeenCalledWith({ type: 'PRODUCT', id: 'prod-1' });
      expect(auditService.record).toHaveBeenCalledWith({
        actorId: 'admin-1', action: 'PRODUCT_APPROVED', targetType: 'PRODUCT', targetId: 'prod-1', reason: null,
      });
      expect(result).toEqual({ id: 'prod-1', approvalStatus: 'APPROVED', rejectionReason: null });
    });

    it('PENDING → reject: writes the reason, enqueues, audits PRODUCT_REJECTED with it', async () => {
      productsRepository.findModerationState.mockResolvedValue(state('PENDING', null));

      await service.rejectProduct('admin-1', 'prod-1', 'Blurry photos');

      expect(productsRepository.updateAdminStatus).toHaveBeenCalledWith('prod-1', { approvalStatus: 'REJECTED', rejectionReason: 'Blurry photos' });
      expect(searchIndexQueue.enqueue).toHaveBeenCalledWith({ type: 'PRODUCT', id: 'prod-1' });
      expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_REJECTED', reason: 'Blurry photos' }));
    });

    it('APPROVED → reject (revoke): enqueues so the product leaves the index', async () => {
      productsRepository.findModerationState.mockResolvedValue(state('APPROVED', null));

      await service.rejectProduct('admin-1', 'prod-1', 'Counterfeit');

      expect(searchIndexQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });

    it('APPROVED → approve: no-op — no write, no enqueue, no audit', async () => {
      productsRepository.findModerationState.mockResolvedValue(state('APPROVED', null));

      const result = await service.approveProduct('admin-1', 'prod-1');

      expect(productsRepository.updateAdminStatus).not.toHaveBeenCalled();
      expect(searchIndexQueue.enqueue).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'prod-1', approvalStatus: 'APPROVED', rejectionReason: null });
    });

    it('REJECTED → reject with a different reason: writes + audits but does NOT enqueue (status unchanged)', async () => {
      productsRepository.findModerationState.mockResolvedValue(state('REJECTED', 'Old'));

      await service.rejectProduct('admin-1', 'prod-1', 'New');

      expect(productsRepository.updateAdminStatus).toHaveBeenCalledWith('prod-1', { approvalStatus: 'REJECTED', rejectionReason: 'New' });
      expect(searchIndexQueue.enqueue).not.toHaveBeenCalled();
      expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ reason: 'New' }));
    });

    it('REJECTED → reject with the same reason: no-op', async () => {
      productsRepository.findModerationState.mockResolvedValue(state('REJECTED', 'Same'));

      await service.rejectProduct('admin-1', 'prod-1', 'Same');

      expect(productsRepository.updateAdminStatus).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('404 PRODUCT_NOT_FOUND when missing', async () => {
      productsRepository.findModerationState.mockResolvedValue(null);

      await expect(service.approveProduct('admin-1', 'nope')).rejects.toMatchObject({
        response: { code: 'PRODUCT_NOT_FOUND' },
      });
    });

    it('404 when soft-deleted — a deleted product is not moderatable (previously updated blindly)', async () => {
      productsRepository.findModerationState.mockResolvedValue(state('PENDING', null, new Date()));

      await expect(service.approveProduct('admin-1', 'prod-1')).rejects.toThrow(NotFoundException);
      expect(productsRepository.updateAdminStatus).not.toHaveBeenCalled();
    });
  });

  describe('listForAdmin', () => {
    it('passes filters through and wraps the page in { data, meta }', async () => {
      productsRepository.findManyForAdmin.mockResolvedValue({ data: [], total: 5 });

      const result = await service.listForAdmin({ approvalStatus: 'PENDING', page: 1, limit: 2 });

      expect(productsRepository.findManyForAdmin).toHaveBeenCalledWith({ approvalStatus: 'PENDING', page: 1, limit: 2 });
      expect(result.meta).toEqual({ total: 5, page: 1, limit: 2, totalPages: 3 });
    });
  });

  describe('getSearchDocument', () => {
    const decimal = (n: number) => ({ toFixed: (dp: number) => n.toFixed(dp) });

    const baseProduct = {
      id: 'prod-1',
      vendorId: 'vendor-1',
      title: 'Linen maxi dress',
      description: 'Airy',
      categoryId: 'cat-maxi',
      basePrice: decimal(500),
      images: ['https://cdn/1.jpg', 'https://cdn/2.jpg'],
      vendor: { name: 'Nour Atelier' },
      category: { slug: 'maxi-dresses' },
      variants: [],
    };

    it('returns null when the product is not publicly visible', async () => {
      productsRepository.findForSearch.mockResolvedValue(null);

      await expect(service.getSearchDocument('prod-1')).resolves.toBeNull();
      expect(productsRepository.findCategoryPath).not.toHaveBeenCalled();
    });

    it('derives min/max price from variant overrides (500 / 800 / 1200 example)', async () => {
      productsRepository.findForSearch.mockResolvedValue({
        ...baseProduct,
        variants: [
          { size: 'S', color: 'Red', priceOverride: null },          // → basePrice 500
          { size: 'M', color: 'Blue', priceOverride: decimal(800) },
          { size: 'L', color: 'Green', priceOverride: decimal(1200) },
        ],
      } as any);
      productsRepository.findCategoryPath.mockResolvedValue(['women', 'dresses', 'maxi-dresses']);

      const doc = await service.getSearchDocument('prod-1');

      expect(doc).toEqual({
        id: 'prod-1',
        vendorId: 'vendor-1',
        vendorName: 'Nour Atelier',
        title: 'Linen maxi dress',
        description: 'Airy',
        categoryId: 'cat-maxi',
        categorySlug: 'maxi-dresses',
        categoryPath: ['women', 'dresses', 'maxi-dresses'],
        basePrice: 500,
        minPrice: 500,
        maxPrice: 1200,
        image: 'https://cdn/1.jpg',
        sizes: ['S', 'M', 'L'],
        colors: ['Red', 'Blue', 'Green'],
      });
      // Nothing internal leaks: no approvalStatus, no rejectionReason, no sku/stock.
      expect(Object.keys(doc!)).not.toEqual(expect.arrayContaining(['approvalStatus', 'rejectionReason', 'deletedAt']));
    });

    it('uses basePrice for both bounds when there are no variants, and null image when there are no images', async () => {
      productsRepository.findForSearch.mockResolvedValue({ ...baseProduct, images: [], basePrice: decimal(99.5) } as any);
      productsRepository.findCategoryPath.mockResolvedValue(['maxi-dresses']);

      const doc = await service.getSearchDocument('prod-1');

      expect(doc).toMatchObject({ basePrice: 99.5, minPrice: 99.5, maxPrice: 99.5, image: null, sizes: [], colors: [] });
    });

    it('dedupes sizes/colors and drops nulls', async () => {
      productsRepository.findForSearch.mockResolvedValue({
        ...baseProduct,
        variants: [
          { size: 'M', color: null, priceOverride: null },
          { size: 'M', color: 'Black', priceOverride: null },
          { size: null, color: 'Black', priceOverride: null },
        ],
      } as any);
      productsRepository.findCategoryPath.mockResolvedValue(['maxi-dresses']);

      const doc = await service.getSearchDocument('prod-1');

      expect(doc).toMatchObject({ sizes: ['M'], colors: ['Black'] });
    });
  });
});
