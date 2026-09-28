import { Injectable } from '@nestjs/common';
import { Category, Prisma } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

/** Upper bound on the ancestor walk; the tree is a few levels deep, this only stops a corrupt loop. */
const ANCESTOR_WALK_LIMIT = 100;

export type AdminCategoryRow = Category & { productCount: number; childCount: number };

/**
 * Outcome of a checked write. The parent/cycle checks run inside the same
 * transaction as the write so a concurrent move can't slip between them.
 */
export type CategoryWriteResult =
  | { kind: 'ok'; category: Category }
  | { kind: 'not_found' }
  | { kind: 'parent_not_found' }
  | { kind: 'cycle' };

export type CategoryDeleteResult =
  | { kind: 'ok' }
  | { kind: 'not_found' }
  | { kind: 'in_use'; productCount: number; childCount: number };

@Injectable()
export class CategoriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Category[]> {
    return this.prisma.category.findMany({ orderBy: { name: 'asc' } });
  }

  // --- Admin (specs/admin-module-spec2.md A7) ---

  /** Flat list with usage counts; soft-deleted products don't count. */
  async findAllForAdmin(): Promise<AdminCategoryRow[]> {
    const rows = await this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { children: true, products: { where: { deletedAt: null } } } } },
    });
    return rows.map(({ _count, ...category }) => ({
      ...category,
      productCount: _count.products,
      childCount: _count.children,
    }));
  }

  findById(id: string): Promise<Category | null> {
    return this.prisma.category.findUnique({ where: { id } });
  }

  /** Slug uniqueness is left to the DB (@unique) — the caller maps P2002. */
  create(data: { name: string; slug: string; parentId: string | null }): Promise<CategoryWriteResult> {
    return this.prisma.$transaction(async (tx) => {
      if (data.parentId && !(await tx.category.findUnique({ where: { id: data.parentId }, select: { id: true } }))) {
        return { kind: 'parent_not_found' };
      }
      return { kind: 'ok', category: await tx.category.create({ data }) };
    });
  }

  /**
   * Serializable because the cycle check reads the ancestor chain: two moves
   * racing under READ COMMITTED could each pass the check and together form a
   * loop. Admin category edits are rare, so the retry cost is irrelevant.
   */
  update(
    id: string,
    data: { name?: string; slug?: string; parentId?: string | null },
  ): Promise<CategoryWriteResult> {
    return this.prisma.$transaction(
      async (tx) => {
        if (!(await tx.category.findUnique({ where: { id }, select: { id: true } }))) {
          return { kind: 'not_found' };
        }

        if (data.parentId) {
          // Walk up from the new parent; meeting `id` means the move would put
          // the category under itself or one of its own descendants.
          let cursor: string | null = data.parentId;
          for (let depth = 0; cursor && depth < ANCESTOR_WALK_LIMIT; depth++) {
            if (cursor === id) return { kind: 'cycle' };
            const node: { parentId: string | null } | null = await tx.category.findUnique({
              where: { id: cursor },
              select: { parentId: true },
            });
            if (!node) {
              if (depth === 0) return { kind: 'parent_not_found' };
              break; // dangling link higher up: not a cycle through `id`
            }
            cursor = node.parentId;
          }
        }

        return { kind: 'ok', category: await tx.category.update({ where: { id }, data }) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * Admin delete (spec3 B3b). "Unused" = no product row points at it — soft-deleted
   * ones included, since Product.categoryId is RESTRICT — and no sub-category.
   * Counts and delete share one transaction; a product added in between still
   * trips the FK, which the service maps to the same CATEGORY_IN_USE.
   */
  deleteIfUnused(id: string): Promise<CategoryDeleteResult> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.category.findUnique({ where: { id }, select: { id: true } }))) {
        return { kind: 'not_found' };
      }
      const [productCount, childCount] = await Promise.all([
        tx.product.count({ where: { categoryId: id } }),
        tx.category.count({ where: { parentId: id } }),
      ]);
      if (productCount > 0 || childCount > 0) {
        return { kind: 'in_use', productCount, childCount };
      }
      await tx.category.delete({ where: { id } });
      return { kind: 'ok' };
    });
  }

  /** Usage for a CATEGORY_IN_USE error raised by a lost race (FK violation). */
  async countUsage(id: string): Promise<{ productCount: number; childCount: number }> {
    const [productCount, childCount] = await Promise.all([
      this.prisma.product.count({ where: { categoryId: id } }),
      this.prisma.category.count({ where: { parentId: id } }),
    ]);
    return { productCount, childCount };
  }
}
