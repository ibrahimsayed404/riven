import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { BoothsRepository, PublicBooth } from './booths.repository';
import { BazaarsService } from '../bazaars/bazaars.service';
import { Prisma, ApplicationStatus } from '@prisma/client';

@Injectable()
export class BoothsService {
  constructor(
    private readonly boothsRepository: BoothsRepository,
    private readonly bazaarsService: BazaarsService,
  ) {}

  async createLayout(bazaarId: string, gridConfig: Prisma.InputJsonValue) {
    const bazaar = await this.bazaarsService.findById(bazaarId);
    if (!bazaar) {
      throw new NotFoundException({ code: 'BAZAAR_NOT_FOUND', message: 'Bazaar not found.' });
    }

    try {
      return await this.boothsRepository.createLayout(bazaarId, gridConfig);
    } catch (error: any) {
      if (error.code === 'P2002' && (error.meta?.target as string[])?.includes('bazaarId')) {
        throw new ConflictException({ code: 'LAYOUT_EXISTS', message: 'Layout already exists for this bazaar.' });
      }
      throw error;
    }
  }

  async getLayout(bazaarId: string) {
    const layout = await this.boothsRepository.findLayoutByBazaarId(bazaarId);
    if (!layout) {
      throw new NotFoundException({ code: 'LAYOUT_NOT_FOUND', message: 'Layout not found.' });
    }
    return layout;
  }

  async updateLayout(bazaarId: string, gridConfig: Prisma.InputJsonValue) {
    const layout = await this.boothsRepository.findLayoutByBazaarId(bazaarId);
    if (!layout) {
      throw new NotFoundException({ code: 'LAYOUT_NOT_FOUND', message: 'Layout not found.' });
    }

    return this.boothsRepository.updateLayoutGridConfig(bazaarId, gridConfig);
  }

  async createBooth(
    bazaarId: string,
    data: { label: string; positionX: number; positionY: number; width: number; height: number },
  ) {
    const layout = await this.boothsRepository.findLayoutByBazaarId(bazaarId);
    if (!layout) {
      throw new NotFoundException({ code: 'LAYOUT_NOT_FOUND', message: 'Layout not found for this bazaar.' });
    }

    try {
      return await this.boothsRepository.createBooth(
        layout.id,
        data.label,
        data.positionX,
        data.positionY,
        data.width,
        data.height,
      );
    } catch (error: any) {
      if (error.code === 'P2002' && (error.meta?.target as string[])?.includes('label')) {
        throw new ConflictException({ code: 'BOOTH_LABEL_TAKEN', message: 'A booth with this label already exists in this layout.' });
      }
      throw error;
    }
  }

  async updateBooth(
    id: string,
    data: { label?: string; positionX?: number; positionY?: number; width?: number; height?: number },
  ) {
    const booth = await this.boothsRepository.findBoothById(id);
    if (!booth) {
      throw new NotFoundException({ code: 'BOOTH_NOT_FOUND', message: 'Booth not found.' });
    }

    try {
      return await this.boothsRepository.updateBooth(id, data);
    } catch (error: any) {
      if (error.code === 'P2002' && (error.meta?.target as string[])?.includes('label')) {
        throw new ConflictException({ code: 'BOOTH_LABEL_TAKEN', message: 'A booth with this label already exists in this layout.' });
      }
      throw error;
    }
  }

  async deleteBooth(id: string) {
    const booth = await this.boothsRepository.findBoothById(id);
    if (!booth) {
      throw new NotFoundException({ code: 'BOOTH_NOT_FOUND', message: 'Booth not found.' });
    }

    if (booth.boothListingId !== null) {
      throw new BadRequestException({ code: 'BOOTH_ASSIGNED', message: 'Unassign the vendor before deleting this booth.' });
    }

    return this.boothsRepository.deleteBooth(id);
  }

  async assignBooth(id: string, boothListingId: string) {
    const booth = await this.boothsRepository.findBoothById(id);
    if (!booth) {
      throw new NotFoundException({ code: 'BOOTH_NOT_FOUND', message: 'Booth not found.' });
    }

    if (booth.boothListingId !== null) {
      throw new BadRequestException({ code: 'BOOTH_ASSIGNED', message: 'Booth already has a vendor assigned — unassign first.' });
    }

    const application = await this.bazaarsService.findApplicationById(boothListingId);
    if (!application) {
      throw new NotFoundException({ code: 'APPLICATION_NOT_FOUND', message: 'Booth listing application not found.' });
    }

    if (application.applicationStatus !== ApplicationStatus.ACCEPTED) {
      throw new BadRequestException({ code: 'APPLICATION_NOT_ACCEPTED', message: 'Application is not accepted.' });
    }

    // Need the layout to verify bazaarId
    // Actually we can get bazaarId from the layout, but the Booth doesn't have it directly.
    // Let's get the layout.
    const layout = await this.boothsRepository.findLayoutByBazaarId(application.bazaarId);
    if (!layout || layout.id !== booth.layoutId) {
      throw new BadRequestException("Vendor's application belongs to a different bazaar.");
    }

    try {
      return await this.boothsRepository.assignBooth(id, boothListingId);
    } catch (error: any) {
      if (error.code === 'P2002' && (error.meta?.target as string[])?.includes('boothListingId')) {
        throw new ConflictException({ code: 'APPLICATION_ALREADY_ASSIGNED', message: 'This vendor application is already assigned to another booth.' });
      }
      throw error;
    }
  }

  async unassignBooth(id: string) {
    const booth = await this.boothsRepository.findBoothById(id);
    if (!booth) {
      throw new NotFoundException({ code: 'BOOTH_NOT_FOUND', message: 'Booth not found.' });
    }

    if (booth.boothListingId === null) {
      return booth; // Idempotent
    }

    return this.boothsRepository.unassignBooth(id);
  }

  async getPublicLayout(bazaarId: string) {
    // Only succeeds if the bazaar is status: PUBLISHED and deletedAt: null
    const bazaar = await this.bazaarsService.findPublicById(bazaarId);
    if (!bazaar) {
      throw new NotFoundException({ code: 'BAZAAR_NOT_FOUND', message: 'Bazaar not found or not published.' });
    }

    const layout = await this.boothsRepository.findPublicLayoutByBazaarId(bazaarId);
    if (!layout) {
      throw new NotFoundException({ code: 'LAYOUT_NOT_FOUND', message: 'Layout not found for this bazaar.' });
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
}
