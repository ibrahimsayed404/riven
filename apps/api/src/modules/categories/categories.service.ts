import { Injectable } from '@nestjs/common';
import { Category } from '@prisma/client';

import { CategoriesRepository } from './categories.repository';

export type CategoryNode = {
  id: string;
  name: string;
  slug: string;
  children: CategoryNode[];
};

@Injectable()
export class CategoriesService {
  constructor(private readonly categoriesRepository: CategoriesRepository) {}

  // One query, tree assembled in memory: the taxonomy is a few dozen rows at
  // most (addendum §2b), so a recursive CTE would be more code for no gain.
  async getTree(): Promise<CategoryNode[]> {
    const rows = await this.categoriesRepository.findAll();
    return buildTree(rows);
  }
}

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
