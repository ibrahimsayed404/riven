import { autoMock, expectPassThrough, loose, routesOf, userOf } from '../../test-utils/controller-test.helpers';
import { Role } from '@prisma/client';

import { CartController } from './cart.controller';

// Unit tests for every route of CartController: the route definition (method, path,
// guards, roles, status code) and delegation to the service with pass-through.
describe('CartController (unit)', () => {
  let cartService: ReturnType<typeof autoMock>;
  let controller: CartController;

  beforeEach(() => {
    cartService = autoMock('cartService');
    controller = new CartController(cartService as never);
  });

  it('declares exactly these routes, guards and roles', () => {
    expect(routesOf(CartController)).toEqual([
      {
        "handler": "getCart",
        "method": "GET",
        "path": "/cart",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ]
      },
      {
        "handler": "addItem",
        "method": "POST",
        "path": "/cart/items",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ]
      },
      {
        "handler": "updateItem",
        "method": "PATCH",
        "path": "/cart/items/:itemId",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ]
      },
      {
        "handler": "removeItem",
        "method": "DELETE",
        "path": "/cart/items/:itemId",
        "guards": [
          "JwtAuthGuard",
          "RolesGuard"
        ],
        "roles": [
          "SHOPPER"
        ]
      },
      {
        "handler": "clearCart",
        "method": "DELETE",
        "path": "/cart",
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

  it('GET /cart → cartService.getCart', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const result = await controller.getCart(userId);
    expect(cartService.getCart).toHaveBeenCalledWith(userId);
    expect(cartService.getCart).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, cartService.getCart);
  });

  it('POST /cart/items → cartService.addItem', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const dto = loose({ sample: 'body' });
    const result = await controller.addItem(userId, dto);
    expect(cartService.addItem).toHaveBeenCalledWith(userId, dto.productId, dto.variantId, dto.quantity);
    expect(cartService.addItem).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, cartService.addItem);
  });

  it('PATCH /cart/items/:itemId → cartService.updateItemQuantity', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const itemId = 'itemId-1';
    const dto = loose({ sample: 'body' });
    const result = await controller.updateItem(userId, itemId, dto);
    expect(cartService.updateItemQuantity).toHaveBeenCalledWith(userId, itemId, dto.quantity);
    expect(cartService.updateItemQuantity).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, cartService.updateItemQuantity);
  });

  it('DELETE /cart/items/:itemId → cartService.removeItem', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const itemId = 'itemId-1';
    const result = await controller.removeItem(userId, itemId);
    expect(cartService.removeItem).toHaveBeenCalledWith(userId, itemId);
    expect(cartService.removeItem).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, cartService.removeItem);
  });

  it('DELETE /cart → cartService.clearCart', async () => {
    const userId = userOf(Role.SHOPPER).id;
    const result = await controller.clearCart(userId);
    expect(cartService.clearCart).toHaveBeenCalledWith(userId);
    expect(cartService.clearCart).toHaveBeenCalledTimes(1);
    await expectPassThrough(result, cartService.clearCart);
  });
});
