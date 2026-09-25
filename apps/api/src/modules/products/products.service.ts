import { Injectable, NotFoundException } from '@nestjs/common';
import { AdminAction, AdminTargetType, ApprovalStatus } from '@prisma/client';
import { ProductsRepository, IdPage } from './products.repository';
import { AuditService } from '../audit/audit.service';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { DEFAULT_PAGE_SIZE, pageMeta } from '../../common/dto/pagination-query.dto';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';
import { ProductSearchDocument, toPriceNumber } from '../../infra/search/search-documents';

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

  /** Admin detail (specs/admin-module-spec2.md A2): any approval state, inactive and soft-deleted included. */
  async getProductForAdmin(id: string) {
    const product = await this.productsRepository.findByIdForAdmin(id);
    if (!product) {
      throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found.' });
    }
    return product;
  }

  async listForAdmin(params: {
    approvalStatus?: ApprovalStatus;
    vendorId?: string;
    page: number;
    limit: number;
  }) {
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

  countPendingForAdmin(): Promise<number> {
    return this.productsRepository.countPendingForAdmin();
  }

  approveProduct(adminId: string, id: string) {
    return this.moderateProduct(adminId, id, { approvalStatus: 'APPROVED', rejectionReason: null }, AdminAction.PRODUCT_APPROVED);
  }

  rejectProduct(adminId: string, id: string, reason: string) {
    return this.moderateProduct(adminId, id, { approvalStatus: 'REJECTED', rejectionReason: reason }, AdminAction.PRODUCT_REJECTED);
  }

  /**
   * One transition function for approve and reject. Idempotent: when the
   * target state equals the current one nothing is written, audited or
   * enqueued. Soft-deleted products 404 — they are not moderatable.
   */
  private async moderateProduct(
    adminId: string,
    id: string,
    target: { approvalStatus: ApprovalStatus; rejectionReason: string | null },
    action: AdminAction,
  ) {
    const current = await this.productsRepository.findModerationState(id);
    if (!current || current.deletedAt) {
      throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found.' });
    }

    const unchanged =
      current.approvalStatus === target.approvalStatus && current.rejectionReason === target.rejectionReason;
    if (unchanged) {
      return { id: current.id, approvalStatus: current.approvalStatus, rejectionReason: current.rejectionReason };
    }

    const updated = await this.productsRepository.updateAdminStatus(id, target);

    if (current.approvalStatus !== target.approvalStatus) {
      // Only an approval-status change moves the product in or out of the index.
      await this.searchIndexQueue.enqueue({ type: 'PRODUCT', id });
    }

    await this.auditService.record({
      actorId: adminId,
      action,
      targetType: AdminTargetType.PRODUCT,
      targetId: id,
      reason: target.rejectionReason,
    });

    return { id: updated.id, approvalStatus: updated.approvalStatus, rejectionReason: updated.rejectionReason };
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
