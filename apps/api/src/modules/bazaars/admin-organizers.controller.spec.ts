import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { AdminOrganizersController } from './admin-organizers.controller';

// Unit tests for every route of AdminOrganizersController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminOrganizersController (unit)', () => {
  let organizersService: ReturnType<typeof autoMock>;
  let controller: AdminOrganizersController;

  beforeEach(() => {
    organizersService = autoMock('organizersService');
    controller = new AdminOrganizersController(organizersService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminOrganizersController)).toEqual([
      {
        "handler": "listOrganizers",
        "method": "GET",
        "path": "/admin/organizers",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "verifyOrganizer",
        "method": "PATCH",
        "path": "/admin/organizers/:id/verify",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ],
        "httpCode": 200
      },
      {
        "handler": "rejectOrganizer",
        "method": "PATCH",
        "path": "/admin/organizers/:id/reject",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ],
        "httpCode": 200
      }
    ]);
  });

  it('GET /admin/organizers → organizersService.listForAdmin', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.listOrganizers(query);
    expect(organizersService.listForAdmin).toHaveBeenCalledWith({
      status: query.status,
      search: query.search,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    expect(organizersService.listForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, organizersService.listForAdmin);
  });

  it('PATCH /admin/organizers/:id/verify → organizersService.verifyOrganizer', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.verifyOrganizer(admin, id);
    expect(organizersService.verifyOrganizer).toHaveBeenCalledWith(admin.id, id);
    expect(organizersService.verifyOrganizer).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, organizersService.verifyOrganizer);
  });

  it('PATCH /admin/organizers/:id/reject → organizersService.rejectOrganizer', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.rejectOrganizer(admin, id, dto);
    expect(organizersService.rejectOrganizer).toHaveBeenCalledWith(admin.id, id, dto.reason);
    expect(organizersService.rejectOrganizer).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, organizersService.rejectOrganizer);
  });
});
