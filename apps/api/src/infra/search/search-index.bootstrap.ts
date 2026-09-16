import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MeiliSearchApiError } from 'meilisearch';

import { SEARCH_INDEXES, SEARCH_INDEX_SETTINGS, SearchIndexName } from './search-index.config';
import { SearchIndexRegistry } from './search-index.registry';

/**
 * Upper bound on the whole bootstrap (all indexes, all settings tasks).
 * The API must start with or without Meilisearch; this is what keeps a slow
 * or absent instance from turning into an indefinite boot hang.
 */
const BOOTSTRAP_TIMEOUT_MS = 10_000;

/**
 * Creates the three indexes if missing and applies their settings, then keeps
 * a `ready` flag that the query layer (503 SEARCH_UNAVAILABLE) and the sync
 * processor (retry with backoff) both consult.
 *
 * Failure here is logged, never thrown: search is a derived read model and a
 * Meilisearch outage must not take down auth, cart or checkout.
 */
@Injectable()
export class SearchIndexBootstrap implements OnModuleInit {
  private readonly logger = new Logger(SearchIndexBootstrap.name);

  private _ready = false;
  // Collapses concurrent ensureReady() calls (e.g. a burst of sync jobs
  // retrying at once) into a single bootstrap attempt.
  private inFlight: Promise<void> | null = null;

  constructor(private readonly registry: SearchIndexRegistry) {}

  get ready(): boolean {
    return this._ready;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureReady();
    } catch (error) {
      this.logger.error(
        `search: Meilisearch unavailable at boot (${this.registry.prefix}*); ` +
          'search endpoints will return 503 and sync jobs will retry until it comes back.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Resolves once the indexes exist with current settings. Cheap after the
   * first success; re-runs the full bootstrap if a previous attempt failed.
   * Throws (does not swallow) so callers on the job path can let BullMQ retry.
   */
  ensureReady(): Promise<void> {
    if (this._ready) return Promise.resolve();
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.bootstrap()
      .then(() => {
        this._ready = true;
        this.logger.log(`search: indexes ready (${this.registry.prefix}*)`);
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async bootstrap(): Promise<void> {
    const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
    const remaining = () => Math.max(1, deadline - Date.now());

    for (const name of SEARCH_INDEXES) {
      await this.ensureIndexExists(name, remaining());

      // Idempotent: identical settings resolve as a no-op task in Meilisearch.
      await this.registry
        .index(name)
        .updateSettings(SEARCH_INDEX_SETTINGS[name])
        .waitTask({ timeout: remaining() });
    }
  }

  private async ensureIndexExists(name: SearchIndexName, timeout: number): Promise<void> {
    const uid = this.registry.uid(name);
    try {
      await this.registry.client.getIndex(uid);
      return;
    } catch (error) {
      if (!(error instanceof MeiliSearchApiError) || error.cause?.code !== 'index_not_found') {
        throw error;
      }
    }

    await this.registry.client.createIndex(uid, { primaryKey: 'id' }).waitTask({ timeout });
    this.logger.log(`search: created index ${uid}`);
  }
}
