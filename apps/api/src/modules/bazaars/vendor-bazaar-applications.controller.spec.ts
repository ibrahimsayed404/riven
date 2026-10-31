import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { VendorBazaarApplicationsController } from './vendor-bazaar-applications.controller';

// Unit tests for every route of VendorBazaarApplicationsController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('VendorBazaarApplicationsController (unit)', () => {
  let bazaarsService: ReturnType<typeof autoMock>;
  let controller: VendorBazaarApplicationsController;

  beforeEach(() => {
    bazaarsService = autoMock('bazaarsService');
    controller = new VendorBazaarApplicationsController(bazaarsService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(VendorBazaarApplicationsController)).toEqual([
      {
        "handler": "applyToBazaar",
        "method": "POST",
        "path": "/bazaars/:id/apply",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "withdrawApplication",
        "method": "DELETE",
        "path": "/bazaars/:id/apply",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ],
        "httpCode": 204
      },
      {
        "handler": "getApplications",
        "method": "GET",
        "path": "/vendors/me/bazaar-applications",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      }
    ]);
  });

  it('POST /bazaars/:id/apply → bazaarsService.applyToBazaar', async () => {
    const ownerId = userOf(Role.VENDOR).id;
    const bazaarId = 'id-1';
    const result = await controller.applyToBazaar(ownerId, bazaarId);
    expect(bazaarsService.applyToBazaar).toHaveBeenCalledWith(ownerId, bazaarId);
    expect(bazaarsService.applyToBazaar).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.applyToBazaar);
  });

  it('DELETE /bazaars/:id/apply → bazaarsService.withdrawApplication', async () => {
    const ownerId = userOf(Role.VENDOR).id;
    const bazaarId = 'id-1';
    const result = await controller.withdrawApplication(ownerId, bazaarId);
    expect(bazaarsService.withdrawApplication).toHaveBeenCalledWith(ownerId, bazaarId);
    expect(bazaarsService.withdrawApplication).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, bazaarsService.withdrawApplication);
  });
  // manual tests (handlers whose body is more than one service call)
  it('GET /vendors/me/applications → bazaarsService.getVendorApplications(ownerId, page, limit, status)', async () => {
    await controller.getApplications('vendor-1', loose({}));
    expect(bazaarsService.getVendorApplications).toHaveBeenLastCalledWith('vendor-1', 1, 20, undefined);
    const result = await controller.getApplications('vendor-1', loose({ page: 4, limit: 10, status: 'ACCEPTED' }));
    expect(bazaarsService.getVendorApplications).toHaveBeenLastCalledWith('vendor-1', 4, 10, 'ACCEPTED');
    await expectPassThrough(result, bazaarsService.getVendorApplications);
  });
});
