import { BadRequestException, ExecutionContext, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import * as request from 'supertest';

import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersModule } from './users.module';
import { UsersService } from './users.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PrismaModule } from '../../infra/prisma/prisma.module';

// --------------------------------------------------------------------------
// Test helpers
// --------------------------------------------------------------------------

let currentTestUser: AuthenticatedUser = {
  id: 'user-1',
  email: 'user@test.com',
  name: 'Test User',
  role: Role.SHOPPER,
};

/**
 * Mock JwtAuthGuard that injects `currentTestUser` into the request.
 * Change `currentTestUser` between tests to simulate different users/roles.
 */
const mockJwtAuthGuard = {
  canActivate: (context: ExecutionContext) => {
    const req = context.switchToHttp().getRequest();
    req.user = currentTestUser;
    return true;
  },
};

const mockUsersService = {
  getProfile: jest.fn(),
  updateProfile: jest.fn(),
  updateLocation: jest.fn(),
  deleteAccount: jest.fn(),
  getAdminUserList: jest.fn(),
  getAdminUserDetail: jest.fn(),
  deactivateUser: jest.fn(),
  reactivateUser: jest.fn(),
};

// --------------------------------------------------------------------------
// Test suite
// --------------------------------------------------------------------------

describe('Users Module (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UsersModule, PrismaModule],
    })
      .overrideProvider(UsersService)
      .useValue(mockUsersService)
      .overrideProvider(PrismaService)
      .useValue({}) // not used since service is mocked
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtAuthGuard)
      .compile();

    app = moduleRef.createNestApplication();

    // Match the real app's validation pipe configuration exactly
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: (errors) =>
          new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: errors.flatMap(
              (error) => Object.values(error.constraints ?? {}),
            ),
          }),
      }),
    );

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset to default test user
    currentTestUser = {
      id: 'user-1',
      email: 'user@test.com',
      name: 'Test User',
      role: Role.SHOPPER,
    };
  });

  // --------------------------------------------------------------------------
  // PATCH /users/me — profile update
  // --------------------------------------------------------------------------

  describe('PATCH /users/me', () => {
    it('succeeds with valid name', async () => {
      const profileResponse = {
        id: 'user-1',
        name: 'Updated Name',
        email: 'user@test.com',
        phone: null,
        role: Role.SHOPPER,
        interests: [],
        location: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockUsersService.updateProfile.mockResolvedValue(profileResponse);

      const res = await request(app.getHttpServer())
        .patch('/users/me')
        .send({ name: 'Updated Name' })
        .expect(200);

      expect(res.body.name).toBe('Updated Name');
      expect(mockUsersService.updateProfile).toHaveBeenCalledWith('user-1', {
        name: 'Updated Name',
      });
    });

    it('rejects when email is present in body (400)', async () => {
      const res = await request(app.getHttpServer())
        .patch('/users/me')
        .send({ name: 'Updated', email: 'new@email.com' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toEqual(
        expect.arrayContaining([
          expect.stringContaining('email'),
        ]),
      );
      expect(mockUsersService.updateProfile).not.toHaveBeenCalled();
    });

    it('rejects when role is present in body (400)', async () => {
      const res = await request(app.getHttpServer())
        .patch('/users/me')
        .send({ role: 'ADMIN' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.message).toEqual(
        expect.arrayContaining([
          expect.stringContaining('role'),
        ]),
      );
      expect(mockUsersService.updateProfile).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Admin routes — role enforcement
  // --------------------------------------------------------------------------

  describe('GET /admin/users (role enforcement)', () => {
    it('blocks non-admin users (403)', async () => {
      currentTestUser = { ...currentTestUser, role: Role.SHOPPER };

      await request(app.getHttpServer())
        .get('/admin/users')
        .expect(403);

      expect(mockUsersService.getAdminUserList).not.toHaveBeenCalled();
    });

    it('allows admin users', async () => {
      currentTestUser = { ...currentTestUser, role: Role.ADMIN };
      mockUsersService.getAdminUserList.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      });

      await request(app.getHttpServer())
        .get('/admin/users')
        .expect(200);

      expect(mockUsersService.getAdminUserList).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Admin deactivate / reactivate
  // --------------------------------------------------------------------------

  describe('PATCH /admin/users/:id/deactivate', () => {
    it('succeeds for admin deactivating another user', async () => {
      currentTestUser = { ...currentTestUser, id: 'admin-1', role: Role.ADMIN };
      mockUsersService.deactivateUser.mockResolvedValue(undefined);

      await request(app.getHttpServer())
        .patch('/admin/users/user-2/deactivate')
        .expect(204);

      expect(mockUsersService.deactivateUser).toHaveBeenCalledWith(
        'admin-1',
        'user-2',
      );
    });
  });

  describe('PATCH /admin/users/:id/reactivate', () => {
    it('succeeds for admin reactivating a user', async () => {
      currentTestUser = { ...currentTestUser, id: 'admin-1', role: Role.ADMIN };
      mockUsersService.reactivateUser.mockResolvedValue(undefined);

      await request(app.getHttpServer())
        .patch('/admin/users/user-2/reactivate')
        .expect(204);

      expect(mockUsersService.reactivateUser).toHaveBeenCalledWith('user-2');
    });
  });

  // --------------------------------------------------------------------------
  // Location update validation
  // --------------------------------------------------------------------------

  describe('PATCH /users/me/location', () => {
    it('rejects invalid lat/lng', async () => {
      await request(app.getHttpServer())
        .patch('/users/me/location')
        .send({ lat: 100, lng: 200 }) // out of range
        .expect(400);
    });

    it('succeeds with valid coordinates', async () => {
      mockUsersService.updateLocation.mockResolvedValue(undefined);

      await request(app.getHttpServer())
        .patch('/users/me/location')
        .send({ lat: 30.0444, lng: 31.2357 })
        .expect(204);

      expect(mockUsersService.updateLocation).toHaveBeenCalledWith(
        'user-1',
        30.0444,
        31.2357,
      );
    });
  });
});
