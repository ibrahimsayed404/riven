import { Prisma } from '@prisma/client';

import { PrismaService } from './prisma.service';

/**
 * Count + page for a paginated list read (specs/architecture-and-query-performance-plan.md §2.2, S1).
 *
 * Both queries run in ONE batch transaction (`$transaction([count, page])`): one
 * pooled connection, `BEGIN; COUNT; SELECT; COMMIT` sent back to back by the
 * query engine. It replaces the interactive `$transaction(async tx => …)` form,
 * which held its connection across Node round trips and failed with P2028 when
 * no connection could be had within Prisma's 2 s `maxWait` (S0 benchmark: 168–210
 * of 300 concurrent product-list requests). A batch transaction waits for a
 * connection through the pool's own timeout instead.
 *
 * Neither form makes `total` and the page one snapshot: at READ COMMITTED each
 * statement sees its own snapshot. That is unchanged.
 *
 * The same `where` object is handed to both callbacks, so count and page can
 * never filter differently.
 */
export async function paginate<W, T>(
  prisma: PrismaService,
  where: W,
  query: {
    count: (where: W) => Prisma.PrismaPromise<number>;
    page: (where: W) => Prisma.PrismaPromise<T[]>;
  },
): Promise<{ data: T[]; total: number }> {
  const [total, data] = await prisma.$transaction([query.count(where), query.page(where)]);
  return { data, total };
}
