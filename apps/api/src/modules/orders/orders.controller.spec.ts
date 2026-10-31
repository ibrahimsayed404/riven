import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { OrdersController } from './orders.controller';

// Unit tests for every route of OrdersController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('OrdersController (unit)', () => {
  let ordersService: ReturnType<typeof autoMock>;
  let controller: OrdersController;

  beforeEach(() => {
    ordersService = autoMock('ordersService');
    controller = new OrdersController(ordersService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(OrdersController)).toEqual([
      {
        "handler": "getOrders",
        "method": "GET",
        "path": "/orders",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ]
      },
      {
        "handler": "getOrder",
        "method": "GET",
        "path": "/orders/:id",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ]
      },
      {
        "handler": "cancelOrder",
        "method": "PATCH",
        "path": "/orders/:id/cancel",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ]
      },
      {
        "handler": "confirmDelivery",
        "method": "PATCH",
        "path": "/orders/:id/confirm-delivery",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ]
      }
    ]);
  });

  it('GET /orders → ordersService.getShopperOrders', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const query = loose({ page: 2, limit: 5 });
    const result = await controller.getOrders(userId, query);
    expect(ordersService.getShopperOrders).toHaveBeenCalledWith(userId, query.page ?? 1, query.limit ?? 20, query.status);
    expect(ordersService.getShopperOrders).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, ordersService.getShopperOrders);
  });

  it('GET /orders/:id → ordersService.getShopperOrder', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const id = 'id-1';
    const result = await controller.getOrder(userId, id);
    expect(ordersService.getShopperOrder).toHaveBeenCalledWith(userId, id);
    expect(ordersService.getShopperOrder).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, ordersService.getShopperOrder);
  });

  it('PATCH /orders/:id/cancel → ordersService.cancelOrder', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const id = 'id-1';
    const result = await controller.cancelOrder(userId, id);
    expect(ordersService.cancelOrder).toHaveBeenCalledWith(userId, id);
    expect(ordersService.cancelOrder).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, ordersService.cancelOrder);
  });

  it('PATCH /orders/:id/confirm-delivery → ordersService.confirmDelivery', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const id = 'id-1';
    const result = await controller.confirmDelivery(userId, id);
    expect(ordersService.confirmDelivery).toHaveBeenCalledWith(userId, id);
    expect(ordersService.confirmDelivery).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, ordersService.confirmDelivery);
  });
});
