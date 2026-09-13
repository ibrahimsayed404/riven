import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FavorableType, FollowableType, RatingTargetType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { SocialService } from './social.service';

describe('SocialService', () => {
  let service: SocialService;
  let prisma: {
    favorite: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
      findMany: jest.Mock;
    };
    follow: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
      findMany: jest.Mock;
    };
    rating: {
      upsert: jest.Mock;
      aggregate: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let ordersService: {
    verifyDeliveredPurchase: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      favorite: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
        findMany: jest.fn(),
      },
      follow: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
        findMany: jest.fn(),
      },
      rating: {
        upsert: jest.fn(),
        aggregate: jest.fn(),
        findMany: jest.fn(),
      },
    };

    ordersService = {
      verifyDeliveredPurchase: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SocialService,
        { provide: PrismaService, useValue: prisma },
        { provide: OrdersService, useValue: ordersService },
      ],
    }).compile();

    service = module.get<SocialService>(SocialService);
  });

  describe('Favorites', () => {
    const userId = 'user-1';
    const favoriteDto = {
      favorableType: FavorableType.BAZAAR,
      favorableId: 'bazaar-1',
    };

    it('idempotently creates or returns favorite via upsert without conflict', async () => {
      const mockFavorite = { id: 'fav-1', userId, ...favoriteDto };
      prisma.favorite.upsert.mockResolvedValue(mockFavorite);

      const result = await service.addFavorite(userId, favoriteDto);
      expect(result).toEqual(mockFavorite);
      expect(prisma.favorite.upsert).toHaveBeenCalledWith({
        where: {
          userId_favorableType_favorableId: {
            userId,
            favorableType: favoriteDto.favorableType,
            favorableId: favoriteDto.favorableId,
          },
        },
        update: {},
        create: {
          userId,
          favorableType: favoriteDto.favorableType,
          favorableId: favoriteDto.favorableId,
        },
      });
    });

    it('idempotently removes a favorite using deleteMany so a missing row does not throw', async () => {
      prisma.favorite.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.removeFavorite(userId, favoriteDto);
      expect(result).toEqual({ success: true });
      expect(prisma.favorite.deleteMany).toHaveBeenCalledWith({
        where: {
          userId,
          favorableType: favoriteDto.favorableType,
          favorableId: favoriteDto.favorableId,
        },
      });
    });

    it('paginates user favorites with keyset cursor and emits nextCursor', async () => {
      const now = new Date('2026-09-01T10:00:00.000Z');
      const later = new Date('2026-09-01T11:00:00.000Z');
      const rows = [
        { id: 'fav-2', userId, favorableType: FavorableType.BAZAAR, favorableId: 'b-2', createdAt: later },
        { id: 'fav-1', userId, favorableType: FavorableType.BAZAAR, favorableId: 'b-1', createdAt: now },
      ];
      // limit = 1, so Prisma returns 2 items (limit + 1)
      prisma.favorite.findMany.mockResolvedValue([...rows]);

      const result = await service.getFavorites(userId, { limit: 1 });
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('fav-2');
      expect(result.nextCursor).toBeDefined();

      // Check cursor decoding on subsequent call
      const cursor = result.nextCursor!;
      prisma.favorite.findMany.mockResolvedValue([{ ...rows[1] }]);

      const nextResult = await service.getFavorites(userId, { limit: 1, cursor });
      expect(nextResult.data).toHaveLength(1);
      expect(nextResult.data[0].id).toBe('fav-1');
      expect(nextResult.nextCursor).toBeNull();
    });

    it('batch checks favorite IDs with a single query and returns a Set', async () => {
      prisma.favorite.findMany.mockResolvedValue([
        { favorableId: 'bazaar-1' },
        { favorableId: 'bazaar-3' },
      ]);

      const result = await service.batchCheckFavorites(userId, FavorableType.BAZAAR, [
        'bazaar-1',
        'bazaar-2',
        'bazaar-3',
      ]);

      expect(result.has('bazaar-1')).toBe(true);
      expect(result.has('bazaar-2')).toBe(false);
      expect(result.has('bazaar-3')).toBe(true);
      expect(prisma.favorite.findMany).toHaveBeenCalledWith({
        where: {
          userId,
          favorableType: FavorableType.BAZAAR,
          favorableId: { in: ['bazaar-1', 'bazaar-2', 'bazaar-3'] },
        },
        select: { favorableId: true },
      });
    });

    it('returns empty Set without querying DB if favorableIds array is empty', async () => {
      const result = await service.batchCheckFavorites(userId, FavorableType.BAZAAR, []);
      expect(result.size).toBe(0);
      expect(prisma.favorite.findMany).not.toHaveBeenCalled();
    });
  });

  describe('Follows', () => {
    const userId = 'user-1';
    const followDto = {
      followableType: FollowableType.VENDOR,
      followableId: 'vendor-1',
    };

    it('idempotently creates or returns follow via upsert', async () => {
      const mockFollow = { id: 'fol-1', userId, ...followDto };
      prisma.follow.upsert.mockResolvedValue(mockFollow);

      const result = await service.addFollow(userId, followDto);
      expect(result).toEqual(mockFollow);
      expect(prisma.follow.upsert).toHaveBeenCalledWith({
        where: {
          userId_followableType_followableId: {
            userId,
            followableType: followDto.followableType,
            followableId: followDto.followableId,
          },
        },
        update: {},
        create: {
          userId,
          followableType: followDto.followableType,
          followableId: followDto.followableId,
        },
      });
    });

    it('idempotently removes a follow using deleteMany', async () => {
      prisma.follow.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.removeFollow(userId, followDto);
      expect(result).toEqual({ success: true });
      expect(prisma.follow.deleteMany).toHaveBeenCalledWith({
        where: {
          userId,
          followableType: followDto.followableType,
          followableId: followDto.followableId,
        },
      });
    });

    it('paginates user follows with keyset cursor', async () => {
      prisma.follow.findMany.mockResolvedValue([]);
      const result = await service.getFollows(userId, {});
      expect(result).toEqual({ data: [], nextCursor: null });
    });
  });

  describe('Ratings & Verified-Purchase Gate', () => {
    const userId = 'user-1';
    const orderId = 'order-123';
    const vendorRatingDto = {
      targetType: RatingTargetType.VENDOR,
      targetId: 'vendor-1',
      score: 5,
      comment: 'Great vendor!',
      orderId,
    };
    const productRatingDto = {
      targetType: RatingTargetType.PRODUCT,
      targetId: 'prod-1',
      score: 4,
      comment: 'Nice quality',
      orderId,
    };

    it('rejects rating if verified-purchase check fails for vendor', async () => {
      ordersService.verifyDeliveredPurchase.mockResolvedValue(false);

      await expect(service.addRating(userId, vendorRatingDto)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.addRating(userId, vendorRatingDto)).rejects.toMatchObject({
        response: { code: 'NOT_VERIFIED_PURCHASE' },
      });
      expect(ordersService.verifyDeliveredPurchase).toHaveBeenCalledWith(
        userId,
        orderId,
        RatingTargetType.VENDOR,
        'vendor-1',
      );
      expect(prisma.rating.upsert).not.toHaveBeenCalled();
    });

    it('rejects rating if verified-purchase check fails for product', async () => {
      ordersService.verifyDeliveredPurchase.mockResolvedValue(false);

      await expect(service.addRating(userId, productRatingDto)).rejects.toThrow(
        ForbiddenException,
      );
      expect(ordersService.verifyDeliveredPurchase).toHaveBeenCalledWith(
        userId,
        orderId,
        RatingTargetType.PRODUCT,
        'prod-1',
      );
    });

    it('allows rating and upserts when verified-purchase check passes for vendor', async () => {
      ordersService.verifyDeliveredPurchase.mockResolvedValue(true);
      const mockRating = { id: 'rate-1', userId, ...vendorRatingDto };
      prisma.rating.upsert.mockResolvedValue(mockRating);

      const result = await service.addRating(userId, vendorRatingDto);
      expect(result).toEqual(mockRating);
      expect(prisma.rating.upsert).toHaveBeenCalledWith({
        where: {
          userId_targetType_targetId: {
            userId,
            targetType: RatingTargetType.VENDOR,
            targetId: 'vendor-1',
          },
        },
        update: {
          score: 5,
          comment: 'Great vendor!',
          orderId,
        },
        create: {
          userId,
          targetType: RatingTargetType.VENDOR,
          targetId: 'vendor-1',
          score: 5,
          comment: 'Great vendor!',
          orderId,
        },
      });
    });

    it('allows rating and upserts when verified-purchase check passes for product', async () => {
      ordersService.verifyDeliveredPurchase.mockResolvedValue(true);
      const mockRating = { id: 'rate-2', userId, ...productRatingDto };
      prisma.rating.upsert.mockResolvedValue(mockRating);

      const result = await service.addRating(userId, productRatingDto);
      expect(result).toEqual(mockRating);
      expect(prisma.rating.upsert).toHaveBeenCalledWith({
        where: {
          userId_targetType_targetId: {
            userId,
            targetType: RatingTargetType.PRODUCT,
            targetId: 'prod-1',
          },
        },
        update: {
          score: 4,
          comment: 'Nice quality',
          orderId,
        },
        create: {
          userId,
          targetType: RatingTargetType.PRODUCT,
          targetId: 'prod-1',
          score: 4,
          comment: 'Nice quality',
          orderId,
        },
      });
    });

    it('computes rating summary using single Prisma aggregate query', async () => {
      prisma.rating.aggregate.mockResolvedValue({
        _avg: { score: 4.66666 },
        _count: { _all: 3 },
      });

      const summary = await service.getRatingSummary({
        targetType: RatingTargetType.VENDOR,
        targetId: 'vendor-1',
      });

      expect(summary).toEqual({ average: 4.67, count: 3 });
      expect(prisma.rating.aggregate).toHaveBeenCalledWith({
        where: {
          targetType: RatingTargetType.VENDOR,
          targetId: 'vendor-1',
        },
        _avg: { score: true },
        _count: { _all: true },
      });
    });

    it('returns average 0 and count 0 when no ratings exist', async () => {
      prisma.rating.aggregate.mockResolvedValue({
        _avg: { score: null },
        _count: { _all: 0 },
      });

      const summary = await service.getRatingSummary({
        targetType: RatingTargetType.PRODUCT,
        targetId: 'prod-none',
      });

      expect(summary).toEqual({ average: 0, count: 0 });
    });

    it('returns paginated ratings with reviewer name and omits raw userId', async () => {
      const now = new Date('2026-09-01T10:00:00.000Z');
      prisma.rating.findMany.mockResolvedValue([
        {
          id: 'rate-1',
          targetType: RatingTargetType.VENDOR,
          targetId: 'vendor-1',
          score: 5,
          comment: 'Love it!',
          createdAt: now,
          user: { name: 'Alice Shopper' },
        },
      ]);

      const result = await service.getRatings({
        targetType: RatingTargetType.VENDOR,
        targetId: 'vendor-1',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toEqual({
        id: 'rate-1',
        targetType: RatingTargetType.VENDOR,
        targetId: 'vendor-1',
        score: 5,
        comment: 'Love it!',
        createdAt: now,
        reviewerName: 'Alice Shopper',
      });
      expect((result.data[0] as any).userId).toBeUndefined();
    });

    it('rejects invalid cursor format with BadRequestException', async () => {
      await expect(
        service.getFavorites('user-1', { cursor: 'invalid-base64!' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
