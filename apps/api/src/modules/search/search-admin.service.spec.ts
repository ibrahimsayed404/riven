import { AuditService } from '../audit/audit.service';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';
import { SearchAdminService } from './search-admin.service';

describe('SearchAdminService.reindex (specs/admin-module-spec3.md B8c)', () => {
  let queue: { enqueueMany: jest.Mock };
  let audit: { record: jest.Mock };
  let service: SearchAdminService;

  beforeEach(() => {
    queue = { enqueueMany: jest.fn().mockResolvedValue(undefined) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new SearchAdminService(queue as unknown as SearchIndexQueue, audit as unknown as AuditService);
  });

  it('enqueues one REINDEX job per requested index and audits each, after enqueueing', async () => {
    await expect(service.reindex('admin-1', ['vendors', 'bazaars'])).resolves.toEqual({ enqueued: ['vendors', 'bazaars'] });

    expect(queue.enqueueMany).toHaveBeenCalledWith([
      { type: 'REINDEX', index: 'vendors' },
      { type: 'REINDEX', index: 'bazaars' },
    ]);
    expect(audit.record.mock.calls.map((c) => c[0])).toEqual([
      { actorId: 'admin-1', action: 'SEARCH_REINDEX_REQUESTED', targetType: 'SEARCH_INDEX', targetId: 'vendors' },
      { actorId: 'admin-1', action: 'SEARCH_REINDEX_REQUESTED', targetType: 'SEARCH_INDEX', targetId: 'bazaars' },
    ]);
    expect(queue.enqueueMany.mock.invocationCallOrder[0]).toBeLessThan(audit.record.mock.invocationCallOrder[0]);
  });

  it('no types = every index, each audited', async () => {
    const { enqueued } = await service.reindex('admin-1');
    expect(enqueued).toEqual(['products', 'vendors', 'bazaars']);
    expect(audit.record).toHaveBeenCalledTimes(3);
  });
});
