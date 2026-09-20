import type { SearchIndexName } from './search-index.config';

export const SEARCH_SYNC_QUEUE = 'search-sync';

export type SearchSyncEntityType = 'PRODUCT' | 'VENDOR' | 'BAZAAR';

/**
 * Jobs carry identifiers only — never a document snapshot. The processor reads
 * current database state when it runs, so collapsing a burst of updates to the
 * same entity into one job (via jobId) is safe by construction.
 */
export type SearchSyncJob =
  // Sync one entity: upsert if index-eligible, delete otherwise.
  | { type: SearchSyncEntityType; id: string }
  // Vendor verification / soft-delete flips visibility of every product of that
  // vendor without touching a product row; this fans out PRODUCT jobs in batches.
  | { type: 'VENDOR_PRODUCTS'; vendorId: string }
  // Backfill one whole index from Postgres (first deploy, recovery).
  | { type: 'REINDEX'; index: SearchIndexName };

/**
 * Deterministic job ids so BullMQ deduplicates while a job is still waiting.
 * Requires removeOnComplete on the queue (see SearchIndexQueue) — a lingering
 * completed job with the same id would make every later add a silent no-op.
 *
 * No ':' in the id: BullMQ reserves that character for repeatable-job ids and
 * throws "Custom Id cannot contain :" on add, which turned every write that
 * re-indexes (profile edit, product approve, bazaar publish, ...) into a 500.
 */
const JOB_ID_SEPARATOR = '.';

export function searchSyncJobId(job: SearchSyncJob): string {
  switch (job.type) {
    case 'VENDOR_PRODUCTS':
      return `VENDOR_PRODUCTS${JOB_ID_SEPARATOR}${job.vendorId}`;
    case 'REINDEX':
      return `REINDEX${JOB_ID_SEPARATOR}${job.index}`;
    default:
      return `${job.type}${JOB_ID_SEPARATOR}${job.id}`;
  }
}
