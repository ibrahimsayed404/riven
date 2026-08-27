import { Test, TestingModule } from '@nestjs/testing';
import { OrganizersService } from './organizers.service';
import { OrganizersRepository } from './organizers.repository';
import { NotFoundException } from '@nestjs/common';

describe('OrganizersService', () => {
  let service: OrganizersService;
  let repository: jest.Mocked<OrganizersRepository>;

  const mockOrganizer = {
    id: 'org-1',
    ownerId: 'owner-1',
    name: 'Org Owner',
    organizationName: 'Test Org',
    verified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizersService,
        {
          provide: OrganizersRepository,
          useValue: {
            findByOwnerId: jest.fn(),
            findById: jest.fn(),
            update: jest.fn(),
            updateVerification: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<OrganizersService>(OrganizersService);
    repository = module.get(OrganizersRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getOrganizerByOwnerId', () => {
    it('should return organizer if found', async () => {
      repository.findByOwnerId.mockResolvedValue(mockOrganizer);
      const result = await service.getOrganizerByOwnerId('owner-1');
      expect(result).toEqual(mockOrganizer);
    });

    it('should throw NotFoundException if organizer not found', async () => {
      repository.findByOwnerId.mockResolvedValue(null);
      await expect(service.getOrganizerByOwnerId('owner-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('verifyOrganizer', () => {
    it('should verify organizer by ID', async () => {
      repository.findById.mockResolvedValue(mockOrganizer);
      repository.update.mockResolvedValue({ ...mockOrganizer, verified: true });

      const result = await service.verifyOrganizer('org-1');
      expect(repository.update).toHaveBeenCalledWith('org-1', { verified: true });
      expect(result.verified).toBe(true);
    });

    it('should throw NotFoundException if organizer not found during verification', async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.verifyOrganizer('org-1')).rejects.toThrow(NotFoundException);
    });
  });
});
