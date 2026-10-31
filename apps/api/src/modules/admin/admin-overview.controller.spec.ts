import { autoMock, expectPassThrough, routesOf } from '../../test-utils/controller-test.helpers';

import { AdminOverviewController } from './admin-overview.controller';

// Unit tests for every route of AdminOverviewController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminOverviewController (unit)', () => {
  let adminOverviewService: ReturnType<typeof autoMock>;
  let controller: AdminOverviewController;

  beforeEach(() => {
    adminOverviewService = autoMock('adminOverviewService');
    controller = new AdminOverviewController(adminOverviewService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminOverviewController)).toEqual([
      {
        "handler": "getOverview",
        "method": "GET",
        "path": "/admin/overview",
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

  it('GET /admin/overview → adminOverviewService.getOverview', async () => {
    const result = await controller.getOverview();
    expect(adminOverviewService.getOverview).toHaveBeenCalledWith();
    expect(adminOverviewService.getOverview).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, adminOverviewService.getOverview);
  });
});
