import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { compare } from 'bcrypt';
import { AdminAction, AdminTargetType, Role } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { OrganizersService } from '../bazaars/organizers.service';
import { VendorsService } from '../vendors/vendors.service';
import { UsersRepository } from './users.repository';
import { UserProfileResponse } from './dto/user-profile-response.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly auditService: AuditService,
    private readonly authService: AuthService,
    private readonly vendorsService: VendorsService,
    private readonly organizersService: OrganizersService,
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

  // The once-per-minute rule is a @Throttle on the route, keyed by user by
  // UserThrottlerGuard — not a per-process Map that grows forever (fix.js ROBUST-01).
  async updateLocation(userId: string, lat: number, lng: number): Promise<void> {
    await this.usersRepository.updateLocation(userId, lat, lng);
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

    // Sessions first: if the soft-delete then fails the user is merely logged
    // out, never deleted-but-still-logged-in (fix.js AUTH-01).
    await this.authService.revokeAllSessions(userId);
    // The owned profile goes with the account (fix.js LOGIC-05). Each call is a
    // no-op for roles that have no such row. Not one transaction — the rows
    // belong to other modules — so profile first: a half-failure leaves a
    // deleted storefront with a live login, never a live storefront with no owner.
    if (user.role === Role.VENDOR) await this.vendorsService.softDeleteByOwner(userId);
    if (user.role === Role.ORGANIZER) await this.organizersService.softDeleteByOwner(userId);
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

    // Revoke every refresh token, then soft-delete. Existing access tokens die
    // on their next request because the auth lookups now exclude deletedAt.
    await this.authService.revokeAllSessions(targetId);
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
