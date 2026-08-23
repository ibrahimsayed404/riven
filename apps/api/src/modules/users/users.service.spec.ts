import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { UsersService } from './users.service';
import { UsersRepository } from './users.repository';

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
    reactivate: jest.fn(),
    findManyPaginated: jest.fn(),
  } as unknown as jest.Mocked<UsersRepository>;
}

describe('UsersService', () => {
  let service: UsersService;
  let repository: jest.Mocked<UsersRepository>;

  beforeEach(() => {
    repository = createMockRepository();
    service = new UsersService(repository);
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

    it('rejects with 429 when called within 60 seconds', async () => {
      repository.updateLocation.mockResolvedValue(undefined);

      // First call succeeds
      await service.updateLocation('user-1', 30.0, 31.0);

      // Second call within 60s should be rate-limited
      try {
        await service.updateLocation('user-1', 30.1, 31.1);
        fail('Expected HttpException to be thrown');
      } catch (error) {
        expect(error).toHaveProperty('status', HttpStatus.TOO_MANY_REQUESTS);
      }
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
      expect(repository.softDelete).not.toHaveBeenCalled();
    });

    it('succeeds for a different user', async () => {
      repository.findById.mockResolvedValue(mockUser);
      repository.softDelete.mockResolvedValue(mockUser);

      await expect(
        service.deactivateUser('admin-1', 'user-1'),
      ).resolves.toBeUndefined();
      expect(repository.softDelete).toHaveBeenCalledWith('user-1');
    });

    it('throws NotFoundException for non-existent target user', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.deactivateUser('admin-1', 'nonexistent'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('reactivateUser', () => {
    it('succeeds for existing user', async () => {
      repository.findById.mockResolvedValue({
        ...mockUser,
        deletedAt: new Date(),
      });
      repository.reactivate.mockResolvedValue(mockUser);

      await expect(service.reactivateUser('user-1')).resolves.toBeUndefined();
      expect(repository.reactivate).toHaveBeenCalledWith('user-1');
    });

    it('throws NotFoundException for non-existent user', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.reactivateUser('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
