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
      findForSearch: jest.fn(),
      findCategoryPath: jest.fn(),
      listIdsByVendor: jest.fn(),
      listPublicIds: jest.fn(),
      findDeletionState: jest.fn(),
      findManyForAdmin: jest.fn(),
      findByIdForAdmin: jest.fn(),
      updateContentForAdmin: jest.fn(),
      softDeleteForAdmin: jest.fn(),
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
    it('should call repository with default pagination and return { data, meta }', async () => {
      productsRepository.findManyPaginated.mockResolvedValue({ data: [], total: 0 });

      const result = await service.listProducts({});

      expect(productsRepository.findManyPaginated).toHaveBeenCalledWith({
        page: 1,
        limit: 20,
        categoryId: undefined,
        vendorId: undefined,
        search: undefined,
      });
      expect(result).toEqual({ data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } });
    });
  });

  describe('listForAdmin', () => {
    it('passes filters through and wraps the page in { data, meta }', async () => {
      productsRepository.findManyForAdmin.mockResolvedValue({ data: [], total: 5 });

      const result = await service.listForAdmin({ page: 1, limit: 2 });

      expect(productsRepository.findManyForAdmin).toHaveBeenCalledWith({ page: 1, limit: 2 });
      expect(result.meta).toEqual({ total: 5, page: 1, limit: 2, totalPages: 3 });
    });
  });

  describe('updateProductForAdmin (specs/admin-module-spec3.md B2)', () => {
    const existing = {
      id: 'p1',
      title: 'Dress',
      description: 'Old',
      images: ['a.jpg'],
      deletedAt: null,
    };

    it('writes only the changed content fields, enqueues and audits after the write', async () => {
      productsRepository.findByIdForAdmin.mockResolvedValue(existing as any);

      await service.updateProductForAdmin('admin-1', 'p1', { title: 'Dress', description: 'New', images: ['a.jpg'] });

      expect(productsRepository.updateContentForAdmin).toHaveBeenCalledWith('p1', { description: 'New' });
      expect(searchIndexQueue.enqueue).toHaveBeenCalledWith({ type: 'PRODUCT', id: 'p1' });
      expect(auditService.record).toHaveBeenCalledWith({
        actorId: 'admin-1',
        action: 'PRODUCT_EDITED',
        targetType: 'PRODUCT',
        targetId: 'p1',
      });
      expect(productsRepository.updateContentForAdmin.mock.invocationCallOrder[0]).toBeLessThan(
        auditService.record.mock.invocationCallOrder[0],
      );
    });

    it('is a no-op when nothing changes: no write, no search job, no audit', async () => {
      productsRepository.findByIdForAdmin.mockResolvedValue(existing as any);

      await expect(
        service.updateProductForAdmin('admin-1', 'p1', { title: 'Dress', images: ['a.jpg'] }),
      ).resolves.toBe(existing);
      expect(productsRepository.updateContentForAdmin).not.toHaveBeenCalled();
      expect(searchIndexQueue.enqueue).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('404 PRODUCT_NOT_FOUND for a missing or soft-deleted product', async () => {
      for (const found of [null, { ...existing, deletedAt: new Date() }]) {
        productsRepository.findByIdForAdmin.mockResolvedValueOnce(found as any);
        await expect(service.updateProductForAdmin('admin-1', 'p1', { title: 'X' })).rejects.toMatchObject({
          response: { code: 'PRODUCT_NOT_FOUND' },
        });
      }
      expect(productsRepository.updateContentForAdmin).not.toHaveBeenCalled();
    });
  });

  describe('deleteProductForAdmin (specs/admin-module-spec3.md B3a)', () => {
    it('soft-deletes, re-indexes and audits after the write', async () => {
      productsRepository.findDeletionState.mockResolvedValue({ id: 'p1', deletedAt: null } as any);

      await service.deleteProductForAdmin('admin-1', 'p1');

      expect(productsRepository.softDeleteForAdmin).toHaveBeenCalledWith('p1');
      expect(searchIndexQueue.enqueue).toHaveBeenCalledWith({ type: 'PRODUCT', id: 'p1' });
      expect(auditService.record).toHaveBeenCalledWith({
        actorId: 'admin-1',
        action: 'PRODUCT_DELETED',
        targetType: 'PRODUCT',
        targetId: 'p1',
      });
      expect(productsRepository.softDeleteForAdmin.mock.invocationCallOrder[0]).toBeLessThan(
        auditService.record.mock.invocationCallOrder[0],
      );
    });

    it('an already deleted product is a no-op', async () => {
      productsRepository.findDeletionState.mockResolvedValue({ id: 'p1', deletedAt: new Date() } as any);

      await service.deleteProductForAdmin('admin-1', 'p1');

      expect(productsRepository.softDeleteForAdmin).not.toHaveBeenCalled();
      expect(searchIndexQueue.enqueue).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('404 PRODUCT_NOT_FOUND for an unknown product', async () => {
      productsRepository.findDeletionState.mockResolvedValue(null);
      await expect(service.deleteProductForAdmin('admin-1', 'x')).rejects.toMatchObject({
        response: { code: 'PRODUCT_NOT_FOUND' },
      });
    });
  });

  describe('getProductForAdmin', () => {
    it('returns an inactive product without the public visibility filter', async () => {
      productsRepository.findByIdForAdmin.mockResolvedValue({ id: 'p1', isActive: false } as any);

      await expect(service.getProductForAdmin('p1')).resolves.toEqual({ id: 'p1', isActive: false });
      expect(productsRepository.findByIdForAdmin).toHaveBeenCalledWith('p1');
      expect(productsRepository.findById).not.toHaveBeenCalled();
    });

    it('throws a coded 404 for an unknown id', async () => {
      productsRepository.findByIdForAdmin.mockResolvedValue(null);

      await expect(service.getProductForAdmin('missing')).rejects.toMatchObject({
        response: { code: 'PRODUCT_NOT_FOUND' },
      });
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
