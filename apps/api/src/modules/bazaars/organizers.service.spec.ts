import { Test, TestingModule } from '@nestjs/testing';
import { OrganizersService } from './organizers.service';
import { OrganizersRepository } from './organizers.repository';
import { NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';

describe('OrganizersService', () => {
  let service: OrganizersService;
  let repository: jest.Mocked<OrganizersRepository>;
  let auditService: jest.Mocked<AuditService>;

  const mockOrganizer = {
    id: 'org-1',
    ownerId: 'owner-1',
    name: 'Org Owner',
    organizationName: 'Test Org',
    verified: false,
    rejectionReason: null,
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
            findModerationState: jest.fn(),
            findManyForAdmin: jest.fn(),
          },
        },
        { provide: AuditService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<OrganizersService>(OrganizersService);
    repository = module.get(OrganizersRepository);
    auditService = module.get(AuditService);
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

  // specs/admin-module-spec.md §3 — transition table, organizer flavour (no search enqueue).
  describe('verifyOrganizer / rejectOrganizer', () => {
    const state = (verified: boolean, rejectionReason: string | null, deletedAt: Date | null = null) =>
      ({ id: 'org-1', verified, rejectionReason, deletedAt });

    beforeEach(() => {
      repository.update.mockImplementation(async (_id, data: any) => ({ ...mockOrganizer, ...data }));
    });

    it('pending → verify: writes and audits ORGANIZER_VERIFIED', async () => {
      repository.findModerationState.mockResolvedValue(state(false, null));

      const result = await service.verifyOrganizer('admin-1', 'org-1');

      expect(repository.update).toHaveBeenCalledWith('org-1', { verified: true, rejectionReason: null });
      expect(auditService.record).toHaveBeenCalledWith({
        actorId: 'admin-1', action: 'ORGANIZER_VERIFIED', targetType: 'ORGANIZER', targetId: 'org-1', reason: null,
      });
      expect(result).toEqual({ id: 'org-1', verified: true, rejectionReason: null });
    });

    it('pending → reject: writes the reason and audits ORGANIZER_REJECTED with it', async () => {
      repository.findModerationState.mockResolvedValue(state(false, null));

      const result = await service.rejectOrganizer('admin-1', 'org-1', 'Incomplete documents');

      expect(repository.update).toHaveBeenCalledWith('org-1', { verified: false, rejectionReason: 'Incomplete documents' });
      expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'ORGANIZER_REJECTED', reason: 'Incomplete documents' }));
      expect(result.rejectionReason).toBe('Incomplete documents');
    });

    it('verified → reject (revoke): flips verified and audits', async () => {
      repository.findModerationState.mockResolvedValue(state(true, null));

      await service.rejectOrganizer('admin-1', 'org-1', 'Complaint');

      expect(repository.update).toHaveBeenCalledWith('org-1', { verified: false, rejectionReason: 'Complaint' });
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });

    it('rejected → verify (re-approval): clears the reason', async () => {
      repository.findModerationState.mockResolvedValue(state(false, 'Old'));

      const result = await service.verifyOrganizer('admin-1', 'org-1');

      expect(repository.update).toHaveBeenCalledWith('org-1', { verified: true, rejectionReason: null });
      expect(result.rejectionReason).toBeNull();
    });

    it('verified → verify: no-op, no write, no audit', async () => {
      repository.findModerationState.mockResolvedValue(state(true, null));

      const result = await service.verifyOrganizer('admin-1', 'org-1');

      expect(repository.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'org-1', verified: true, rejectionReason: null });
    });

    it('rejected → reject with a different reason: replaces and audits', async () => {
      repository.findModerationState.mockResolvedValue(state(false, 'Old'));

      await service.rejectOrganizer('admin-1', 'org-1', 'New');

      expect(repository.update).toHaveBeenCalledWith('org-1', { verified: false, rejectionReason: 'New' });
      expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ reason: 'New' }));
    });

    it('rejected → reject with the same reason: no-op', async () => {
      repository.findModerationState.mockResolvedValue(state(false, 'Same'));

      await service.rejectOrganizer('admin-1', 'org-1', 'Same');

      expect(repository.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('404 ORGANIZER_NOT_FOUND when missing', async () => {
      repository.findModerationState.mockResolvedValue(null);

      await expect(service.verifyOrganizer('admin-1', 'org-1')).rejects.toMatchObject({
        response: { code: 'ORGANIZER_NOT_FOUND' },
      });
    });

    it('404 when soft-deleted', async () => {
      repository.findModerationState.mockResolvedValue(state(false, null, new Date()));

      await expect(service.rejectOrganizer('admin-1', 'org-1', 'x')).rejects.toThrow(NotFoundException);
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('listForAdmin', () => {
    it('wraps the repository page in { data, meta }', async () => {
      repository.findManyForAdmin.mockResolvedValue({ data: [], total: 0 });

      const result = await service.listForAdmin({ status: 'rejected', page: 1, limit: 20 });

      expect(repository.findManyForAdmin).toHaveBeenCalledWith({ status: 'rejected', page: 1, limit: 20 });
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 20, totalPages: 0 });
    });
  });
});
