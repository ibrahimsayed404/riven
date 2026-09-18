import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BazaarsRepository } from '../bazaars.repository';
import { Logger } from '@nestjs/common';
import { SearchIndexQueue } from '../../../infra/search/search-index.queue';

@Processor('bazaars')
export class BazaarAutocompleteProcessor extends WorkerHost {
  private readonly logger = new Logger(BazaarAutocompleteProcessor.name);

  constructor(
    private readonly bazaarsRepository: BazaarsRepository,
    private readonly searchIndexQueue: SearchIndexQueue,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    if (job.name === 'autocomplete-one-off') {
      try {
        const completedIds = await this.bazaarsRepository.transitionPastOneOffBazaars();
        // COMPLETED is not public: drop each one from the search index.
        await this.searchIndexQueue.enqueueMany(
          completedIds.map((id) => ({ type: 'BAZAAR' as const, id })),
        );
        const updatedCount = completedIds.length;
        this.logger.log(`Auto-completed ${updatedCount} ONE_OFF bazaars.`);
        return { updatedCount };
      } catch (error) {
        this.logger.error('Failed to auto-complete bazaars', error);
        throw error;
      }
    }
  }
}
