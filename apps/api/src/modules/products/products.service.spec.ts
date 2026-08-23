import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProductsService } from './products.service';
import { ProductsRepository } from './products.repository';

describe('ProductsService', () => {
  let service: ProductsService;
  let productsRepository: jest.Mocked<ProductsRepository>;

  beforeEach(async () => {
    const productsRepositoryMock = {
      findManyPaginated: jest.fn(),
      findById: jest.fn(),
      updateAdminStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: ProductsRepository, useValue: productsRepositoryMock },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
    productsRepository = module.get(ProductsRepository);
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
  });
});
