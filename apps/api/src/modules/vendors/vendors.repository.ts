import { Injectable } from '@nestjs/common';
import { Prisma, Product, ProductVariant } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { ACTIVE_VARIANT_WHERE } from '../products/product-visibility';

const vendorProfileSelect = {
  id: true,
  ownerId: true,
  name: true,
  category: true,
  description: true,
  logo: true,
  coverMedia: true,
  hasFixedLocation: true,
  verified: true,
  rejectionReason: true,
  subscriptionStatus: true,
  vendorType: true,
  brandStory: true,
  logoUrl: true,
  bannerUrl: true,
  returnPolicy: true,
  shippingPolicy: true,
} satisfies Prisma.VendorSelect;

export type VendorProfile = Prisma.VendorGetPayload<{ select: typeof vendorProfileSelect }>;

// The storefront a shopper sees. Deliberately not derived from the profile
// select: no ownerId, subscriptionStatus, rejectionReason (fix.js VULN-03).
const vendorPublicSelect = {
  id: true,
  name: true,
  category: true,
  description: true,
  logo: true,
  coverMedia: true,
  hasFixedLocation: true,
  vendorType: true,
  brandStory: true,
  logoUrl: true,
  bannerUrl: true,
  returnPolicy: true,
  shippingPolicy: true,
  createdAt: true,
} satisfies Prisma.VendorSelect;

export type VendorPublic = Prisma.VendorGetPayload<{ select: typeof vendorPublicSelect }>;

// Only what the search index is allowed to see — see VendorSearchDocument.
const vendorForSearchSelect = {
  id: true,
  name: true,
  category: true,
  description: true,
  brandStory: true,
  logoUrl: true,
  bannerUrl: true,
  vendorType: true,
  hasFixedLocation: true,
} satisfies Prisma.VendorSelect;

export type VendorForSearch = Prisma.VendorGetPayload<{ select: typeof vendorForSearchSelect }>;

// Admin queue row. Includes ownerId and the owner's email on purpose — this
// shape is for /admin/* only and must never be returned from a public route.
const adminVendorRowSelect = {
  id: true,
  ownerId: true,
  name: true,
  category: true,
  vendorType: true,
  verified: true,
  rejectionReason: true,
  subscriptionStatus: true,
  createdAt: true,
  owner: { select: { id: true, name: true, email: true } },
} satisfies Prisma.VendorSelect;

export type AdminVendorRow = Prisma.VendorGetPayload<{ select: typeof adminVendorRowSelect }>;

/** pending = unverified with no reason; rejected = unverified with a reason. */
export type VendorModerationStatus = 'pending' | 'verified' | 'rejected';

export const VENDOR_MODERATION_STATUSES: readonly VendorModerationStatus[] = ['pending', 'verified', 'rejected'];

export interface VendorModerationState {
  id: string;
  verified: boolean;
  rejectionReason: string | null;
  deletedAt: Date | null;
}

function moderationStatusWhere(status: VendorModerationStatus): Prisma.VendorWhereInput {
  switch (status) {
    case 'pending':
      return { verified: false, rejectionReason: null };
    case 'verified':
      return { verified: true };
    case 'rejected':
      return { verified: false, rejectionReason: { not: null } };
  }
}

/** A batch of ids for keyset iteration (reindex). */
export type IdPage = { ids: string[]; nextCursor: string | null };

@Injectable()
export class VendorsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByOwnerId(ownerId: string): Promise<VendorProfile | null> {
    return this.prisma.vendor.findUnique({
      where: { ownerId },
      select: vendorProfileSelect,
    });
  }

  findById(id: string): Promise<VendorProfile | null> {
    return this.prisma.vendor.findUnique({
      where: { id },
      select: vendorProfileSelect,
    });
  }

  /** Soft-deletes the vendor owned by this user, if any. Returns the vendor id or null. */
  async softDeleteByOwner(ownerId: string): Promise<string | null> {
    const vendor = await this.prisma.vendor.findFirst({ where: { ownerId, deletedAt: null }, select: { id: true } });
    if (!vendor) return null;
    await this.prisma.vendor.update({ where: { id: vendor.id }, data: { deletedAt: new Date() } });
    return vendor.id;
  }

  /** Storefront read: verified and not soft-deleted, else null. */
  findPublicById(id: string): Promise<VendorPublic | null> {
    return this.prisma.vendor.findFirst({
      where: { id, verified: true, deletedAt: null },
      select: vendorPublicSelect,
    });
  }

  update(id: string, data: Prisma.VendorUpdateInput): Promise<VendorProfile> {
    return this.prisma.vendor.update({
      where: { id },
      data,
      select: vendorProfileSelect,
    });
  }

  async updateLocation(vendorId: string, lat: number, lng: number): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "vendors"
      SET "homeLocation" = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      WHERE "id" = ${vendorId}
    `;
  }

  async findVendorLocation(id: string): Promise<{ lat: number; lng: number } | null> {
    const result = await this.prisma.$queryRaw<{ lat: number; lng: number }[]>`
      SELECT
        ST_Y("homeLocation"::geometry) AS "lat",
        ST_X("homeLocation"::geometry) AS "lng"
      FROM "vendors"
      WHERE "id" = ${id} AND "homeLocation" IS NOT NULL
    `;

    return result.length > 0 ? { lat: result[0].lat, lng: result[0].lng } : null;
  }

  // --- Admin moderation ---

  /** Minimal state for a verify/reject decision. Unlike findById this exposes deletedAt. */
  findModerationState(id: string): Promise<VendorModerationState | null> {
    return this.prisma.vendor.findUnique({
      where: { id },
      select: { id: true, verified: true, rejectionReason: true, deletedAt: true },
    });
  }

  async findManyForAdmin(params: {
    status?: VendorModerationStatus;
    search?: string;
    page: number;
    limit: number;
  }): Promise<{ data: AdminVendorRow[]; total: number }> {
    const where: Prisma.VendorWhereInput = {
      deletedAt: null,
      ...(params.status ? moderationStatusWhere(params.status) : {}),
    };
    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { owner: { email: { contains: params.search, mode: 'insensitive' } } },
      ];
    }

    return this.prisma.$transaction(async (tx) => {
      const total = await tx.vendor.count({ where });
      const data = await tx.vendor.findMany({
        where,
        select: adminVendorRowSelect,
        orderBy: { createdAt: 'asc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      });
      return { data, total };
    });
  }

  /** Overview tile: vendors awaiting a first decision. */
  countPendingForAdmin(): Promise<number> {
    return this.prisma.vendor.count({ where: { verified: false, rejectionReason: null, deletedAt: null } });
  }

  /** Public-visibility read for the search index: verified and not soft-deleted, else null. */
  findForSearch(id: string): Promise<VendorForSearch | null> {
    return this.prisma.vendor.findFirst({
      where: { id, verified: true, deletedAt: null },
      select: vendorForSearchSelect,
    });
  }

  async listPublicIds(cursor: string | null, take: number): Promise<IdPage> {
    const where: Prisma.VendorWhereInput = { verified: true, deletedAt: null };
    const rows = await this.prisma.vendor.findMany({
      where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const ids = rows.slice(0, take).map((row) => row.id);
    return { ids, nextCursor: hasMore ? ids[ids.length - 1] : null };
  }

  // --- Product Methods ---

  createProduct(vendorId: string, data: Prisma.ProductUncheckedCreateWithoutVendorInput): Promise<Product> {
    return this.prisma.product.create({
      data: {
        ...data,
        vendorId,
      },
    });
  }

  // "All statuses" means every approvalStatus — not deleted rows. A deleted
  // product must not be editable or re-submitted for approval (fix.js LOGIC-02).
  findProductByIdAndVendor(productId: string, vendorId: string): Promise<(Product & { variants: ProductVariant[] }) | null> {
    return this.prisma.product.findFirst({
      where: {
        id: productId,
        vendorId,
        deletedAt: null,
      },
      include: {
        variants: { where: ACTIVE_VARIANT_WHERE },
      },
    });
  }

  findProductsPaginated(vendorId: string, page: number, limit: number): Promise<{ data: Product[]; total: number }> {
    const where: Prisma.ProductWhereInput = { vendorId, deletedAt: null };
    return this.prisma.$transaction(async (tx) => {
      const total = await tx.product.count({ where });
      const data = await tx.product.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      });
      return { data, total };
    });
  }

  updateProduct(productId: string, data: Prisma.ProductUpdateInput): Promise<Product> {
    return this.prisma.product.update({
      where: { id: productId },
      data,
    });
  }

  softDeleteProduct(productId: string): Promise<Product> {
    return this.prisma.product.update({
      where: { id: productId },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  // --- Product Variant Methods ---

  createProductVariant(productId: string, data: Omit<Prisma.ProductVariantUncheckedCreateInput, 'productId'>): Promise<ProductVariant> {
    return this.prisma.productVariant.create({
      data: {
        ...data,
        productId,
      },
    });
  }

  updateProductVariant(variantId: string, data: Prisma.ProductVariantUpdateInput): Promise<ProductVariant> {
    return this.prisma.productVariant.update({
      where: { id: variantId },
      data,
    });
  }

  /** Soft delete: cart_items and order_items reference variants with RESTRICT (fix.js LOGIC-03). */
  deleteProductVariant(variantId: string): Promise<ProductVariant> {
    return this.prisma.productVariant.update({
      where: { id: variantId },
      data: { deletedAt: new Date() },
    });
  }
}
