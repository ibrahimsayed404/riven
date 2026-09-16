import { Injectable } from '@nestjs/common';
import { Prisma, Product, ProductVariant } from '@prisma/client';

/** Max category nesting the ancestor walk will follow; also guards against cycles. */
const CATEGORY_PATH_MAX_DEPTH = 10;

/** A batch of ids for keyset iteration (reindex / fan-out). */
export type IdPage = { ids: string[]; nextCursor: string | null };

export type ProductForSearch = Product & {
  vendor: { name: string };
  category: { slug: string };
  variants: Pick<ProductVariant, 'size' | 'color' | 'priceOverride'>[];
};

import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class ProductsRepository {
  constructor(private readonly prisma: PrismaService) {}

  public get visibilityFilter(): Prisma.ProductWhereInput {
    return {
      isActive: true,
      approvalStatus: 'APPROVED',
      deletedAt: null,
      vendor: {
        verified: true,
      },
    };
  }

  async findManyPaginated(params: {
    categoryId?: string;
    vendorId?: string;
    search?: string;
    page: number;
    limit: number;
  }): Promise<{ data: Product[]; total: number }> {
    const where: Prisma.ProductWhereInput = {
      ...this.visibilityFilter,
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
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        orderBy: { createdAt: 'desc' },
      });
      return { data, total };
    });
  }

  findById(id: string): Promise<(Product & { variants: ProductVariant[] }) | null> {
    return this.prisma.product.findFirst({
      where: {
        id,
        ...this.visibilityFilter,
      },
      include: {
        variants: true,
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
        ...this.visibilityFilter,
        vendor: { verified: true, deletedAt: null },
      },
      include: {
        vendor: { select: { name: true } },
        category: { select: { slug: true } },
        variants: { select: { size: true, color: true, priceOverride: true } },
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
}
