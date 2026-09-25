import { Injectable } from '@nestjs/common';
import { FavorableType, Favorite, Follow, FollowableType, Prisma, Rating, RatingTargetType } from '@prisma/client';

import { PrismaService } from '../../infra/prisma/prisma.service';

/** Keyset page request shared by the three lists: newest first, (createdAt, id) cursor. */
export interface KeysetPage {
  take: number; // limit + 1, so the caller can detect a next page
  after?: { createdAt: Date; id: string };
}

function keysetWhere(after?: KeysetPage['after']) {
  if (!after) return {};
  return { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] };
}

const KEYSET_ORDER = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

// Admin moderation row: the full rating plus who wrote it (email and account
// state included, so the admin can act on the reviewer). /admin/* only — the
// public list exposes the reviewer's name and nothing else.
const ADMIN_RATING_SELECT = {
  id: true,
  targetType: true,
  targetId: true,
  score: true,
  comment: true,
  orderId: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, name: true, email: true, isActive: true } },
} satisfies Prisma.RatingSelect;

export type AdminRatingRow = Prisma.RatingGetPayload<{ select: typeof ADMIN_RATING_SELECT }>;

/** Every Prisma call of the social module (fix.js ARCH-01). */
@Injectable()
export class SocialRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- Favorites ---

  upsertFavorite(userId: string, favorableType: FavorableType, favorableId: string): Promise<Favorite> {
    return this.prisma.favorite.upsert({
      where: { userId_favorableType_favorableId: { userId, favorableType, favorableId } },
      update: {},
      create: { userId, favorableType, favorableId },
    });
  }

  deleteFavorite(userId: string, favorableType: FavorableType, favorableId: string): Promise<Prisma.BatchPayload> {
    return this.prisma.favorite.deleteMany({ where: { userId, favorableType, favorableId } });
  }

  findFavorites(userId: string, favorableType: FavorableType | undefined, page: KeysetPage): Promise<Favorite[]> {
    return this.prisma.favorite.findMany({
      where: { userId, ...(favorableType ? { favorableType } : {}), ...keysetWhere(page.after) },
      orderBy: [...KEYSET_ORDER],
      take: page.take,
    });
  }

  async findFavoriteIds(userId: string, favorableType: FavorableType, favorableIds: string[]): Promise<string[]> {
    const rows = await this.prisma.favorite.findMany({
      where: { userId, favorableType, favorableId: { in: favorableIds } },
      select: { favorableId: true },
    });
    return rows.map((row) => row.favorableId);
  }

  // --- Follows ---

  upsertFollow(userId: string, followableType: FollowableType, followableId: string): Promise<Follow> {
    return this.prisma.follow.upsert({
      where: { userId_followableType_followableId: { userId, followableType, followableId } },
      update: {},
      create: { userId, followableType, followableId },
    });
  }

  deleteFollow(userId: string, followableType: FollowableType, followableId: string): Promise<Prisma.BatchPayload> {
    return this.prisma.follow.deleteMany({ where: { userId, followableType, followableId } });
  }

  findFollows(userId: string, followableType: FollowableType | undefined, page: KeysetPage): Promise<Follow[]> {
    return this.prisma.follow.findMany({
      where: { userId, ...(followableType ? { followableType } : {}), ...keysetWhere(page.after) },
      orderBy: [...KEYSET_ORDER],
      take: page.take,
    });
  }

  // --- Ratings ---

  upsertRating(input: {
    userId: string;
    targetType: RatingTargetType;
    targetId: string;
    score: number;
    comment: string | null;
    orderId: string | null;
  }): Promise<Rating> {
    const { userId, targetType, targetId, score, comment, orderId } = input;
    return this.prisma.rating.upsert({
      where: { userId_targetType_targetId: { userId, targetType, targetId } },
      update: { score, comment, orderId },
      create: { userId, targetType, targetId, score, comment, orderId },
    });
  }

  async aggregateRatings(targetType: RatingTargetType, targetId: string): Promise<{ average: number | null; count: number }> {
    const aggregate = await this.prisma.rating.aggregate({
      where: { targetType, targetId },
      _avg: { score: true },
      _count: { _all: true },
    });
    return { average: aggregate._avg.score, count: aggregate._count._all };
  }

  findRatings(targetType: RatingTargetType, targetId: string, page: KeysetPage) {
    return this.prisma.rating.findMany({
      where: { targetType, targetId, ...keysetWhere(page.after) },
      orderBy: [...KEYSET_ORDER],
      take: page.take,
      select: {
        id: true,
        targetType: true,
        targetId: true,
        score: true,
        comment: true,
        createdAt: true,
        user: { select: { name: true } },
      },
    });
  }

  // --- Admin (specs/admin-module-spec2.md A6) ---

  /**
   * Moderation queue over every rating. Page-based like the other admin lists,
   * not keyset like the public one. `hasComment` treats '' as no comment.
   */
  async findRatingsForAdmin(params: {
    targetType?: RatingTargetType;
    targetId?: string;
    userId?: string;
    hasComment?: boolean;
    maxScore?: number;
    page: number;
    limit: number;
  }): Promise<{ data: AdminRatingRow[]; total: number }> {
    const where: Prisma.RatingWhereInput = {};
    if (params.targetType) where.targetType = params.targetType;
    if (params.targetId) where.targetId = params.targetId;
    if (params.userId) where.userId = params.userId;
    if (params.maxScore !== undefined) where.score = { lte: params.maxScore };
    if (params.hasComment === true) where.AND = [{ comment: { not: null } }, { comment: { not: '' } }];
    if (params.hasComment === false) where.OR = [{ comment: null }, { comment: '' }];

    const [total, data] = await this.prisma.$transaction([
      this.prisma.rating.count({ where }),
      this.prisma.rating.findMany({
        where,
        select: ADMIN_RATING_SELECT,
        orderBy: [...KEYSET_ORDER],
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
    ]);
    return { data, total };
  }

  // --- Admin moderation writes (spec3 B3c) ---

  findRatingByIdForAdmin(id: string): Promise<AdminRatingRow | null> {
    return this.prisma.rating.findUnique({ where: { id }, select: ADMIN_RATING_SELECT });
  }

  /** Hard delete: Rating has no deletedAt; summaries are aggregated at read time. */
  async deleteRating(id: string): Promise<void> {
    await this.prisma.rating.delete({ where: { id } });
  }

  clearRatingComment(id: string): Promise<AdminRatingRow> {
    return this.prisma.rating.update({ where: { id }, data: { comment: null }, select: ADMIN_RATING_SELECT });
  }
}
