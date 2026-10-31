import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { DEFAULT_PAGE_SIZE } from '../../common/dto/pagination-query.dto';
import { AdminOrdersController } from './admin-orders.controller';

// Unit tests for every route of AdminOrdersController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('AdminOrdersController (unit)', () => {
  let ordersService: ReturnType<typeof autoMock>;
  let controller: AdminOrdersController;

  beforeEach(() => {
    ordersService = autoMock('ordersService');
    controller = new AdminOrdersController(ordersService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(AdminOrdersController)).toEqual([
      {
        "handler": "listOrders",
        "method": "GET",
        "path": "/admin/orders",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "getOrder",
        "method": "GET",
        "path": "/admin/orders/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "ADMIN"
        ]
      },
      {
        "handler": "cancelOrder",
        "method": "PATCH",
        "path": "/admin/orders/:id/cancel",
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

  it('GET /admin/orders → ordersService.listForAdmin', async () => {
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.listOrders(query);
    expect(ordersService.listForAdmin).toHaveBeenCalledWith({
      status: query.status,
      vendorId: query.vendorId,
      userId: query.userId,
      orderGroupId: query.orderGroupId,
      page: query.page ?? 1,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
    expect(ordersService.listForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, ordersService.listForAdmin);
  });

  it('GET /admin/orders/:id → ordersService.getOrderForAdmin', async () => {
    const id = 'id-1';
    const result = await controller.getOrder(id);
    expect(ordersService.getOrderForAdmin).toHaveBeenCalledWith(id);
    expect(ordersService.getOrderForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, ordersService.getOrderForAdmin);
  });

  it('PATCH /admin/orders/:id/cancel → ordersService.cancelOrderForAdmin', async () => {
    const admin = userOf(Role.ADMIN);
    const id = 'id-1';
    const result = await controller.cancelOrder(admin, id);
    expect(ordersService.cancelOrderForAdmin).toHaveBeenCalledWith(admin.id, id);
    expect(ordersService.cancelOrderForAdmin).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, ordersService.cancelOrderForAdmin);
  });
});
