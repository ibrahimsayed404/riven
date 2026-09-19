import { Injectable, NotFoundException } from '@nestjs/common';
import { AdminAction, AdminTargetType } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { OrganizersRepository, OrganizerProfile, OrganizerModerationStatus } from './organizers.repository';

@Injectable()
export class OrganizersService {
  constructor(
    private readonly organizersRepository: OrganizersRepository,
    private readonly auditService: AuditService,
  ) {}

  async getOrganizerByOwnerId(ownerId: string): Promise<OrganizerProfile> {
    const organizer = await this.organizersRepository.findByOwnerId(ownerId);
    if (!organizer) {
      throw new NotFoundException({ code: 'ORGANIZER_PROFILE_NOT_FOUND', message: 'Organizer profile not found.' });
    }
    return organizer;
  }

  async getOrganizerById(id: string): Promise<OrganizerProfile> {
    const organizer = await this.organizersRepository.findById(id);
    if (!organizer) {
      throw new NotFoundException({ code: 'ORGANIZER_PROFILE_NOT_FOUND', message: 'Organizer profile not found.' });
    }
    return organizer;
  }

  async updateMyProfile(ownerId: string, data: { name?: string }): Promise<OrganizerProfile> {
    const organizer = await this.getOrganizerByOwnerId(ownerId);
    return this.organizersRepository.update(organizer.id, data);
  }

  /**
   * Called when the owning user account is deleted (fix.js LOGIC-05). Their
   * PUBLISHED bazaars are left as they are — bazaar visibility never depended
   * on the organizer row (admin spec Open Item 3), and cancelling live events
   * with accepted vendors is a product decision, not a side effect.
   */
  async softDeleteByOwner(ownerId: string): Promise<void> {
    await this.organizersRepository.softDeleteByOwner(ownerId);
  }

  // --- Admin moderation (specs/admin-module-spec.md §3, §4.2) ---

  async listForAdmin(params: {
    status?: OrganizerModerationStatus;
    search?: string;
    page: number;
    limit: number;
  }) {
    const { data, total } = await this.organizersRepository.findManyForAdmin(params);
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

  countPendingForAdmin(): Promise<number> {
    return this.organizersRepository.countPendingForAdmin();
  }

  verifyOrganizer(adminId: string, id: string) {
    return this.moderateOrganizer(adminId, id, { verified: true, rejectionReason: null }, AdminAction.ORGANIZER_VERIFIED);
  }

  /** Works on a pending organizer (reject) and on a verified one (revoke). */
  rejectOrganizer(adminId: string, id: string, reason: string) {
    return this.moderateOrganizer(adminId, id, { verified: false, rejectionReason: reason }, AdminAction.ORGANIZER_REJECTED);
  }

  /**
   * One transition function for verify and reject. Idempotent: when the target
   * state equals the current one nothing is written or audited.
   * No search work: bazaar eligibility never reads organizer.verified
   * (bazaars.repository.ts listPublicIds) — verification only gates creation.
   */
  private async moderateOrganizer(
    adminId: string,
    id: string,
    target: { verified: boolean; rejectionReason: string | null },
    action: AdminAction,
  ) {
    const current = await this.organizersRepository.findModerationState(id);
    if (!current || current.deletedAt) {
      throw new NotFoundException({ code: 'ORGANIZER_NOT_FOUND', message: 'Organizer not found.' });
    }

    const unchanged =
      current.verified === target.verified && current.rejectionReason === target.rejectionReason;
    if (unchanged) {
      return { id: current.id, verified: current.verified, rejectionReason: current.rejectionReason };
    }

    const updated = await this.organizersRepository.update(id, target);

    await this.auditService.record({
      actorId: adminId,
      action,
      targetType: AdminTargetType.ORGANIZER,
      targetId: id,
      reason: target.rejectionReason,
    });

    return { id: updated.id, verified: updated.verified, rejectionReason: updated.rejectionReason };
  }
}
