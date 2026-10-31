import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { AdminApplicationsController } from './admin-applications.controller';

// Unit tests for every route of AdminApplicationsController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminApplicationsController (unit)', () => {
  let bazaarsService: ReturnType<typeof autoMock>;
  let controller: AdminApplicationsController;

  beforeEach(() => {
    bazaarsService = autoMock('bazaarsService');
    controller = new AdminApplicationsController(bazaarsService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminApplicationsController)).toEqual([
      {
        "handler": "listApplications",
        "method": "GET",
        "path": "/admin/applications",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "getApplication",
        "method": "GET",
        "path": "/admin/applications/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "acceptApplication",
        "method": "PATCH",
        "path": "/admin/applications/:id/accept",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "rejectApplication",
        "method": "PATCH",
        "path": "/admin/applications/:id/reject",
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

  it('GET /admin/applications → bazaarsService.listApplicationsForAdmin', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.listApplications(query);
    expect(bazaarsService.listApplicationsForAdmin).toHaveBeenCalledWith({
      bazaarId: query.bazaarId,
      vendorId: query.vendorId,
      status: query.status,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
    expect(bazaarsService.listApplicationsForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.listApplicationsForAdmin);
  });

  it('GET /admin/applications/:id → bazaarsService.getApplicationForAdmin', async () => {
    const id = 'id-1';
    const result = await controller.getApplication(id);
    expect(bazaarsService.getApplicationForAdmin).toHaveBeenCalledWith(id);
    expect(bazaarsService.getApplicationForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.getApplicationForAdmin);
  });

  it('PATCH /admin/applications/:id/accept → bazaarsService.decideApplicationForAdmin', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.acceptApplication(admin, id);
    expect(bazaarsService.decideApplicationForAdmin).toHaveBeenCalledWith(admin.id, id, 'ACCEPTED');
    expect(bazaarsService.decideApplicationForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.decideApplicationForAdmin);
  });

  it('PATCH /admin/applications/:id/reject → bazaarsService.decideApplicationForAdmin', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.rejectApplication(admin, id, dto);
    expect(bazaarsService.decideApplicationForAdmin).toHaveBeenCalledWith(admin.id, id, 'REJECTED', dto.reason);
    expect(bazaarsService.decideApplicationForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.decideApplicationForAdmin);
  });
});
