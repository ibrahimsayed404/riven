import { Injectable, NotFoundException } from '@nestjs/common';
import { AdminAction, AdminTargetType } from '@prisma/client';
import { ProductsRepository, IdPage } from './products.repository';
import { AuditService } from '../audit/audit.service';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { DEFAULT_PAGE_SIZE, pageMeta } from '../../common/dto/pagination-query.dto';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';
import { ProductSearchDocument, toPriceNumber } from '../../infra/search/search-documents';
import { changedFields } from '../../common/changed-fields';
import { AdminUpdateProductDto } from './dto/admin-update-product.dto';

@Injectable()
export class ProductsService {
  constructor(
    private readonly productsRepository: ProductsRepository,
    private readonly searchIndexQueue: SearchIndexQueue,
    private readonly auditService: AuditService,
  ) {}

  async listProducts(query: ListProductsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    const { data, total } = await this.productsRepository.findManyPaginated({
      categoryId: query.categoryId,
      vendorId: query.vendorId,
      search: query.search,
      page,
      limit,
    });
    return { data, meta: pageMeta(total, page, limit) };
  }

  async getProductById(id: string) {
    const product = await this.productsRepository.findById(id);
    if (!product) {
      throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found.' });
    }
    return product;
  }

  // --- Admin moderation (specs/admin-module-spec.md §4.3) ---

  /** Admin detail (specs/admin-module-spec2.md A2): inactive and soft-deleted included. */
  async getProductForAdmin(id: string) {
    const product = await this.productsRepository.findByIdForAdmin(id);
    if (!product) {
      throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found.' });
    }
    return product;
  }

  /** Admin edit (specs/admin-module-spec3.md B2): title, description and images only. */
  async updateProductForAdmin(adminId: string, id: string, dto: AdminUpdateProductDto) {
    const product = await this.productsRepository.findByIdForAdmin(id);
    if (!product || product.deletedAt) {
      throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found.' });
    }

    const changes = changedFields(product, dto);
    if (Object.keys(changes).length === 0) {
      return product;
    }

    await this.productsRepository.updateContentForAdmin(id, changes);
    await this.searchIndexQueue.enqueue({ type: 'PRODUCT', id });
    await this.auditService.record({
      actorId: adminId,
      action: AdminAction.PRODUCT_EDITED,
      targetType: AdminTargetType.PRODUCT,
      targetId: id,
    });

    return this.getProductForAdmin(id);
  }

  /**
   * Admin delete (specs/admin-module-spec3.md B3a): soft delete. Cart lines are
   * left in place — checkout already refuses them as PRODUCT_UNAVAILABLE, since
   * PUBLIC_PRODUCT_WHERE excludes deleted products. Already deleted = no-op.
   */
  async deleteProductForAdmin(adminId: string, id: string): Promise<void> {
    const product = await this.productsRepository.findDeletionState(id);
    if (!product) {
      throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found.' });
    }
    if (product.deletedAt) {
      return;
    }

    await this.productsRepository.softDeleteForAdmin(id);
    await this.searchIndexQueue.enqueue({ type: 'PRODUCT', id });
    await this.auditService.record({
      actorId: adminId,
      action: AdminAction.PRODUCT_DELETED,
      targetType: AdminTargetType.PRODUCT,
      targetId: id,
    });
  }

  async listForAdmin(params: { vendorId?: string; page: number; limit: number }) {
    const { data, total } = await this.productsRepository.findManyForAdmin(params);
    return {
      data,
      meta: {
        total,
        page: params.page,
        limit: params.limit,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }

  // --- Search index support (read-only; the single authority on product eligibility) ---

  /**
   * The product's search document, or null when it must not be in the index
   * (inactive/deleted, or its vendor unverified/deleted).
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

  listProductIdsByCategory(categoryId: string, cursor: string | null, take: number): Promise<IdPage> {
    return this.productsRepository.listIdsByCategory(categoryId, cursor, take);
  }

  listPublicProductIds(cursor: string | null, take: number): Promise<IdPage> {
    return this.productsRepository.listPublicIds(cursor, take);
  }
}

function distinctNonNull(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null && value !== ''))];
}
