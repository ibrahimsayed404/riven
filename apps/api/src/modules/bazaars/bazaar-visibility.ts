import { BazaarStatus, Prisma } from '@prisma/client';

/**
 * The one rule for "may a shopper see this bazaar" (specs/admin-module-spec3.md
 * B8b), mirroring PUBLIC_PRODUCT_WHERE for products: PUBLISHED, not deleted,
 * and its organizer verified and not deleted. The bazaar's own status is never
 * changed by an organizer reject — re-verifying makes it public again.
 */
export const PUBLIC_ORGANIZER_WHERE = { verified: true, deletedAt: null } satisfies Prisma.OrganizerWhereInput;

export const PUBLIC_BAZAAR_WHERE = {
  status: BazaarStatus.PUBLISHED,
  deletedAt: null,
  organizer: PUBLIC_ORGANIZER_WHERE,
} satisfies Prisma.BazaarWhereInput;

/**
 * Raw-SQL form of the organizer half, for the PostGIS queries on "bazaars".
 * A correlated EXISTS rather than a JOIN, so no selected column becomes ambiguous.
 */
export const PUBLIC_ORGANIZER_SQL = Prisma.sql`EXISTS (
  SELECT 1 FROM "organizers" o
  WHERE o."id" = "bazaars"."organizerId" AND o."verified" = true AND o."deletedAt" IS NULL
)`;
