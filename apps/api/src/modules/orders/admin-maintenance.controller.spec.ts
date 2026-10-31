import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { AdminMaintenanceController } from './admin-maintenance.controller';

// Unit tests for every route of AdminMaintenanceController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminMaintenanceController (unit)', () => {
  let expiryService: ReturnType<typeof autoMock>;
  let controller: AdminMaintenanceController;

  beforeEach(() => {
    expiryService = autoMock('expiryService');
    controller = new AdminMaintenanceController(expiryService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminMaintenanceController)).toEqual([
      {
        "handler": "expireOverdue",
        "method": "POST",
        "path": "/admin/maintenance/expire-overdue",
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

  it('POST /admin/maintenance/expire-overdue → expiryService.runManual', async () => {
    const admin = userOf(Role.ADMIN);
    const dto = loose({ sample: 'body' });
    const result = await controller.expireOverdue(admin, dto);
    expect(expiryService.runManual).toHaveBeenCalledWith(admin.id, dto.reason);
    expect(expiryService.runManual).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, expiryService.runManual);
  });
});
