import { SEARCH_SYNC_JOB_OPTIONS, SearchIndexQueue } from './search-index.queue';
import { searchSyncJobId } from './search-sync.job';

describe('searchSyncJobId', () => {
  it('is deterministic per entity so bursts deduplicate', () => {
    expect(searchSyncJobId({ type: 'PRODUCT', id: 'p1' })).toBe('PRODUCT:p1');
    expect(searchSyncJobId({ type: 'VENDOR', id: 'v1' })).toBe('VENDOR:v1');
    expect(searchSyncJobId({ type: 'BAZAAR', id: 'b1' })).toBe('BAZAAR:b1');
    expect(searchSyncJobId({ type: 'VENDOR_PRODUCTS', vendorId: 'v1' })).toBe('VENDOR_PRODUCTS:v1');
    expect(searchSyncJobId({ type: 'REINDEX', index: 'products' })).toBe('REINDEX:products');
  });
});

describe('SearchIndexQueue', () => {
  let add: jest.Mock;
  let addBulk: jest.Mock;
  let queue: SearchIndexQueue;

  beforeEach(() => {
    add = jest.fn().mockResolvedValue(undefined);
    addBulk = jest.fn().mockResolvedValue(undefined);
    queue = new SearchIndexQueue({ add, addBulk } as any);
  });

  it('removes completed jobs so a jobId can be reused for the next sync', () => {
    // Without this, a lingering completed job makes every later add with the
    // same jobId a silent no-op and the entity never syncs again.
    expect(SEARCH_SYNC_JOB_OPTIONS.removeOnComplete).toBe(true);
    expect(SEARCH_SYNC_JOB_OPTIONS.attempts).toBeGreaterThan(1);
    expect(SEARCH_SYNC_JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 2000 });
  });

  it('enqueue adds one job keyed by type:id with the shared options', async () => {
    await queue.enqueue({ type: 'PRODUCT', id: 'p1' });

    expect(add).toHaveBeenCalledWith(
      'PRODUCT',
      { type: 'PRODUCT', id: 'p1' },
      { ...SEARCH_SYNC_JOB_OPTIONS, jobId: 'PRODUCT:p1' },
    );
  });

  it('enqueueMany uses addBulk with a jobId per job', async () => {
    await queue.enqueueMany([
      { type: 'PRODUCT', id: 'p1' },
      { type: 'PRODUCT', id: 'p2' },
    ]);

    expect(addBulk).toHaveBeenCalledTimes(1);
    expect(addBulk.mock.calls[0][0]).toEqual([
      { name: 'PRODUCT', data: { type: 'PRODUCT', id: 'p1' }, opts: { ...SEARCH_SYNC_JOB_OPTIONS, jobId: 'PRODUCT:p1' } },
      { name: 'PRODUCT', data: { type: 'PRODUCT', id: 'p2' }, opts: { ...SEARCH_SYNC_JOB_OPTIONS, jobId: 'PRODUCT:p2' } },
    ]);
  });

  it('enqueueMany with an empty list does not touch the queue', async () => {
    await queue.enqueueMany([]);
    expect(addBulk).not.toHaveBeenCalled();
  });
});
