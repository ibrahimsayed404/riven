import { AdminAction, AdminTargetType, Category, Prisma } from '@prisma/client';

import { SearchIndexQueue } from '../../infra/search/search-index.queue';
import { AuditService } from '../audit/audit.service';
import { CategoriesRepository } from './categories.repository';
import { buildTree, CategoriesService, subtreeIds } from './categories.service';

const row = (id: string, name: string, parentId: string | null = null): Category => ({
  id,
  name,
  slug: name.toLowerCase(),
  parentId,
});

describe('buildTree', () => {
  it('nests children under their parent and keeps roots at the top level', () => {
    const tree = buildTree([
      row('women', 'Women'),
      row('men', 'Men'),
      row('dresses', 'Dresses', 'women'),
      row('maxi', 'Maxi', 'dresses'),
    ]);

    expect(tree.map((n) => n.slug)).toEqual(['women', 'men']);
    expect(tree[0].children.map((n) => n.slug)).toEqual(['dresses']);
    expect(tree[0].children[0].children.map((n) => n.slug)).toEqual(['maxi']);
    expect(tree[1].children).toEqual([]);
  });

  it('treats a category whose parent row is missing as a root', () => {
    const tree = buildTree([row('orphan', 'Orphan', 'gone')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].slug).toBe('orphan');
  });

  it('does not expose parentId on the response shape', () => {
    const [node] = buildTree([row('women', 'Women')]);
    expect(Object.keys(node)).toEqual(['id', 'name', 'slug', 'children']);
  });
});

describe('subtreeIds', () => {
  it('returns the root and every descendant, and nothing outside the subtree', () => {
    const rows = [
      row('women', 'Women'),
      row('dresses', 'Dresses', 'women'),
      row('maxi', 'Maxi', 'dresses'),
      row('tops', 'Tops', 'women'),
      row('men', 'Men'),
    ];
    expect(subtreeIds(rows, 'women').sort()).toEqual(['dresses', 'maxi', 'tops', 'women']);
    expect(subtreeIds(rows, 'maxi')).toEqual(['maxi']);
  });

  it('terminates on a corrupt loop instead of spinning', () => {
    expect(subtreeIds([row('a', 'A', 'b'), row('b', 'B', 'a')], 'a').sort()).toEqual(['a', 'b']);
  });
});

// specs/admin-module-spec2.md A7 — admin create / update.
describe('CategoriesService (admin writes)', () => {
  let repo: jest.Mocked<
    Pick<CategoriesRepository, 'findAll' | 'findById' | 'create' | 'update' | 'findAllForAdmin' | 'deleteIfUnused' | 'countUsage'>
  >;
  let audit: { record: jest.Mock };
  let queue: { enqueueMany: jest.Mock };
  let service: CategoriesService;

  const dresses = row('dresses', 'Dresses', 'women');
  const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

  beforeEach(() => {
    repo = {
      findAll: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findAllForAdmin: jest.fn(),
      deleteIfUnused: jest.fn(),
      countUsage: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    queue = { enqueueMany: jest.fn().mockResolvedValue(undefined) };
    service = new CategoriesService(
      repo as unknown as CategoriesRepository,
      audit as unknown as AuditService,
      queue as unknown as SearchIndexQueue,
    );
  });

  describe('createCategory', () => {
    it('creates, audits CATEGORY_CREATED with the admin as actor, and enqueues no re-index', async () => {
      repo.create.mockResolvedValue({ kind: 'ok', category: dresses });

      await expect(service.createCategory('admin-1', { name: 'Dresses', slug: 'dresses', parentId: 'women' })).resolves.toBe(dresses);

      expect(repo.create).toHaveBeenCalledWith({ name: 'Dresses', slug: 'dresses', parentId: 'women' });
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'admin-1',
        action: AdminAction.CATEGORY_CREATED,
        targetType: AdminTargetType.CATEGORY,
        targetId: 'dresses',
      });
      expect(queue.enqueueMany).not.toHaveBeenCalled();
    });

    it('defaults a missing parentId to a root category', async () => {
      repo.create.mockResolvedValue({ kind: 'ok', category: row('kids', 'Kids') });
      await service.createCategory('admin-1', { name: 'Kids', slug: 'kids' });
      expect(repo.create).toHaveBeenCalledWith({ name: 'Kids', slug: 'kids', parentId: null });
    });

    it('maps a slug collision (P2002) to 409 CATEGORY_SLUG_TAKEN and records nothing', async () => {
      repo.create.mockRejectedValue(p2002);
      await expect(service.createCategory('admin-1', { name: 'X', slug: 'women' })).rejects.toMatchObject({
        status: 409,
        response: { code: 'CATEGORY_SLUG_TAKEN' },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('maps an unknown parent to 404 CATEGORY_PARENT_NOT_FOUND', async () => {
      repo.create.mockResolvedValue({ kind: 'parent_not_found' });
      await expect(service.createCategory('admin-1', { name: 'X', slug: 'x', parentId: 'gone' })).rejects.toMatchObject({
        status: 404,
        response: { code: 'CATEGORY_PARENT_NOT_FOUND' },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('updateCategory', () => {
    beforeEach(() => repo.findById.mockResolvedValue(dresses));

    it('400 CATEGORY_UPDATE_EMPTY when no field is given', async () => {
      await expect(service.updateCategory('admin-1', 'dresses', {})).rejects.toMatchObject({
        status: 400,
        response: { code: 'CATEGORY_UPDATE_EMPTY' },
      });
      expect(repo.findById).not.toHaveBeenCalled();
    });

    it('404 CATEGORY_NOT_FOUND for an unknown id', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.updateCategory('admin-1', 'gone', { name: 'X' })).rejects.toMatchObject({
        status: 404,
        response: { code: 'CATEGORY_NOT_FOUND' },
      });
    });

    it('is a no-op when every given field equals the current value: no write, no audit, no re-index', async () => {
      await expect(
        service.updateCategory('admin-1', 'dresses', { name: 'Dresses', slug: 'dresses', parentId: 'women' }),
      ).resolves.toBe(dresses);
      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(queue.enqueueMany).not.toHaveBeenCalled();
    });

    it('a rename writes only the changed field, audits, and does NOT re-index (search stores slugs only)', async () => {
      repo.update.mockResolvedValue({ kind: 'ok', category: { ...dresses, name: 'Gowns' } });

      await service.updateCategory('admin-1', 'dresses', { name: 'Gowns', slug: 'dresses' });

      expect(repo.update).toHaveBeenCalledWith('dresses', { name: 'Gowns' });
      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'admin-1',
        action: AdminAction.CATEGORY_UPDATED,
        targetType: AdminTargetType.CATEGORY,
        targetId: 'dresses',
      });
      expect(queue.enqueueMany).not.toHaveBeenCalled();
    });

    it('a slug change re-indexes the products of the whole subtree, after the audit', async () => {
      repo.update.mockResolvedValue({ kind: 'ok', category: { ...dresses, slug: 'gowns' } });
      repo.findAll.mockResolvedValue([row('women', 'Women'), dresses, row('maxi', 'Maxi', 'dresses'), row('men', 'Men')]);

      await service.updateCategory('admin-1', 'dresses', { slug: 'gowns' });

      const jobs = queue.enqueueMany.mock.calls[0][0] as { type: string; categoryId: string }[];
      expect(jobs.map((j) => j.categoryId).sort()).toEqual(['dresses', 'maxi']);
      expect(jobs.every((j) => j.type === 'CATEGORY_PRODUCTS')).toBe(true);
      expect(audit.record.mock.invocationCallOrder[0]).toBeLessThan(queue.enqueueMany.mock.invocationCallOrder[0]);
    });

    it('a move to the root (parentId: null) counts as a change and re-indexes', async () => {
      repo.update.mockResolvedValue({ kind: 'ok', category: { ...dresses, parentId: null } });
      repo.findAll.mockResolvedValue([{ ...dresses, parentId: null }]);

      await service.updateCategory('admin-1', 'dresses', { parentId: null });

      expect(repo.update).toHaveBeenCalledWith('dresses', { parentId: null });
      expect(queue.enqueueMany).toHaveBeenCalledWith([{ type: 'CATEGORY_PRODUCTS', categoryId: 'dresses' }]);
    });

    it.each([
      ['cycle', 400, 'CATEGORY_CYCLE'],
      ['parent_not_found', 404, 'CATEGORY_PARENT_NOT_FOUND'],
      ['not_found', 404, 'CATEGORY_NOT_FOUND'],
    ] as const)('maps a %s write result to %i %s and records nothing', async (kind, status, code) => {
      repo.update.mockResolvedValue({ kind });
      await expect(service.updateCategory('admin-1', 'dresses', { parentId: 'maxi' })).rejects.toMatchObject({
        status,
        response: { code },
      });
      expect(audit.record).not.toHaveBeenCalled();
      expect(queue.enqueueMany).not.toHaveBeenCalled();
    });

    it('maps a slug collision on update to 409 CATEGORY_SLUG_TAKEN', async () => {
      repo.update.mockRejectedValue(p2002);
      await expect(service.updateCategory('admin-1', 'dresses', { slug: 'women' })).rejects.toMatchObject({
        status: 409,
        response: { code: 'CATEGORY_SLUG_TAKEN' },
      });
    });
  });

  describe('deleteCategory (specs/admin-module-spec3.md B3b)', () => {
    it('deletes an unused category and audits CATEGORY_DELETED; no search work', async () => {
      repo.deleteIfUnused.mockResolvedValue({ kind: 'ok' });

      await service.deleteCategory('admin-1', 'kids');

      expect(audit.record).toHaveBeenCalledWith({
        actorId: 'admin-1',
        action: AdminAction.CATEGORY_DELETED,
        targetType: AdminTargetType.CATEGORY,
        targetId: 'kids',
      });
      expect(queue.enqueueMany).not.toHaveBeenCalled();
    });

    it('409 CATEGORY_IN_USE with the counts when products or sub-categories remain; nothing audited', async () => {
      repo.deleteIfUnused.mockResolvedValue({ kind: 'in_use', productCount: 3, childCount: 1 });

      await expect(service.deleteCategory('admin-1', 'women')).rejects.toMatchObject({
        status: 409,
        response: { code: 'CATEGORY_IN_USE', details: { productCount: 3, childCount: 1 } },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('a lost race (FK violation P2003) is the same 409, with fresh counts', async () => {
      repo.deleteIfUnused.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', { code: 'P2003', clientVersion: 'test' }),
      );
      repo.countUsage.mockResolvedValue({ productCount: 1, childCount: 0 });

      await expect(service.deleteCategory('admin-1', 'kids')).rejects.toMatchObject({
        status: 409,
        response: { code: 'CATEGORY_IN_USE', details: { productCount: 1, childCount: 0 } },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404 CATEGORY_NOT_FOUND for an unknown category', async () => {
      repo.deleteIfUnused.mockResolvedValue({ kind: 'not_found' });
      await expect(service.deleteCategory('admin-1', 'gone')).rejects.toMatchObject({
        status: 404,
        response: { code: 'CATEGORY_NOT_FOUND' },
      });
    });
  });
});
