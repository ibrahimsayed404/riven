import { Test, TestingModule } from '@nestjs/testing';
import { BazaarAutocompleteProcessor } from './bazaar-autocomplete.processor';
import { BazaarsRepository } from '../bazaars.repository';
import { Job } from 'bullmq';

describe('BazaarAutocompleteProcessor', () => {
  let processor: BazaarAutocompleteProcessor;
  let repository: jest.Mocked<BazaarsRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BazaarAutocompleteProcessor,
        {
          provide: BazaarsRepository,
          useValue: {
            transitionPastOneOffBazaars: jest.fn(),
          },
        },
      ],
    }).compile();

    processor = module.get<BazaarAutocompleteProcessor>(BazaarAutocompleteProcessor);
    repository = module.get(BazaarsRepository);
  });

  describe('process', () => {
    it('should call transitionPastOneOffBazaars and log updated count', async () => {
      repository.transitionPastOneOffBazaars.mockResolvedValue(5);
      
      const mockJob = { name: 'autocomplete-one-off', id: '1' } as Job;
      await processor.process(mockJob);

      expect(repository.transitionPastOneOffBazaars).toHaveBeenCalled();
    });

    it('should ignore jobs with unknown names', async () => {
      const mockJob = { name: 'unknown-job', id: '2' } as Job;
      await processor.process(mockJob);

      expect(repository.transitionPastOneOffBazaars).not.toHaveBeenCalled();
    });
  });
});
