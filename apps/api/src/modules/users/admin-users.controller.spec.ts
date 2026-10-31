import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { AdminUsersController } from './admin-users.controller';

// Unit tests for every route of AdminUsersController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminUsersController (unit)', () => {
  let usersService: ReturnType<typeof autoMock>;
  let controller: AdminUsersController;

  beforeEach(() => {
    usersService = autoMock('usersService');
    controller = new AdminUsersController(usersService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminUsersController)).toEqual([
      {
        "handler": "listUsers",
        "method": "GET",
        "path": "/admin/users",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "getUserDetail",
        "method": "GET",
        "path": "/admin/users/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "deactivateUser",
        "method": "PATCH",
        "path": "/admin/users/:id/deactivate",
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
        "handler": "reactivateUser",
        "method": "PATCH",
        "path": "/admin/users/:id/reactivate",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ],
        "httpCode": 204
      }
    ]);
  });

  it('GET /admin/users → usersService.getAdminUserList', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.listUsers(query);
    expect(usersService.getAdminUserList).toHaveBeenCalledWith({
      role: query.role,
      search: query.search,
      includeDeleted: query.includeDeleted ?? false,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    expect(usersService.getAdminUserList).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, usersService.getAdminUserList);
  });

  it('GET /admin/users/:id → usersService.getAdminUserDetail', async () => {
    const id = 'id-1';
    const result = await controller.getUserDetail(id);
    expect(usersService.getAdminUserDetail).toHaveBeenCalledWith(id);
    expect(usersService.getAdminUserDetail).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, usersService.getAdminUserDetail);
  });

  it('PATCH /admin/users/:id/deactivate → usersService.deactivateUser', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.deactivateUser(admin, id);
    expect(usersService.deactivateUser).toHaveBeenCalledWith(admin.id, id);
    expect(usersService.deactivateUser).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, usersService.deactivateUser);
  });

  it('PATCH /admin/users/:id/reactivate → usersService.reactivateUser', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.reactivateUser(admin, id);
    expect(usersService.reactivateUser).toHaveBeenCalledWith(admin.id, id);
    expect(usersService.reactivateUser).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, usersService.reactivateUser);
  });
});
