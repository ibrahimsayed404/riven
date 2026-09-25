import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AdminAction, AdminTargetType, Category, Prisma } from '@prisma/client';

import { SearchIndexQueue } from '../../infra/search/search-index.queue';
import { AuditService } from '../audit/audit.service';
import {
  AdminCategoryRow,
  CategoriesRepository,
  CategoryDeleteResult,
  CategoryWriteResult,
} from './categories.repository';

export type CategoryNode = {
  id: string;
  name: string;
  slug: string;
  children: CategoryNode[];
};

export interface CategoryUpdate {
  name?: string;
  slug?: string;
  parentId?: string | null;
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly categoriesRepository: CategoriesRepository,
    private readonly auditService: AuditService,
    private readonly searchIndexQueue: SearchIndexQueue,
  ) {}

  // One query, tree assembled in memory: the taxonomy is a few dozen rows at
  // most (addendum §2b), so a recursive CTE would be more code for no gain.
  async getTree(): Promise<CategoryNode[]> {
    const rows = await this.categoriesRepository.findAll();
    return buildTree(rows);
  }

  // --- Admin (specs/admin-module-spec2.md A7) ---

  listForAdmin(): Promise<AdminCategoryRow[]> {
    return this.categoriesRepository.findAllForAdmin();
  }

  async createCategory(adminId: string, data: { name: string; slug: string; parentId?: string }): Promise<Category> {
    const result = await this.write(() =>
      this.categoriesRepository.create({ name: data.name, slug: data.slug, parentId: data.parentId ?? null }),
    );

    // A new category has no products, so there is nothing to re-index.
    await this.auditService.record({
      actorId: adminId,
      action: AdminAction.CATEGORY_CREATED,
      targetType: AdminTargetType.CATEGORY,
      targetId: result.id,
    });
    return result;
  }

  async updateCategory(adminId: string, id: string, update: CategoryUpdate): Promise<Category> {
    if (update.name === undefined && update.slug === undefined && update.parentId === undefined) {
      throw new BadRequestException({
        code: 'CATEGORY_UPDATE_EMPTY',
        message: 'Provide at least one of name, slug, parentId.',
      });
    }

    const current = await this.categoriesRepository.findById(id);
    if (!current) {
      throw categoryNotFound();
    }

    // Only the fields that actually differ; an unchanged PATCH is a no-op that
    // writes nothing and records nothing (pass 1 §3 idempotency).
    const changes: CategoryUpdate = {};
    if (update.name !== undefined && update.name !== current.name) changes.name = update.name;
    if (update.slug !== undefined && update.slug !== current.slug) changes.slug = update.slug;
    if (update.parentId !== undefined && update.parentId !== current.parentId) changes.parentId = update.parentId;
    if (Object.keys(changes).length === 0) {
      return current;
    }

    const updated = await this.write(() => this.categoriesRepository.update(id, changes));

    await this.auditService.record({
      actorId: adminId,
      action: AdminAction.CATEGORY_UPDATED,
      targetType: AdminTargetType.CATEGORY,
      targetId: id,
    });

    // Search documents carry categorySlug and categoryPath (slugs of the whole
    // chain), never the name: a rename alone leaves them correct. A slug change
    // or a move makes every product in this subtree stale.
    if (changes.slug !== undefined || changes.parentId !== undefined) {
      const subtree = subtreeIds(await this.categoriesRepository.findAll(), id);
      await this.searchIndexQueue.enqueueMany(subtree.map((categoryId) => ({ type: 'CATEGORY_PRODUCTS' as const, categoryId })));
    }

    return updated;
  }

  /**
   * Admin delete (specs/admin-module-spec3.md B3b): only an unused category
   * (no products — soft-deleted included — and no sub-categories). No auto-move,
   * no cascade; a new category has no products, so no search work either.
   */
  async deleteCategory(adminId: string, id: string): Promise<void> {
    let result: CategoryDeleteResult;
    try {
      result = await this.categoriesRepository.deleteIfUnused(id);
    } catch (error) {
      // A product created between the count and the delete trips the RESTRICT FK.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw categoryInUse(await this.categoriesRepository.countUsage(id));
      }
      throw error;
    }

    if (result.kind === 'not_found') throw categoryNotFound();
    if (result.kind === 'in_use') throw categoryInUse(result);

    await this.auditService.record({
      actorId: adminId,
      action: AdminAction.CATEGORY_DELETED,
      targetType: AdminTargetType.CATEGORY,
      targetId: id,
    });
  }

  /** Runs a checked write and turns its outcome, or a slug collision, into a coded HTTP error. */
  private async write(run: () => Promise<CategoryWriteResult>): Promise<Category> {
    let result: CategoryWriteResult;
    try {
      result = await run();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'CATEGORY_SLUG_TAKEN', message: 'A category with this slug already exists.' });
      }
      throw error;
    }

    switch (result.kind) {
      case 'ok':
        return result.category;
      case 'not_found':
        throw categoryNotFound();
      case 'parent_not_found':
        throw new NotFoundException({ code: 'CATEGORY_PARENT_NOT_FOUND', message: 'Parent category not found.' });
      case 'cycle':
        throw new BadRequestException({
          code: 'CATEGORY_CYCLE',
          message: 'A category cannot be moved under itself or one of its own descendants.',
        });
    }
  }
}

const categoryNotFound = () => new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'Category not found.' });

const categoryInUse = (usage: { productCount: number; childCount: number }) =>
  new ConflictException({
    code: 'CATEGORY_IN_USE',
    message: 'Category still has products (including deleted ones) or sub-categories; move them first.',
    details: { productCount: usage.productCount, childCount: usage.childCount },
  });

export function buildTree(rows: Category[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const row of rows) {
    nodes.set(row.id, { id: row.id, name: row.name, slug: row.slug, children: [] });
  }

  const roots: CategoryNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    // A dangling parentId (parent row deleted) is treated as a root rather
    // than dropping the category from the picker entirely.
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** `rootId` and every descendant, breadth-first. `seen` guards against a corrupt loop. */
export function subtreeIds(rows: Pick<Category, 'id' | 'parentId'>[], rootId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const siblings = childrenOf.get(row.parentId) ?? [];
    siblings.push(row.id);
    childrenOf.set(row.parentId, siblings);
  }

  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    for (const child of childrenOf.get(queue[i]) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return queue;
}
