import { Injectable } from '@nestjs/common';
import { ApprovalStatus, Prisma, Product, ProductVariant } from '@prisma/client';

/** Max category nesting the ancestor walk will follow; also guards against cycles. */
const CATEGORY_PATH_MAX_DEPTH = 10;

/** A batch of ids for keyset iteration (reindex / fan-out). */
export type IdPage = { ids: string[]; nextCursor: string | null };

export type PublicProduct = Prisma.ProductGetPayload<{ select: typeof PUBLIC_PRODUCT_SELECT }>;
export type PublicProductDetail = Prisma.ProductGetPayload<{
  select: typeof PUBLIC_PRODUCT_SELECT & { variants: { select: typeof PUBLIC_VARIANT_SELECT } };
}>;

// Admin queue row: the fields an admin needs to decide, plus the vendor's
// verification flag so the UI can flag "approved but vendor unverified".
const adminProductRowSelect = {
  id: true,
  vendorId: true,
  title: true,
  description: true,
  categoryId: true,
  basePrice: true,
  images: true,
  approvalStatus: true,
  rejectionReason: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  vendor: { select: { id: true, name: true, verified: true } },
} satisfies Prisma.ProductSelect;

export type AdminProductRow = Prisma.ProductGetPayload<{ select: typeof adminProductRowSelect }>;

export interface ProductModerationState {
  id: string;
  approvalStatus: ApprovalStatus;
  rejectionReason: string | null;
  deletedAt: Date | null;
}

export type ProductForSearch = Product & {
  vendor: { name: string };
  category: { slug: string };
  variants: Pick<ProductVariant, 'size' | 'color' | 'priceOverride'>[];
};

import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  ACTIVE_VARIANT_WHERE,
  PUBLIC_PRODUCT_SELECT,
  PUBLIC_PRODUCT_WHERE,
  PUBLIC_VARIANT_SELECT,
} from './product-visibility';

@Injectable()
export class ProductsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** @deprecated import PUBLIC_PRODUCT_WHERE from ./product-visibility instead. */
  public get visibilityFilter(): Prisma.ProductWhereInput {
    return PUBLIC_PRODUCT_WHERE;
  }

  async findManyPaginated(params: {
    categoryId?: string;
    vendorId?: string;
    search?: string;
    page: number;
    limit: number;
  }): Promise<{ data: PublicProduct[]; total: number }> {
    const where: Prisma.ProductWhereInput = {
      ...PUBLIC_PRODUCT_WHERE,
    };

    if (params.categoryId) {
      where.categoryId = params.categoryId;
    }

    if (params.vendorId) {
      where.vendorId = params.vendorId;
    }

    if (params.search) {
      where.OR = [
        { title: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    return this.prisma.$transaction(async (tx) => {
      const total = await tx.product.count({ where });
      const data = await tx.product.findMany({
        where,
        select: PUBLIC_PRODUCT_SELECT,
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        orderBy: { createdAt: 'desc' },
      });
      return { data, total };
    });
  }

  findById(id: string): Promise<PublicProductDetail | null> {
    return this.prisma.product.findFirst({
      where: {
        id,
        ...PUBLIC_PRODUCT_WHERE,
      },
      select: {
        ...PUBLIC_PRODUCT_SELECT,
        variants: { where: ACTIVE_VARIANT_WHERE, select: PUBLIC_VARIANT_SELECT },
      },
    });
  }

  /**
   * The product as the search index needs it, or null when it is not publicly
   * visible. Same visibility filter as the public endpoints, plus the vendor's
   * own soft-delete — a deleted vendor's products must not stay searchable.
   */
  findForSearch(id: string): Promise<ProductForSearch | null> {
    return this.prisma.product.findFirst({
      where: {
        id,
        ...PUBLIC_PRODUCT_WHERE,
      },
      include: {
        vendor: { select: { name: true } },
        category: { select: { slug: true } },
        variants: { where: ACTIVE_VARIANT_WHERE, select: { size: true, color: true, priceOverride: true } },
      },
    });
  }

  /**
   * Slugs from the root category down to (and including) categoryId, via a
   * recursive CTE so the walk is one round-trip regardless of depth.
   */
  async findCategoryPath(categoryId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ slug: string }[]>`
      WITH RECURSIVE chain AS (
        SELECT "id", "slug", "parentId", 1 AS depth
        FROM "categories"
        WHERE "id" = ${categoryId}
        UNION ALL
        SELECT c."id", c."slug", c."parentId", chain.depth + 1
        FROM "categories" c
        JOIN chain ON c."id" = chain."parentId"
        WHERE chain.depth < ${CATEGORY_PATH_MAX_DEPTH}
      )
      SELECT "slug" FROM chain ORDER BY depth DESC
    `;
    return rows.map((row) => row.slug);
  }

  /** Every product of a vendor regardless of status — eligibility is decided per product later. */
  async listIdsByVendor(vendorId: string, cursor: string | null, take: number): Promise<IdPage> {
    return this.pageIds({ vendorId }, cursor, take);
  }

  async listPublicIds(cursor: string | null, take: number): Promise<IdPage> {
    return this.pageIds({ ...this.visibilityFilter, vendor: { verified: true, deletedAt: null } }, cursor, take);
  }

  private async pageIds(where: Prisma.ProductWhereInput, cursor: string | null, take: number): Promise<IdPage> {
    const rows = await this.prisma.product.findMany({
      where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const ids = rows.slice(0, take).map((row) => row.id);
    return { ids, nextCursor: hasMore ? ids[ids.length - 1] : null };
  }

  updateAdminStatus(id: string, data: { approvalStatus: Prisma.ProductUpdateInput['approvalStatus'], rejectionReason: string | null }): Promise<Product> {
    return this.prisma.product.update({
      where: { id },
      data,
    });
  }

  // --- Admin moderation ---

  /** Minimal state for an approve/reject decision. Unlike findById this does not hide soft-deleted rows. */
  findModerationState(id: string): Promise<ProductModerationState | null> {
    return this.prisma.product.findUnique({
      where: { id },
      select: { id: true, approvalStatus: true, rejectionReason: true, deletedAt: true },
    });
  }

  /**
   * Admin queue. Deliberately NOT built on visibilityFilter: that hides
   * PENDING/REJECTED rows and products of unverified vendors, which is exactly
   * what the queue exists to show. Soft-deleted rows are always excluded;
   * isActive is not filtered (an inactive PENDING product still needs a decision).
   */
  async findManyForAdmin(params: {
    approvalStatus?: ApprovalStatus;
    vendorId?: string;
    page: number;
    limit: number;
  }): Promise<{ data: AdminProductRow[]; total: number }> {
    const where: Prisma.ProductWhereInput = { deletedAt: null };
    if (params.approvalStatus) where.approvalStatus = params.approvalStatus;
    if (params.vendorId) where.vendorId = params.vendorId;

    return this.prisma.$transaction(async (tx) => {
      const total = await tx.product.count({ where });
      const data = await tx.product.findMany({
        where,
        select: adminProductRowSelect,
        orderBy: { createdAt: 'asc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      });
      return { data, total };
    });
  }

  /** Overview tile: products awaiting a decision. */
  countPendingForAdmin(): Promise<number> {
    return this.prisma.product.count({ where: { approvalStatus: 'PENDING', deletedAt: null } });
  }
}
