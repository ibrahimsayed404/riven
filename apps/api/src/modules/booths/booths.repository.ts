import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { Prisma, BoothLayout, Booth, BoothListing } from '@prisma/client';

export interface PublicBooth extends Booth {
  boothListing: (BoothListing & {
    vendor: {
      id: string;
      name: string;
      logo: string | null;
    };
  }) | null;
}

export interface PublicBoothLayout extends BoothLayout {
  booths: PublicBooth[];
}

@Injectable()
export class BoothsRepository {
  constructor(private readonly prisma: PrismaService) {}

  createLayout(bazaarId: string, gridConfig: Prisma.InputJsonValue): Promise<BoothLayout> {
    return this.prisma.boothLayout.create({
      data: {
        bazaarId,
        gridConfig,
      },
    });
  }

  findLayoutByBazaarId(bazaarId: string): Promise<(BoothLayout & { booths: Booth[] }) | null> {
    return this.prisma.boothLayout.findUnique({
      where: { bazaarId },
      include: {
        booths: true,
      },
    });
  }

  updateLayoutGridConfig(bazaarId: string, gridConfig: Prisma.InputJsonValue): Promise<BoothLayout> {
    return this.prisma.boothLayout.update({
      where: { bazaarId },
      data: { gridConfig },
    });
  }

  createBooth(
    layoutId: string,
    label: string,
    positionX: number,
    positionY: number,
    width: number,
    height: number,
  ): Promise<Booth> {
    return this.prisma.booth.create({
      data: {
        layoutId,
        label,
        positionX,
        positionY,
        width,
        height,
      },
    });
  }

  findBoothById(id: string): Promise<Booth | null> {
    return this.prisma.booth.findUnique({
      where: { id },
    });
  }

  updateBooth(
    id: string,
    data: Partial<Pick<Booth, 'label' | 'positionX' | 'positionY' | 'width' | 'height'>>,
  ): Promise<Booth> {
    return this.prisma.booth.update({
      where: { id },
      data,
    });
  }

  deleteBooth(id: string): Promise<Booth> {
    return this.prisma.booth.delete({
      where: { id },
    });
  }

  assignBooth(id: string, boothListingId: string): Promise<Booth> {
    return this.prisma.booth.update({
      where: { id },
      data: { boothListingId },
    });
  }

  unassignBooth(id: string): Promise<Booth> {
    return this.prisma.booth.update({
      where: { id },
      data: { boothListingId: null },
    });
  }

  async findPublicLayoutByBazaarId(bazaarId: string): Promise<PublicBoothLayout | null> {
    const layout = await this.prisma.boothLayout.findUnique({
      where: { bazaarId },
      include: {
        booths: {
          include: {
            boothListing: {
              include: {
                vendor: {
                  select: {
                    id: true,
                    name: true,
                    logo: true,
                    verified: true,
                    deletedAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!layout) return null;

    // A booth stays occupied, but a revoked or self-deleted vendor is not shown
    // to shoppers — same rule as every other public read.
    return {
      ...layout,
      booths: layout.booths.map(({ boothListing, ...booth }) => {
        if (!boothListing) return { ...booth, boothListing: null };
        const { verified, deletedAt, ...vendor } = boothListing.vendor;
        return {
          ...booth,
          boothListing: verified && !deletedAt ? { ...boothListing, vendor } : null,
        };
      }),
    };
  }
}
