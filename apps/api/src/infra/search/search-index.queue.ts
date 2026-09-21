import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { JobsOptions, Queue } from 'bullmq';

import { SEARCH_SYNC_QUEUE, SearchSyncJob, searchSyncJobId } from './search-sync.job';

/**
 * Queue options for every search-sync job.
 *
 * Deduplication is by BullMQ's `deduplication` option, not by a custom jobId:
 * a custom jobId silently drops an add while a job with that id is *active*,
 * and the active job has already read the database — so "create bazaar,
 * publish it 50 ms later" left the bazaar un-indexed. `keepLastIfActive`
 * queues one follow-up job that runs after the active one and sees the
 * committed state. removeOnComplete keeps the queue small; it is no longer
 * what makes dedup correct.
 */
export const SEARCH_SYNC_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: true,
  removeOnFail: { count: 1000 },
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
};

/**
 * The only way domain modules touch search. Lives in infra (global) rather
 * than in modules/search so that vendors/products/bazaars can enqueue without
 * importing SearchModule — which has to import *them* to read documents.
 *
 * Call after the owning $transaction has committed, never inside it.
 */
/** One job per entity in the queue at a time, plus at most one queued behind an active one. */
const dedup = (job: SearchSyncJob): JobsOptions['deduplication'] => ({ id: searchSyncJobId(job), keepLastIfActive: true });

@Injectable()
export class SearchIndexQueue {
  constructor(@InjectQueue(SEARCH_SYNC_QUEUE) private readonly queue: Queue<SearchSyncJob>) {}

  async enqueue(job: SearchSyncJob): Promise<void> {
    await this.queue.add(job.type, job, { ...SEARCH_SYNC_JOB_OPTIONS, deduplication: dedup(job) });
  }

  async enqueueMany(jobs: SearchSyncJob[]): Promise<void> {
    if (jobs.length === 0) return;
    await this.queue.addBulk(
      jobs.map((job) => ({
        name: job.type,
        data: job,
        opts: { ...SEARCH_SYNC_JOB_OPTIONS, deduplication: dedup(job) },
      })),
    );
  }
}
