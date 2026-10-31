import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { VendorBarcodesController } from './vendor-barcodes.controller';

// Unit tests for every route of VendorBarcodesController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('VendorBarcodesController (unit)', () => {
  let barcodesService: ReturnType<typeof autoMock>;
  let controller: VendorBarcodesController;

  beforeEach(() => {
    barcodesService = autoMock('barcodesService');
    controller = new VendorBarcodesController(barcodesService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(VendorBarcodesController)).toEqual([
      {
        "handler": "propose",
        "method": "POST",
        "path": "/vendors/me/barcodes",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "list",
        "method": "GET",
        "path": "/vendors/me/barcodes",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "withdraw",
        "method": "DELETE",
        "path": "/vendors/me/barcodes/:id",
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

  it('GET /vendors/me/barcodes → barcodesService.listOwn', async () => {
    const user = userOf(Role.VENDOR);
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.list(user, query);
    expect(barcodesService.listOwn).toHaveBeenCalledWith(user.id, { status: query.status, page: query.page ?? 1, limit: query.limit ?? DEFAULT_PAGE_SIZE });
    expect(barcodesService.listOwn).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, barcodesService.listOwn);
  });

  it('DELETE /vendors/me/barcodes/:id → barcodesService.withdraw', async () => {
    const user = userOf(Role.VENDOR);
    const id = 'id-1';
    const result = await controller.withdraw(user, id);
    expect(barcodesService.withdraw).toHaveBeenCalledWith(user.id, id);
    expect(barcodesService.withdraw).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, barcodesService.withdraw);
  });
  // manual tests (handlers whose body is more than one service call)
  it('POST /vendors/me/barcodes → barcodesService.propose(user.id, dto) and returns only the public fields', async () => {
    const user = userOf(Role.VENDOR);
    const dto = loose({ variantId: 'v-1', value: '0012', packagingType: 'UNIT' });
    barcodesService.propose.mockResolvedValueOnce({
      id: 'b-1', value: '0012', status: 'PENDING_APPROVAL', packagingType: 'UNIT', unitsPerPackage: 1,
      vendorId: 'internal-vendor', proposedById: 'secret-user', decidedById: null, source: 'VENDOR_PROPOSED',
    });
    const result = await controller.propose(user, dto);
    expect(barcodesService.propose).toHaveBeenCalledWith('vendor-1', dto);
    expect(result).toEqual({ id: 'b-1', value: '0012', status: 'PENDING_APPROVAL', packagingType: 'UNIT', unitsPerPackage: 1 });
  });
});
