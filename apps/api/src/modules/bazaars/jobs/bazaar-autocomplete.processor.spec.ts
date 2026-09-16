import { Test, TestingModule } from '@nestjs/testing';
import { BazaarAutocompleteProcessor } from './bazaar-autocomplete.processor';
import { BazaarsRepository } from '../bazaars.repository';
import { Job } from 'bullmq';
import { SearchIndexQueue } from '../../../infra/search/search-index.queue';

describe('BazaarAutocompleteProcessor', () => {
  let processor: BazaarAutocompleteProcessor;
  let repository: jest.Mocked<BazaarsRepository>;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        BazaarAutocompleteProcessor,
        {
          provide: BazaarsRepository,
          useValue: {
            transitionPastOneOffBazaars: jest.fn(),
          },
        },
        {
          provide: SearchIndexQueue,
          useValue: { enqueue: jest.fn().mockResolvedValue(undefined), enqueueMany: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    processor = module.get<BazaarAutocompleteProcessor>(BazaarAutocompleteProcessor);
    repository = module.get(BazaarsRepository);
  });

  describe('process', () => {
    it('should call transitionPastOneOffBazaars and drop completed bazaars from the search index', async () => {
      repository.transitionPastOneOffBazaars.mockResolvedValue(['b1', 'b2']);
      const searchIndexQueue = module.get(SearchIndexQueue) as jest.Mocked<SearchIndexQueue>;
      
      const mockJob = { name: 'autocomplete-one-off', id: '1' } as Job;
      const result = await processor.process(mockJob);

      expect(repository.transitionPastOneOffBazaars).toHaveBeenCalled();
      expect(result).toEqual({ updatedCount: 2 });
      expect(searchIndexQueue.enqueueMany).toHaveBeenCalledWith([
        { type: 'BAZAAR', id: 'b1' },
        { type: 'BAZAAR', id: 'b2' },
      ]);
    });

    it('should ignore jobs with unknown names', async () => {
      const mockJob = { name: 'unknown-job', id: '2' } as Job;
      await processor.process(mockJob);

      expect(repository.transitionPastOneOffBazaars).not.toHaveBeenCalled();
    });
  });
});
