import { autoMock, expectPassThrough, loose, routesOf } from '../../test-utils/controller-test.helpers';

import { VendorOrdersController } from './vendor-orders.controller';

// Unit tests for every route of VendorOrdersController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('VendorOrdersController (unit)', () => {
  let ordersService: ReturnType<typeof autoMock>;
  let vendorsService: ReturnType<typeof autoMock>;
  let controller: VendorOrdersController;

  beforeEach(() => {
    ordersService = autoMock('ordersService');
    vendorsService = autoMock('vendorsService');
    controller = new VendorOrdersController(ordersService as never, vendorsService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(VendorOrdersController)).toEqual([
      {
        "handler": "getOrders",
        "method": "GET",
        "path": "/vendors/me/orders",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "getOrder",
        "method": "GET",
        "path": "/vendors/me/orders/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "VENDOR"
        ]
      },
      {
        "handler": "updateStatus",
        "method": "PATCH",
        "path": "/vendors/me/orders/:id/status",
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
  // manual tests (handlers whose body is more than one service call)
  describe('the vendor is always resolved from the authenticated user (owner-scoped)', () => {
    beforeEach(() => {
      vendorsService.getMyProfile.mockResolvedValue({ id: 'vendor-profile-9' });
    });

    it('GET /vendors/me/orders → ordersService.getVendorOrders(vendorId, page, limit, status), defaulting to 1 / 20', async () => {
      await controller.getOrders('vendor-1', loose({}));
      expect(vendorsService.getMyProfile).toHaveBeenCalledWith('vendor-1');
      expect(ordersService.getVendorOrders).toHaveBeenLastCalledWith('vendor-profile-9', 1, 20, undefined);
      const result = await controller.getOrders('vendor-1', loose({ page: 2, limit: 3, status: 'PAID' }));
      expect(ordersService.getVendorOrders).toHaveBeenLastCalledWith('vendor-profile-9', 2, 3, 'PAID');
      await expectPassThrough(result, ordersService.getVendorOrders);
    });

    it('GET /vendors/me/orders/:id → ordersService.getVendorOrder(vendorId, id)', async () => {
      const result = await controller.getOrder('vendor-1', 'order-1');
      expect(ordersService.getVendorOrder).toHaveBeenCalledWith('vendor-profile-9', 'order-1');
      await expectPassThrough(result, ordersService.getVendorOrder);
    });

    it('PATCH /vendors/me/orders/:id/status → ordersService.updateVendorOrderStatus(vendorId, id, dto.status)', async () => {
      const result = await controller.updateStatus('vendor-1', 'order-1', loose({ status: 'FULFILLED' }));
      expect(ordersService.updateVendorOrderStatus).toHaveBeenCalledWith('vendor-profile-9', 'order-1', 'FULFILLED');
      await expectPassThrough(result, ordersService.updateVendorOrderStatus);
    });

    it('a vendor without a profile never reaches the orders service', async () => {
      vendorsService.getMyProfile.mockRejectedValueOnce(new Error('VENDOR_NOT_FOUND'));
      await expect(controller.getOrders('vendor-1', loose({}))).rejects.toThrow('VENDOR_NOT_FOUND');
      expect(ordersService.getVendorOrders).not.toHaveBeenCalled();
    });
  });
});
