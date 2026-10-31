import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { AdminBarcodesController } from './admin-barcodes.controller';

// Unit tests for every route of AdminBarcodesController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminBarcodesController (unit)', () => {
  let barcodesService: ReturnType<typeof autoMock>;
  let controller: AdminBarcodesController;

  beforeEach(() => {
    barcodesService = autoMock('barcodesService');
    controller = new AdminBarcodesController(barcodesService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminBarcodesController)).toEqual([
      {
        "handler": "list",
        "method": "GET",
        "path": "/admin/barcodes",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "get",
        "method": "GET",
        "path": "/admin/barcodes/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "createInternal",
        "method": "POST",
        "path": "/admin/barcodes/internal",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "registerVendor",
        "method": "POST",
        "path": "/admin/barcodes/vendor",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "lookup",
        "method": "POST",
        "path": "/admin/barcodes/lookup",
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
        "handler": "approve",
        "method": "POST",
        "path": "/admin/barcodes/:id/approve",
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
        "handler": "reject",
        "method": "POST",
        "path": "/admin/barcodes/:id/reject",
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
        "handler": "activate",
        "method": "POST",
        "path": "/admin/barcodes/:id/activate",
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
        "handler": "deactivate",
        "method": "POST",
        "path": "/admin/barcodes/:id/deactivate",
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
        "handler": "changeConversion",
        "method": "PATCH",
        "path": "/admin/barcodes/:id",
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

  it('GET /admin/barcodes → barcodesService.listForAdmin', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.list(query);
    expect(barcodesService.listForAdmin).toHaveBeenCalledWith({
      vendorId: query.vendorId,
      variantId: query.variantId,
      status: query.status,
      value: query.value,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
    expect(barcodesService.listForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, barcodesService.listForAdmin);
  });

  it('GET /admin/barcodes/:id → barcodesService.getForAdmin', async () => {
    const id = 'id-1';
    const result = await controller.get(id);
    expect(barcodesService.getForAdmin).toHaveBeenCalledWith(id);
    expect(barcodesService.getForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, barcodesService.getForAdmin);
  });

  it('POST /admin/barcodes/internal → barcodesService.createInternal', async () => {
    const admin = userOf(Role.ADMIN);
    const dto = loose({ sample: 'body' });
    const result = await controller.createInternal(admin, dto);
    expect(barcodesService.createInternal).toHaveBeenCalledWith(admin.id, dto);
    expect(barcodesService.createInternal).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, barcodesService.createInternal);
  });

  it('POST /admin/barcodes/vendor → barcodesService.registerVendorBarcode', async () => {
    const admin = userOf(Role.ADMIN);
    const dto = loose({ sample: 'body' });
    const result = await controller.registerVendor(admin, dto);
    expect(barcodesService.registerVendorBarcode).toHaveBeenCalledWith(admin.id, dto);
    expect(barcodesService.registerVendorBarcode).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, barcodesService.registerVendorBarcode);
  });

  it('POST /admin/barcodes/lookup → barcodesService.resolve', async () => {
    const dto = loose({ sample: 'body' });
    const result = await controller.lookup(dto);
    expect(barcodesService.resolve).toHaveBeenCalledWith(dto.value, dto.vendorId);
    expect(barcodesService.resolve).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, barcodesService.resolve);
  });

  it('POST /admin/barcodes/:id/approve → barcodesService.approve', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.approve(admin, id);
    expect(barcodesService.approve).toHaveBeenCalledWith(admin.id, id);
    expect(barcodesService.approve).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, barcodesService.approve);
  });

  it('POST /admin/barcodes/:id/reject → barcodesService.reject', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.reject(admin, id, dto);
    expect(barcodesService.reject).toHaveBeenCalledWith(admin.id, id, dto.reason);
    expect(barcodesService.reject).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, barcodesService.reject);
  });

  it('POST /admin/barcodes/:id/activate → barcodesService.activate', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.activate(admin, id, dto);
    expect(barcodesService.activate).toHaveBeenCalledWith(admin.id, id, dto.reason);
    expect(barcodesService.activate).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, barcodesService.activate);
  });

  it('POST /admin/barcodes/:id/deactivate → barcodesService.deactivate', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.deactivate(admin, id, dto);
    expect(barcodesService.deactivate).toHaveBeenCalledWith(admin.id, id, dto.reason);
    expect(barcodesService.deactivate).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, barcodesService.deactivate);
  });

  it('PATCH /admin/barcodes/:id → barcodesService.changeConversion', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.changeConversion(admin, id, dto);
    expect(barcodesService.changeConversion).toHaveBeenCalledWith(admin.id, id, dto.unitsPerPackage, dto.reason);
    expect(barcodesService.changeConversion).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, barcodesService.changeConversion);
  });
});
