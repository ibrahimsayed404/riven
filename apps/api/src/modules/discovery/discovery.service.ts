import { BadRequestException, Injectable } from '@nestjs/common';
import { FavorableType, ScheduleType } from '@prisma/client';

import { BazaarsService } from '../bazaars/bazaars.service';
import { SocialService } from '../social/social.service';
import { DiscoverBazaarsQueryDto } from './dto/discover-bazaars-query.dto';

/**
 * Explicit allowlist of the fields a public feed may expose. Deliberately drops
 * status, deletedAt, createdAt and updatedAt: they are internal, and every row
 * here is PUBLISHED and undeleted by construction anyway.
 */
export type DiscoveredBazaar = {
  id: string;
  organizerId: string;
  name: string;
  description: string | null;
  coverMedia: string[];
  scheduleType: ScheduleType;
  recurrenceRule: string | null;
  startDate: Date;
  endDate: Date | null;
  location: { lat: number; lng: number } | null;
  distanceMeters: number | null;
  distanceKm: number | null;
  isFavorite: boolean;
};

type Cursor = { sortValue: number | Date; id: string };

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly bazaarsService: BazaarsService,
    private readonly socialService: SocialService,
  ) {}

  async discoverBazaars(
    query: DiscoverBazaarsQueryDto,
    userId?: string | null,
  ): Promise<{ data: DiscoveredBazaar[]; nextCursor: string | null }> {
    // The DTO supplies these defaults, but re-defaulting keeps the service
    // callable from tests without constructing a validated DTO instance.
    const limit = query.limit ?? 20;
    const radiusKm = query.radiusKm ?? 25;
    const upcomingOnly = query.upcomingOnly ?? true;

    const sortedByDistance = query.lat !== undefined && query.lng !== undefined;
    const cursor = query.cursor ? this.decodeCursor(query.cursor, sortedByDistance) : undefined;

    const { data, hasMore } = await this.bazaarsService.findNearby(
      {
        lat: query.lat,
        lng: query.lng,
        radiusKm,
        scheduleType: query.scheduleType,
        upcomingOnly,
      },
      limit,
      cursor,
    );

    let favoriteIds = new Set<string>();
    if (userId && data.length > 0) {
      favoriteIds = await this.socialService.batchCheckFavorites(
        userId,
        FavorableType.BAZAAR,
        data.map((bazaar) => bazaar.id),
      );
    }

    const bazaars: DiscoveredBazaar[] = data.map((bazaar) => ({
      id: bazaar.id,
      organizerId: bazaar.organizerId,
      name: bazaar.name,
      description: bazaar.description,
      coverMedia: bazaar.coverMedia,
      scheduleType: bazaar.scheduleType,
      recurrenceRule: bazaar.recurrenceRule,
      startDate: bazaar.startDate,
      endDate: bazaar.endDate,
      location: bazaar.location,
      distanceMeters: bazaar.distanceMeters,
      distanceKm:
        bazaar.distanceMeters === null
          ? null
          : Number((bazaar.distanceMeters / 1000).toFixed(2)),
      isFavorite: favoriteIds.has(bazaar.id),
    }));

    let nextCursor: string | null = null;
    if (hasMore && bazaars.length > 0) {
      const last = bazaars[bazaars.length - 1];
      const sortValue = sortedByDistance ? last.distanceMeters : last.startDate;
      if (sortValue !== null) {
        nextCursor = this.encodeCursor(sortValue, last.id);
      }
    }

    return { data: bazaars, nextCursor };
  }

  private encodeCursor(sortValue: number | Date, id: string): string {
    const s = sortValue instanceof Date ? sortValue.toISOString() : sortValue;
    return Buffer.from(JSON.stringify({ s, id }), 'utf8').toString('base64url');
  }

  /**
   * base64url rather than plain base64: an unescaped '+' in a query string
   * decodes to a space, which corrupts the cursor without raising anything.
   */
  private decodeCursor(raw: string, expectsDistance: boolean): Cursor {
    let parsed: unknown;

    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      throw this.invalidCursor();
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw this.invalidCursor();
    }

    const { s, id } = parsed as { s?: unknown; id?: unknown };

    if (typeof id !== 'string' || id.length === 0) {
      throw this.invalidCursor();
    }

    if (expectsDistance) {
      if (typeof s !== 'number' || !Number.isFinite(s)) {
        throw this.invalidCursor();
      }
      return { sortValue: s, id };
    }

    // A numeric cursor with no lat/lng means the client dropped its coordinates
    // mid-pagination: the sort key changed underneath it, so the cursor is stale.
    if (typeof s !== 'string') {
      throw this.invalidCursor();
    }

    const date = new Date(s);
    if (Number.isNaN(date.getTime())) {
      throw this.invalidCursor();
    }

    return { sortValue: date, id };
  }

  private invalidCursor(): BadRequestException {
    return new BadRequestException({
      code: 'INVALID_CURSOR',
      message: 'Malformed pagination cursor.',
    });
  }
}
