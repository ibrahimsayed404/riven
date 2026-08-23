import { Injectable } from '@nestjs/common';
import { Prisma, Vendor, Product, ProductVariant } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

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
  subscriptionStatus: true,
  vendorType: true,
  brandStory: true,
  logoUrl: true,
  bannerUrl: true,
  returnPolicy: true,
  shippingPolicy: true,
} satisfies Prisma.VendorSelect;

export type VendorProfile = Prisma.VendorGetPayload<{ select: typeof vendorProfileSelect }>;

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

  // --- Product Methods ---

  createProduct(vendorId: string, data: Prisma.ProductUncheckedCreateWithoutVendorInput): Promise<Product> {
    return this.prisma.product.create({
      data: {
        ...data,
        vendorId,
      },
    });
  }

  findProductByIdAndVendor(productId: string, vendorId: string): Promise<(Product & { variants: ProductVariant[] }) | null> {
    return this.prisma.product.findFirst({
      where: {
        id: productId,
        vendorId,
        // deletedAt: null // Assuming soft delete via deletedAt? Wait, the spec says: "DELETE /vendors/me/products/:id — soft-delete (deletedAt)." But we should include deleted items if needed or just filter? Spec says "GET /vendors/me/products — paginated, all statuses". I should just return it.
      },
      include: {
        variants: true,
      }
    });
  }

  findProductsPaginated(vendorId: string, page: number, limit: number): Promise<{ data: Product[]; total: number }> {
    const where: Prisma.ProductWhereInput = { vendorId };
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

  deleteProductVariant(variantId: string): Promise<ProductVariant> {
    return this.prisma.productVariant.delete({
      where: { id: variantId },
    });
  }
}
