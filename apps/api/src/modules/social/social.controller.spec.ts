import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { SocialController } from './social.controller';

// Unit tests for every route of SocialController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('SocialController (unit)', () => {
  let socialService: ReturnType<typeof autoMock>;
  let controller: SocialController;

  beforeEach(() => {
    socialService = autoMock('socialService');
    controller = new SocialController(socialService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(SocialController)).toEqual([
      {
        "handler": "addFavorite",
        "method": "POST",
        "path": "/social/favorites",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ],
        "httpCode": 200
      },
      {
        "handler": "removeFavorite",
        "method": "DELETE",
        "path": "/social/favorites",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ],
        "httpCode": 200
      },
      {
        "handler": "getFavorites",
        "method": "GET",
        "path": "/social/favorites",
        "guards": [
          "JwtAuthGuard"
        ]
      },
      {
        "handler": "addFollow",
        "method": "POST",
        "path": "/social/follows",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ],
        "httpCode": 200
      },
      {
        "handler": "removeFollow",
        "method": "DELETE",
        "path": "/social/follows",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ],
        "httpCode": 200
      },
      {
        "handler": "getFollows",
        "method": "GET",
        "path": "/social/follows",
        "guards": [
          "JwtAuthGuard"
        ]
      },
      {
        "handler": "addRating",
        "method": "POST",
        "path": "/social/ratings",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ],
        "httpCode": 200
      },
      {
        "handler": "getRatingSummary",
        "method": "GET",
        "path": "/social/ratings/summary",
        "guards": []
      },
      {
        "handler": "getRatings",
        "method": "GET",
        "path": "/social/ratings",
        "guards": []
      }
    ]);
  });

  it('POST /social/favorites → socialService.addFavorite', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const dto = loose({ sample: 'body' });
    const result = await controller.addFavorite(userId, dto);
    expect(socialService.addFavorite).toHaveBeenCalledWith(userId, dto);
    expect(socialService.addFavorite).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, socialService.addFavorite);
  });

  it('DELETE /social/favorites → socialService.removeFavorite', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const dto = loose({ sample: 'body' });
    const result = await controller.removeFavorite(userId, dto);
    expect(socialService.removeFavorite).toHaveBeenCalledWith(userId, dto);
    expect(socialService.removeFavorite).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, socialService.removeFavorite);
  });

  it('GET /social/favorites → socialService.getFavorites', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.getFavorites(userId, query);
    expect(socialService.getFavorites).toHaveBeenCalledWith(userId, query);
    expect(socialService.getFavorites).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, socialService.getFavorites);
  });

  it('POST /social/follows → socialService.addFollow', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const dto = loose({ sample: 'body' });
    const result = await controller.addFollow(userId, dto);
    expect(socialService.addFollow).toHaveBeenCalledWith(userId, dto);
    expect(socialService.addFollow).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, socialService.addFollow);
  });

  it('DELETE /social/follows → socialService.removeFollow', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const dto = loose({ sample: 'body' });
    const result = await controller.removeFollow(userId, dto);
    expect(socialService.removeFollow).toHaveBeenCalledWith(userId, dto);
    expect(socialService.removeFollow).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, socialService.removeFollow);
  });

  it('GET /social/follows → socialService.getFollows', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.getFollows(userId, query);
    expect(socialService.getFollows).toHaveBeenCalledWith(userId, query);
    expect(socialService.getFollows).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, socialService.getFollows);
  });

  it('POST /social/ratings → socialService.addRating', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const dto = loose({ sample: 'body' });
    const result = await controller.addRating(userId, dto);
    expect(socialService.addRating).toHaveBeenCalledWith(userId, dto);
    expect(socialService.addRating).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, socialService.addRating);
  });

  it('GET /social/ratings/summary → socialService.getRatingSummary', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.getRatingSummary(query);
    expect(socialService.getRatingSummary).toHaveBeenCalledWith(query);
    expect(socialService.getRatingSummary).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, socialService.getRatingSummary);
  });

  it('GET /social/ratings → socialService.getRatings', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.getRatings(query);
    expect(socialService.getRatings).toHaveBeenCalledWith(query);
    expect(socialService.getRatings).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, socialService.getRatings);
  });
});
