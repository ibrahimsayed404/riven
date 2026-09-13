import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { FavorableType, FollowableType, Prisma, RatingTargetType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
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

type Cursor = { s: string; id: string };

@Injectable()
export class SocialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
  ) {}

  // ---------------------------------------------------------------------------
  // Favorites
  // ---------------------------------------------------------------------------

  async addFavorite(userId: string, dto: CreateFavoriteDto) {
    return this.prisma.favorite.upsert({
      where: {
        userId_favorableType_favorableId: {
          userId,
          favorableType: dto.favorableType,
          favorableId: dto.favorableId,
        },
      },
      update: {},
      create: {
        userId,
        favorableType: dto.favorableType,
        favorableId: dto.favorableId,
      },
    });
  }

  async removeFavorite(userId: string, dto: DeleteFavoriteDto) {
    await this.prisma.favorite.deleteMany({
      where: {
        userId,
        favorableType: dto.favorableType,
        favorableId: dto.favorableId,
      },
    });
    return { success: true };
  }

  async getFavorites(userId: string, query: GetFavoritesQueryDto) {
    const limit = query.limit ?? 20;
    const where: Prisma.FavoriteWhereInput = {
      userId,
      ...(query.favorableType ? { favorableType: query.favorableType } : {}),
    };

    if (query.cursor) {
      const { s, id } = this.decodeCursor(query.cursor);
      const cursorDate = new Date(s);
      where.OR = [
        { createdAt: { lt: cursorDate } },
        { createdAt: cursorDate, id: { lt: id } },
      ];
    }

    const items = await this.prisma.favorite.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    let nextCursor: string | null = null;
    if (items.length > limit) {
      items.pop();
      const last = items[items.length - 1];
      nextCursor = this.encodeCursor(last.createdAt, last.id);
    }

    return { data: items, nextCursor };
  }

  async batchCheckFavorites(
    userId: string,
    favorableType: FavorableType,
    favorableIds: string[],
  ): Promise<Set<string>> {
    if (!favorableIds.length) {
      return new Set<string>();
    }

    const favorites = await this.prisma.favorite.findMany({
      where: {
        userId,
        favorableType,
        favorableId: { in: favorableIds },
      },
      select: { favorableId: true },
    });

    return new Set(favorites.map((f) => f.favorableId));
  }

  // ---------------------------------------------------------------------------
  // Follows
  // ---------------------------------------------------------------------------

  async addFollow(userId: string, dto: CreateFollowDto) {
    return this.prisma.follow.upsert({
      where: {
        userId_followableType_followableId: {
          userId,
          followableType: dto.followableType,
          followableId: dto.followableId,
        },
      },
      update: {},
      create: {
        userId,
        followableType: dto.followableType,
        followableId: dto.followableId,
      },
    });
  }

  async removeFollow(userId: string, dto: DeleteFollowDto) {
    await this.prisma.follow.deleteMany({
      where: {
        userId,
        followableType: dto.followableType,
        followableId: dto.followableId,
      },
    });
    return { success: true };
  }

  async getFollows(userId: string, query: GetFollowsQueryDto) {
    const limit = query.limit ?? 20;
    const where: Prisma.FollowWhereInput = {
      userId,
      ...(query.followableType ? { followableType: query.followableType } : {}),
    };

    if (query.cursor) {
      const { s, id } = this.decodeCursor(query.cursor);
      const cursorDate = new Date(s);
      where.OR = [
        { createdAt: { lt: cursorDate } },
        { createdAt: cursorDate, id: { lt: id } },
      ];
    }

    const items = await this.prisma.follow.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    let nextCursor: string | null = null;
    if (items.length > limit) {
      items.pop();
      const last = items[items.length - 1];
      nextCursor = this.encodeCursor(last.createdAt, last.id);
    }

    return { data: items, nextCursor };
  }

  // ---------------------------------------------------------------------------
  // Ratings
  // ---------------------------------------------------------------------------

  async addRating(userId: string, dto: CreateRatingDto) {
    const isVerified = await this.ordersService.verifyDeliveredPurchase(
      userId,
      dto.orderId,
      dto.targetType,
      dto.targetId,
    );

    if (!isVerified) {
      throw new ForbiddenException({
        code: 'NOT_VERIFIED_PURCHASE',
        message: 'Rating requires a verified delivered purchase for this target.',
      });
    }

    return this.prisma.rating.upsert({
      where: {
        userId_targetType_targetId: {
          userId,
          targetType: dto.targetType,
          targetId: dto.targetId,
        },
      },
      update: {
        score: dto.score,
        comment: dto.comment ?? null,
        orderId: dto.orderId,
      },
      create: {
        userId,
        targetType: dto.targetType,
        targetId: dto.targetId,
        score: dto.score,
        comment: dto.comment ?? null,
        orderId: dto.orderId,
      },
    });
  }

  async getRatingSummary(query: GetRatingSummaryQueryDto) {
    const aggregate = await this.prisma.rating.aggregate({
      where: {
        targetType: query.targetType,
        targetId: query.targetId,
      },
      _avg: {
        score: true,
      },
      _count: {
        _all: true,
      },
    });

    return {
      average: aggregate._avg.score !== null ? Number(aggregate._avg.score.toFixed(2)) : 0,
      count: aggregate._count._all,
    };
  }

  async getRatings(query: GetRatingsQueryDto) {
    const limit = query.limit ?? 20;
    const where: Prisma.RatingWhereInput = {
      targetType: query.targetType,
      targetId: query.targetId,
    };

    if (query.cursor) {
      const { s, id } = this.decodeCursor(query.cursor);
      const cursorDate = new Date(s);
      where.OR = [
        { createdAt: { lt: cursorDate } },
        { createdAt: cursorDate, id: { lt: id } },
      ];
    }

    const items = await this.prisma.rating.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        targetType: true,
        targetId: true,
        score: true,
        comment: true,
        createdAt: true,
        user: {
          select: {
            name: true,
          },
        },
      },
    });

    let nextCursor: string | null = null;
    if (items.length > limit) {
      items.pop();
      const last = items[items.length - 1];
      nextCursor = this.encodeCursor(last.createdAt, last.id);
    }

    const data = items.map((item) => ({
      id: item.id,
      targetType: item.targetType,
      targetId: item.targetId,
      score: item.score,
      comment: item.comment,
      createdAt: item.createdAt,
      reviewerName: item.user.name,
    }));

    return { data, nextCursor };
  }

  // ---------------------------------------------------------------------------
  // Keyset cursor helpers
  // ---------------------------------------------------------------------------

  private encodeCursor(sortValue: Date | string, id: string): string {
    const s = sortValue instanceof Date ? sortValue.toISOString() : sortValue;
    return Buffer.from(JSON.stringify({ s, id }), 'utf8').toString('base64url');
  }

  private decodeCursor(raw: string): Cursor {
    let parsed: unknown;

    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
      throw new BadRequestException({
        code: 'INVALID_CURSOR',
        message: 'Invalid pagination cursor.',
      });
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new BadRequestException({
        code: 'INVALID_CURSOR',
        message: 'Invalid pagination cursor.',
      });
    }

    const { s, id } = parsed as { s?: unknown; id?: unknown };

    if (typeof s !== 'string' || typeof id !== 'string' || id.length === 0) {
      throw new BadRequestException({
        code: 'INVALID_CURSOR',
        message: 'Invalid pagination cursor.',
      });
    }

    return { s, id };
  }
}
