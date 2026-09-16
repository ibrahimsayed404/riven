import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { SearchIndexBootstrap } from './search-index.bootstrap';
import { SearchIndexQueue } from './search-index.queue';
import { SearchIndexRegistry } from './search-index.registry';
import { SEARCH_SYNC_QUEUE } from './search-sync.job';

/**
 * Meilisearch adapter + sync-queue producer. Global for the same reason as
 * PrismaModule: several domain modules need it and none of them should have
 * to import each other to get it. The consumer (processor) and the public
 * search endpoints live in modules/search, which imports the domain modules.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: SEARCH_SYNC_QUEUE })],
  providers: [SearchIndexRegistry, SearchIndexBootstrap, SearchIndexQueue],
  exports: [SearchIndexRegistry, SearchIndexBootstrap, SearchIndexQueue, BullModule],
})
export class SearchInfraModule {}
