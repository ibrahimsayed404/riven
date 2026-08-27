import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { BazaarsRepository } from '../bazaars.repository';
import { Logger } from '@nestjs/common';

@Processor('bazaars')
export class BazaarAutocompleteProcessor extends WorkerHost {
  private readonly logger = new Logger(BazaarAutocompleteProcessor.name);

  constructor(private readonly bazaarsRepository: BazaarsRepository) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    if (job.name === 'autocomplete-one-off') {
      try {
        const updatedCount = await this.bazaarsRepository.transitionPastOneOffBazaars();
        this.logger.log(`Auto-completed ${updatedCount} ONE_OFF bazaars.`);
        return { updatedCount };
      } catch (error) {
        this.logger.error('Failed to auto-complete bazaars', error);
        throw error;
      }
    }
  }
}
