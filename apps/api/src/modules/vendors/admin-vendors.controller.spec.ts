import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { AdminVendorsController } from './admin-vendors.controller';

// Unit tests for every route of AdminVendorsController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminVendorsController (unit)', () => {
  let vendorsService: ReturnType<typeof autoMock>;
  let controller: AdminVendorsController;

  beforeEach(() => {
    vendorsService = autoMock('vendorsService');
    controller = new AdminVendorsController(vendorsService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminVendorsController)).toEqual([
      {
        "handler": "listVendors",
        "method": "GET",
        "path": "/admin/vendors",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "getVendor",
        "method": "GET",
        "path": "/admin/vendors/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "updateVendor",
        "method": "PATCH",
        "path": "/admin/vendors/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "verifyVendor",
        "method": "PATCH",
        "path": "/admin/vendors/:id/verify",
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
        "handler": "rejectVendor",
        "method": "PATCH",
        "path": "/admin/vendors/:id/reject",
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

  it('GET /admin/vendors → vendorsService.listForAdmin', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.listVendors(query);
    expect(vendorsService.listForAdmin).toHaveBeenCalledWith({
      status: query.status,
      search: query.search,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
    expect(vendorsService.listForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.listForAdmin);
  });

  it('GET /admin/vendors/:id → vendorsService.getVendorForAdmin', async () => {
    const id = 'id-1';
    const result = await controller.getVendor(id);
    expect(vendorsService.getVendorForAdmin).toHaveBeenCalledWith(id);
    expect(vendorsService.getVendorForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.getVendorForAdmin);
  });

  it('PATCH /admin/vendors/:id → vendorsService.updateVendorForAdmin', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.updateVendor(admin, id, dto);
    expect(vendorsService.updateVendorForAdmin).toHaveBeenCalledWith(admin.id, id, dto);
    expect(vendorsService.updateVendorForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.updateVendorForAdmin);
  });

  it('PATCH /admin/vendors/:id/verify → vendorsService.verifyVendor', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.verifyVendor(admin, id);
    expect(vendorsService.verifyVendor).toHaveBeenCalledWith(admin.id, id);
    expect(vendorsService.verifyVendor).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.verifyVendor);
  });

  it('PATCH /admin/vendors/:id/reject → vendorsService.rejectVendor', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.rejectVendor(admin, id, dto);
    expect(vendorsService.rejectVendor).toHaveBeenCalledWith(admin.id, id, dto.reason);
    expect(vendorsService.rejectVendor).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, vendorsService.rejectVendor);
  });
});
