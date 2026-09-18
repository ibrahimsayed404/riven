/**
 * Documents as stored in Meilisearch. These are the *only* fields that reach
 * the index — an explicit allowlist mirroring what the public endpoints already
 * expose (same approach as DiscoveredBazaar in discovery.service.ts). Internal
 * fields (ownerId, subscriptionStatus, approvalStatus, status, rejectionReason,
 * deletedAt, timestamps, variant sku/stock) are deliberately absent.
 *
 * Built by the owning module's getSearchDocument(id); consumed by the search
 * module. Kept in infra so neither side has to import the other for the type.
 */

export type GeoPoint = { lat: number; lng: number };

export type ProductSearchDocument = {
  id: string;
  vendorId: string;
  vendorName: string;
  title: string;
  description: string;
  categoryId: string;
  categorySlug: string;
  /** Slugs from the root category down to the product's own category. */
  categoryPath: string[];
  basePrice: number;
  /** min / max of (variant.priceOverride ?? basePrice); both = basePrice when there are no variants. */
  minPrice: number;
  maxPrice: number;
  image: string | null;
  sizes: string[];
  colors: string[];
};

export type VendorSearchDocument = {
  id: string;
  name: string;
  category: string;
  description: string | null;
  brandStory: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  vendorType: 'BAZAAR_ONLY' | 'MARKETPLACE' | 'BOTH';
  hasFixedLocation: boolean;
  /** Absent (not null) when the vendor has no homeLocation, so _geoRadius excludes it. */
  _geo?: GeoPoint;
};

export type BazaarSearchDocument = {
  id: string;
  organizerId: string;
  name: string;
  description: string | null;
  coverMedia: string[];
  scheduleType: 'ONE_OFF' | 'RECURRING';
  recurrenceRule: string | null;
  /** Unix seconds — Meilisearch filters and sorts numbers, not ISO strings. */
  startDate: number;
  endDate: number | null;
  _geo: GeoPoint;
};

export type SearchDocument = ProductSearchDocument | VendorSearchDocument | BazaarSearchDocument;

/** Prisma Decimal → JSON number with 2 dp, the only price representation the index sees. */
export function toPriceNumber(value: { toFixed(dp: number): string }): number {
  return Number(value.toFixed(2));
}

export function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
