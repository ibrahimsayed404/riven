import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { AdminRatingsController } from './admin-ratings.controller';

// Unit tests for every route of AdminRatingsController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminRatingsController (unit)', () => {
  let socialService: ReturnType<typeof autoMock>;
  let controller: AdminRatingsController;

  beforeEach(() => {
    socialService = autoMock('socialService');
    controller = new AdminRatingsController(socialService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminRatingsController)).toEqual([
      {
        "handler": "listRatings",
        "method": "GET",
        "path": "/admin/ratings",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "deleteRating",
        "method": "DELETE",
        "path": "/admin/ratings/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ],
        "httpCode": 204
      },
      {
        "handler": "clearComment",
        "method": "PATCH",
        "path": "/admin/ratings/:id/clear-comment",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      }
    ]);
  });

  it('GET /admin/ratings → socialService.listRatingsForAdmin', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.listRatings(query);
    expect(socialService.listRatingsForAdmin).toHaveBeenCalledWith({
      targetType: query.targetType,
      targetId: query.targetId,
      userId: query.userId,
      hasComment: query.hasComment,
      maxScore: query.maxScore,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
    expect(socialService.listRatingsForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, socialService.listRatingsForAdmin);
  });

  it('DELETE /admin/ratings/:id → socialService.deleteRatingForAdmin', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.deleteRating(admin, id);
    expect(socialService.deleteRatingForAdmin).toHaveBeenCalledWith(admin.id, id);
    expect(socialService.deleteRatingForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, socialService.deleteRatingForAdmin);
  });

  it('PATCH /admin/ratings/:id/clear-comment → socialService.clearRatingCommentForAdmin', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.clearComment(admin, id);
    expect(socialService.clearRatingCommentForAdmin).toHaveBeenCalledWith(admin.id, id);
    expect(socialService.clearRatingCommentForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, socialService.clearRatingCommentForAdmin);
  });
});
