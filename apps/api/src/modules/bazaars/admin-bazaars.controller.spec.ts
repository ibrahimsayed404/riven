import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { AdminBazaarsController } from './admin-bazaars.controller';

// Unit tests for every route of AdminBazaarsController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminBazaarsController (unit)', () => {
  let bazaarsService: ReturnType<typeof autoMock>;
  let controller: AdminBazaarsController;

  beforeEach(() => {
    bazaarsService = autoMock('bazaarsService');
    controller = new AdminBazaarsController(bazaarsService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminBazaarsController)).toEqual([
      {
        "handler": "listBazaars",
        "method": "GET",
        "path": "/admin/bazaars",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "getBazaar",
        "method": "GET",
        "path": "/admin/bazaars/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "cancelBazaar",
        "method": "PATCH",
        "path": "/admin/bazaars/:id/cancel",
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

  it('GET /admin/bazaars → bazaarsService.listForAdmin', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.listBazaars(query);
    expect(bazaarsService.listForAdmin).toHaveBeenCalledWith({
      status: query.status,
      organizerId: query.organizerId,
      search: query.search,
      includeDeleted: query.includeDeleted ?? false,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
    expect(bazaarsService.listForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.listForAdmin);
  });

  it('GET /admin/bazaars/:id → bazaarsService.getBazaarForAdmin', async () => {
    const id = 'id-1';
    const result = await controller.getBazaar(id);
    expect(bazaarsService.getBazaarForAdmin).toHaveBeenCalledWith(id);
    expect(bazaarsService.getBazaarForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.getBazaarForAdmin);
  });

  it('PATCH /admin/bazaars/:id/cancel → bazaarsService.cancelBazaarForAdmin', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.cancelBazaar(admin, id);
    expect(bazaarsService.cancelBazaarForAdmin).toHaveBeenCalledWith(admin.id, id);
    expect(bazaarsService.cancelBazaarForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.cancelBazaarForAdmin);
  });
});
