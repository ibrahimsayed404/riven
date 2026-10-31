import { Injectable } from '@nestjs/common';
import { Barcode, BarcodeScope, BarcodeStatus, PackagingType, Prisma } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

export interface BarcodeEventInput {
  type: string;
  actorId: string;
  actorRole: 'VENDOR' | 'ADMIN';
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  reason?: string | null;
}

export interface NewBarcode {
  value: string;
  scope: BarcodeScope;
  vendorId: string;
  variantId: string;
  packagingType: PackagingType;
  unitsPerPackage: number;
  status: BarcodeStatus;
  source: 'RIVEN_GENERATED' | 'VENDOR_PROPOSED' | 'ADMIN_REGISTERED';
  proposedById?: string | null;
  decidedById?: string | null;
}

export type VariantOwnership = {
  id: string;
  deletedAt: Date | null;
  product: { vendorId: string; deletedAt: Date | null; isActive: boolean };
};

/** Every Prisma call of the barcode registry. Every change writes its BarcodeEvent in the same transaction. */
@Injectable()
export class BarcodesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findVendorIdByOwner(ownerId: string): Promise<{ id: string } | null> {
    return this.prisma.vendor.findFirst({ where: { ownerId, deletedAt: null }, select: { id: true } });
  }

  vendorExists(vendorId: string): Promise<{ id: string } | null> {
    return this.prisma.vendor.findFirst({ where: { id: vendorId, deletedAt: null }, select: { id: true } });
  }

  findVariantOwnership(variantId: string): Promise<VariantOwnership | null> {
    return this.prisma.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true, deletedAt: true, product: { select: { vendorId: true, deletedAt: true, isActive: true } } },
    });
  }

  /** Insert + its first event, atomically. A unique violation (P2002) means the value is taken. */
  create(data: NewBarcode, event: BarcodeEventInput): Promise<Barcode> {
    return this.prisma.$transaction(async (tx) => {
      const barcode = await tx.barcode.create({ data: { ...data, decidedAt: data.decidedById ? new Date() : null } });
      await tx.barcodeEvent.create({ data: { barcodeId: barcode.id, ...event, after: event.after ?? snapshot(barcode) } });
      return barcode;
    });
  }

  findById(id: string) {
    return this.prisma.barcode.findUnique({ where: { id } });
  }

  findByIdWithHistory(id: string) {
    return this.prisma.barcode.findUnique({
      where: { id },
      include: { events: { orderBy: { createdAt: 'asc' } }, variant: { select: { id: true, sku: true, productId: true } } },
    });
  }

  async list(filter: { vendorId?: string; variantId?: string; status?: BarcodeStatus; value?: string; scope?: BarcodeScope; page: number; limit: number }) {
    const where: Prisma.BarcodeWhereInput = {};
    if (filter.scope) where.scope = filter.scope;
    if (filter.vendorId) where.vendorId = filter.vendorId;
    if (filter.variantId) where.variantId = filter.variantId;
    if (filter.status) where.status = filter.status;
    if (filter.value) where.value = filter.value;
    const [total, data] = await this.prisma.$transaction([
      this.prisma.barcode.count({ where }),
      this.prisma.barcode.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.limit,
        take: filter.limit,
      }),
    ]);
    return { data, total };
  }

  /**
   * Guarded status change + event in one transaction. Returns null when the row
   * was not in `from` (someone else decided first, or it never was).
   */
  transition(
    id: string,
    from: BarcodeStatus[],
    to: BarcodeStatus,
    data: Prisma.BarcodeUpdateManyMutationInput,
    event: BarcodeEventInput,
  ): Promise<Barcode | null> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.barcode.findUnique({ where: { id } });
      const moved = await tx.barcode.updateMany({ where: { id, status: { in: from } }, data: { ...data, status: to } });
      if (moved.count !== 1 || !before) return null;
      const after = await tx.barcode.findUniqueOrThrow({ where: { id } });
      await tx.barcodeEvent.create({ data: { barcodeId: id, ...event, before: snapshot(before), after: snapshot(after) } });
      return after;
    });
  }

  /** Conversion change: guarded on the version the caller saw, bumps configVersion, records before / after. */
  changeConversion(id: string, expectedVersion: number, unitsPerPackage: number, event: BarcodeEventInput): Promise<Barcode | null> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.barcode.findUnique({ where: { id } });
      const moved = await tx.barcode.updateMany({
        where: { id, configVersion: expectedVersion, status: { not: BarcodeStatus.REJECTED } },
        data: { unitsPerPackage, configVersion: { increment: 1 } },
      });
      if (moved.count !== 1 || !before) return null;
      const after = await tx.barcode.findUniqueOrThrow({ where: { id } });
      await tx.barcodeEvent.create({ data: { barcodeId: id, ...event, before: snapshot(before), after: snapshot(after) } });
      return after;
    });
  }

  /** Candidates for resolution (§F.2): internal by value, or the vendor's own, in any non-rejected status. */
  findCandidates(value: string, vendorId: string) {
    return this.prisma.barcode.findMany({
      where: {
        value,
        status: { not: BarcodeStatus.REJECTED },
        OR: [{ scope: BarcodeScope.INTERNAL }, { scope: BarcodeScope.VENDOR, vendorId }],
      },
      include: { variant: { select: { id: true, sku: true, deletedAt: true, product: { select: { id: true, vendorId: true, deletedAt: true, isActive: true } } } } },
    });
  }

  /** Is the value registered as a vendor barcode of some OTHER vendor? (distinguishes VENDOR_MISMATCH from UNKNOWN) */
  async existsForOtherVendor(value: string, vendorId: string): Promise<boolean> {
    const count = await this.prisma.barcode.count({
      where: { value, scope: BarcodeScope.VENDOR, vendorId: { not: vendorId }, status: { not: BarcodeStatus.REJECTED } },
    });
    return count > 0;
  }
}

function snapshot(b: Barcode): Prisma.InputJsonValue {
  return {
    value: b.value,
    scope: b.scope,
    vendorId: b.vendorId,
    variantId: b.variantId,
    packagingType: b.packagingType,
    unitsPerPackage: b.unitsPerPackage,
    status: b.status,
    configVersion: b.configVersion,
  };
}
