import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { OrganizersService } from '../bazaars/organizers.service';
import { VendorsService } from '../vendors/vendors.service';

jest.mock('bcrypt');

const mockUser = {
  id: 'user-1',
  name: 'Test User',
  email: 'test@example.com',
  phone: '+201012345678',
  role: Role.SHOPPER as Role,
  interests: ['fashion', 'tech'],
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  isActive: true,
  deletedAt: null,
};

const mockUserWithHash = {
  ...mockUser,
  passwordHash: '$2b$12$hashedpassword',
};

function createMockRepository(): jest.Mocked<UsersRepository> {
  return {
    findById: jest.fn(),
    findByIdWithPasswordHash: jest.fn(),
    updateProfile: jest.fn(),
    updateLocation: jest.fn(),
    findUserLocation: jest.fn(),
    softDelete: jest.fn(),
    deactivate: jest.fn(),
    reactivate: jest.fn(),
    findManyPaginated: jest.fn(),
  } as unknown as jest.Mocked<UsersRepository>;
}

describe('UsersService', () => {
  let service: UsersService;
  let repository: jest.Mocked<UsersRepository>;
  let auditService: jest.Mocked<AuditService>;
  let authService: jest.Mocked<AuthService>;
  let vendorsService: jest.Mocked<VendorsService>;
  let organizersService: jest.Mocked<OrganizersService>;

  beforeEach(() => {
    repository = createMockRepository();
    auditService = { record: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;
    authService = { revokeAllSessions: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuthService>;
    vendorsService = { softDeleteByOwner: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<VendorsService>;
    organizersService = { softDeleteByOwner: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<OrganizersService>;
    service = new UsersService(repository, auditService, authService, vendorsService, organizersService);
  });

  describe('getProfile', () => {
    it('returns the user profile with location', async () => {
      repository.findById.mockResolvedValue(mockUser);
      repository.findUserLocation.mockResolvedValue({ lat: 30.0444, lng: 31.2357 });

      const result = await service.getProfile('user-1');

      expect(result).toEqual({
        id: 'user-1',
        name: 'Test User',
        email: 'test@example.com',
        phone: '+201012345678',
        role: Role.SHOPPER,
        interests: ['fashion', 'tech'],
        isActive: true,
        location: { lat: 30.0444, lng: 31.2357 },
        createdAt: mockUser.createdAt,
        updatedAt: mockUser.updatedAt,
      });
    });

    it('returns location as null when not set', async () => {
      repository.findById.mockResolvedValue(mockUser);
      repository.findUserLocation.mockResolvedValue(null);

      const result = await service.getProfile('user-1');

      expect(result.location).toBeNull();
    });

    it('throws NotFoundException for non-existent user', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.getProfile('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateLocation', () => {
    it('succeeds on first call', async () => {
      repository.updateLocation.mockResolvedValue(undefined);

      await expect(service.updateLocation('user-1', 30.0, 31.0)).resolves.toBeUndefined();
      expect(repository.updateLocation).toHaveBeenCalledWith('user-1', 30.0, 31.0);
    });

    it('no longer rate-limits in the service — that is the route @Throttle (ROBUST-01)', async () => {
      repository.updateLocation.mockResolvedValue(undefined);

      await service.updateLocation('user-1', 30.0, 31.0);
      await expect(service.updateLocation('user-1', 30.1, 31.1)).resolves.toBeUndefined();
      expect(repository.updateLocation).toHaveBeenCalledTimes(2);
    });

    it('allows updates for different users independently', async () => {
      repository.updateLocation.mockResolvedValue(undefined);

      await service.updateLocation('user-1', 30.0, 31.0);

      // Different user should not be rate-limited
      await expect(
        service.updateLocation('user-2', 30.0, 31.0),
      ).resolves.toBeUndefined();
    });
  });

  describe('deleteAccount', () => {
    it('succeeds with correct password', async () => {
      repository.findByIdWithPasswordHash.mockResolvedValue(mockUserWithHash);
      repository.softDelete.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(
        service.deleteAccount('user-1', 'correctpassword'),
      ).resolves.toBeUndefined();
      expect(repository.softDelete).toHaveBeenCalledWith('user-1');
    });

    it('throws UnauthorizedException with wrong password', async () => {
      repository.findByIdWithPasswordHash.mockResolvedValue(mockUserWithHash);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.deleteAccount('user-1', 'wrongpassword'),
      ).rejects.toThrow(UnauthorizedException);
      expect(repository.softDelete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for non-existent user', async () => {
      repository.findByIdWithPasswordHash.mockResolvedValue(null);

      await expect(
        service.deleteAccount('nonexistent', 'password'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deactivateUser', () => {
    it('throws BadRequestException when admin tries to deactivate self', async () => {
      await expect(
        service.deactivateUser('admin-1', 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(repository.deactivate).not.toHaveBeenCalled();
    });

    it('suspends a different user (isActive=false, not deletedAt), revokes sessions, records USER_DEACTIVATED', async () => {
      repository.findById.mockResolvedValue(mockUser);
      repository.deactivate.mockResolvedValue({ ...mockUser, isActive: false });

      await expect(
        service.deactivateUser('admin-1', 'user-1'),
      ).resolves.toBeUndefined();
      expect(repository.deactivate).toHaveBeenCalledWith('user-1');
      expect(repository.softDelete).not.toHaveBeenCalled();
      expect(authService.revokeAllSessions).toHaveBeenCalledWith('user-1');
      expect(auditService.record).toHaveBeenCalledWith({
        actorId: 'admin-1',
        action: 'USER_DEACTIVATED',
        targetType: 'USER',
        targetId: 'user-1',
      });
    });

    it('is a no-op for an already-deactivated user: no write, no audit', async () => {
      repository.findById.mockResolvedValue({ ...mockUser, isActive: false });

      await expect(
        service.deactivateUser('admin-1', 'user-1'),
      ).resolves.toBeUndefined();
      expect(repository.deactivate).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('rejects an owner-deleted account with USER_DELETED', async () => {
      repository.findById.mockResolvedValue({ ...mockUser, deletedAt: new Date() });

      await expect(service.deactivateUser('admin-1', 'user-1')).rejects.toMatchObject({
        response: { code: 'USER_DELETED' },
      });
      expect(repository.deactivate).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for non-existent target user', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.deactivateUser('admin-1', 'nonexistent'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('reactivateUser', () => {
    it('succeeds for a deactivated user and records USER_REACTIVATED', async () => {
      repository.findById.mockResolvedValue({ ...mockUser, isActive: false });
      repository.reactivate.mockResolvedValue(mockUser);

      await expect(service.reactivateUser('admin-1', 'user-1')).resolves.toBeUndefined();
      expect(repository.reactivate).toHaveBeenCalledWith('user-1');
      expect(auditService.record).toHaveBeenCalledWith({
        actorId: 'admin-1',
        action: 'USER_REACTIVATED',
        targetType: 'USER',
        targetId: 'user-1',
      });
    });

    it('is a no-op for an already-active user: no write, no audit', async () => {
      repository.findById.mockResolvedValue(mockUser);

      await expect(service.reactivateUser('admin-1', 'user-1')).resolves.toBeUndefined();
      expect(repository.reactivate).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('cannot resurrect an owner-deleted account: USER_DELETED', async () => {
      repository.findById.mockResolvedValue({ ...mockUser, deletedAt: new Date() });

      await expect(service.reactivateUser('admin-1', 'user-1')).rejects.toMatchObject({
        response: { code: 'USER_DELETED' },
      });
      expect(repository.reactivate).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for non-existent user', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.reactivateUser('admin-1', 'nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
