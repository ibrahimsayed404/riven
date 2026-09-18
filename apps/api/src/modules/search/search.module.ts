import { Module } from '@nestjs/common';

import { BazaarsModule } from '../bazaars/bazaars.module';
import { ProductsModule } from '../products/products.module';
import { SocialModule } from '../social/social.module';
import { VendorsModule } from '../vendors/vendors.module';
import { AdminSearchController } from './admin-search.controller';
import { SearchSyncProcessor } from './jobs/search-sync.processor';
import { PublicSearchController } from './public-search.controller';
import { SearchAdminService } from './search-admin.service';
import { SearchService } from './search.service';

/**
 * Consumer side of search: the sync processor and the endpoints. Reads only
 * through the domain modules' exported services. The producer (queue) and the
 * Meilisearch client come from the global SearchInfraModule.
 */
@Module({
  imports: [ProductsModule, VendorsModule, BazaarsModule, SocialModule],
  controllers: [PublicSearchController, AdminSearchController],
  providers: [SearchService, SearchAdminService, SearchSyncProcessor],
})
export class SearchModule {}
