import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { BoothsRepository, PublicBooth } from './booths.repository';
import { BazaarsService } from '../bazaars/bazaars.service';
import { AuditService } from '../audit/audit.service';
import {
  Prisma,
  ApplicationStatus,
  AdminAction,
  AdminTargetType,
} from '@prisma/client';

/**
 * Booth layouts are admin-only writes, and every one is audited after it
 * succeeds (specs/admin-module-spec3.md B8c): layout create/update target the
 * BAZAAR (layouts are keyed by bazaar), booth operations target the BOOTH.
 * A no-op (unassigning an unassigned booth) records nothing.
 */
@Injectable()
export class BoothsService {
  constructor(
    private readonly boothsRepository: BoothsRepository,
    private readonly bazaarsService: BazaarsService,
    private readonly auditService: AuditService,
  ) {}

  async createLayout(
    adminId: string,
    bazaarId: string,
    gridConfig: Prisma.InputJsonValue,
  ) {
    const bazaar = await this.bazaarsService.findById(bazaarId);

    if (!bazaar) {
      throw new NotFoundException({
        code: 'BAZAAR_NOT_FOUND',
        message: 'Bazaar not found.',
      });
    }

    let layout;

    try {
      layout = await this.boothsRepository.createLayout(bazaarId, gridConfig);
    } catch (error: any) {
      if (
        error.code === 'P2002' &&
        (error.meta?.target as string[])?.includes('bazaarId')
      ) {
        throw new ConflictException({
          code: 'LAYOUT_EXISTS',
          message: 'Layout already exists for this bazaar.',
        });
      }

      throw error;
    }

    await this.audit(
      adminId,
      AdminAction.BOOTH_LAYOUT_CREATED,
      AdminTargetType.BAZAAR,
      bazaarId,
    );

    return layout;
  }

  async getLayout(bazaarId: string) {
    const layout = await this.boothsRepository.findLayoutByBazaarId(bazaarId);

    if (!layout) {
      throw new NotFoundException({
        code: 'LAYOUT_NOT_FOUND',
        message: 'Layout not found.',
      });
    }

    return layout;
  }

  async updateLayout(
    adminId: string,
    bazaarId: string,
    gridConfig: Prisma.InputJsonValue,
  ) {
    const layout = await this.boothsRepository.findLayoutByBazaarId(bazaarId);

    if (!layout) {
      throw new NotFoundException({
        code: 'LAYOUT_NOT_FOUND',
        message: 'Layout not found.',
      });
    }

    const updated = await this.boothsRepository.updateLayoutGridConfig(
      bazaarId,
      gridConfig,
    );

    await this.audit(
      adminId,
      AdminAction.BOOTH_LAYOUT_UPDATED,
      AdminTargetType.BAZAAR,
      bazaarId,
    );

    return updated;
  }

  async createBooth(
    adminId: string,
    bazaarId: string,
    data: {
      label: string;
      positionX: number;
      positionY: number;
      width: number;
      height: number;
    },
  ) {
    const layout = await this.boothsRepository.findLayoutByBazaarId(bazaarId);

    if (!layout) {
      throw new NotFoundException({
        code: 'LAYOUT_NOT_FOUND',
        message: 'Layout not found for this bazaar.',
      });
    }

    let booth;

    try {
      booth = await this.boothsRepository.createBooth(
        layout.id,
        data.label,
        data.positionX,
        data.positionY,
        data.width,
        data.height,
      );
    } catch (error: any) {
      if (
        error.code === 'P2002' &&
        (error.meta?.target as string[])?.includes('label')
      ) {
        throw new ConflictException({
          code: 'BOOTH_LABEL_TAKEN',
          message: 'A booth with this label already exists in this layout.',
        });
      }

      throw error;
    }

    await this.audit(
      adminId,
      AdminAction.BOOTH_CREATED,
      AdminTargetType.BOOTH,
      booth.id,
    );

    return booth;
  }

  async updateBooth(
    adminId: string,
    id: string,
    data: {
      label?: string;
      positionX?: number;
      positionY?: number;
      width?: number;
      height?: number;
    },
  ) {
    const booth = await this.boothsRepository.findBoothById(id);

    if (!booth) {
      throw new NotFoundException({
        code: 'BOOTH_NOT_FOUND',
        message: 'Booth not found.',
      });
    }

    let updated;

    try {
      updated = await this.boothsRepository.updateBooth(id, data);
    } catch (error: any) {
      if (
        error.code === 'P2002' &&
        (error.meta?.target as string[])?.includes('label')
      ) {
        throw new ConflictException({
          code: 'BOOTH_LABEL_TAKEN',
          message: 'A booth with this label already exists in this layout.',
        });
      }

      throw error;
    }

    await this.audit(
      adminId,
      AdminAction.BOOTH_UPDATED,
      AdminTargetType.BOOTH,
      id,
    );

    return updated;
  }

  async deleteBooth(adminId: string, id: string) {
    const booth = await this.boothsRepository.findBoothById(id);

    if (!booth) {
      throw new NotFoundException({
        code: 'BOOTH_NOT_FOUND',
        message: 'Booth not found.',
      });
    }

    if (booth.boothListingId !== null) {
      throw new BadRequestException({
        code: 'BOOTH_ASSIGNED',
        message: 'Unassign the vendor before deleting this booth.',
      });
    }

    const deleted = await this.boothsRepository.deleteBooth(id);

    await this.audit(
      adminId,
      AdminAction.BOOTH_DELETED,
      AdminTargetType.BOOTH,
      id,
    );

    return deleted;
  }

  async assignBooth(adminId: string, id: string, boothListingId: string) {
    const booth = await this.boothsRepository.findBoothById(id);

    if (!booth) {
      throw new NotFoundException({
        code: 'BOOTH_NOT_FOUND',
        message: 'Booth not found.',
      });
    }

    if (booth.boothListingId !== null) {
      throw new BadRequestException({
        code: 'BOOTH_ASSIGNED',
        message: 'Booth already has a vendor assigned — unassign first.',
      });
    }

    const application =
      await this.bazaarsService.findApplicationById(boothListingId);

    if (!application) {
      throw new NotFoundException({
        code: 'APPLICATION_NOT_FOUND',
        message: 'Booth listing application not found.',
      });
    }

    if (application.applicationStatus !== ApplicationStatus.ACCEPTED) {
      throw new BadRequestException({
        code: 'APPLICATION_NOT_ACCEPTED',
        message: 'Application is not accepted.',
      });
    }

    // The booth only knows its layout; resolve the application's bazaar
    // to its layout to verify that both belong to the same bazaar.
    const layout = await this.boothsRepository.findLayoutByBazaarId(
      application.bazaarId,
    );

    if (!layout || layout.id !== booth.layoutId) {
      throw new BadRequestException({
        code: 'APPLICATION_BAZAAR_MISMATCH',
        message: "Vendor's application belongs to a different bazaar.",
      });
    }

    let assigned;

    try {
      // Guarded write: the pre-check above is the friendly path, but this
      // write is the source of truth. Null means another request took
      // the booth between the check and the write.
      assigned = await this.boothsRepository.assignBooth(
        id,
        boothListingId,
      );

      if (!assigned) {
        throw new ConflictException({
          code: 'BOOTH_ASSIGNED',
          message:
            'Booth was assigned to another vendor while this request was in flight. Reload and try again.',
        });
      }
    } catch (error: any) {
      if (
        error.code === 'P2002' &&
        (error.meta?.target as string[])?.includes('boothListingId')
      ) {
        throw new ConflictException({
          code: 'APPLICATION_ALREADY_ASSIGNED',
          message:
            'This vendor application is already assigned to another booth.',
        });
      }

      throw error;
    }

    await this.audit(
      adminId,
      AdminAction.BOOTH_ASSIGNED,
      AdminTargetType.BOOTH,
      id,
    );

    return assigned;
  }

  async unassignBooth(adminId: string, id: string) {
    const booth = await this.boothsRepository.findBoothById(id);

    if (!booth) {
      throw new NotFoundException({
        code: 'BOOTH_NOT_FOUND',
        message: 'Booth not found.',
      });
    }

    if (booth.boothListingId === null) {
      return booth; // Idempotent: nothing written, nothing audited
    }

    const unassigned = await this.boothsRepository.unassignBooth(id);

    await this.audit(
      adminId,
      AdminAction.BOOTH_UNASSIGNED,
      AdminTargetType.BOOTH,
      id,
    );

    return unassigned;
  }

  async getPublicLayout(bazaarId: string) {
    // Only succeeds if the bazaar is publicly visible (bazaar-visibility.ts)
    const bazaar = await this.bazaarsService.findPublicById(bazaarId);

    if (!bazaar) {
      throw new NotFoundException({
        code: 'BAZAAR_NOT_FOUND',
        message: 'Bazaar not found or not published.',
      });
    }

    const layout =
      await this.boothsRepository.findPublicLayoutByBazaarId(bazaarId);

    if (!layout) {
      throw new NotFoundException({
        code: 'LAYOUT_NOT_FOUND',
        message: 'Layout not found for this bazaar.',
      });
    }

    // Map the shape
    const booths = layout.booths.map((booth: PublicBooth) => {
      let vendorInfo = null;

      if (booth.boothListing && booth.boothListing.vendor) {
        vendorInfo = {
          vendorId: booth.boothListing.vendor.id,
          businessName: booth.boothListing.vendor.name,
          logo: booth.boothListing.vendor.logo,
        };
      }

      return {
        id: booth.id,
        label: booth.label,
        positionX: booth.positionX,
        positionY: booth.positionY,
        width: booth.width,
        height: booth.height,
        vendor: vendorInfo,
      };
    });

    return {
      id: layout.id,
      bazaarId: layout.bazaarId,
      gridConfig: layout.gridConfig,
      booths,
    };
  }

  private audit(
    actorId: string,
    action: AdminAction,
    targetType: AdminTargetType,
    targetId: string,
  ): Promise<void> {
    return this.auditService.record({
      actorId,
      action,
      targetType,
      targetId,
    });
  }
}