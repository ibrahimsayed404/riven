import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { AuthRepository } from './auth.repository';
import { AuthService, normalizeEmail } from './auth.service';

jest.mock('bcrypt');

const user = {
  id: 'user-1',
  email: 'shopper@example.com',
  name: 'Shopper',
  role: Role.SHOPPER,
  passwordHash: '$2b$12$hash',
  createdAt: new Date('2026-01-01'),
} as any;

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['email'] },
  });
}

describe('AuthService', () => {
  let service: AuthService;
  let repository: jest.Mocked<AuthRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = {
      findUserByEmail: jest.fn(),
      findUserById: jest.fn(),
      findAuthenticatedUserById: jest.fn(),
      createUser: jest.fn(),
      createVendorUser: jest.fn(),
      createOrganizerUser: jest.fn(),
      createRefreshToken: jest.fn().mockResolvedValue({}),
      findRefreshTokenByHash: jest.fn(),
      rotateRefreshToken: jest.fn(),
      revokeRefreshToken: jest.fn(),
      revokeAllActiveRefreshTokensForUser: jest.fn().mockResolvedValue({ count: 2 }),
    } as unknown as jest.Mocked<AuthRepository>;

    const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') } as unknown as JwtService;
    const config = { getOrThrow: jest.fn().mockReturnValue('7d') } as unknown as ConfigService;
    service = new AuthService(repository, jwt, config);
    (bcrypt.hash as jest.Mock).mockResolvedValue('$2b$12$hash');
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
  });

  describe('normalizeEmail (AUTH-03)', () => {
    it('trims and lowercases', () => {
      expect(normalizeEmail('  Foo.Bar@Example.COM ')).toBe('foo.bar@example.com');
    });
  });

  describe('register (AUTH-02, AUTH-03, AUTH-04)', () => {
    const dto = { email: 'New.User@Example.com', password: 'Password1', name: 'New' };

    it('stores the normalized email and always creates a SHOPPER', async () => {
      repository.findUserByEmail.mockResolvedValue(null);
      repository.createUser.mockResolvedValue({ ...user, email: 'new.user@example.com' });

      await service.register({ ...dto, role: Role.SHOPPER });

      expect(repository.findUserByEmail).toHaveBeenCalledWith('new.user@example.com');
      expect(repository.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'new.user@example.com', role: Role.SHOPPER }),
      );
    });

    it('rejects VENDOR / ORGANIZER / ADMIN in the service, not only the DTO', async () => {
      for (const role of [Role.VENDOR, Role.ORGANIZER, Role.ADMIN]) {
        await expect(service.register({ ...dto, role })).rejects.toMatchObject({
          response: { code: 'ROLE_NOT_SELF_ASSIGNABLE' },
        });
      }
      expect(repository.createUser).not.toHaveBeenCalled();
    });

    it('maps a unique-violation race to 409 EMAIL_ALREADY_EXISTS instead of a 500', async () => {
      repository.findUserByEmail.mockResolvedValue(null); // pre-check passes …
      repository.createUser.mockRejectedValue(uniqueViolation()); // … the index does not

      await expect(service.register(dto)).rejects.toMatchObject({
        response: { code: 'EMAIL_ALREADY_EXISTS' },
      });
      await expect(service.register(dto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('registerVendor gets the same race handling', async () => {
      repository.findUserByEmail.mockResolvedValue(null);
      repository.createVendorUser.mockRejectedValue(uniqueViolation());

      await expect(
        service.registerVendor({
          email: 'v@example.com', password: 'Password1', name: 'V', businessName: 'V Shop', category: 'FASHION', vendorType: 'MARKETPLACE',
        } as any),
      ).rejects.toMatchObject({ response: { code: 'EMAIL_ALREADY_EXISTS' } });
    });
  });

  describe('login (AUTH-01, AUTH-03)', () => {
    it('looks the user up by normalized email', async () => {
      repository.findUserByEmail.mockResolvedValue(user);

      const result = await service.login({ email: 'SHOPPER@example.com', password: 'Password1' });

      expect(repository.findUserByEmail).toHaveBeenCalledWith('shopper@example.com');
      expect(result.accessToken).toBe('access-token');
    });

    it('a soft-deleted user (repository returns null) gets INVALID_CREDENTIALS like any unknown email', async () => {
      // The repository excludes deletedAt != null, so from here a deactivated
      // account is indistinguishable from a non-existent one — by design.
      repository.findUserByEmail.mockResolvedValue(null);

      await expect(service.login({ email: 'gone@example.com', password: 'x' })).rejects.toMatchObject({
        response: { code: 'INVALID_CREDENTIALS' },
      });
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });
  });

  describe('refresh (AUTH-01)', () => {
    it('rejects a valid token whose user has since been soft-deleted', async () => {
      repository.findRefreshTokenByHash.mockResolvedValue({
        id: 'rt-1', userId: 'user-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
      } as any);
      repository.findUserById.mockResolvedValue(null); // deletedAt filter

      await expect(service.refresh({ refreshToken: 'abc' })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(repository.rotateRefreshToken).not.toHaveBeenCalled();
    });
  });

  describe('revokeAllSessions (AUTH-01)', () => {
    it('revokes every active refresh token of the user', async () => {
      await service.revokeAllSessions('user-1');
      expect(repository.revokeAllActiveRefreshTokensForUser).toHaveBeenCalledWith('user-1');
    });
  });
});
