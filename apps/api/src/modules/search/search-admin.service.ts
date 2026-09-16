import { Injectable } from '@nestjs/common';

import { SEARCH_INDEXES, SearchIndexName } from '../../infra/search/search-index.config';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';

@Injectable()
export class SearchAdminService {
  constructor(private readonly searchIndexQueue: SearchIndexQueue) {}

  /**
   * Backfill / recovery. Enqueues one REINDEX job per index; the processor
   * pages ids from Postgres and fans out per-entity jobs. A second request
   * while one is still pending deduplicates on jobId (REINDEX:<index>).
   */
  async reindex(types?: SearchIndexName[]): Promise<{ enqueued: SearchIndexName[] }> {
    const indexes = types && types.length > 0 ? types : [...SEARCH_INDEXES];
    await this.searchIndexQueue.enqueueMany(indexes.map((index) => ({ type: 'REINDEX' as const, index })));
    return { enqueued: indexes };
  }
}
