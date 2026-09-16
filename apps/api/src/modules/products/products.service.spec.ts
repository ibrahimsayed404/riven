import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProductsService } from './products.service';
import { ProductsRepository } from './products.repository';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';

describe('ProductsService', () => {
  let service: ProductsService;
  let productsRepository: jest.Mocked<ProductsRepository>;
  let searchIndexQueue: jest.Mocked<SearchIndexQueue>;

  beforeEach(async () => {
    const productsRepositoryMock = {
      findManyPaginated: jest.fn(),
      findById: jest.fn(),
      updateAdminStatus: jest.fn(),
      findForSearch: jest.fn(),
      findCategoryPath: jest.fn(),
      listIdsByVendor: jest.fn(),
      listPublicIds: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: ProductsRepository, useValue: productsRepositoryMock },
        {
          provide: SearchIndexQueue,
          useValue: { enqueue: jest.fn().mockResolvedValue(undefined), enqueueMany: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
    productsRepository = module.get(ProductsRepository);
    searchIndexQueue = module.get(SearchIndexQueue);
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

  describe('approveProduct', () => {
    it('should set status to APPROVED and clear rejection reason', async () => {
      productsRepository.updateAdminStatus.mockResolvedValue({ id: 'prod-1', approvalStatus: 'APPROVED', rejectionReason: null } as any);

      await service.approveProduct('prod-1');

      expect(productsRepository.updateAdminStatus).toHaveBeenCalledWith('prod-1', {
        approvalStatus: 'APPROVED',
        rejectionReason: null,
      });
    });

    it('should enqueue a search sync after the status write', async () => {
      productsRepository.updateAdminStatus.mockResolvedValue({ id: 'prod-1' } as any);

      await service.approveProduct('prod-1');
      await service.rejectProduct('prod-1', 'nope');

      expect(searchIndexQueue.enqueue).toHaveBeenCalledTimes(2);
      expect(searchIndexQueue.enqueue).toHaveBeenCalledWith({ type: 'PRODUCT', id: 'prod-1' });
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
