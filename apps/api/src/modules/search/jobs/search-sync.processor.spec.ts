import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { SearchIndexBootstrap } from '../../../infra/search/search-index.bootstrap';
import { SearchIndexQueue } from '../../../infra/search/search-index.queue';
import { SearchIndexRegistry } from '../../../infra/search/search-index.registry';
import { SearchSyncJob } from '../../../infra/search/search-sync.job';
import { BazaarsService } from '../../bazaars/bazaars.service';
import { ProductsService } from '../../products/products.service';
import { VendorsService } from '../../vendors/vendors.service';
import { SEARCH_SYNC_BATCH_SIZE, SearchSyncProcessor } from './search-sync.processor';

const job = (data: SearchSyncJob, id = 'job-1') => ({ id, data, attemptsMade: 0 }) as Job<SearchSyncJob>;

describe('SearchSyncProcessor', () => {
  let addDocuments: jest.Mock;
  let deleteDocument: jest.Mock;
  let indexFor: jest.Mock;
  let ensureReady: jest.Mock;
  let enqueueMany: jest.Mock;
  let productsService: jest.Mocked<
    Pick<ProductsService, 'getSearchDocument' | 'listProductIdsByVendor' | 'listProductIdsByCategory' | 'listPublicProductIds'>
  >;
  let vendorsService: jest.Mocked<Pick<VendorsService, 'getSearchDocument' | 'listPublicVendorIds'>>;
  let bazaarsService: jest.Mocked<Pick<BazaarsService, 'getSearchDocument' | 'listPublicBazaarIds' | 'listBazaarIdsByOrganizer'>>;
  let processor: SearchSyncProcessor;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    addDocuments = jest.fn().mockResolvedValue({ taskUid: 1 });
    deleteDocument = jest.fn().mockResolvedValue({ taskUid: 2 });
    indexFor = jest.fn().mockReturnValue({ addDocuments, deleteDocument });
    ensureReady = jest.fn().mockResolvedValue(undefined);
    enqueueMany = jest.fn().mockResolvedValue(undefined);

    productsService = {
      getSearchDocument: jest.fn(),
      listProductIdsByVendor: jest.fn(),
      listProductIdsByCategory: jest.fn(),
      listPublicProductIds: jest.fn(),
    };
    vendorsService = { getSearchDocument: jest.fn(), listPublicVendorIds: jest.fn() };
    bazaarsService = { getSearchDocument: jest.fn(), listPublicBazaarIds: jest.fn(), listBazaarIdsByOrganizer: jest.fn() };

    processor = new SearchSyncProcessor(
      { index: indexFor } as unknown as SearchIndexRegistry,
      { ensureReady } as unknown as SearchIndexBootstrap,
      { enqueueMany } as unknown as SearchIndexQueue,
      productsService as unknown as ProductsService,
      vendorsService as unknown as VendorsService,
      bazaarsService as unknown as BazaarsService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('upserts the document when the owning service says the entity is eligible', async () => {
    const doc = { id: 'p1', title: 'Dress' };
    productsService.getSearchDocument.mockResolvedValue(doc as any);

    await processor.process(job({ type: 'PRODUCT', id: 'p1' }));

    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(indexFor).toHaveBeenCalledWith('products');
    expect(addDocuments).toHaveBeenCalledWith([doc], { primaryKey: 'id' });
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it('deletes from the index when the entity is not (or no longer) eligible', async () => {
    vendorsService.getSearchDocument.mockResolvedValue(null);

    await processor.process(job({ type: 'VENDOR', id: 'v1' }));

    expect(indexFor).toHaveBeenCalledWith('vendors');
    expect(deleteDocument).toHaveBeenCalledWith('v1');
    expect(addDocuments).not.toHaveBeenCalled();
  });

  it('routes BAZAAR jobs to the bazaars index', async () => {
    bazaarsService.getSearchDocument.mockResolvedValue({ id: 'b1' } as any);

    await processor.process(job({ type: 'BAZAAR', id: 'b1' }));

    expect(indexFor).toHaveBeenCalledWith('bazaars');
    expect(addDocuments).toHaveBeenCalledWith([{ id: 'b1' }], { primaryKey: 'id' });
  });

  it('fans VENDOR_PRODUCTS out page by page via addBulk, following the cursor', async () => {
    productsService.listProductIdsByVendor
      .mockResolvedValueOnce({ ids: ['p1', 'p2'], nextCursor: 'p2' })
      .mockResolvedValueOnce({ ids: ['p3'], nextCursor: null });

    await processor.process(job({ type: 'VENDOR_PRODUCTS', vendorId: 'v1' }));

    expect(productsService.listProductIdsByVendor).toHaveBeenNthCalledWith(1, 'v1', null, SEARCH_SYNC_BATCH_SIZE);
    expect(productsService.listProductIdsByVendor).toHaveBeenNthCalledWith(2, 'v1', 'p2', SEARCH_SYNC_BATCH_SIZE);
    expect(enqueueMany).toHaveBeenNthCalledWith(1, [
      { type: 'PRODUCT', id: 'p1' },
      { type: 'PRODUCT', id: 'p2' },
    ]);
    expect(enqueueMany).toHaveBeenNthCalledWith(2, [{ type: 'PRODUCT', id: 'p3' }]);
    // The fan-out itself never touches Meilisearch.
    expect(addDocuments).not.toHaveBeenCalled();
  });

  it('fans ORGANIZER_BAZAARS out into BAZAAR jobs, following the cursor (spec3 B8b)', async () => {
    bazaarsService.listBazaarIdsByOrganizer
      .mockResolvedValueOnce({ ids: ['b1', 'b2'], nextCursor: 'b2' })
      .mockResolvedValueOnce({ ids: ['b3'], nextCursor: null });

    await processor.process(job({ type: 'ORGANIZER_BAZAARS', organizerId: 'org-1' }));

    expect(bazaarsService.listBazaarIdsByOrganizer).toHaveBeenNthCalledWith(1, 'org-1', null, SEARCH_SYNC_BATCH_SIZE);
    expect(bazaarsService.listBazaarIdsByOrganizer).toHaveBeenNthCalledWith(2, 'org-1', 'b2', SEARCH_SYNC_BATCH_SIZE);
    expect(enqueueMany).toHaveBeenNthCalledWith(1, [
      { type: 'BAZAAR', id: 'b1' },
      { type: 'BAZAAR', id: 'b2' },
    ]);
    expect(enqueueMany).toHaveBeenNthCalledWith(2, [{ type: 'BAZAAR', id: 'b3' }]);
    expect(addDocuments).not.toHaveBeenCalled();
  });

  it('fans CATEGORY_PRODUCTS out page by page the same way (admin-module-spec2 A7)', async () => {
    productsService.listProductIdsByCategory
      .mockResolvedValueOnce({ ids: ['p1'], nextCursor: 'p1' })
      .mockResolvedValueOnce({ ids: ['p2'], nextCursor: null });

    await processor.process(job({ type: 'CATEGORY_PRODUCTS', categoryId: 'c1' }));

    expect(productsService.listProductIdsByCategory).toHaveBeenNthCalledWith(1, 'c1', null, SEARCH_SYNC_BATCH_SIZE);
    expect(productsService.listProductIdsByCategory).toHaveBeenNthCalledWith(2, 'c1', 'p1', SEARCH_SYNC_BATCH_SIZE);
    expect(enqueueMany).toHaveBeenNthCalledWith(1, [{ type: 'PRODUCT', id: 'p1' }]);
    expect(enqueueMany).toHaveBeenNthCalledWith(2, [{ type: 'PRODUCT', id: 'p2' }]);
    expect(productsService.listProductIdsByVendor).not.toHaveBeenCalled();
    expect(addDocuments).not.toHaveBeenCalled();
  });

  it('REINDEX pages public ids of the requested index and enqueues per-entity jobs', async () => {
    bazaarsService.listPublicBazaarIds.mockResolvedValueOnce({ ids: ['b1', 'b2'], nextCursor: null });

    await processor.process(job({ type: 'REINDEX', index: 'bazaars' }));

    expect(bazaarsService.listPublicBazaarIds).toHaveBeenCalledWith(null, SEARCH_SYNC_BATCH_SIZE);
    expect(enqueueMany).toHaveBeenCalledWith([
      { type: 'BAZAAR', id: 'b1' },
      { type: 'BAZAAR', id: 'b2' },
    ]);
    expect(productsService.listPublicProductIds).not.toHaveBeenCalled();
  });

  it('does nothing for an empty page', async () => {
    vendorsService.listPublicVendorIds.mockResolvedValueOnce({ ids: [], nextCursor: null });

    await processor.process(job({ type: 'REINDEX', index: 'vendors' }));

    expect(enqueueMany).not.toHaveBeenCalled();
  });

  it('re-throws when Meilisearch is not ready so BullMQ retries', async () => {
    const down = new Error('ECONNREFUSED');
    ensureReady.mockRejectedValue(down);

    await expect(processor.process(job({ type: 'PRODUCT', id: 'p1' }))).rejects.toBe(down);
    expect(productsService.getSearchDocument).not.toHaveBeenCalled();
    expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
  });

  it('re-throws indexing failures instead of swallowing them', async () => {
    productsService.getSearchDocument.mockResolvedValue({ id: 'p1' } as any);
    const failure = new Error('write failed');
    addDocuments.mockRejectedValue(failure);

    await expect(processor.process(job({ type: 'PRODUCT', id: 'p1' }))).rejects.toBe(failure);
  });
});
