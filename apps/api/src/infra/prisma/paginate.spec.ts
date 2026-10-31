import { Prisma } from '@prisma/client';

import { paginate } from './paginate';
import { PrismaService } from './prisma.service';

/** A PrismaPromise stand-in: the helper only hands it to $transaction, never awaits it itself. */
const lazy = <T>(value: T) => ({ value }) as unknown as Prisma.PrismaPromise<T>;

describe('paginate (plan §2.2, S1)', () => {
  let prisma: { $transaction: jest.Mock };

  beforeEach(() => {
    // the batch form: resolves the array of queries in order
    prisma = { $transaction: jest.fn(async (queries: { value: unknown }[]) => queries.map((q) => q.value)) };
  });

  it('hands the SAME where object to count and page, and runs both as one batch transaction', async () => {
    const where = { deletedAt: null, vendorId: 'v-1' };
    const count = jest.fn((_w: typeof where) => lazy(7));
    const page = jest.fn((_w: typeof where) => lazy([{ id: 'a' }, { id: 'b' }]));

    await expect(paginate(prisma as unknown as PrismaService, where, { count, page })).resolves.toEqual({
      data: [{ id: 'a' }, { id: 'b' }],
      total: 7,
    });
    expect(count.mock.calls[0][0]).toBe(where);
    expect(page.mock.calls[0][0]).toBe(where);
    // one call, with an ARRAY of exactly the two queries — the batch form, never an interactive callback
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(Array.isArray(prisma.$transaction.mock.calls[0][0])).toBe(true);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
    expect(prisma.$transaction.mock.calls[0][1]).toBeUndefined(); // no isolation level / maxWait options
  });

  it('a failing query rejects the whole call (no partial result)', async () => {
    prisma.$transaction.mockRejectedValue(new Error('db down'));
    await expect(paginate(prisma as unknown as PrismaService, {}, { count: () => lazy(1), page: () => lazy([]) })).rejects.toThrow('db down');
  });
});
