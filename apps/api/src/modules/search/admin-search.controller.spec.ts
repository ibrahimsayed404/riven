import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { AdminSearchController } from './admin-search.controller';

// Unit tests for every route of AdminSearchController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminSearchController (unit)', () => {
  let searchAdminService: ReturnType<typeof autoMock>;
  let controller: AdminSearchController;

  beforeEach(() => {
    searchAdminService = autoMock('searchAdminService');
    controller = new AdminSearchController(searchAdminService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminSearchController)).toEqual([
      {
        "handler": "reindex",
        "method": "POST",
        "path": "/admin/search/reindex",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ],
        "httpCode": 202
      }
    ]);
  });

  it('POST /admin/search/reindex → searchAdminService.reindex', async () => {
    const admin = userOf(Role.ADMIN);
    const dto = loose({ sample: 'body' });
    const result = await controller.reindex(admin, dto);
    expect(searchAdminService.reindex).toHaveBeenCalledWith(admin.id, dto.types);
    expect(searchAdminService.reindex).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, searchAdminService.reindex);
  });
});
