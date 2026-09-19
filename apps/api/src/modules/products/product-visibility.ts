import { Prisma } from '@prisma/client';

/**
 * A product a shopper may see: active, approved, not deleted, and its vendor
 * verified and not deleted. Every public read, cart add and checkout check
 * uses this one object so they cannot drift apart (fix.js LOGIC-04, ARCH-02).
 */
export const PUBLIC_PRODUCT_WHERE = {
  isActive: true,
  approvalStatus: 'APPROVED',
  deletedAt: null,
  vendor: { verified: true, deletedAt: null },
} satisfies Prisma.ProductWhereInput;

/** Variants are soft-deleted (fix.js LOGIC-03); public reads see only live ones. */
export const ACTIVE_VARIANT_WHERE = { deletedAt: null } satisfies Prisma.ProductVariantWhereInput;

/** What a shopper gets to see of a variant — no internal bookkeeping. */
export const PUBLIC_VARIANT_SELECT = {
  id: true,
  sku: true,
  size: true,
  color: true,
  priceOverride: true,
  stockQuantity: true,
} satisfies Prisma.ProductVariantSelect;

/** What a shopper gets to see of a product (fix.js VULN-03). */
export const PUBLIC_PRODUCT_SELECT = {
  id: true,
  vendorId: true,
  title: true,
  description: true,
  categoryId: true,
  basePrice: true,
  images: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;
