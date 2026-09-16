import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Index, MeiliSearch } from 'meilisearch';

import { SearchIndexName } from './search-index.config';

/**
 * Owns the Meilisearch client and the logical-name → physical-uid mapping.
 * Everything else in the codebase refers to indexes by logical name
 * ('products', 'vendors', 'bazaars') and never builds a uid by hand.
 */
@Injectable()
export class SearchIndexRegistry {
  readonly client: MeiliSearch;
  readonly prefix: string;

  constructor(configService: ConfigService) {
    const host = configService.get<string>('MEILISEARCH_HOST');
    const apiKey = configService.get<string>('MEILISEARCH_API_KEY');
    if (!host || !apiKey) {
      // Both are Zod-required at boot, so this is a programming error, not config.
      throw new Error('MEILISEARCH_HOST and MEILISEARCH_API_KEY must be configured');
    }

    this.prefix =
      configService.get<string>('MEILISEARCH_INDEX_PREFIX') ??
      `riven_${configService.get<string>('NODE_ENV') ?? 'development'}_`;

    this.client = new MeiliSearch({
      host,
      apiKey,
      // Per-request HTTP timeout. Bootstrap and the sync processor must never
      // hang on an unreachable Meilisearch; the query layer maps this to 503.
      timeout: 5_000,
    });
  }

  uid(name: SearchIndexName): string {
    return `${this.prefix}${name}`;
  }

  index<T extends Record<string, unknown> = Record<string, unknown>>(name: SearchIndexName): Index<T> {
    return this.client.index<T>(this.uid(name));
  }
}
