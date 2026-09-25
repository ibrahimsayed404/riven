import { Injectable } from '@nestjs/common';
import { AdminAction, AdminTargetType } from '@prisma/client';

import { SEARCH_INDEXES, SearchIndexName } from '../../infra/search/search-index.config';
import { SearchIndexQueue } from '../../infra/search/search-index.queue';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class SearchAdminService {
  constructor(
    private readonly searchIndexQueue: SearchIndexQueue,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Backfill / recovery. Enqueues one REINDEX job per index; the processor
   * pages ids from Postgres and fans out per-entity jobs. A second request
   * while one is still pending deduplicates on the deduplication id (REINDEX.<index>).
   * Audited once per index requested (specs/admin-module-spec3.md B8c).
   */
  async reindex(adminId: string, types?: SearchIndexName[]): Promise<{ enqueued: SearchIndexName[] }> {
    const indexes = types && types.length > 0 ? types : [...SEARCH_INDEXES];
    await this.searchIndexQueue.enqueueMany(indexes.map((index) => ({ type: 'REINDEX' as const, index })));

    for (const index of indexes) {
      await this.auditService.record({
        actorId: adminId,
        action: AdminAction.SEARCH_REINDEX_REQUESTED,
        targetType: AdminTargetType.SEARCH_INDEX,
        targetId: index,
      });
    }

    return { enqueued: indexes };
  }
}
