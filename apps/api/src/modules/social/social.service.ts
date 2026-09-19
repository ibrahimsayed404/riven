import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FavorableType, FollowableType } from '@prisma/client';

import { BazaarsService } from '../bazaars/bazaars.service';
import { OrdersService } from '../orders/orders.service';
import { ProductsService } from '../products/products.service';
import { VendorsService } from '../vendors/vendors.service';
import {
  CreateFavoriteDto,
  DeleteFavoriteDto,
  GetFavoritesQueryDto,
  CreateFollowDto,
  DeleteFollowDto,
  GetFollowsQueryDto,
  CreateRatingDto,
  GetRatingSummaryQueryDto,
  GetRatingsQueryDto,
} from './dto';
import { KeysetPage, SocialRepository } from './social.repository';

type Cursor = { s: string; id: string };

/** Anything a shopper can follow or favorite. EVENT exists in the enum but has no module yet. */
type PublicTargetType = FavorableType | FollowableType;

@Injectable()
export class SocialService {
  constructor(
    private readonly socialRepository: SocialRepository,
    private readonly ordersService: OrdersService,
    private readonly vendorsService: VendorsService,
    private readonly bazaarsService: BazaarsService,
    private readonly productsService: ProductsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Favorites
  // ---------------------------------------------------------------------------

  async addFavorite(userId: string, dto: CreateFavoriteDto) {
    await this.assertPublicTarget(dto.favorableType, dto.favorableId);
    return this.socialRepository.upsertFavorite(userId, dto.favorableType, dto.favorableId);
  }

  async removeFavorite(userId: string, dto: DeleteFavoriteDto) {
    await this.socialRepository.deleteFavorite(userId, dto.favorableType, dto.favorableId);
    return { success: true };
  }

  async getFavorites(userId: string, query: GetFavoritesQueryDto) {
    const limit = query.limit ?? 20;
    const items = await this.socialRepository.findFavorites(userId, query.favorableType, this.page(limit, query.cursor));
    return this.paginate(items, limit);
  }

  async batchCheckFavorites(
    userId: string,
    favorableType: FavorableType,
    favorableIds: string[],
  ): Promise<Set<string>> {
    if (!favorableIds.length) {
      return new Set<string>();
    }
    return new Set(await this.socialRepository.findFavoriteIds(userId, favorableType, favorableIds));
  }

  // ---------------------------------------------------------------------------
  // Follows
  // ---------------------------------------------------------------------------

  async addFollow(userId: string, dto: CreateFollowDto) {
    await this.assertPublicTarget(dto.followableType, dto.followableId);
    return this.socialRepository.upsertFollow(userId, dto.followableType, dto.followableId);
  }

  async removeFollow(userId: string, dto: DeleteFollowDto) {
    await this.socialRepository.deleteFollow(userId, dto.followableType, dto.followableId);
    return { success: true };
  }

  async getFollows(userId: string, query: GetFollowsQueryDto) {
    const limit = query.limit ?? 20;
    const items = await this.socialRepository.findFollows(userId, query.followableType, this.page(limit, query.cursor));
    return this.paginate(items, limit);
  }

  // ---------------------------------------------------------------------------
  // Ratings
  // ---------------------------------------------------------------------------

  /**
   * Two gates (fix.js SPEC-03):
   *  - VENDOR / PRODUCT: a DELIVERED order of this shopper containing the target.
   *  - BAZAAR: the bazaar has run (PUBLISHED or COMPLETED); no order — attendance
   *    is not something the platform can verify, and riven-spec §8 wants bazaars rateable.
   *  - EVENT: blocked until an events module exists.
   */
  async addRating(userId: string, dto: CreateRatingDto) {
    const orderId = await this.assertRatingAllowed(userId, dto);

    return this.socialRepository.upsertRating({
      userId,
      targetType: dto.targetType,
      targetId: dto.targetId,
      score: dto.score,
      comment: dto.comment ?? null,
      orderId,
    });
  }

  private async assertRatingAllowed(userId: string, dto: CreateRatingDto): Promise<string | null> {
    switch (dto.targetType) {
      case 'BAZAAR': {
        if (!(await this.bazaarsService.isRateable(dto.targetId))) {
          throw new NotFoundException({ code: 'BAZAAR_NOT_FOUND', message: 'Bazaar not found or not yet published.' });
        }
        return null;
      }
      case 'EVENT':
        throw new NotFoundException({ code: 'TARGET_NOT_FOUND', message: 'Events are not available yet.' });
      case 'VENDOR':
      case 'PRODUCT': {
        if (!dto.orderId) {
          throw new BadRequestException({
            code: 'ORDER_ID_REQUIRED',
            message: 'Rating a vendor or product requires the delivered order it was bought in.',
          });
        }
        const isVerified = await this.ordersService.verifyDeliveredPurchase(userId, dto.orderId, dto.targetType, dto.targetId);
        if (!isVerified) {
          throw new ForbiddenException({
            code: 'NOT_VERIFIED_PURCHASE',
            message: 'Rating requires a verified delivered purchase for this target.',
          });
        }
        return dto.orderId;
      }
    }
  }

  async getRatingSummary(query: GetRatingSummaryQueryDto) {
    const { average, count } = await this.socialRepository.aggregateRatings(query.targetType, query.targetId);
    return {
      average: average !== null ? Number(average.toFixed(2)) : 0,
      count,
    };
  }

  async getRatings(query: GetRatingsQueryDto) {
    const limit = query.limit ?? 20;
    const items = await this.socialRepository.findRatings(query.targetType, query.targetId, this.page(limit, query.cursor));
    const { data, nextCursor } = this.paginate(items, limit);

    return {
      data: data.map((item) => ({
        id: item.id,
        targetType: item.targetType,
        targetId: item.targetId,
        score: item.score,
        comment: item.comment,
        createdAt: item.createdAt,
        reviewerName: item.user.name,
      })),
      nextCursor,
    };
  }

  // ---------------------------------------------------------------------------
  // Target existence (fix.js VULN-04)
  // ---------------------------------------------------------------------------

  /**
   * A follow/favorite may only point at something the shopper could see on
   * the public surface. Each owning module's public read already 404s on
   * unverified / unpublished / soft-deleted rows, so we simply reuse it.
   */
  private async assertPublicTarget(type: PublicTargetType, id: string): Promise<void> {
    switch (type) {
      case 'VENDOR':
        await this.vendorsService.getVendorById(id);
        return;
      case 'BAZAAR':
        await this.bazaarsService.getPublicBazaarById(id);
        return;
      case 'PRODUCT':
        await this.productsService.getProductById(id);
        return;
      case 'EVENT':
        // No events module exists yet; nothing can be resolved, so nothing can be favorited.
        throw new NotFoundException({ code: 'TARGET_NOT_FOUND', message: 'Events are not available yet.' });
      default: {
        const never: never = type;
        throw new BadRequestException({ code: 'TARGET_TYPE_UNSUPPORTED', message: `Unsupported target type ${String(never)}.` });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Keyset cursor helpers
  // ---------------------------------------------------------------------------

  private page(limit: number, cursor?: string): KeysetPage {
    if (!cursor) return { take: limit + 1 };
    const { s, id } = this.decodeCursor(cursor);
    return { take: limit + 1, after: { createdAt: new Date(s), id } };
  }

  private paginate<T extends { createdAt: Date; id: string }>(items: T[], limit: number): { data: T[]; nextCursor: string | null } {
    let nextCursor: string | null = null;
    if (items.length > limit) {
      items.pop();
      const last = items[items.length - 1];
      nextCursor = this.encodeCursor(last.createdAt, last.id);
    }
    return { data: items, nextCursor };
  }

  private encodeCursor(sortValue: Date | string, id: string): string {
    const s = sortValue instanceof Date ? sortValue.toISOString() : sortValue;
    return Buffer.from(JSON.stringify({ s, id }), 'utf8').toString('base64url');
  }

  private decodeCursor(raw: string): Cursor {
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

    if (typeof s !== 'string' || typeof id !== 'string' || id.length === 0) {
      throw this.invalidCursor();
    }

    return { s, id };
  }

  private invalidCursor(): BadRequestException {
    return new BadRequestException({ code: 'INVALID_CURSOR', message: 'Invalid pagination cursor.' });
  }
}
