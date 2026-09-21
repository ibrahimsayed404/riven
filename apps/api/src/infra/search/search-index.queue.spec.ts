import { SEARCH_SYNC_JOB_OPTIONS, SearchIndexQueue } from './search-index.queue';
import { searchSyncJobId } from './search-sync.job';

describe('searchSyncJobId', () => {
  it('is deterministic per entity so bursts deduplicate', () => {
    expect(searchSyncJobId({ type: 'PRODUCT', id: 'p1' })).toBe('PRODUCT.p1');
    expect(searchSyncJobId({ type: 'VENDOR', id: 'v1' })).toBe('VENDOR.v1');
    expect(searchSyncJobId({ type: 'BAZAAR', id: 'b1' })).toBe('BAZAAR.b1');
    expect(searchSyncJobId({ type: 'VENDOR_PRODUCTS', vendorId: 'v1' })).toBe('VENDOR_PRODUCTS.v1');
    expect(searchSyncJobId({ type: 'REINDEX', index: 'products' })).toBe('REINDEX.products');
  });

  it('never contains ":" — BullMQ rejects such custom ids at Queue.add (it reserves them for repeatable jobs)', () => {
    const ids = [
      searchSyncJobId({ type: 'PRODUCT', id: '926ce398-f8cb-4f52-a77a-a501ace01ec4' }),
      searchSyncJobId({ type: 'VENDOR_PRODUCTS', vendorId: 'f76448a0-12fd-4b06-a938-23589afd26de' }),
      searchSyncJobId({ type: 'REINDEX', index: 'bazaars' }),
    ];
    for (const id of ids) expect(id).not.toContain(':');
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

  it('dedups per entity with keepLastIfActive so an add during an active job is not lost', () => {
    // removeOnComplete keeps the queue small; correctness comes from the
    // deduplication option asserted below.
    expect(SEARCH_SYNC_JOB_OPTIONS.removeOnComplete).toBe(true);
    expect(SEARCH_SYNC_JOB_OPTIONS.attempts).toBeGreaterThan(1);
    expect(SEARCH_SYNC_JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 2000 });
  });

  it('enqueue adds one job keyed by type:id with the shared options', async () => {
    await queue.enqueue({ type: 'PRODUCT', id: 'p1' });

    expect(add).toHaveBeenCalledWith(
      'PRODUCT',
      { type: 'PRODUCT', id: 'p1' },
      { ...SEARCH_SYNC_JOB_OPTIONS, deduplication: { id: 'PRODUCT.p1', keepLastIfActive: true } },
    );
  });

  it('enqueueMany uses addBulk with a deduplication id per job', async () => {
    await queue.enqueueMany([
      { type: 'PRODUCT', id: 'p1' },
      { type: 'PRODUCT', id: 'p2' },
    ]);

    expect(addBulk).toHaveBeenCalledTimes(1);
    expect(addBulk.mock.calls[0][0]).toEqual([
      { name: 'PRODUCT', data: { type: 'PRODUCT', id: 'p1' }, opts: { ...SEARCH_SYNC_JOB_OPTIONS, deduplication: { id: 'PRODUCT.p1', keepLastIfActive: true } } },
      { name: 'PRODUCT', data: { type: 'PRODUCT', id: 'p2' }, opts: { ...SEARCH_SYNC_JOB_OPTIONS, deduplication: { id: 'PRODUCT.p2', keepLastIfActive: true } } },
    ]);
  });

  it('enqueueMany with an empty list does not touch the queue', async () => {
    await queue.enqueueMany([]);
    expect(addBulk).not.toHaveBeenCalled();
  });
});
