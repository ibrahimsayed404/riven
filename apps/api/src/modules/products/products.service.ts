import { Injectable, NotFoundException } from '@nestjs/common';
import { ProductsRepository } from './products.repository';
import { ListProductsQueryDto } from './dto/list-products-query.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly productsRepository: ProductsRepository) {}

  async listProducts(query: ListProductsQueryDto) {
    const page = query.page ? parseInt(query.page, 10) : 1;
    const limit = query.limit ? parseInt(query.limit, 10) : 20;

    return this.productsRepository.findManyPaginated({
      categoryId: query.categoryId,
      vendorId: query.vendorId,
      search: query.search,
      page,
      limit,
    });
  }

  async getProductById(id: string) {
    const product = await this.productsRepository.findById(id);
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async approveProduct(id: string) {
    return this.productsRepository.updateAdminStatus(id, {
      approvalStatus: 'APPROVED',
      rejectionReason: null,
    });
  }

  async rejectProduct(id: string, reason: string) {
    return this.productsRepository.updateAdminStatus(id, {
      approvalStatus: 'REJECTED',
      rejectionReason: reason,
    });
  }
}
