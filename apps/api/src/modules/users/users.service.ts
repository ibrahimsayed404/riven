import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { compare } from 'bcrypt';
import { AdminAction, AdminTargetType, Role } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { UsersRepository } from './users.repository';
import { UserProfileResponse } from './dto/user-profile-response.dto';

const LOCATION_RATE_LIMIT_MS = 60_000; // 1 update per 60 seconds per user

@Injectable()
export class UsersService {
  /**
   * In-memory per-user rate limit for location updates.
   * Maps userId → timestamp (ms) of last location update.
   *
   * Acceptable for single-instance dev; swap to Redis for multi-instance.
   * The map auto-cleans on restart (stale rate-limit state is low-risk).
   */
  private readonly locationUpdateTimestamps = new Map<string, number>();

  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly auditService: AuditService,
  ) {}

  async getProfile(userId: string): Promise<UserProfileResponse> {
    const user = await this.usersRepository.findById(userId);

    if (!user) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found.',
      });
    }

    const location = await this.usersRepository.findUserLocation(userId);

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      interests: user.interests,
      location,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async updateProfile(
    userId: string,
    data: { name?: string; phone?: string; interests?: string[] },
  ): Promise<UserProfileResponse> {
    const user = await this.usersRepository.updateProfile(userId, data);
    const location = await this.usersRepository.findUserLocation(userId);

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      interests: user.interests,
      location,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async updateLocation(userId: string, lat: number, lng: number): Promise<void> {
    const now = Date.now();
    const lastUpdate = this.locationUpdateTimestamps.get(userId);

    if (lastUpdate && now - lastUpdate < LOCATION_RATE_LIMIT_MS) {
      const retryAfterSeconds = Math.ceil(
        (LOCATION_RATE_LIMIT_MS - (now - lastUpdate)) / 1000,
      );
      throw new HttpException(
        {
          code: 'LOCATION_RATE_LIMITED',
          message: `Location can only be updated once every 60 seconds. Retry after ${retryAfterSeconds}s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.usersRepository.updateLocation(userId, lat, lng);
    this.locationUpdateTimestamps.set(userId, now);
  }

  async deleteAccount(userId: string, password: string): Promise<void> {
    const user = await this.usersRepository.findByIdWithPasswordHash(userId);

    if (!user) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found.',
      });
    }

    const passwordMatches = await compare(password, user.passwordHash);

    if (!passwordMatches) {
      throw new UnauthorizedException({
        code: 'INVALID_PASSWORD',
        message: 'Incorrect password.',
      });
    }

    await this.usersRepository.softDelete(userId);
  }

  async getAdminUserList(params: {
    role?: Role;
    search?: string;
    includeDeleted: boolean;
    page: number;
    limit: number;
  }): Promise<{
    data: UserProfileResponse[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { users, total } = await this.usersRepository.findManyPaginated(params);

    const data: UserProfileResponse[] = users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      interests: user.interests,
      location: null, // Omitted in list view to avoid N+1 queries; available in detail view
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));

    return {
      data,
      meta: {
        total,
        page: params.page,
        limit: params.limit,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }

  async getAdminUserDetail(userId: string): Promise<UserProfileResponse> {
    return this.getProfile(userId);
  }

  async deactivateUser(adminId: string, targetId: string): Promise<void> {
    if (adminId === targetId) {
      throw new BadRequestException({
        code: 'CANNOT_DEACTIVATE_SELF',
        message: 'You cannot deactivate your own account through this endpoint.',
      });
    }

    const user = await this.usersRepository.findById(targetId);

    if (!user) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found.',
      });
    }

    // Already deactivated: 204 no-op, no audit row (specs/admin-module-spec.md §4.4).
    if (user.deletedAt) {
      return;
    }

    // Known gap: this does NOT auto-revoke the target user's refresh tokens.
    // A deactivated user could still use an existing valid access token
    // until it expires (15m TTL). Full session-kill on deactivate can be
    // a fast-follow if needed.
    await this.usersRepository.softDelete(targetId);

    await this.auditService.record({
      actorId: adminId,
      action: AdminAction.USER_DEACTIVATED,
      targetType: AdminTargetType.USER,
      targetId,
    });
  }

  async reactivateUser(adminId: string, targetId: string): Promise<void> {
    const user = await this.usersRepository.findById(targetId);

    if (!user) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'User not found.',
      });
    }

    // Already active: 204 no-op, no audit row.
    if (!user.deletedAt) {
      return;
    }

    await this.usersRepository.reactivate(targetId);

    await this.auditService.record({
      actorId: adminId,
      action: AdminAction.USER_REACTIVATED,
      targetType: AdminTargetType.USER,
      targetId,
    });
  }

  /** Admin overview: active users per role, one query. */
  countByRole(): Promise<{ role: Role; count: number }[]> {
    return this.usersRepository.groupByRole();
  }
}
