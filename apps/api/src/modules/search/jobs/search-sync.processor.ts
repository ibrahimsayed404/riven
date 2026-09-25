import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { SearchIndexBootstrap } from '../../../infra/search/search-index.bootstrap';
import { SearchIndexName } from '../../../infra/search/search-index.config';
import { SearchIndexQueue } from '../../../infra/search/search-index.queue';
import { SearchIndexRegistry } from '../../../infra/search/search-index.registry';
import { SearchDocument } from '../../../infra/search/search-documents';
import { SEARCH_SYNC_QUEUE, SearchSyncEntityType, SearchSyncJob } from '../../../infra/search/search-sync.job';
import { BazaarsService } from '../../bazaars/bazaars.service';
import { ProductsService } from '../../products/products.service';
import { VendorsService } from '../../vendors/vendors.service';

/** Ids fetched per page when fanning out or reindexing. */
export const SEARCH_SYNC_BATCH_SIZE = 500;

type IdPage = { ids: string[]; nextCursor: string | null };

/**
 * Consumes the search-sync queue. Reads current database state through each
 * owning module's *public service* (never its repository) and mirrors the
 * result into Meilisearch: a document → upsert, null → delete.
 *
 * Errors are logged and re-thrown so BullMQ retries with backoff; nothing here
 * decides business state, so a failed job is only ever a stale index.
 */
@Processor(SEARCH_SYNC_QUEUE)
export class SearchSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(SearchSyncProcessor.name);

  constructor(
    private readonly registry: SearchIndexRegistry,
    private readonly bootstrap: SearchIndexBootstrap,
    private readonly queue: SearchIndexQueue,
    private readonly productsService: ProductsService,
    private readonly vendorsService: VendorsService,
    private readonly bazaarsService: BazaarsService,
  ) {
    super();
  }

  async process(job: Job<SearchSyncJob>): Promise<void> {
    try {
      // Re-runs the index bootstrap if boot-time setup failed; throws (→ retry)
      // while Meilisearch is still unreachable.
      await this.bootstrap.ensureReady();

      const data = job.data;
      switch (data.type) {
        case 'PRODUCT':
        case 'VENDOR':
        case 'BAZAAR':
          await this.syncOne(data.type, data.id);
          return;
        case 'VENDOR_PRODUCTS':
          await this.fanOutVendorProducts(data.vendorId);
          return;
        case 'CATEGORY_PRODUCTS':
          await this.fanOutCategoryProducts(data.categoryId);
          return;
        case 'ORGANIZER_BAZAARS':
          await this.fanOutOrganizerBazaars(data.organizerId);
          return;
        case 'REINDEX':
          await this.reindex(data.index);
          return;
        default:
          this.logger.warn(`search-sync: unknown job ${JSON.stringify(data)} — ignored`);
      }
    } catch (error) {
      this.logger.error(
        `search-sync: job ${job.id} failed (attempt ${job.attemptsMade + 1}): ${JSON.stringify(job.data)}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  private async syncOne(type: SearchSyncEntityType, id: string): Promise<void> {
    const { index, document } = await this.load(type, id);
    // Both operations are idempotent; deleting a document that is not there succeeds.
    if (document) {
      await this.registry.index(index).addDocuments([document], { primaryKey: 'id' });
    } else {
      await this.registry.index(index).deleteDocument(id);
    }
  }

  private async load(
    type: SearchSyncEntityType,
    id: string,
  ): Promise<{ index: SearchIndexName; document: SearchDocument | null }> {
    switch (type) {
      case 'PRODUCT':
        return { index: 'products', document: await this.productsService.getSearchDocument(id) };
      case 'VENDOR':
        return { index: 'vendors', document: await this.vendorsService.getSearchDocument(id) };
      case 'BAZAAR':
        return { index: 'bazaars', document: await this.bazaarsService.getSearchDocument(id) };
    }
  }

  /**
   * One PRODUCT job per product of the vendor, enqueued a page at a time. All
   * products regardless of status: each job decides its own eligibility.
   */
  private async fanOutVendorProducts(vendorId: string): Promise<void> {
    const total = await this.forEachPage(
      (cursor) => this.productsService.listProductIdsByVendor(vendorId, cursor, SEARCH_SYNC_BATCH_SIZE),
      (ids) => this.queue.enqueueMany(ids.map((id) => ({ type: 'PRODUCT' as const, id }))),
    );
    this.logger.log(`search-sync: fanned out ${total} product jobs for vendor ${vendorId}`);
  }

  /** Same as the vendor fan-out, for the products filed directly under one category. */
  private async fanOutCategoryProducts(categoryId: string): Promise<void> {
    const total = await this.forEachPage(
      (cursor) => this.productsService.listProductIdsByCategory(categoryId, cursor, SEARCH_SYNC_BATCH_SIZE),
      (ids) => this.queue.enqueueMany(ids.map((id) => ({ type: 'PRODUCT' as const, id }))),
    );
    this.logger.log(`search-sync: fanned out ${total} product jobs for category ${categoryId}`);
  }

  /** One BAZAAR job per bazaar of the organizer (any status); each decides its own eligibility. */
  private async fanOutOrganizerBazaars(organizerId: string): Promise<void> {
    const total = await this.forEachPage(
      (cursor) => this.bazaarsService.listBazaarIdsByOrganizer(organizerId, cursor, SEARCH_SYNC_BATCH_SIZE),
      (ids) => this.queue.enqueueMany(ids.map((id) => ({ type: 'BAZAAR' as const, id }))),
    );
    this.logger.log(`search-sync: fanned out ${total} bazaar jobs for organizer ${organizerId}`);
  }

  private async reindex(index: SearchIndexName): Promise<void> {
    const listers: Record<SearchIndexName, (cursor: string | null) => Promise<IdPage>> = {
      products: (cursor) => this.productsService.listPublicProductIds(cursor, SEARCH_SYNC_BATCH_SIZE),
      vendors: (cursor) => this.vendorsService.listPublicVendorIds(cursor, SEARCH_SYNC_BATCH_SIZE),
      bazaars: (cursor) => this.bazaarsService.listPublicBazaarIds(cursor, SEARCH_SYNC_BATCH_SIZE),
    };
    const entityType: Record<SearchIndexName, SearchSyncEntityType> = {
      products: 'PRODUCT',
      vendors: 'VENDOR',
      bazaars: 'BAZAAR',
    };

    const total = await this.forEachPage(listers[index], (ids) =>
      this.queue.enqueueMany(ids.map((id) => ({ type: entityType[index], id }))),
    );
    this.logger.log(`search-sync: reindex enqueued ${total} ${index} jobs`);
  }

  private async forEachPage(
    fetch: (cursor: string | null) => Promise<IdPage>,
    handle: (ids: string[]) => Promise<void>,
  ): Promise<number> {
    let cursor: string | null = null;
    let total = 0;
    do {
      const page: IdPage = await fetch(cursor);
      if (page.ids.length > 0) {
        await handle(page.ids);
        total += page.ids.length;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return total;
  }
}
