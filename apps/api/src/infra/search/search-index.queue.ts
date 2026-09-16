import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { JobsOptions, Queue } from 'bullmq';

import { SEARCH_SYNC_QUEUE, SearchSyncJob, searchSyncJobId } from './search-sync.job';

/**
 * Queue options for every search-sync job.
 *
 * removeOnComplete is not a tidiness setting here — it is what makes jobId
 * deduplication work. BullMQ only lets a jobId be reused once the previous
 * job with that id is gone; if completed jobs lingered, every later enqueue
 * for the same entity would be silently dropped and it would never sync again.
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
@Injectable()
export class SearchIndexQueue {
  constructor(@InjectQueue(SEARCH_SYNC_QUEUE) private readonly queue: Queue<SearchSyncJob>) {}

  async enqueue(job: SearchSyncJob): Promise<void> {
    await this.queue.add(job.type, job, { ...SEARCH_SYNC_JOB_OPTIONS, jobId: searchSyncJobId(job) });
  }

  async enqueueMany(jobs: SearchSyncJob[]): Promise<void> {
    if (jobs.length === 0) return;
    await this.queue.addBulk(
      jobs.map((job) => ({
        name: job.type,
        data: job,
        opts: { ...SEARCH_SYNC_JOB_OPTIONS, jobId: searchSyncJobId(job) },
      })),
    );
  }
}
