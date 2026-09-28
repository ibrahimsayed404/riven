import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { FavorableType, FollowableType, RatingTargetType } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { BazaarsService } from '../bazaars/bazaars.service';
import { OrdersService } from '../orders/orders.service';
import { ProductsService } from '../products/products.service';
import { VendorsService } from '../vendors/vendors.service';
import { SocialRepository } from './social.repository';
import { SocialService } from './social.service';

const notFound = (code: string) => new NotFoundException({ code, message: 'nope' });

describe('SocialService', () => {
  let service: SocialService;
  let repo: jest.Mocked<SocialRepository>;
  let ordersService: { verifyDeliveredPurchase: jest.Mock };
  let vendorsService: { getVendorById: jest.Mock };
  let bazaarsService: { getPublicBazaarById: jest.Mock; isRateable: jest.Mock };
  let productsService: { getProductById: jest.Mock };
  let auditService: { record: jest.Mock };

  const userId = 'user-1';

  beforeEach(() => {
    repo = {
      upsertFavorite: jest.fn(),
      deleteFavorite: jest.fn(),
      findFavorites: jest.fn(),
      findFavoriteIds: jest.fn(),
      upsertFollow: jest.fn(),
      deleteFollow: jest.fn(),
      findFollows: jest.fn(),
      upsertRating: jest.fn(),
      aggregateRatings: jest.fn(),
      findRatings: jest.fn(),
      findRatingsForAdmin: jest.fn(),
      findRatingByIdForAdmin: jest.fn(),
      deleteRating: jest.fn(),
      clearRatingComment: jest.fn(),
    } as unknown as jest.Mocked<SocialRepository>;
    ordersService = { verifyDeliveredPurchase: jest.fn() };
    vendorsService = { getVendorById: jest.fn().mockResolvedValue({ id: 'vendor-1' }) };
    bazaarsService = { getPublicBazaarById: jest.fn().mockResolvedValue({ id: 'bazaar-1' }), isRateable: jest.fn().mockResolvedValue(true) };
    productsService = { getProductById: jest.fn().mockResolvedValue({ id: 'prod-1' }) };
    auditService = { record: jest.fn().mockResolvedValue(undefined) };

    service = new SocialService(
      repo,
      ordersService as unknown as OrdersService,
      vendorsService as unknown as VendorsService,
      bazaarsService as unknown as BazaarsService,
      productsService as unknown as ProductsService,
      auditService as unknown as AuditService,
    );
  });

  describe('Favorites', () => {
    const dto = { favorableType: FavorableType.BAZAAR, favorableId: 'bazaar-1' };

    it('verifies the target is publicly visible, then upserts (VULN-04)', async () => {
      const mockFavorite = { id: 'fav-1', userId, ...dto };
      repo.upsertFavorite.mockResolvedValue(mockFavorite as any);

      const result = await service.addFavorite(userId, dto);

      expect(bazaarsService.getPublicBazaarById).toHaveBeenCalledWith('bazaar-1');
      expect(repo.upsertFavorite).toHaveBeenCalledWith(userId, FavorableType.BAZAAR, 'bazaar-1');
      expect(result).toEqual(mockFavorite);
    });

    it('404s and writes nothing when the target is not public (unverified vendor, draft bazaar, hidden product)', async () => {
      vendorsService.getVendorById.mockRejectedValue(notFound('VENDOR_NOT_FOUND'));
      await expect(service.addFavorite(userId, { favorableType: FavorableType.VENDOR, favorableId: 'v-x' })).rejects.toMatchObject({
        response: { code: 'VENDOR_NOT_FOUND' },
      });

      productsService.getProductById.mockRejectedValue(notFound('PRODUCT_NOT_FOUND'));
      await expect(service.addFavorite(userId, { favorableType: FavorableType.PRODUCT, favorableId: 'p-x' })).rejects.toBeInstanceOf(NotFoundException);

      expect(repo.upsertFavorite).not.toHaveBeenCalled();
    });

    it('EVENT targets cannot be resolved yet and are rejected', async () => {
      await expect(service.addFavorite(userId, { favorableType: FavorableType.EVENT, favorableId: 'e-1' })).rejects.toMatchObject({
        response: { code: 'TARGET_NOT_FOUND' },
      });
    });

    it('idempotently removes a favorite (deleteMany, missing row does not throw)', async () => {
      repo.deleteFavorite.mockResolvedValue({ count: 0 });
      await expect(service.removeFavorite(userId, dto)).resolves.toEqual({ success: true });
      expect(repo.deleteFavorite).toHaveBeenCalledWith(userId, FavorableType.BAZAAR, 'bazaar-1');
    });

    it('paginates with a keyset cursor and emits nextCursor', async () => {
      const rows = [
        { id: 'f3', createdAt: new Date('2026-01-03'), favorableType: 'BAZAAR', favorableId: 'b3' },
        { id: 'f2', createdAt: new Date('2026-01-02'), favorableType: 'BAZAAR', favorableId: 'b2' },
        { id: 'f1', createdAt: new Date('2026-01-01'), favorableType: 'BAZAAR', favorableId: 'b1' },
      ];
      repo.findFavorites.mockResolvedValue([...rows] as any);

      const page1 = await service.getFavorites(userId, { limit: 2 });
      expect(page1.data).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      expect(repo.findFavorites).toHaveBeenCalledWith(userId, undefined, { take: 3 });

      repo.findFavorites.mockResolvedValue([rows[2]] as any);
      const page2 = await service.getFavorites(userId, { limit: 2, cursor: page1.nextCursor! });
      expect(repo.findFavorites).toHaveBeenLastCalledWith(userId, undefined, {
        take: 3,
        after: { createdAt: rows[1].createdAt, id: 'f2' },
      });
      expect(page2.nextCursor).toBeNull();
    });

    it('batch-checks favorite ids in one query and returns a Set', async () => {
      repo.findFavoriteIds.mockResolvedValue(['b1', 'b3']);
      const result = await service.batchCheckFavorites(userId, FavorableType.BAZAAR, ['b1', 'b2', 'b3']);
      expect(result).toEqual(new Set(['b1', 'b3']));
      expect(repo.findFavoriteIds).toHaveBeenCalledWith(userId, FavorableType.BAZAAR, ['b1', 'b2', 'b3']);
    });

    it('returns an empty Set without querying when there are no ids', async () => {
      const result = await service.batchCheckFavorites(userId, FavorableType.BAZAAR, []);
      expect(result.size).toBe(0);
      expect(repo.findFavoriteIds).not.toHaveBeenCalled();
    });
  });

  describe('Follows', () => {
    const dto = { followableType: FollowableType.VENDOR, followableId: 'vendor-1' };

    it('verifies the vendor is public, then upserts', async () => {
      repo.upsertFollow.mockResolvedValue({ id: 'fol-1' } as any);
      await service.addFollow(userId, dto);
      expect(vendorsService.getVendorById).toHaveBeenCalledWith('vendor-1');
      expect(repo.upsertFollow).toHaveBeenCalledWith(userId, FollowableType.VENDOR, 'vendor-1');
    });

    it('idempotently removes a follow', async () => {
      repo.deleteFollow.mockResolvedValue({ count: 1 });
      await expect(service.removeFollow(userId, dto)).resolves.toEqual({ success: true });
    });

    it('paginates follows', async () => {
      repo.findFollows.mockResolvedValue([]);
      await expect(service.getFollows(userId, {})).resolves.toEqual({ data: [], nextCursor: null });
    });
  });

  describe('Ratings & verified-purchase gate', () => {
    const ratingDto = { targetType: RatingTargetType.VENDOR, targetId: 'vendor-1', orderId: 'order-1', score: 5, comment: 'Great' };

    it('rejects when the purchase is not verified, and writes nothing', async () => {
      ordersService.verifyDeliveredPurchase.mockResolvedValue(false);
      await expect(service.addRating(userId, ratingDto)).rejects.toBeInstanceOf(ForbiddenException);
      expect(ordersService.verifyDeliveredPurchase).toHaveBeenCalledWith(userId, 'order-1', RatingTargetType.VENDOR, 'vendor-1');
      expect(repo.upsertRating).not.toHaveBeenCalled();
    });

    it('upserts when verified', async () => {
      ordersService.verifyDeliveredPurchase.mockResolvedValue(true);
      repo.upsertRating.mockResolvedValue({ id: 'r-1' } as any);
      await service.addRating(userId, ratingDto);
      expect(repo.upsertRating).toHaveBeenCalledWith({
        userId, targetType: RatingTargetType.VENDOR, targetId: 'vendor-1', score: 5, comment: 'Great', orderId: 'order-1',
      });
    });

    it('a BAZAAR rating needs no order — only that the bazaar is PUBLISHED or COMPLETED (SPEC-03)', async () => {
      repo.upsertRating.mockResolvedValue({ id: 'r-b' } as any);
      await service.addRating(userId, { targetType: RatingTargetType.BAZAAR, targetId: 'bazaar-1', score: 4 });
      expect(bazaarsService.isRateable).toHaveBeenCalledWith('bazaar-1');
      expect(ordersService.verifyDeliveredPurchase).not.toHaveBeenCalled();
      expect(repo.upsertRating).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'BAZAAR', orderId: null }));

      bazaarsService.isRateable.mockResolvedValue(false);
      await expect(service.addRating(userId, { targetType: RatingTargetType.BAZAAR, targetId: 'draft', score: 4 })).rejects.toMatchObject({
        response: { code: 'BAZAAR_NOT_FOUND' },
      });
    });

    it('a VENDOR/PRODUCT rating without orderId is ORDER_ID_REQUIRED; EVENT is not rateable yet', async () => {
      await expect(service.addRating(userId, { targetType: RatingTargetType.VENDOR, targetId: 'v', score: 5 })).rejects.toMatchObject({
        response: { code: 'ORDER_ID_REQUIRED' },
      });
      await expect(service.addRating(userId, { targetType: RatingTargetType.EVENT, targetId: 'e', score: 5 })).rejects.toMatchObject({
        response: { code: 'TARGET_NOT_FOUND' },
      });
      expect(repo.upsertRating).not.toHaveBeenCalled();
    });

    it('summary rounds the average to 2dp and returns 0 when there are none', async () => {
      repo.aggregateRatings.mockResolvedValue({ average: 4.3333, count: 3 });
      await expect(service.getRatingSummary({ targetType: RatingTargetType.VENDOR, targetId: 'v' })).resolves.toEqual({ average: 4.33, count: 3 });

      repo.aggregateRatings.mockResolvedValue({ average: null, count: 0 });
      await expect(service.getRatingSummary({ targetType: RatingTargetType.VENDOR, targetId: 'v' })).resolves.toEqual({ average: 0, count: 0 });
    });

    it('lists ratings with reviewerName and without the raw user object', async () => {
      repo.findRatings.mockResolvedValue([
        { id: 'r1', targetType: 'VENDOR', targetId: 'v', score: 5, comment: null, createdAt: new Date(), user: { name: 'Nour' } },
      ] as any);
      const result = await service.getRatings({ targetType: RatingTargetType.VENDOR, targetId: 'v' });
      expect(result.data[0]).toMatchObject({ id: 'r1', reviewerName: 'Nour' });
      expect(result.data[0]).not.toHaveProperty('user');
    });

    it('rejects a malformed cursor with INVALID_CURSOR', async () => {
      await expect(service.getRatings({ targetType: RatingTargetType.VENDOR, targetId: 'v', cursor: '!!!' })).rejects.toMatchObject({
        response: { code: 'INVALID_CURSOR' },
      });
      await expect(service.getRatings({ targetType: RatingTargetType.VENDOR, targetId: 'v', cursor: '!!!' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('listRatingsForAdmin (specs/admin-module-spec2.md A6)', () => {
    it('passes every filter through and wraps the page in { data, meta } — no keyset cursor', async () => {
      repo.findRatingsForAdmin.mockResolvedValue({ data: [{ id: 'r1' }] as any, total: 7 });

      const params = {
        targetType: RatingTargetType.PRODUCT,
        targetId: 'p1',
        userId: 'u1',
        hasComment: true,
        maxScore: 2,
        page: 2,
        limit: 5,
      };
      const result = await service.listRatingsForAdmin(params);

      expect(repo.findRatingsForAdmin).toHaveBeenCalledWith(params);
      expect(repo.findRatings).not.toHaveBeenCalled();
      expect(result).toEqual({ data: [{ id: 'r1' }], meta: { total: 7, page: 2, limit: 5, totalPages: 2 } });
    });
  });

  describe('admin rating moderation (specs/admin-module-spec3.md B3c)', () => {
    const rating = { id: 'r1', score: 1, comment: 'Rude seller' };

    it('deleteRatingForAdmin hard-deletes, then audits RATING_DELETED', async () => {
      repo.findRatingByIdForAdmin.mockResolvedValue(rating as any);

      await service.deleteRatingForAdmin('admin-1', 'r1');

      expect(repo.deleteRating).toHaveBeenCalledWith('r1');
      expect(auditService.record).toHaveBeenCalledWith({
        actorId: 'admin-1',
        action: 'RATING_DELETED',
        targetType: 'RATING',
        targetId: 'r1',
      });
      expect(repo.deleteRating.mock.invocationCallOrder[0]).toBeLessThan(auditService.record.mock.invocationCallOrder[0]);
    });

    it('clearRatingCommentForAdmin nulls the comment, keeps the score, audits RATING_COMMENT_CLEARED', async () => {
      repo.findRatingByIdForAdmin.mockResolvedValue(rating as any);
      repo.clearRatingComment.mockResolvedValue({ ...rating, comment: null } as any);

      await expect(service.clearRatingCommentForAdmin('admin-1', 'r1')).resolves.toMatchObject({ score: 1, comment: null });
      expect(repo.deleteRating).not.toHaveBeenCalled();
      expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'RATING_COMMENT_CLEARED' }));
    });

    it('clearing an empty or null comment is a no-op: no write, no audit', async () => {
      for (const comment of [null, '']) {
        repo.findRatingByIdForAdmin.mockResolvedValueOnce({ ...rating, comment } as any);
        await service.clearRatingCommentForAdmin('admin-1', 'r1');
      }
      expect(repo.clearRatingComment).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('404 RATING_NOT_FOUND on both actions, with nothing written', async () => {
      repo.findRatingByIdForAdmin.mockResolvedValue(null);
      await expect(service.deleteRatingForAdmin('admin-1', 'x')).rejects.toMatchObject({ response: { code: 'RATING_NOT_FOUND' } });
      await expect(service.clearRatingCommentForAdmin('admin-1', 'x')).rejects.toMatchObject({ response: { code: 'RATING_NOT_FOUND' } });
      expect(repo.deleteRating).not.toHaveBeenCalled();
      expect(repo.clearRatingComment).not.toHaveBeenCalled();
    });
  });
});
