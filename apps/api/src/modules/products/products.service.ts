import { Injectable, NotFoundException } from '@nestjs/common';
import { ProductsRepository, IdPage } from './products.repository';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';
import { ProductSearchDocument, toPriceNumber } from '../../infra/search/search-documents';

@Injectable()
export class ProductsService {
  constructor(
    private readonly productsRepository: ProductsRepository,
    private readonly searchIndexQueue: SearchIndexQueue,
  ) {}

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
    const updated = await this.productsRepository.updateAdminStatus(id, {
      approvalStatus: 'APPROVED',
      rejectionReason: null,
    });
    await this.searchIndexQueue.enqueue({ type: 'PRODUCT', id });
    return updated;
  }

  async rejectProduct(id: string, reason: string) {
    const updated = await this.productsRepository.updateAdminStatus(id, {
      approvalStatus: 'REJECTED',
      rejectionReason: reason,
    });
    await this.searchIndexQueue.enqueue({ type: 'PRODUCT', id });
    return updated;
  }

  // --- Search index support (read-only; the single authority on product eligibility) ---

  /**
   * The product's search document, or null when it must not be in the index
   * (pending/rejected/inactive/deleted, or its vendor unverified/deleted).
   */
  async getSearchDocument(id: string): Promise<ProductSearchDocument | null> {
    const product = await this.productsRepository.findForSearch(id);
    if (!product) return null;

    const basePrice = toPriceNumber(product.basePrice);
    const effectivePrices = product.variants.map((variant) =>
      variant.priceOverride === null ? basePrice : toPriceNumber(variant.priceOverride),
    );
    const minPrice = effectivePrices.length ? Math.min(...effectivePrices) : basePrice;
    const maxPrice = effectivePrices.length ? Math.max(...effectivePrices) : basePrice;

    const categoryPath = await this.productsRepository.findCategoryPath(product.categoryId);

    return {
      id: product.id,
      vendorId: product.vendorId,
      vendorName: product.vendor.name,
      title: product.title,
      description: product.description,
      categoryId: product.categoryId,
      categorySlug: product.category.slug,
      categoryPath,
      basePrice,
      minPrice,
      maxPrice,
      image: product.images[0] ?? null,
      sizes: distinctNonNull(product.variants.map((variant) => variant.size)),
      colors: distinctNonNull(product.variants.map((variant) => variant.color)),
    };
  }

  listProductIdsByVendor(vendorId: string, cursor: string | null, take: number): Promise<IdPage> {
    return this.productsRepository.listIdsByVendor(vendorId, cursor, take);
  }

  listPublicProductIds(cursor: string | null, take: number): Promise<IdPage> {
    return this.productsRepository.listPublicIds(cursor, take);
  }
}

function distinctNonNull(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null && value !== ''))];
}
